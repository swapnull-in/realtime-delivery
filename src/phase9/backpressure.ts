/**
 * Phase 9 — BACKPRESSURE & THE SLOW CONSUMER. Run with:  npm run phase9
 *
 * The war story: one slow client takes down a whole gateway node. A gateway holds
 * thousands of live connections. Each connection has a per-connection SEND BUFFER
 * — bytes the server has produced but the socket hasn't drained yet. A healthy
 * client drains as fast as you push. A 2G phone in a basement drains at a crawl.
 *
 * If you keep pushing to that slow client without bound, its send buffer grows
 * every tick and NEVER shrinks. Node memory is the SUM of all send buffers, so
 * one slow consumer drags the whole node's memory up. Then the cascade:
 *
 *     buffer grows → GC pressure → event-loop stalls → EVERY connection on the
 *     node gets slower → healthy clients now look "slow" too → OOM → node dies.
 *
 * One 2G phone just caused a node-wide outage. This is not hypothetical; it is the
 * classic way realtime gateways fall over (§3.2 / §9).
 *
 * The fixes, in order:
 *   A) show the unbounded buffer blowing up node memory + poisoning healthy conns
 *   B) BOUND every send buffer; when the slow consumer overflows the cap, DROP it
 *      (close the socket). It reconnects and re-syncs from its cursor — dropping is
 *      SAFE because chat clients resync (Phase 6). Node availability beats one
 *      degraded client.
 *   C) COALESCE latest-wins state (presence/typing/cursor): only the newest value
 *      matters, so collapse the buffer — a stale "typing…" is worthless.
 *   D) (below) per-connection rate limits, shed low-priority first, and spill to a
 *      durable per-user queue ONLY for message types you genuinely cannot lose.
 *
 * Deterministic: discrete ticks, fixed drain rates. No clocks, no randomness.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TICKS = 10; // discrete simulated ticks
const PRODUCE_PER_TICK = 25; // messages the producer pushes to EACH connection per tick
const OOM_THRESHOLD = 200; // node "memory" units (sum of all buffers) that kills the node

// Drain rate = messages a connection can flush to its socket per tick.
// Healthy clients keep up (drain ≥ produce); the 2G phone barely moves.
const FAST_DRAIN = 25;
const SLOW_DRAIN = 2;

type Conn = { id: string; drain: number; buffer: number; alive: boolean };

function makeConns(): Conn[] {
  return [
    { id: "conn-A (wifi) ", drain: FAST_DRAIN, buffer: 0, alive: true },
    { id: "conn-B (wifi) ", drain: FAST_DRAIN, buffer: 0, alive: true },
    { id: "conn-C (2G!!!) ", drain: SLOW_DRAIN, buffer: 0, alive: true },
  ];
}

const nodeMemory = (conns: Conn[]) => conns.reduce((sum, c) => sum + c.buffer, 0);
const bar = (n: number) => "█".repeat(Math.max(0, Math.round(n / 5)));

// ─── A) UNBOUNDED BUFFER — the problem ─────────────────────────────────────
function unboundedDemo() {
  log("═══ A) UNBOUNDED send buffers: one 2G client OOMs the node ═══");
  log(`   producer pushes ${PRODUCE_PER_TICK} msgs/tick to EACH conn; drain: wifi=${FAST_DRAIN}/tick, 2G=${SLOW_DRAIN}/tick`);
  log("");
  const conns = makeConns();

  for (let tick = 1; tick <= TICKS; tick++) {
    // Producer enqueues into every connection's send buffer, then each drains.
    for (const c of conns) {
      c.buffer += PRODUCE_PER_TICK;
      c.buffer = Math.max(0, c.buffer - c.drain); // flush what the socket can take
    }
    const mem = nodeMemory(conns);
    // Once node memory crosses ~half the OOM line, the event loop is under GC
    // pressure and stalls — healthy connections' effective latency rises too.
    const stalled = mem > OOM_THRESHOLD / 2;
    const slow = conns.find((c) => c.drain === SLOW_DRAIN)!;
    const health = stalled ? "  ⚠ event-loop stalled → healthy conns' latency rising" : "";
    log(`   tick ${String(tick).padStart(2)}  2G-buffer=${String(slow.buffer).padStart(3)} ${bar(slow.buffer)}`);
    log(`            node-mem=${String(mem).padStart(3)}/${OOM_THRESHOLD} ${bar(mem)}${health}`);
    if (mem > OOM_THRESHOLD) {
      log("");
      log(`   💥 node memory ${mem} > ${OOM_THRESHOLD}: OOM. The whole node dies —`);
      log("      every connection on it drops, not just the slow one. Cascading failure.");
      return;
    }
  }
}

// ─── B) BOUNDED BUFFER + DROP SLOW CONSUMER — the fix ──────────────────────
function boundedDemo() {
  log("");
  log("═══ B) BOUNDED buffers + DROP the slow consumer ═══");
  log(`   cap each send buffer at ${BUFFER_CAP}; overflow ⇒ close that socket (it resyncs)`);
  log("");
  const conns = makeConns();

  for (let tick = 1; tick <= TICKS; tick++) {
    for (const c of conns) {
      if (!c.alive) continue;
      c.buffer += PRODUCE_PER_TICK;
      c.buffer = Math.max(0, c.buffer - c.drain);
      if (c.buffer > BUFFER_CAP) {
        // The client can't keep up. Don't buffer to death — drop it.
        c.alive = false;
        c.buffer = 0; // socket closed, buffer freed
        log(`   tick ${String(tick).padStart(2)}  ${c.id.trim()} overflowed cap → CLOSED. It'll reconnect &`);
        log(`            fetch-since its cursor (Phase 6). Node stays up. ✓`);
      }
    }
    const mem = nodeMemory(conns);
    log(`   tick ${String(tick).padStart(2)}  node-mem=${String(mem).padStart(3)}/${OOM_THRESHOLD} ${bar(mem)}  (bounded)`);
  }
  const survivors = conns.filter((c) => c.alive).map((c) => c.id.trim()).join(", ");
  log("");
  log(`   ✓ node memory never approaches OOM; healthy conns unaffected: ${survivors}.`);
  log("   Money line: node availability beats one degraded client.");
}

const BUFFER_CAP = 24; // max messages a per-connection send buffer may hold

// ─── C) COALESCE LATEST-WINS state ─────────────────────────────────────────
function coalesceDemo() {
  log("");
  log("═══ C) COALESCE latest-wins state (presence / typing / cursor) ═══");

  // A stream of presence deltas queued for one slow watcher's connection.
  const deltas = [
    "alice: typing…",
    "alice: online",
    "alice: typing…",
    "alice: idle",
    "alice: typing…",
    "alice: online", // ← only THIS one still matters
  ];
  log(`   raw buffer had ${deltas.length} presence deltas queued for a slow conn:`);
  deltas.forEach((d) => log(`      · ${d}`));

  // Latest-wins: keep only the newest value per key. A stale "typing" is worthless.
  const coalesced = new Map<string, string>();
  for (const d of deltas) {
    const [key] = d.split(":");
    coalesced.set(key, d); // newer overwrites older
  }
  log("   coalesced (keep newest per key) — intermediate states dropped:");
  for (const v of coalesced.values()) log(`      ⇒ ${v}`);
  log(`   ${deltas.length} deltas collapsed to ${coalesced.size}. Slow client gets the truth, cheaply.`);
}

async function main() {
  unboundedDemo();
  await sleep(0);
  boundedDemo();
  coalesceDemo();

  log("");
  log("─── D) The rest of the backpressure toolkit ───");
  log("   • per-connection RATE LIMITS so no single conn can flood its own buffer");
  log("   • SHED low-priority traffic first (typing/presence) before real messages");
  log("   • SPILL to a durable per-user queue ONLY for types you truly cannot lose");
  log("     (e.g. a DM) — everything else is droppable/coalesceable.");
  log("");
  log("TAKEAWAY: an unbounded per-connection send buffer turns one slow 2G client");
  log("into a node-wide outage (buffer grows → GC pressure → event-loop stall →");
  log("every connection degrades). Bound EVERY send buffer and drop the slow");
  log("consumer — node availability beats one degraded client, and it re-syncs from");
  log("a cursor anyway. Coalesce latest-wins state; only spill to a durable queue");
  log("for messages you cannot lose.");
  process.exit(0);
}

main();
