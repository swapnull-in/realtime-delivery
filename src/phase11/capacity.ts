/**
 * Phase 11 — C10K → C10M: HOLDING MILLIONS OF CONNECTIONS. Run: npm run phase11
 *
 * A realtime chat server's hard limit is not "requests/sec" — most connections
 * sit IDLE, doing nothing but existing. The scarce resource is MEMORY: every
 * open WebSocket costs kernel socket buffers + app state whether or not a byte
 * ever flows. So capacity planning is an arithmetic exercise in RAM, and — the
 * part juniors miss — you plan it for the FAILURE case, not the steady state.
 *
 *   A) THE C10K PROBLEM (Dan Kegel, 1999). The old model gave every connection
 *      its OWN THREAD blocked on read(). A thread carries a ~1MB stack, so 10k
 *      threads = ~10 GB of stack before a single message is processed, plus the
 *      scheduler thrashing context-switching between them. The fix that made
 *      C10K (then C10M) possible: EVENT-DRIVEN I/O. One thread runs an event
 *      loop (epoll on Linux, kqueue on BSD/macOS) that multiplexes thousands of
 *      sockets, waking only for the few that are readable. Memory stays flat at
 *      a few tens of KB of app state per connection. Thread-per-conn is dead.
 *
 *   B) MEMORY-BOUND CAPACITY (BOTEC — DERIVE it, never quote a number). Given a
 *      node's RAM and the per-connection cost, theoretical max = RAM ÷ per-conn.
 *      But you NEVER run at the theoretical max, because RAM must also cover
 *      message-processing CPU/heap, GC headroom, and — see (C) — absorbing a
 *      dead neighbor's connections. So you cap WELL below the ceiling.
 *
 *   C) FAILOVER HEADROOM (the staff distinction). When a node dies its clients
 *      reconnect onto the SURVIVORS — a stampede. If every node ran full, the
 *      first death overloads its neighbors, which then die too: a cascade. So
 *      each node reserves spare capacity to absorb a share of a dead node. You
 *      DERIVE the fleet size from (total conns) and (lean per-node cap), then
 *      add nodes so that losing a few doesn't push survivors past their ceiling.
 *
 *   D) HEARTBEAT COST. Liveness isn't free: a 30s heartbeat on 10M connections
 *      is ~333k ping/pong round-trips EVERY SECOND, pure overhead. That's the
 *      reason to stretch the interval as long as NAT/firewall timeouts allow.
 *
 * Deterministic: a pretend event loop driven by a tick counter; all figures are
 * DERIVED from the constants below. No clocks, no randomness.
 *
 * TAKEAWAY: holding millions of connections is a MEMORY problem, not a CPU one —
 * thread-per-conn is dead (10k threads = GBs of stack), event-driven I/O
 * multiplexes them on one loop. You DERIVE connections/node from RAM ÷ per-conn
 * state, then cap well below the theoretical max to leave headroom for message
 * CPU, GC pauses, and — the staff distinction — FAILOVER ABSORPTION, because a
 * dead node's connections stampede onto the survivors. Plan capacity for the
 * failure case, not the steady state; derive the number, never quote it.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── The knobs. Every printed figure is DERIVED from these ──────────────────
const NODE_RAM_GB = 64; // RAM on one gateway node
const OS_RESERVE_GB = 6; // kernel + runtime + non-connection overhead, off the top
const PER_CONN_KB = 40; // socket buffers + app state for ONE idle WebSocket (~tens of KB)
const THREAD_STACK_MB = 1; // default stack for ONE OS thread (the C10K cost)

const TOTAL_USERS = 6_000_000; // users the product must hold
const CONNS_PER_USER = 1.8; // multi-device: phone + laptop + tablet averages ~1.8
const LEAN_CAP_PER_NODE = 500_000; // conservative per-node cap we CHOOSE to run at
const FAILURE_BUDGET = 3; // nodes we must survive losing simultaneously

const HEARTBEAT_SECONDS = 30; // liveness ping interval

const GB = 1024 * 1024; // in KB
const fmt = (n: number) => n.toLocaleString("en-US");
const bar = (n: number, unit: number) => "█".repeat(Math.max(0, Math.round(n / unit)));

// ─── A) THREAD-PER-CONN vs EVENT-DRIVEN I/O — a pretend event loop ──────────
// Model: thread-per-conn memory = conns × stack; event loop = conns × state + fixed.
function threadPerConnGB(conns: number): number {
  return (conns * THREAD_STACK_MB) / 1024; // MB → GB
}
function eventLoopGB(conns: number): number {
  const LOOP_FIXED_MB = 30; // the single epoll/kqueue loop's own footprint
  return (LOOP_FIXED_MB + (conns * PER_CONN_KB) / 1024) / 1024; // KB/MB → GB
}

function c10kDemo() {
  log("═══ A) THREAD-PER-CONN vs EVENT-DRIVEN I/O (the C10K problem, Kegel 1999) ═══");
  log(`   thread-per-conn: each conn owns a thread ⇒ ~${THREAD_STACK_MB}MB stack apiece`);
  log(`   event loop:      one epoll/kqueue loop multiplexes all ⇒ ~${PER_CONN_KB}KB state apiece`);
  log("");

  // Drive a pretend event loop: tick through growing connection counts.
  const points = [1_000, 10_000, 100_000, 500_000];
  let crossoverAt = 0;
  for (let tick = 0; tick < points.length; tick++) {
    const conns = points[tick];
    const tpc = threadPerConnGB(conns);
    const evl = eventLoopGB(conns);
    if (crossoverAt === 0 && tpc > NODE_RAM_GB) crossoverAt = conns;
    const tpcNote = tpc > NODE_RAM_GB ? `  💥 > ${NODE_RAM_GB}GB node RAM: OOM` : "";
    log(`   tick ${tick} · ${fmt(conns).padStart(9)} conns`);
    log(`      thread-per-conn ${tpc.toFixed(1).padStart(7)} GB ${bar(tpc, 2)}${tpcNote}`);
    log(`      event loop      ${evl.toFixed(2).padStart(7)} GB ${bar(evl, 2)}`);
  }
  // The crossover: how many threads it takes to blow the whole node's RAM.
  const threadsToOom = Math.floor((NODE_RAM_GB * 1024) / THREAD_STACK_MB);
  log("");
  log(`   CROSSOVER: thread-per-conn blows ${NODE_RAM_GB}GB of RAM at just`);
  log(`   ${fmt(threadsToOom)} threads — on stack alone, before ONE message is handled.`);
  log(`   The event loop holds the same ${fmt(threadsToOom)} conns in`);
  log(`   ${eventLoopGB(threadsToOom).toFixed(1)} GB and stays flat. Thread-per-conn is dead.`);
}

// ─── B) MEMORY-BOUND CAPACITY DERIVATION (the BOTEC) ────────────────────────
function capacityDemo(): { theoreticalMax: number } {
  log("");
  log("═══ B) MEMORY-BOUND CAPACITY: derive max conns/node from RAM ÷ per-conn ═══");

  const usableGB = NODE_RAM_GB - OS_RESERVE_GB;
  const usableKB = usableGB * GB;
  const theoreticalMax = Math.floor(usableKB / PER_CONN_KB);

  log(`   node RAM ................. ${String(NODE_RAM_GB).padStart(9)} GB`);
  log(`   − OS/runtime reserve ..... ${String(OS_RESERVE_GB).padStart(9)} GB`);
  log(`   = usable for conns ....... ${String(usableGB).padStart(9)} GB  (${fmt(usableKB)} KB)`);
  log(`   ÷ per-conn state ......... ${String(PER_CONN_KB).padStart(9)} KB`);
  log(`   = THEORETICAL max ........ ${fmt(theoreticalMax).padStart(9)} conns/node`);
  log("");
  log(`   But you DON'T run at ${fmt(theoreticalMax)}. That ceiling assumes conns are`);
  log("   the ONLY thing using RAM. Real nodes also need headroom for:");
  log("      • message-processing CPU/heap (idle conns wake up and DO things)");
  log("      • GC pauses (a full heap ⇒ long stop-the-world ⇒ missed heartbeats)");
  log("      • FAILOVER absorption — a dead neighbor's conns stampede here (see C)");
  log(`   ⇒ we CHOOSE a lean cap of ${fmt(LEAN_CAP_PER_NODE)}/node`);
  log(`     (${((LEAN_CAP_PER_NODE / theoreticalMax) * 100).toFixed(0)}% of theoretical — the rest IS the headroom).`);
  return { theoreticalMax };
}

// ─── C) FAILOVER HEADROOM — derive the fleet size for the failure case ──────
function failoverDemo(theoreticalMax: number) {
  log("");
  log("═══ C) FAILOVER HEADROOM: size the fleet for the FAILURE case (staff move) ═══");

  // Multi-device pushes the connection count above the user count.
  const totalConns = Math.ceil(TOTAL_USERS * CONNS_PER_USER);
  log(`   ${fmt(TOTAL_USERS)} users × ${CONNS_PER_USER} conns/user (multi-device)`);
  log(`   = ${fmt(totalConns)} concurrent connections to hold`);
  log("");

  // Step 1: lean node count if nothing ever failed.
  const leanNodes = Math.ceil(totalConns / LEAN_CAP_PER_NODE);
  log(`   step 1 — lean fit (no failures):`);
  log(`      ${fmt(totalConns)} ÷ ${fmt(LEAN_CAP_PER_NODE)}/node = ${leanNodes} nodes`);

  // Step 2: reserve enough spare that losing FAILURE_BUDGET nodes doesn't push
  // survivors past their lean cap. The dead nodes' conns must fit on the rest.
  //   need: (leanNodes+extra − budget) × cap ≥ totalConns  and survivors ≤ cap.
  // Solve for the total node count N such that (N − budget) × cap ≥ totalConns.
  const nodesForFailure = Math.ceil(totalConns / LEAN_CAP_PER_NODE) + FAILURE_BUDGET;
  const survivorsAfterLoss = nodesForFailure - FAILURE_BUDGET;
  const loadPerSurvivor = Math.ceil(totalConns / survivorsAfterLoss);
  log("");
  log(`   step 2 — survive losing ${FAILURE_BUDGET} nodes at once:`);
  log(`      provision ${leanNodes} + ${FAILURE_BUDGET} spare = ${nodesForFailure} nodes`);
  log(`      lose ${FAILURE_BUDGET} ⇒ ${survivorsAfterLoss} survivors must hold ${fmt(totalConns)}`);
  log(`      = ${fmt(loadPerSurvivor)}/survivor  (cap ${fmt(LEAN_CAP_PER_NODE)}: ${loadPerSurvivor <= LEAN_CAP_PER_NODE ? "✓ fits" : "✗ OVERLOADED"})`);

  // Step 3: sanity — even the stampede stays far under the theoretical ceiling.
  const headroomPct = ((1 - loadPerSurvivor / theoreticalMax) * 100).toFixed(0);
  log("");
  log(`   step 3 — sanity vs the RAM ceiling:`);
  log(`      worst-case ${fmt(loadPerSurvivor)}/survivor is still ${headroomPct}% under the`);
  log(`      ${fmt(theoreticalMax)} theoretical max — the stampede has somewhere to land.`);
  log("");
  log(`   ⇒ FLEET: ${nodesForFailure} nodes. Derived from memory + failover, not guessed.`);
  return { totalConns };
}

// ─── D) HEARTBEAT COST — liveness traffic scales with the whole fleet ───────
function heartbeatDemo(totalConns: number) {
  log("");
  log("═══ D) HEARTBEAT COST: liveness is a constant background tax ═══");
  const pingsPerSec = Math.round(totalConns / HEARTBEAT_SECONDS);
  log(`   ${fmt(totalConns)} conns with a ${HEARTBEAT_SECONDS}s heartbeat`);
  log(`   = ${fmt(totalConns)} ÷ ${HEARTBEAT_SECONDS}s = ${fmt(pingsPerSec)} ping/pong round-trips/sec`);
  log("   of PURE liveness traffic — no user ever sees a byte of it.");
  log(`   That's why you stretch the interval as long as NAT/firewall timeouts allow:`);
  log(`   doubling ${HEARTBEAT_SECONDS}s → ${HEARTBEAT_SECONDS * 2}s HALVES it to ${fmt(Math.round(totalConns / (HEARTBEAT_SECONDS * 2)))}/sec.`);
}

async function main() {
  c10kDemo();
  await sleep(0);
  const { theoreticalMax } = capacityDemo();
  const { totalConns } = failoverDemo(theoreticalMax);
  heartbeatDemo(totalConns);

  log("");
  log("TAKEAWAY: holding millions of connections is a MEMORY problem, not a CPU one.");
  log("Thread-per-conn is dead (10k threads = GBs of stack); event-driven I/O");
  log("multiplexes them on ONE loop. DERIVE conns/node from RAM ÷ per-conn state, then");
  log("cap well below the theoretical max to leave headroom for message CPU, GC pauses,");
  log("and — the staff distinction — FAILOVER ABSORPTION, because a dead node's conns");
  log("stampede onto survivors. Plan for the failure case, not the steady state;");
  log("derive the number, never quote it.");
  process.exit(0);
}

main();
