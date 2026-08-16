/**
 * Phase 7 — PUSH NOTIFICATIONS: how you reach a recipient who has NO live
 * socket. Run:  node "src/phase7/push-notifications.ts"
 *
 * When the recipient's app is backgrounded or killed, there is no WebSocket to
 * push down. You can't hold the message hostage until they reconnect, so you
 * hand it to the platform's wake-up channel — APNs (iOS) or FCM (Android/Web) —
 * which pokes the device to say "something happened". Four things make this work
 * without lying to the user or melting their battery:
 *
 *   A) THE ONLINE↔PUSH RACE + DEDUP. A message can land the instant the user
 *      backgrounds the app, so the server sprays it BOTH ways — down the socket
 *      AND to the push provider — because it can't be sure which will land. The
 *      device dedups by a per-message id (clientMsgId/serverMsgId): whichever
 *      arrives second is dropped. Effectively-once, from an at-least-once fan-out.
 *
 *   B) PUSH IS A BEST-EFFORT WAKE-UP, NOT DELIVERY. The push payload is a tiny
 *      HINT ("new message"), not the content. "Sent to APNs" is NOT "delivered"
 *      — the real delivery is the INBOX SYNC on app open (a cursor fetch from the
 *      durable store). Treating "handed to APNs" as "delivered" is the §0.4
 *      anti-pattern: the message still sits in the inbox until the app syncs.
 *
 *   C) NOTIFICATION COLLAPSE. A collapse key (apns-collapse-id / FCM
 *      collapse_key) tells the OS "this notification REPLACES that one". So "You
 *      have 5 messages" supersedes "You have 4 messages" — one entry, one buzz,
 *      not five. Essential for both UX and battery.
 *
 *   D) TOKEN PRUNING. When a provider replies 410 Unregistered / NotRegistered
 *      (the app was uninstalled), that token is dead forever. You DELETE it from
 *      the device→token map via provider feedback, or you'll push into the void.
 *
 * (E) Real fan-out services also BATCH low-priority pushes, RATE-LIMIT per device,
 * mark DMs high-priority so they BYPASS batching, and respect iOS's silent/
 * background push BUDGET of ~2–3 per hour. We call those out in the output.
 *
 * TAKEAWAY: push is a best-effort wake-up NUDGE, not delivery — the durable
 * inbox sync on app-open is the real delivery mechanism. You dedup the
 * online↔push race by message id (effectively-once), collapse stale
 * notifications to one buzz, and prune dead tokens on 410. Never treat
 * "sent to APNs" as "delivered".
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Message { id: string; from: string; text: string; seq: number }
interface PushHint { msgId: string; from: string; collapseId: string }
type SendResult = "ok" | "410-unregistered";

/**
 * Server-side DURABLE inbox + sequencer. This is the source of truth: the moment
 * the server accepts a message it lands here, whether or not any push succeeds.
 * App-open sync reads from here — that's the real delivery path.
 */
class Server {
  private inbox = new Map<string, Message[]>();
  private seq = 0;

  append(userId: string, from: string, text: string): Message {
    const msg: Message = { id: `m${++this.seq}`, from, text, seq: this.seq };
    const box = this.inbox.get(userId) ?? [];
    box.push(msg);
    this.inbox.set(userId, box);
    return msg;
  }

  /** Cursor fetch: everything after the device's last-synced position. */
  syncSince(userId: string, cursor: number): Message[] {
    return (this.inbox.get(userId) ?? []).slice(cursor);
  }
}

/**
 * A recipient's device. Holds the live-socket flag, dedups rendered messages by
 * id, and shows at most one collapsed notification banner.
 */
class RecipientDevice {
  deviceId: string;
  owner: string;
  platform: "ios" | "android";
  token: string;
  live: boolean;
  private cursor: number;                 // how far it has synced the inbox
  private rendered = new Set<string>();   // msgIds shown IN the chat (real delivery)
  private notified = new Set<string>();   // msgIds that raised a banner (a nudge only)
  private banner: { key: string; count: number } | null;

  constructor(deviceId: string, owner: string, platform: "ios" | "android", token: string) {
    this.deviceId = deviceId;
    this.owner = owner;
    this.platform = platform;
    this.token = token;
    this.live = false;
    this.cursor = 0;
    this.banner = null;
  }

  /** Full message down the live socket → rendered in the chat immediately. */
  receiveSocket(msg: Message) {
    if (this.rendered.has(msg.id)) {
      log(`   [${this.deviceId}] socket ${msg.id} — already shown, deduped`);
      return;
    }
    this.rendered.add(msg.id);
    log(`   [${this.deviceId}] ✓ rendered via socket: "${msg.text}"`);
  }

  /** A push HINT (no content). Dedups against the chat, collapses stale banners. */
  receivePush(hint: PushHint, provider: string): SendResult {
    if (this.rendered.has(hint.msgId)) {
      log(`   [${this.deviceId}] push ${hint.msgId} via ${provider} — already shown in chat → deduped, no banner`);
      return "ok";
    }
    if (this.notified.has(hint.msgId)) return "ok"; // duplicate push for same msg
    this.notified.add(hint.msgId);

    if (this.banner && this.banner.key === hint.collapseId) {
      this.banner.count++;
      log(`   [${this.deviceId}] 🔔 collapsed → "You have ${this.banner.count} messages" (supersedes previous — one entry, no new buzz)`);
    } else {
      this.banner = { key: hint.collapseId, count: 1 };
      log(`   [${this.deviceId}] 🔔 buzz via ${provider}: "You have 1 message"`);
    }
    return "ok";
  }

  background() {
    this.live = false;
    log(`   [${this.deviceId}] app backgrounded — socket gone`);
  }

  /** App open: THE real delivery. Cursor-fetch the durable inbox, dedup, render. */
  openApp(server: Server) {
    this.live = true;
    const pending = server.syncSince(this.owner, this.cursor);
    this.cursor += pending.length;
    log(`   [${this.deviceId}] app opened → inbox sync from cursor (${pending.length} pending)`);
    for (const msg of pending) {
      if (this.rendered.has(msg.id)) continue;
      this.rendered.add(msg.id);
      log(`   [${this.deviceId}] ✓ DELIVERED via inbox sync: "${msg.text}"`);
    }
    if (this.banner) log(`   [${this.deviceId}] notification cleared (chat is open)`);
    this.banner = null;
    this.notified.clear();
  }
}

/** device → token map, per user. Prunes dead tokens on provider feedback. */
class DeviceRegistry {
  private byUser = new Map<string, RecipientDevice[]>();

  add(device: RecipientDevice) {
    const list = this.byUser.get(device.owner) ?? [];
    list.push(device);
    this.byUser.set(device.owner, list);
  }

  devices(userId: string): RecipientDevice[] {
    return this.byUser.get(userId) ?? [];
  }

  prune(token: string) {
    for (const [user, list] of this.byUser) {
      const kept = list.filter((d) => d.token !== token);
      if (kept.length !== list.length) {
        this.byUser.set(user, kept);
        log(`   registry: pruned dead token ${token} (device unregistered)`);
      }
    }
  }
}

/** Fake APNs/FCM. Routes a token to its device, or returns 410 if uninstalled. */
class PushProvider {
  name: string;
  private routes = new Map<string, RecipientDevice>();
  private dead = new Set<string>();

  constructor(name: string) {
    this.name = name;
  }

  attach(token: string, device: RecipientDevice) {
    this.routes.set(token, device);
  }

  /** Simulate the app being uninstalled: the token is now unregistered forever. */
  uninstall(token: string) {
    this.dead.add(token);
  }

  send(token: string, hint: PushHint): SendResult {
    const device = this.routes.get(token);
    if (this.dead.has(token) || device === undefined) {
      log(`   ${this.name} → ${token}: 410 Unregistered (dead token)`);
      return "410-unregistered";
    }
    return device.receivePush(hint, this.name);
  }
}

/** Notification / fan-out service: durable append first, then socket + push. */
class FanoutService {
  private server: Server;
  private registry: DeviceRegistry;
  private providers: Record<string, PushProvider>;

  constructor(server: Server, registry: DeviceRegistry, ios: PushProvider, android: PushProvider) {
    this.server = server;
    this.registry = registry;
    this.providers = { ios, android };
  }

  /**
   * @param alsoPush belt-and-suspenders: also fire a push even to a "live"
   *        device, because our liveness view races the user backgrounding.
   */
  notify(userId: string, from: string, text: string, collapseId: string, alsoPush = false): Message {
    const msg = this.server.append(userId, from, text); // durable FIRST — real delivery
    for (const device of this.registry.devices(userId)) {
      if (device.live) {
        device.receiveSocket(msg);
        if (!alsoPush) continue;
      }
      const hint: PushHint = { msgId: msg.id, from, collapseId };
      const result = this.providers[device.platform].send(device.token, hint);
      if (result === "410-unregistered") {
        this.registry.prune(device.token);
      } else if (!device.live) {
        log(`   ↳ handed ${msg.id} to ${this.providers[device.platform].name} — this is a WAKE-UP, NOT delivery; ${msg.id} still only lives in the inbox`);
      }
    }
    return msg;
  }
}

async function main() {
  const server = new Server();
  const registry = new DeviceRegistry();
  const apns = new PushProvider("APNs");
  const fcm = new PushProvider("FCM");
  const service = new FanoutService(server, registry, apns, fcm);

  // Alice's current iPhone (the one she uses), registered with APNs.
  const iphone = new RecipientDevice("alice-iphone", "alice", "ios", "tok-apns-live");
  registry.add(iphone);
  apns.attach(iphone.token, iphone);
  const convo = "convo:alice+bob";

  log("═══ A) The online↔push RACE, deduped by message id ═══");
  iphone.live = true; // Alice has the app open
  log("Bob sends while Alice is (just barely) online; server sprays socket + push.");
  service.notify("alice", "bob", "you around?", convo, /* alsoPush */ true);
  await sleep(150);
  log("Same message arrived via socket AND push → the device kept exactly one.");

  log("");
  log("═══ B) 'Sent to APNs' is NOT 'delivered' — inbox sync is ═══");
  iphone.background(); // Alice backgrounds the app → no live socket
  service.notify("alice", "bob", "call me when you can", convo);
  await sleep(150);
  log("APNs said ok, but Alice has NOT received it — it waits in the durable inbox.");
  await sleep(150);
  iphone.openApp(server); // THE real delivery happens here
  log("Only the app-open inbox sync actually delivered it.");

  log("");
  log("═══ C) Notification collapse — 5 pushes, one buzz ═══");
  iphone.background();
  for (const text of ["ping 1", "ping 2", "ping 3", "ping 4", "ping 5"]) {
    service.notify("alice", "bob", text, convo);
    await sleep(60);
  }
  log("Five messages queued, but the collapse key left ONE banner (battery + sanity).");
  await sleep(120);
  iphone.openApp(server); // syncs all five from the inbox, deduped

  log("");
  log("═══ D) Token pruning on 410 Unregistered ═══");
  // Alice's OLD android phone — app uninstalled, but the token still lingers.
  const oldPhone = new RecipientDevice("alice-old-android", "alice", "android", "tok-fcm-dead");
  registry.add(oldPhone);
  fcm.attach(oldPhone.token, oldPhone);
  fcm.uninstall(oldPhone.token); // the app is gone; FCM will now 410
  iphone.background();
  log("Bob sends; fan-out pushes to BOTH of Alice's devices.");
  service.notify("alice", "bob", "still there?", convo);
  await sleep(120);
  log(`Alice now has ${registry.devices("alice").length} live device token(s) — the dead one is gone.`);

  log("");
  log("Also in a real fan-out service: BATCH low-priority pushes, RATE-LIMIT per");
  log("device, mark DMs high-priority so they BYPASS batching, and respect iOS's");
  log("silent/background push BUDGET (~2–3/hour). Push nudges; the inbox delivers.");
  process.exit(0);
}

main();
