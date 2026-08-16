/**
 * Phase 8 — GROUP FAN-OUT: where do you pay the cost? Run: npm run phase8
 *
 * A 1:1 chat is easy — one send, one recipient. A GROUP changes the math: one
 * send has to reach N members. The defining group-scaling decision is WHERE you
 * pay that fan-out cost — at write time, or at read time.
 *
 *   FAN-OUT-ON-WRITE (push / copy-to-inbox): when a message is sent, write a
 *   COPY into each recipient's inbox. Reads are trivial — you just read your own
 *   pre-materialized inbox, O(1). But the WRITE amplifies by the group size:
 *   one send = N inbox writes. Great for small groups, lethal for huge ones.
 *
 *   FAN-OUT-ON-READ (pull / shared log): store the message ONCE in a shared
 *   conversation log (the same log + cursor idea from phase 6). Writes are cheap
 *   — always one write, no matter the group size. Each member's read queries the
 *   shared log from their cursor. The read does the work now, not the write.
 *
 * The catch that makes this a HYBRID, not a religion:
 *
 *   A) SMALL GROUP  → fan-out-on-write. 5 members, one send = 5 inbox writes.
 *      Cheap, and reads are instant. This is the default below the threshold.
 *
 *   B) HUGE GROUP on fan-out-on-write → the WRITE-AMPLIFICATION CATASTROPHE.
 *      100k members, one message = 100k inbox writes. At 30 msgs/min that's
 *      3,000,000 inbox writes/min ≈ 50,000 writes/sec for ONE group. Untenable.
 *
 *   C) HUGE GROUP  → fan-out-on-read. Store once in the shared log (1 write),
 *      and fan out the LIVE push only to the members who are CURRENTLY ONLINE
 *      (the presence registry tells you who). 100k members but only ~800 online
 *      → 800 real-time pushes, not 100k. The offline majority never gets a copy;
 *      they sync from the log via fetch-since on reconnect (phase 6).
 *
 *   D) THE THRESHOLD. Plot write-on-write cost vs write-on-read cost against
 *      group size and there's a crossover around a few hundred members. Below
 *      it: materialize per-inbox for fast reads. Above it: shared log + per-member
 *      cursor + live-push-only-to-online.
 *
 * We run all four and print the cost table with the crossover marked.
 *
 * TAKEAWAY: group fan-out is a THRESHOLD HYBRID. The write-amplification of
 * fan-out-on-write crosses the read-query cost of fan-out-on-read at ~a few
 * hundred members. Below that, materialize per-inbox for fast reads; above it,
 * store once in a shared log with per-member cursors and fan out the LIVE push
 * only to currently-online members — the offline majority syncs from the log.
 * Never write a million inbox rows for one broadcast message.
 */

import { log } from "../lib/log.ts";

// Deterministic PRNG so "who is online" is reproducible run to run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── FAN-OUT-ON-WRITE: a copy in every recipient's inbox ────────────────────
class InboxStore {
  private inboxes = new Map<string, string[]>();
  private writes = 0;

  /** One send → one write PER member. This is the amplification. */
  fanOutOnWrite(members: string[], text: string): number {
    for (const m of members) {
      const box = this.inboxes.get(m) ?? [];
      box.push(text);
      this.inboxes.set(m, box);
      this.writes++;
    }
    return members.length; // writes performed for this one send
  }

  read(member: string): string[] {
    return this.inboxes.get(member) ?? []; // O(1) — already materialized
  }

  totalWrites(): number {
    return this.writes;
  }
}

// ─── FAN-OUT-ON-READ: one shared log, per-member cursors, phase-6 style ──────
class SharedLog {
  private messages: { id: number; text: string }[] = [];

  /** One send → exactly ONE write, regardless of group size. */
  append(text: string): number {
    const id = this.messages.length + 1;
    this.messages.push({ id, text });
    return id;
  }

  /** A member's read: fetch-since their cursor (the read does the work). */
  since(cursor: number): { id: number; text: string }[] {
    return this.messages.filter((m) => m.id > cursor);
  }
}

function smallGroupDemo() {
  log("═══ A) SMALL GROUP (5 members) → FAN-OUT-ON-WRITE ═══");
  const members = ["alice", "bob", "carol", "dave", "erin"];
  const inbox = new InboxStore();

  const writes = inbox.fanOutOnWrite(members, "lunch at 1?");
  log(`   one send to ${members.length} members → ${writes} inbox writes (copy in each inbox):`);
  members.forEach((m) => log(`      ${m}'s inbox: ${JSON.stringify(inbox.read(m))}`));
  log("   reads are O(1) — each member just reads their own pre-materialized inbox.");
  log("   below the threshold this is the right call: cheap writes, instant reads.");
}

function hugeWriteCatastropheDemo() {
  log("");
  log("═══ B) HUGE GROUP (100,000 members) on FAN-OUT-ON-WRITE → CATASTROPHE ═══");
  const groupSize = 100_000;
  const inbox = new InboxStore();

  const writes = inbox.fanOutOnWrite(
    Array.from({ length: groupSize }, (_, i) => `u${i}`),
    "🎉 the celebrity posted",
  );
  const msgsPerMin = 30;
  const writesPerMin = writes * msgsPerMin;
  const writesPerSec = Math.round(writesPerMin / 60);
  log(`   one message → ${writes.toLocaleString()} inbox writes (one per member).`);
  log(`   at ${msgsPerMin} msgs/min: ${writes.toLocaleString()} × ${msgsPerMin} = ${writesPerMin.toLocaleString()} writes/min`);
  log(`   ≈ ${writesPerSec.toLocaleString()} writes/sec for ONE group. 💥 this does not scale.`);
  log("   99% of those writes land in inboxes nobody is reading right now.");
}

function hugeReadDemo() {
  log("");
  log("═══ C) HUGE GROUP (100,000 members) → FAN-OUT-ON-READ ═══");
  const groupSize = 100_000;
  const rng = mulberry32(42);

  // Presence registry: deterministically decide who is online (~0.8%).
  const onlineRate = 0.008;
  let online = 0;
  for (let i = 0; i < groupSize; i++) if (rng() < onlineRate) online++;

  const shared = new SharedLog();
  const id = shared.append("🎉 the celebrity posted");
  log(`   store the message ONCE in the shared log → 1 write (id ${id}).`);
  log(`   presence registry: ${online.toLocaleString()} of ${groupSize.toLocaleString()} members are online.`);
  log(`   fan out the LIVE push only to those ${online.toLocaleString()} → ${online.toLocaleString()} pushes, not ${groupSize.toLocaleString()}.`);
  log(`   the offline ${(groupSize - online).toLocaleString()} get NO copy — they fetch-since from the log on reconnect (phase 6).`);

  // Show one offline member catching up from the shared log at their cursor.
  const cursor = 0;
  const delta = shared.since(cursor);
  log(`   e.g. an offline member reconnects at cursor=${cursor} and pulls ${delta.length} msg from the log: "${delta[0].text}"`);
}

function thresholdTable() {
  log("");
  log("═══ D) THE THRESHOLD — write-amplification vs read-query cost ═══");
  const onlineRate = 0.008; // ~0.8% online at any moment (matches demo C)
  // Fan-out-on-read is NOT free: even though the write is a single log append,
  // the READ path carries a fixed per-message overhead — the shared-log append +
  // index update + waking/coordinating the pub-sub subscribers + cursor bookkeeping.
  // Call it ~a few hundred cost-units, roughly constant in group size. That fixed
  // floor is exactly why tiny groups are CHEAPER on fan-out-on-write: writing N
  // inbox copies beats paying the shared-log coordination overhead. (The real
  // number is infra-specific; it lands around a few hundred in practice.)
  const readBaseCost = 300;

  const sizes = [5, 50, 150, 300, 400, 1_000, 10_000, 100_000];
  log(`   on-READ carries a fixed ~${readBaseCost}-unit shared-log/pub-sub overhead per message,`);
  log("   plus one live push per online member. on-WRITE is N inbox writes, no floor:");
  log("");
  log("     group size │ on-WRITE (inbox writes) │ on-READ (~base coord + online pushes) │ pick");
  log("     ───────────┼─────────────────────────┼───────────────────────────────────────┼──────────");

  let crossover = -1;
  for (const n of sizes) {
    const onWrite = n; // one inbox write per member (write amplification)
    const onlinePushes = Math.max(0, Math.round(n * onlineRate));
    const onRead = readBaseCost + onlinePushes; // fixed coord floor + live pushes
    const pick = onWrite <= onRead ? "on-WRITE" : "on-READ";
    if (crossover === -1 && pick === "on-READ") crossover = n;
    const flag = crossover === n ? "  ← crossover" : "";
    log(
      `     ${String(n).padStart(10)} │ ${String(onWrite).padStart(23)} │ ${String(`${onRead} (${readBaseCost} + ${onlinePushes})`).padStart(37)} │ ${pick}${flag}`,
    );
  }

  // Analytic crossover: N = readBaseCost + onlineRate·N  →  N = base / (1 - rate).
  const analytic = Math.round(readBaseCost / (1 - onlineRate));
  log("");
  log(`   crossover is ~${analytic} members (first on-READ row: ${crossover}) — a few hundred, as the`);
  log("   heuristic promises. Below → fan-out-on-write (materialize inboxes, fast O(1) reads;");
  log("   N writes is cheaper than the shared-log coordination floor). Above → shared log +");
  log("   per-member cursor + live-push-only-to-online: on-WRITE's N keeps climbing without");
  log("   bound while on-READ stays flat at (fixed floor + however few are actually online).");
}

function main() {
  smallGroupDemo();
  hugeWriteCatastropheDemo();
  hugeReadDemo();
  thresholdTable();
  log("");
  log("Group fan-out is a threshold hybrid: pay the fan-out at WRITE time while the");
  log("group is small (fast pre-materialized reads), and flip to paying at READ time");
  log("once it's large — store once in a shared log, keep per-member cursors, and push");
  log("live only to who's online. Never write a million inbox rows for one broadcast.");
  process.exit(0);
}

main();
