/**
 * Phase 2 — THE TWO-HOP PATTERN: routing a message to whichever gateway holds
 * the recipient. Run with:  npm run phase2   (needs Redis)
 *
 * At scale you don't have ONE server — you have a FLEET of gateways, each
 * holding a slice of the live connections (say 100k sockets each). So when user
 * A sends to user B, A's gateway has no socket for B. Realtime delivery is two
 * hops:
 *
 *   hop 1 — ROUTING: "which gateway holds B's connection?"  A pub/sub problem.
 *           A registry maps user → gateway. A's gateway looks up B, then
 *           publishes the message to B's gateway over a shared bus (Redis pub/sub).
 *
 *   hop 2 — TRANSPORT: B's gateway pushes the bytes down B's socket (Phase 1).
 *
 *   A ──socket──▶ gateway-1 ──registry: B is on gateway-3?──▶ Redis pub/sub
 *                                                                   │
 *                                          gateway-3 ◀─────────────┘
 *                                              └──socket──▶ B
 *
 * The offline branch: if B isn't in the registry, no gateway has them — stash
 * the message in B's inbox to deliver on reconnect (Phase 6).
 *
 * We run 3 gateways in one process (each with its own Redis subscription) and a
 * shared Redis registry, then send messages across them.
 */

import Redis from "ioredis";
import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shared = new Redis(); // registry + publishing + inbox

interface Msg { from: string; to: string; text: string }

class Gateway {
  id: string;
  private sub: Redis; // subscriber connections must be dedicated
  private local = new Map<string, (m: Msg) => void>(); // userId → deliver-to-socket

  constructor(id: string) {
    this.id = id;
    this.sub = new Redis();
  }

  async start() {
    await this.sub.subscribe(`gw:${this.id}`);
    this.sub.on("message", (_ch, payload) => {
      const m: Msg = JSON.parse(payload);
      const deliver = this.local.get(m.to);
      if (deliver) {
        log(`   [${this.id}] hop 2: pushing to ${m.to}'s socket`);
        deliver(m);
      }
    });
  }

  /** A user connects here; record them in the shared registry. */
  async connect(userId: string, onMessage: (m: Msg) => void) {
    this.local.set(userId, onMessage);
    await shared.hset("registry", userId, this.id); // user → gateway
    log(`   [${this.id}] ${userId} connected (registry: ${userId} → ${this.id})`);
  }

  /** Send a message from a user on THIS gateway to any user anywhere. */
  async send(from: string, to: string, text: string) {
    const targetGw = await shared.hget("registry", to); // hop 1: routing lookup
    if (!targetGw) {
      await shared.rpush(`inbox:${to}`, JSON.stringify({ from, text })); // offline branch
      log(`   [${this.id}] ${to} is OFFLINE → stored in inbox for later`);
      return;
    }
    log(`   [${this.id}] hop 1: ${to} is on ${targetGw} → publish over Redis pub/sub`);
    await shared.publish(`gw:${targetGw}`, JSON.stringify({ from, to, text }));
  }

  async stop() { this.sub.disconnect(); }
}

async function main() {
  await shared.del("registry", "inbox:carol");

  const g1 = new Gateway("gateway-1");
  const g2 = new Gateway("gateway-2");
  const g3 = new Gateway("gateway-3");
  await Promise.all([g1.start(), g2.start(), g3.start()]);

  // Users connect to different gateways (as a load balancer would spread them).
  await g1.connect("alice", (m) => log(`      ✉ alice received from ${m.from}: "${m.text}"`));
  await g3.connect("bob", (m) => log(`      ✉ bob received from ${m.from}: "${m.text}"`));
  log("");

  log('═══ alice (on gateway-1) messages bob (on gateway-3) ═══');
  await g1.send("alice", "bob", "hey bob!");
  await sleep(300);

  log("");
  log('═══ bob replies to alice — routed back across gateways ═══');
  await g3.send("bob", "alice", "hey alice, got it");
  await sleep(300);

  log("");
  log('═══ alice messages carol, who is offline ═══');
  await g1.send("alice", "carol", "you around?");
  await sleep(200);
  const pending = await shared.llen("inbox:carol");
  log(`   carol's inbox now holds ${pending} message(s) for when she reconnects`);

  log("");
  log("That's the pattern every chat system uses. hop 1 (routing) is why Redis");
  log("pub/sub shows up here — and why at-most-once is usually fine: a missed");
  log("message is recovered by the reconnect-and-fetch-since path (Phase 6).");

  await Promise.all([g1.stop(), g2.stop(), g3.stop()]);
  shared.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error("Phase 2 error:", e.message, "\nIs Redis running?"); process.exit(1); });
