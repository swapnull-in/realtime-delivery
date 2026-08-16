/**
 * Phase 10 — GRACEFUL DEPLOYS, CONNECTION DRAINING & THE RECONNECT STORM.
 * Run with:  node "src/phase10/draining.ts"
 *
 * This is THE signature Staff-level real-time question (§3.5 / §9): "How do you
 * ship new code to a fleet holding 2,000,000 live WebSocket connections without
 * dropping them?" The happy path is easy. The hard part of real-time — the whole
 * job, really — is the CORRELATED-FAILURE RECOVERY PATH: what the system does
 * when a lot of sockets die at the same instant.
 *
 * THE STORM (naive deploy). A socket isn't a stateless request; it's a standing
 * cost (auth, presence, registry entry, buffers). Kill all N at once and all N
 * reconnect in the SAME tick → a thundering herd that:
 *   • exceeds the survivors' accept capacity (auth + register throughput/tick),
 *   • becomes a registry WRITE storm (every user re-homes — see phase2/two-hop.ts),
 *   • becomes an AUTH stampede, and a PRESENCE flap (phase5) as everyone blips.
 * The replacement capacity tips over → cascading outage. The deploy caused it.
 *
 * THE PLAYBOOK (the fix), layered — this phase EXTENDS the jittered-reconnect
 * sketch in phase6/offline-sync.ts into the full deploy-drain playbook:
 *   1. SLOW / ROLLING DRAIN — deregister a node from the LB, then migrate its
 *      connections over a long WINDOW (many ticks), a few % of the fleet at a
 *      time — never more than survivors can absorb.
 *   2. SERVER-INITIATED RECONNECT WITH JITTER — tell each client "reconnect
 *      within the next W ticks at a random offset." Jitter is EVERYTHING: without
 *      it they all come back at once. Rejected attempts back off exponentially
 *      × random(0.5, 1.5) so retries don't re-synchronize into a fresh herd.
 *   3. CAPACITY HEADROOM — survivors must have room to absorb the drained load.
 *      Size to a FAILOVER BUDGET: lose a node and stay under 100% utilization.
 *   4. CHEAP CURSOR RESUME — a reconnect fetches only the gap since its cursor
 *      (phase6 fetch-since), not full history, so each reconnect is cheap.
 *
 * TWO more truths this phase makes concrete:
 *   • THE DEAD-NODE REGISTRY WINDOW — a CRASH (not a graceful drain) leaves the
 *     TTL-based registry pointing at a dead node until the TTL expires. Messages
 *     routed there in that window are dropped. You ACCEPT the window (rather than
 *     pay for consensus registration) because at-least-once retry + cursor
 *     resync catches the gap anyway.
 *   • CONTINUOUS ROTATION — force ~1% of connections to reconnect every few ticks
 *     in STEADY STATE, so the reconnect path is always warm. A full deploy is
 *     then just a louder version of normal. You never want your disaster-recovery
 *     path to be the code that only runs during disasters.
 *
 * Everything below is deterministic: discrete integer ticks, and a seeded
 * mulberry32 PRNG for jitter offsets — no Date.now / Math.random in the logic.
 *
 * TAKEAWAY: you deploy to millions of live sockets by draining SLOWLY over a long
 * window (rolling, a few % at a time), telling clients to reconnect with JITTERED
 * exponential backoff (jitter defeats the thundering herd), sizing survivors with
 * capacity HEADROOM (a failover budget), and resuming from a CURSOR so reconnects
 * are cheap — plus continuous low-rate rotation so the recovery path is always
 * warm. Design for the recovery storm, not the steady state.
 */

import { log } from "../lib/log.ts";

// ─── Seeded PRNG so every jitter offset is deterministic across runs ─────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x5eed_c0de;

// ─── Fleet & capacity model (small enough to print, same shape at 2M) ────────
const NODES = 10;
const CONNS_PER_NODE = 20_000;
const N = NODES * CONNS_PER_NODE; // 200,000 live sockets
const ACCEPT_PER_NODE = 3_000; // new conns a node can auth+register per tick
const FLEET_ACCEPT = NODES * ACCEPT_PER_NODE; // 30,000 reconnects/tick, whole fleet
const SURVIVOR_ACCEPT = (NODES - 1) * ACCEPT_PER_NODE; // 27,000/tick while one node is out

const DRAIN_WINDOW = 40; // ticks over which one node's connections migrate
const STAGGER = 40; // ticks between starting to drain each node (rolling)

// ─── Tiny chart: reconnect-rate-per-tick curve, scaled to its own shape ──────
// Bars are scaled to the series' own peak so the SHAPE is visible (a spike vs a
// plateau); the capacity line is reported numerically and marks over-capacity
// ticks with 💥.
function renderCurve(perTick: number[], capacity: number, cols = 20): void {
  let lastActive = 0;
  for (let i = 0; i < perTick.length; i++) if (perTick[i] > 0) lastActive = i;
  const len = lastActive + 1;
  const size = Math.max(1, Math.ceil(len / cols));
  const WIDTH = 34;

  const buckets: { tick: number; peak: number }[] = [];
  for (let s = 0; s < len; s += size) {
    let peak = 0;
    for (let i = s; i < Math.min(s + size, len); i++) peak = Math.max(peak, perTick[i]);
    buckets.push({ tick: s, peak });
  }
  const scaleMax = Math.max(1, ...buckets.map((b) => b.peak));

  for (const b of buckets) {
    const barLen = Math.round((b.peak / scaleMax) * WIDTH);
    const bar = "█".repeat(barLen).padEnd(WIDTH, "·");
    const over = b.peak > capacity;
    log(`   t=${String(b.tick).padStart(3)} │${bar}│ ${String(b.peak).padStart(7)}/tick${over ? "  💥 exceeds accept capacity" : ""}`);
  }
}

function peakOf(perTick: number[]): number {
  let m = 0;
  for (const v of perTick) m = Math.max(m, v);
  return m;
}

// ════════════════════════════════════════════════════════════════════════════
// A) NAIVE DEPLOY — kill all N at one instant → the storm
// ════════════════════════════════════════════════════════════════════════════
function naiveDeployDemo(): number[] {
  log("═══ A) NAIVE DEPLOY: kill all sockets at once ═══");
  log(`   fleet: ${NODES} nodes × ${CONNS_PER_NODE.toLocaleString()} = ${N.toLocaleString()} live sockets`);
  log(`   accept capacity: ${FLEET_ACCEPT.toLocaleString()} reconnects/tick (whole fleet, best case)`);
  log("");

  const perTick = new Array(DRAIN_WINDOW * NODES + DRAIN_WINDOW).fill(0);
  perTick[1] = N; // everyone drops at t=0, reconnects at t=1, same instant

  log("   reconnect-rate curve:");
  renderCurve(perTick, FLEET_ACCEPT);

  const peak = peakOf(perTick);
  const over = (peak / FLEET_ACCEPT).toFixed(1);
  log("");
  log(`   spike = ${peak.toLocaleString()}/tick vs capacity ${FLEET_ACCEPT.toLocaleString()}/tick → ${over}× over 💥`);
  log("   → auth stampede + registry write-storm + presence flap → the replacement");
  log("     capacity tips over → cascading outage. The deploy caused the outage.");
  return perTick;
}

// ════════════════════════════════════════════════════════════════════════════
// B) THE DRAIN PLAYBOOK — rolling + jitter + headroom + cursor resume
// ════════════════════════════════════════════════════════════════════════════

// full-jitter exponential backoff for a REJECTED reconnect: base·2^attempt · random(0.5,1.5)
function backoffTicks(attempt: number, rng: () => number): number {
  const raw = 2 ** attempt; // 2, 4, 8, … ticks
  const jitter = 0.5 + rng(); // random in [0.5, 1.5)
  return Math.max(1, Math.round(raw * jitter));
}

// B1 + B2: roll node-by-node; each node's conns pick a JITTERED offset inside the window.
function drainedDeployDemo(): number[] {
  log("");
  log("═══ B) THE DRAIN PLAYBOOK: rolling drain + jittered reconnect ═══");
  log(`   drain one node at a time (${(100 / NODES).toFixed(0)}% of the fleet), migrate its ${CONNS_PER_NODE.toLocaleString()}`);
  log(`   connections over a ${DRAIN_WINDOW}-tick window at a random per-client offset.`);
  log("");

  const rng = mulberry32(SEED);
  const perTick = new Array(STAGGER * NODES + DRAIN_WINDOW + 2).fill(0);

  for (let node = 0; node < NODES; node++) {
    const drainStart = 1 + node * STAGGER; // rolling: deregister nodes one after another
    for (let c = 0; c < CONNS_PER_NODE; c++) {
      // server-initiated: "reconnect within the next DRAIN_WINDOW ticks, random offset"
      const offset = Math.floor(rng() * DRAIN_WINDOW);
      perTick[drainStart + offset]++;
    }
  }

  log("   reconnect-rate curve:");
  renderCurve(perTick, SURVIVOR_ACCEPT);

  const peak = peakOf(perTick);
  const util = ((peak / SURVIVOR_ACCEPT) * 100).toFixed(1);
  log("");
  log(`   plateau ≈ ${peak.toLocaleString()}/tick vs survivor capacity ${SURVIVOR_ACCEPT.toLocaleString()}/tick → ${util}% utilization ✓`);
  log(`   same ${N.toLocaleString()} reconnects as (A), but spread ${(peakOf(naiveSpikeOnly()) / peak).toFixed(0)}× lower — a flat`);
  log("   plateau instead of a spike. The herd never forms.");
  return perTick;
}
// helper so the comparison line above stays honest (naive peak = N in one tick)
function naiveSpikeOnly(): number[] {
  return [0, N];
}

// B2 (isolated): jitter is everything — without it, rejected retries re-synchronize.
function jitterDemo(): void {
  log("");
  log("   ── B2. why jitter (not just backoff) ──");
  const rng = mulberry32(SEED ^ 0x1111);
  const clients = 12;

  const lockstep = new Map<number, number>();
  const jittered = new Map<number, number>();
  for (let i = 0; i < clients; i++) {
    const noJitter = 2 ** 1; // everyone: base·2^attempt, attempt=1 → tick 2, in lockstep
    const withJitter = backoffTicks(1, rng); // × random(0.5,1.5) → spread across ticks
    lockstep.set(noJitter, (lockstep.get(noJitter) ?? 0) + 1);
    jittered.set(withJitter, (jittered.get(withJitter) ?? 0) + 1);
  }
  const fmt = (m: Map<number, number>) =>
    [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `t+${t}:${"▮".repeat(n)}`).join("  ");
  log(`   backoff, NO jitter : ${fmt(lockstep)}   ← ${clients} clients re-collide (a fresh herd)`);
  log(`   backoff × random(0.5,1.5): ${fmt(jittered)}   ← spread out, no second storm`);
}

// B3: capacity headroom — survivors must fit the fleet minus a node (failover budget).
function headroomDemo(): void {
  log("");
  log("   ── B3. capacity headroom (the failover budget) ──");
  const holdPerNodeSteady = N / NODES; // 20,000 held per node in steady state
  const holdPerNodeFailover = Math.ceil(N / (NODES - 1)); // redistribute onto survivors

  const sized = 25_000; // provisioned max sockets/node — sized WITH headroom
  const tight = 21_000; // provisioned WITHOUT headroom
  log(`   steady state: ${holdPerNodeSteady.toLocaleString()} sockets/node`);
  log(`   lose 1 node → survivors each hold ${holdPerNodeFailover.toLocaleString()}`);
  log(`   • sized ${sized.toLocaleString()}/node → ${((holdPerNodeFailover / sized) * 100).toFixed(0)}% util ✓ absorbs the drain within budget`);
  log(`   • sized ${tight.toLocaleString()}/node → ${((holdPerNodeFailover / tight) * 100).toFixed(0)}% util 💥 no headroom → the drain itself overloads survivors`);
}

// B4: cheap cursor resume — a reconnect fetches only the gap (phase6 fetch-since).
class ConversationLog {
  // ONE log per conversation; reconnects read a delta, not full history.
  private messages: { id: number; text: string }[] = [];
  append(text: string): number {
    const id = this.messages.length + 1;
    this.messages.push({ id, text });
    return id;
  }
  since(cursor: number): { id: number; text: string }[] {
    return this.messages.filter((m) => m.id > cursor);
  }
  get size(): number {
    return this.messages.length;
  }
}
function cursorResumeDemo(): void {
  log("");
  log("   ── B4. cheap cursor resume (reconnect fetches only the gap) ──");
  const convo = new ConversationLog();
  for (let i = 0; i < 5_000; i++) convo.append(`m${i}`); // long history already on the server
  const clientCursor = 4_997; // a drained client is nearly caught up
  const delta = convo.since(clientCursor);
  log(`   conversation has ${convo.size.toLocaleString()} messages; drained client cursor=${clientCursor}`);
  log(`   reconnect transfers only ${delta.length} message(s) (the gap), not ${convo.size.toLocaleString()} →`);
  log("   a reconnect stays cheap even when the whole fleet reconnects at once.");
}

// ════════════════════════════════════════════════════════════════════════════
// C) THE DEAD-NODE REGISTRY WINDOW — a crash, not a graceful drain
// ════════════════════════════════════════════════════════════════════════════
function deadNodeWindowDemo(): void {
  log("");
  log("═══ C) DEAD-NODE REGISTRY WINDOW (crash, not a drain) ═══");
  const TTL = 15; // ticks until the TTL registry entry (phase2/two-hop) expires
  const INBOUND_PER_TICK = 120; // messages/tick routed to users on the dead node

  log(`   node-7 crashes holding ${CONNS_PER_NODE.toLocaleString()} sockets. The TTL registry still points`);
  log(`   at it for ${TTL} ticks (no graceful deregister). Messages routed there are dropped:`);
  let dropped = 0;
  for (let t = 1; t <= TTL; t++) dropped += INBOUND_PER_TICK;
  log(`   → ${dropped.toLocaleString()} messages routed into the void during the stale-registry window`);
  log("");
  log("   why we ACCEPT this window instead of paying for consensus registration:");
  log(`   at-least-once retry + cursor resync (phase6 fetch-since) recovers all ${dropped.toLocaleString()}`);
  log("   once affected clients re-home after the TTL expires → net user-visible loss = 0.");
  log("   Consensus on every socket registration would cost far more than a bounded,");
  log("   self-healing gap. Accept the window; let the recovery path close it.");
}

// ════════════════════════════════════════════════════════════════════════════
// D) CONTINUOUS CONNECTION ROTATION — keep the recovery path warm
// ════════════════════════════════════════════════════════════════════════════
function rotationDemo(): void {
  log("");
  log("═══ D) CONTINUOUS ROTATION: the recovery path is always warm ═══");
  const ROTATE_PCT = 0.01; // 1% of the fleet
  const ROTATE_EVERY = 5; // …recycled every 5 ticks, in steady state
  const perTick = Math.round((N * ROTATE_PCT) / ROTATE_EVERY);

  const rng = mulberry32(SEED ^ 0x2222);
  const window = new Array(20).fill(0);
  // spread each rotation batch with jitter, exactly like a mini-drain
  for (let batch = 0; batch < 4; batch++) {
    const start = batch * ROTATE_EVERY;
    for (let c = 0; c < Math.round(N * ROTATE_PCT); c++) {
      window[start + Math.floor(rng() * ROTATE_EVERY)]++;
    }
  }
  log(`   force ${(ROTATE_PCT * 100).toFixed(0)}% of ${N.toLocaleString()} sockets to reconnect every ${ROTATE_EVERY} ticks (jittered):`);
  renderCurve(window, SURVIVOR_ACCEPT);
  log(`   steady-state baseline ≈ ${perTick.toLocaleString()}/tick. A full rolling deploy's plateau`);
  log("   (≈ B) is only a little louder than this — the reconnect, auth, registry and");
  log("   cursor-resync paths run continuously, so a deploy exercises battle-tested code.");
  log("   You never want your disaster-recovery path to be the code that only runs");
  log("   during disasters.");
}

function main(): void {
  const naive = naiveDeployDemo();
  const drained = drainedDeployDemo();
  jitterDemo();
  headroomDemo();
  cursorResumeDemo();
  deadNodeWindowDemo();
  rotationDemo();

  log("");
  log("═══ NAIVE vs DRAINED ═══");
  log(`   naive peak : ${peakOf(naive).toLocaleString()}/tick  (${(peakOf(naive) / FLEET_ACCEPT).toFixed(1)}× over capacity 💥)`);
  log(`   drained peak: ${peakOf(drained).toLocaleString()}/tick  (${((peakOf(drained) / SURVIVOR_ACCEPT) * 100).toFixed(1)}% of capacity ✓)`);
  log("");
  log("You deploy to millions of live sockets by draining SLOWLY over a long window");
  log("(rolling, a few % at a time), telling clients to reconnect with JITTERED backoff");
  log("(jitter defeats the thundering herd), sizing survivors with capacity HEADROOM,");
  log("and resuming from a CURSOR so reconnects are cheap — plus continuous low-rate");
  log("rotation so the recovery path is always warm. Design for the recovery storm,");
  log("not the steady state.");
  process.exit(0);
}

main();
