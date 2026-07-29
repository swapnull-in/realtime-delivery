/**
 * Phase 6 — OFFLINE SYNC & RECONNECT STORMS. Run with:  npm run phase6
 *
 * A phone goes into a tunnel for 3 days and reconnects. How does it catch up?
 *
 * WRONG (at scale): "replay the user's queue" — keep a durable per-user queue of
 * every undelivered message and push them all on reconnect. Millions of
 * unbounded per-user queues, duplicate delivery, and a huge write amplification.
 *
 * RIGHT: FETCH-SINCE (cursor sync). Messages live in the conversation log with
 * monotonic IDs. The client remembers the last ID it has. On reconnect it asks
 * "give me everything after cursor N", and the server returns just that delta
 * from the log it already stores. No per-user queues; reconnect is idempotent
 * (ask twice, same answer); works the same for a 3-second or 3-day gap.
 *
 * Second problem: when a gateway dies, ALL its clients reconnect at once — a
 * thundering herd that knocks over the replacement gateway. Fix: reconnect with
 * randomized (JITTERED) backoff so the herd spreads over time.
 *
 * We show a cursor-based catch-up, then naive vs jittered reconnect timing.
 */

import { log } from "../lib/log.ts";

// ─── The conversation log (server keeps ONE per conversation) ───────────────
class ConversationLog {
  private messages: { id: number; text: string }[] = [];
  append(text: string) {
    const id = this.messages.length + 1;
    this.messages.push({ id, text });
    return id;
  }
  /** Fetch-since: everything strictly after the client's cursor. */
  since(cursor: number) {
    return this.messages.filter((m) => m.id > cursor);
  }
}

function offlineSyncDemo() {
  const log_ = new ConversationLog();
  ["welcome!", "meeting at 3", "…still there?"].forEach((t) => log_.append(t)); // seen before offline

  let clientCursor = 3; // client last saw message id 3

  log("═══ Fetch-since catch-up ═══");
  log(`   client was last synced at cursor=${clientCursor}`);
  log("   while offline, 3 more messages arrive on the server:");
  ["sam joined", "here's the doc", "ping me when back"].forEach((t) => log(`      + "${t}" (id ${log_.append(t)})`));

  log("   client reconnects and asks: 'give me everything after cursor 3'");
  const delta = log_.since(clientCursor);
  delta.forEach((m) => { log(`      ⇢ synced id ${m.id}: "${m.text}"`); clientCursor = m.id; });
  log(`   client cursor is now ${clientCursor}. Asking again returns ${log_.since(clientCursor).length} messages (idempotent).`);
}

function reconnectStormDemo() {
  log("");
  log("═══ Reconnect storm: 10,000 clients when a gateway dies ═══");

  // Naive: everyone reconnects immediately at t=0.
  log("   NAIVE: all 10,000 reconnect at t=0 → the new gateway gets 10,000 hits");
  log("          in the same instant 💥 (it dies too → cascading failure)");

  // Jittered: each client waits base + random. Show the spread over 1s buckets.
  const base = 0;
  const maxJitterMs = 5000;
  const buckets = new Array(5).fill(0); // 5 one-second buckets
  for (let i = 0; i < 10_000; i++) {
    const delay = base + Math.floor(Math.random() * maxJitterMs);
    buckets[Math.floor(delay / 1000)]++;
  }
  log("   JITTERED (0–5s random backoff): reconnects spread across time:");
  buckets.forEach((count, s) => log(`      ${s}–${s + 1}s: ${"█".repeat(Math.round(count / 200))} ${count}`));
  log("   ✓ peak load per second is ~1/5 of the herd — the gateway survives.");
}

function main() {
  offlineSyncDemo();
  reconnectStormDemo();
  log("");
  log("Fetch-since + jittered reconnect are the two things that make 'everyone was");
  log("offline and came back' a non-event instead of an outage.");
  process.exit(0);
}

main();
