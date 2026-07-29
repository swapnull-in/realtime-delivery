/**
 * Phase 3 — ORDERING: making messages arrive in the right order. Run: npm run phase3
 *
 * Networks reorder things. Two messages sent a millisecond apart can arrive
 * backwards (different routes, retries, multiple gateways). "bob: are you ok?"
 * followed by "bob: nvm" is a very different conversation if it arrives flipped.
 *
 * You CANNOT rely on arrival order. The fix is three parts:
 *
 *   1. ID ASSIGNMENT — the server stamps each message with a monotonically
 *      increasing SEQUENCE number, per conversation. (Not a global counter —
 *      per conversation, so one chat's ordering doesn't bottleneck on another.)
 *
 *   2. PARTITION KEY — all messages for a conversation go through the SAME
 *      ordered path (partition = conversationId). That's what makes the
 *      sequence numbers gap-free and monotonic in the first place.
 *
 *   3. CLIENT REORDER BUFFER — the client tracks "next expected seq". Anything
 *      that arrives early is held; when the gap fills, it flushes in order.
 *
 * We assign sequence numbers, deliberately deliver them out of order, and watch
 * the reorder buffer put them back in sequence.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { seq: number; text: string }

/** Server side: assigns a per-conversation monotonic sequence. */
class ConversationSequencer {
  private counters = new Map<string, number>();
  stamp(conversationId: string, text: string): Msg {
    const next = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, next);
    return { seq: next, text };
  }
}

/** Client side: releases messages strictly in sequence, buffering early arrivals. */
class ReorderBuffer {
  private nextExpected = 1;
  private held = new Map<number, Msg>();

  receive(msg: Msg, emit: (m: Msg) => void) {
    if (msg.seq < this.nextExpected) return; // duplicate/old — drop
    this.held.set(msg.seq, msg);
    if (msg.seq !== this.nextExpected) {
      log(`      (buffered seq ${msg.seq}; still waiting for ${this.nextExpected})`);
    }
    // Flush every contiguous message we now have.
    while (this.held.has(this.nextExpected)) {
      emit(this.held.get(this.nextExpected)!);
      this.held.delete(this.nextExpected);
      this.nextExpected++;
    }
  }
}

async function main() {
  const sequencer = new ConversationSequencer();
  const convo = "alice+bob";

  // Server stamps 5 messages in order.
  const sent = ["hey", "are you ok?", "i heard the news", "call me", "nvm, talked to sam"]
    .map((t) => sequencer.stamp(convo, t));
  log("server assigned sequence numbers:");
  sent.forEach((m) => log(`   seq ${m.seq}: "${m.text}"`));

  // The network delivers them out of order (and with jitter).
  const arrivalOrder = [1, 3, 2, 5, 4].map((s) => sent[s - 1]);
  log("");
  log("network delivers them OUT OF ORDER: " + arrivalOrder.map((m) => m.seq).join(", "));
  log("");

  const buffer = new ReorderBuffer();
  const delivered: string[] = [];
  log("client reorder buffer output:");
  for (const msg of arrivalOrder) {
    log(`   ⇢ arrived seq ${msg.seq}`);
    buffer.receive(msg, (m) => { delivered.push(m.text); log(`      ✓ released to UI: "${m.text}"`); });
    await sleep(150);
  }

  log("");
  log("final order shown to the user:");
  delivered.forEach((t, i) => log(`   ${i + 1}. ${t}`));
  log("");
  log("Perfectly in order despite scrambled arrival. Note: ordering is guaranteed");
  log("PER CONVERSATION (the partition key), not globally — that's the scalability");
  log("trick. A global total order would serialize every chat through one lane.");

  process.exit(0);
}

main();
