/**
 * Phase 4 — DELIVERY RECEIPTS: the sent → delivered → read state machine, and
 * the "twice / out-of-order / never" problems. Run with:  npm run phase4
 *
 * Those ticks in a chat app (✓ sent, ✓✓ delivered, ✓✓ blue read) are a
 * distributed state machine. Each transition is a separate network event that
 * can be lost, duplicated, or reordered:
 *
 *   SENT       server accepted and persisted the message (it won't be lost)
 *   DELIVERED  recipient's DEVICE received it (their gateway pushed it down)
 *   READ       recipient actually opened/viewed it
 *
 * State only moves FORWARD (read implies delivered implies sent). That
 * monotonicity is what makes the acks idempotent — a duplicate "delivered" after
 * "read" is simply ignored, so at-least-once acking is safe.
 *
 * The three classic bugs and their one-line fixes:
 *   • delivered TWICE      → dedupe by messageId (idempotent receipts)
 *   • delivered OUT OF ORDER→ monotonic state (never move backward)
 *   • NEVER delivered      → the sender retries from "sent" until an ack arrives
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STATES = ["sent", "delivered", "read"] as const;
type State = (typeof STATES)[number];
const rank = (s: State) => STATES.indexOf(s);

class MessageTracker {
  private state = new Map<string, State>();

  create(id: string) {
    this.state.set(id, "sent");
    log(`   msg ${id}: ✓ SENT`);
  }

  /** Idempotent, monotonic transition. Ignores duplicates and backward moves. */
  advance(id: string, to: State) {
    const cur = this.state.get(id);
    if (cur === undefined) return;
    if (rank(to) <= rank(cur)) {
      log(`   msg ${id}: (ignored ${to} — already ${cur}; state only moves forward)`);
      return;
    }
    this.state.set(id, to);
    const tick = to === "delivered" ? "✓✓ DELIVERED" : "✓✓ READ (blue)";
    log(`   msg ${id}: ${tick}`);
  }

  get(id: string) { return this.state.get(id); }
}

async function main() {
  const tracker = new MessageTracker();

  log("═══ Happy path: sent → delivered → read ═══");
  tracker.create("m1");
  await sleep(150);
  tracker.advance("m1", "delivered"); // recipient's device got it
  await sleep(150);
  tracker.advance("m1", "read"); // recipient opened the chat

  log("");
  log("═══ Bug 1: duplicate 'delivered' ack (at-least-once networks) ═══");
  tracker.create("m2");
  tracker.advance("m2", "delivered");
  tracker.advance("m2", "delivered"); // duplicate → ignored, no double-tick

  log("");
  log("═══ Bug 2: acks arrive OUT OF ORDER ('read' before 'delivered') ═══");
  tracker.create("m3");
  tracker.advance("m3", "read"); // jumps ahead — that's fine, read implies delivered
  tracker.advance("m3", "delivered"); // late 'delivered' → ignored (would move backward)

  log("");
  log("═══ Bug 3: message NEVER delivered → sender retries until acked ═══");
  tracker.create("m4");
  let acked = false;
  const deliver = () => { acked = true; tracker.advance("m4", "delivered"); };
  for (let attempt = 1; attempt <= 3 && !acked; attempt++) {
    log(`   sender: no ack yet, retry attempt ${attempt} (from 'sent')`);
    if (attempt === 3) deliver(); // succeeds on the 3rd try
    await sleep(120);
  }

  log("");
  log("The whole state machine is: forward-only + idempotent + sender-retries.");
  log("That combination is what survives an at-least-once, reordering network.");
  process.exit(0);
}

main();
