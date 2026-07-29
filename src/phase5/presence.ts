/**
 * Phase 5 — PRESENCE: the hidden fan-out monster. Run with:  npm run phase5
 *
 * "Online / last seen / typing…" looks trivial and is the thing that melts
 * realtime systems. Two reasons:
 *
 *   1. HEARTBEATS: presence is derived, not declared. The client sends a
 *      heartbeat every ~30s; miss ~2–3 in a row and you're "offline". So 10M
 *      users = 10M/30s ≈ 333k heartbeats/sec just to know who's online.
 *
 *   2. FAN-OUT: every status flip notifies everyone WATCHING that user (their
 *      contacts). One user with 500 watchers going offline = 500 pushes. Now
 *      picture a flaky mobile network flipping online/offline 5×/minute:
 *      the "monster" is fan-out × flap-rate × watchers.
 *
 * The fix is FLAP DAMPING: debounce status changes (don't believe an offline
 * until it's stable for a few seconds) and BATCH the fan-out. A user who
 * flaps 4 times but ends where they started should cost ZERO notifications.
 *
 * We compare naive fan-out to debounced fan-out on a flapping user.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WATCHERS = 500; // contacts who see this user's presence

// ─── NAIVE: notify all watchers on every single flip ───────────────────────
function naive(flips: string[]): number {
  let notifications = 0;
  let state = "offline";
  for (const next of flips) {
    if (next !== state) {
      state = next;
      notifications += WATCHERS; // fan out immediately, every time
    }
  }
  return notifications;
}

// ─── DEBOUNCED: only fan out a change that STAYS stable ────────────────────
async function debounced(flips: Array<{ at: number; state: string }>, debounceMs: number): Promise<number> {
  let notifications = 0;
  let committed = "offline"; // what watchers currently believe
  let pending: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (state: string) => {
    pending = state;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending !== committed) {
        committed = pending!;
        notifications += WATCHERS; // fan out ONCE, after it settles
        log(`      → settled to "${committed}", fanned out to ${WATCHERS} watchers`);
      } else {
        log(`      → flapped back to "${committed}", no fan-out needed`);
      }
    }, debounceMs);
  };

  // Apply each flip ~100ms apart, then wait out the debounce window.
  return await new Promise<number>((resolve) => {
    let i = 0;
    const step = () => {
      if (i < flips.length) { schedule(flips[i].state); i++; setTimeout(step, 100); }
      else setTimeout(() => resolve(notifications), debounceMs + 50);
    };
    step();
  });
}

async function main() {
  // A user on a flaky network: online, drop, online, drop... ends ONLINE.
  const flipStates = ["online", "offline", "online", "offline", "online"];

  log(`═══ A user with ${WATCHERS} watchers flaps ${flipStates.length} times, ends online ═══`);
  log("");

  log("NAIVE (fan out on every flip):");
  const naiveCount = naive(flipStates);
  log(`   ${flipStates.length} flips × ${WATCHERS} watchers = ${naiveCount} notifications  💥`);

  log("");
  log("DEBOUNCED (500ms flap damping):");
  const flips = flipStates.map((state, i) => ({ at: i * 100, state }));
  const debouncedCount = await debounced(flips, 500);
  log(`   → total notifications: ${debouncedCount}  ✓`);

  log("");
  log(`Same user activity: ${naiveCount} pushes vs ${debouncedCount}. The net state barely`);
  log("changed, so the damped version barely fans out. At fleet scale this is the");
  log("difference between a working presence system and a self-inflicted DDoS.");
  log("");
  log("Note: presence is also split read-path vs write-path — you often DON'T");
  log("push presence at all; watchers pull it lazily when they open a chat.");
  process.exit(0);
}

main();
