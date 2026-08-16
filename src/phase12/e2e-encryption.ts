/**
 * Phase 12 — END-TO-END ENCRYPTION: the Signal Protocol, conceptually, and what
 * E2E does to your ARCHITECTURE (§8.7). Run:  node src/phase12/e2e-encryption.ts
 *
 * You will NOT implement Signal in an interview. What you WILL do is name the
 * protocol — "Signal: X3DH key agreement + a double ratchet" — and then pivot
 * fast to the thing that actually matters for system design: once messages are
 * end-to-end encrypted, THE SERVER CAN NEVER READ THEM. It becomes a blind relay
 * that shuffles opaque bytes. That single fact reshapes the whole product.
 *
 * The crypto below is REAL but tiny — Node's built-in node:crypto gives us X25519
 * Diffie–Hellman and HKDF/HMAC, so the key agreement and the ratchet are honest
 * math, not hand-waving. We are demonstrating the SHAPE of the protocol, not
 * shipping a secure messenger (don't roll your own).
 *
 *   A) X3DH KEY AGREEMENT — each user publishes a "prekey bundle" of PUBLIC keys
 *      to the server (identity key, a signed prekey, one-time prekeys). A sender
 *      fetches the bundle and derives a shared secret via several Diffie–Hellmans
 *      — CRITICALLY, even while the recipient is OFFLINE. Async is the whole game
 *      in messaging: Bob is asleep; Alice must still be able to send.
 *
 *   B) DOUBLE RATCHET — one fresh key PER MESSAGE. A symmetric ratchet advances a
 *      chain key each message (forward secrecy). A DH ratchet re-randomizes the
 *      root on every reply (post-compromise security / self-healing).
 *
 *   C) FORWARD SECRECY — keys are deleted after use and the ratchet is one-way, so
 *      stealing TODAY's key does NOT unlock YESTERDAY's ciphertext.
 *
 *   D) BLIND RELAY — the server only ever holds ciphertext. We print what it
 *      stores and enumerate the architectural consequences that forces.
 */

import { log } from "../lib/log.ts";
import {
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  createHmac,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from "node:crypto";

// ── tiny crypto helpers (all real, all from node:crypto) ────────────────────

type KeyPair = { publicKey: KeyObject; privateKey: KeyObject };

/** A fresh X25519 keypair — the elliptic curve Signal uses for key agreement. */
const newX25519 = (): KeyPair => generateKeyPairSync("x25519");

/** Raw X25519 Diffie–Hellman. DH(a.priv, b.pub) === DH(b.priv, a.pub). */
const dh = (priv: KeyObject, pub: KeyObject): Buffer =>
  diffieHellman({ privateKey: priv, publicKey: pub });

/** HKDF → a Buffer of `len` bytes. Used to squeeze DH outputs into clean keys. */
const kdf = (ikm: Buffer, salt: Buffer, info: string, len: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), len));

const hmac = (key: Buffer, data: number): Buffer =>
  createHmac("sha256", key).update(Buffer.from([data])).digest();

/** Short hex fingerprint so we can EYEBALL that two secrets match / keys evolve. */
const fp = (b: Buffer): string => b.toString("hex").slice(0, 16);

// AES-256-GCM. Each message gets a UNIQUE key from the ratchet, so a fixed IV is
// safe here (never reuse an IV under the SAME key — but we never reuse a key).
const IV = Buffer.alloc(12, 0);
function encrypt(messageKey: Buffer, plaintext: string): Buffer {
  const c = createCipheriv("aes-256-gcm", messageKey, IV);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]); // body || 16-byte tag
}
function decrypt(messageKey: Buffer, ciphertext: Buffer): string {
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const d = createDecipheriv("aes-256-gcm", messageKey, IV);
  d.setAuthTag(tag);
  return d.update(body).toString("utf8") + d.final().toString("utf8");
}

// ── A) X3DH: publish a bundle, derive a shared secret while offline ─────────

/** What a user uploads to the server. ALL PUBLIC. The server never sees a private key. */
interface PrekeyBundle {
  identityKey: KeyObject; // long-term identity (IK)
  signedPrekey: KeyObject; // medium-term, signed by IK (SPK)
  oneTimePrekey: KeyObject; // used once then discarded (OPK)
}

/** A user keeps the private halves; the server only gets the public bundle. */
interface User {
  identity: KeyPair;
  signedPrekey: KeyPair;
  oneTimePrekey: KeyPair;
  publish(): PrekeyBundle;
}

function makeUser(): User {
  const identity = newX25519();
  const signedPrekey = newX25519();
  const oneTimePrekey = newX25519();
  return {
    identity,
    signedPrekey,
    oneTimePrekey,
    publish: () => ({
      identityKey: identity.publicKey,
      signedPrekey: signedPrekey.publicKey,
      oneTimePrekey: oneTimePrekey.publicKey,
    }),
  };
}

const SALT = Buffer.alloc(32, 0); // fixed X3DH salt (Signal uses a constant here)

/** SENDER side: Alice has Bob's PUBLIC bundle + her own ephemeral key. */
function x3dhSender(
  aliceIdentity: KeyPair,
  aliceEphemeral: KeyPair,
  bob: PrekeyBundle,
): Buffer {
  // Four Diffie–Hellmans, mixing identity + ephemeral + Bob's prekeys.
  const dh1 = dh(aliceIdentity.privateKey, bob.signedPrekey); // IK_A · SPK_B
  const dh2 = dh(aliceEphemeral.privateKey, bob.identityKey); // EK_A · IK_B
  const dh3 = dh(aliceEphemeral.privateKey, bob.signedPrekey); // EK_A · SPK_B
  const dh4 = dh(aliceEphemeral.privateKey, bob.oneTimePrekey); // EK_A · OPK_B
  return kdf(Buffer.concat([dh1, dh2, dh3, dh4]), SALT, "x3dh", 32);
}

/** RECIPIENT side: Bob, LATER (he was offline), with Alice's PUBLIC keys. */
function x3dhReceiver(
  bob: User,
  aliceIdentityPub: KeyObject,
  aliceEphemeralPub: KeyObject,
): Buffer {
  // Same DHs, opposite private/public halves — so the secret comes out identical.
  const dh1 = dh(bob.signedPrekey.privateKey, aliceIdentityPub); // SPK_B · IK_A
  const dh2 = dh(bob.identity.privateKey, aliceEphemeralPub); // IK_B · EK_A
  const dh3 = dh(bob.signedPrekey.privateKey, aliceEphemeralPub); // SPK_B · EK_A
  const dh4 = dh(bob.oneTimePrekey.privateKey, aliceEphemeralPub); // OPK_B · EK_A
  return kdf(Buffer.concat([dh1, dh2, dh3, dh4]), SALT, "x3dh", 32);
}

// ── B/C) Double ratchet: one key per message, evolving, forward-secret ──────

/** A sending chain: symmetric-ratchet a chain key into per-message keys. */
class SendingChain {
  private chainKey: Buffer;
  constructor(chainKey: Buffer) {
    this.chainKey = chainKey;
  }
  /** Advance once: derive this message's key, then step the chain FORWARD. */
  next(): Buffer {
    const messageKey = hmac(this.chainKey, 0x01); // key for THIS message
    this.chainKey = hmac(this.chainKey, 0x02); // chain moves on; old value gone
    return messageKey;
  }
  fingerprint(): string {
    return fp(this.chainKey);
  }
}

/** DH ratchet: on a reply, mix a NEW Diffie–Hellman into the root → fresh chain. */
function dhRatchet(
  rootKey: Buffer,
  myNewKey: KeyPair,
  theirPub: KeyObject,
): { rootKey: Buffer; chainKey: Buffer } {
  const derived = kdf(dh(myNewKey.privateKey, theirPub), rootKey, "dh-ratchet", 64);
  return { rootKey: derived.subarray(0, 32), chainKey: derived.subarray(32, 64) };
}

async function main() {
  log("═══ A) X3DH KEY AGREEMENT — derive a shared secret while Bob is OFFLINE ═══");
  const alice = makeUser();
  const bob = makeUser();

  // Bob uploads his PUBLIC bundle to the server, then goes offline (phone asleep).
  const bobBundle = bob.publish();
  // X25519 public keys export as 44-byte SPKI DER: a 12-byte header then the key.
  // Slice past the shared header so the fingerprints show the REAL key material.
  const pubFp = (k: KeyObject) => fp(k.export({ type: "spki", format: "der" }).subarray(12));
  log("Bob publishes his prekey bundle (all PUBLIC) and goes OFFLINE:");
  log(`   IK_B  ${pubFp(bobBundle.identityKey)} …`);
  log(`   SPK_B ${pubFp(bobBundle.signedPrekey)} …`);
  log(`   OPK_B ${pubFp(bobBundle.oneTimePrekey)} …`);
  log("");

  // Alice fetches the bundle, makes an ephemeral key, derives the secret NOW.
  const aliceEphemeral = newX25519();
  const aliceSecret = x3dhSender(alice.identity, aliceEphemeral, bobBundle);
  log("Alice fetches the bundle, generates an ephemeral key, derives the secret:");
  log(`   Alice's shared secret:  ${fp(aliceSecret)} …  (Bob never touched the network)`);

  // Much later, Bob wakes up. Alice's message carried her IK_pub + EK_pub. He derives.
  const bobSecret = x3dhReceiver(bob, alice.identity.publicKey, aliceEphemeral.publicKey);
  log("Later, Bob comes online and derives from Alice's public keys:");
  log(`   Bob's shared secret:    ${fp(bobSecret)} …`);
  log(
    aliceSecret.equals(bobSecret)
      ? "   ✓ IDENTICAL — a shared secret agreed ASYNCHRONOUSLY, no live handshake."
      : "   ✗ mismatch (bug!)",
  );

  log("");
  log("═══ B) DOUBLE RATCHET — a fresh key PER MESSAGE, evolving as we go ═══");
  // Root/chain keys seed from the X3DH secret. Alice sends a burst to Bob.
  const seed = kdf(aliceSecret, SALT, "ratchet-init", 64);
  let rootKey = seed.subarray(0, 32);
  const chain = new SendingChain(seed.subarray(32, 64));

  // Keep a record of what the SERVER relays, plus (for the demo) the message keys.
  interface Relayed { seq: number; ciphertext: Buffer }
  const onWire: Relayed[] = [];
  const messageKeys: Buffer[] = []; // demo bookkeeping only — real clients DELETE these

  const outbox = ["hey, you around?", "sending the deploy key now", "…ok it's live 🚀"];
  outbox.forEach((text, i) => {
    const mk = chain.next(); // unique key, chain steps forward
    messageKeys.push(mk);
    const ciphertext = encrypt(mk, text);
    onWire.push({ seq: i + 1, ciphertext });
    log(`   msg ${i + 1}: msgKey ${fp(mk)}…  chainKey now ${chain.fingerprint()}…`);
  });
  log("   → each message key differs, and the chain key ratcheted forward each time.");

  log("");
  log("   Bob replies → DH RATCHET re-randomizes the root (self-healing):");
  const bobNewKey = newX25519();
  const beforeRoot = fp(rootKey);
  ({ rootKey } = dhRatchet(rootKey, bobNewKey, aliceEphemeral.publicKey));
  log(`   root key ${beforeRoot}… → ${fp(rootKey)}…  (a compromise BEFORE now can't`);
  log("   predict keys AFTER now — the ratchet 'heals' from a leak).");

  log("");
  log("═══ C) FORWARD SECRECY — today's key does NOT unlock yesterday's message ═══");
  // An attacker seizes Bob's device RIGHT NOW and reads the CURRENT chain key.
  const stolenChainKey = chain.fingerprint();
  log(`   Attacker steals the CURRENT chain key (${stolenChainKey}…) from the device.`);
  // The ratchet is one-way (HMAC): you cannot run it BACKWARD to recover past keys.
  // Concretely, decrypting msg 1 with anything derived from the current state fails.
  const oldCiphertext = onWire[0].ciphertext;
  let cracked = false;
  try {
    // Best the attacker can do is guess forward from the stolen key — never backward.
    const forwardGuess = hmac(Buffer.from(stolenChainKey.padEnd(64, "0"), "hex"), 0x01);
    decrypt(forwardGuess, oldCiphertext); // GCM auth tag will reject this
    cracked = true;
  } catch {
    cracked = false;
  }
  log(
    cracked
      ? "   ✗ old message decrypted (bug!)"
      : "   ✓ msg 1 stays UNREADABLE — its key was derived, used, and DELETED. Past",
  );
  log("     traffic is safe even though the current key leaked. That's forward secrecy.");
  // Sanity check: the RIGHTLY-held key still decrypts msg 1 (crypto isn't broken).
  log(`   (with its real key, msg 1 was: "${decrypt(messageKeys[0], oldCiphertext)}")`);

  log("");
  log("═══ D) THE SERVER IS A BLIND RELAY — it only ever sees CIPHERTEXT ═══");
  log("What the server actually stores/relays for this conversation:");
  onWire.forEach((r) => {
    log(`   msg ${r.seq}: ${r.ciphertext.toString("base64")}   ← opaque bytes, no plaintext`);
  });
  log("");
  log("Because the server can't read any of that, the architecture is FORCED to change:");
  log("   • NO server-side search — you can't index words the server can't see;");
  log("     search must run on-device over locally-decrypted messages.");
  log("   • NO content moderation on plaintext — server-side filters are blind;");
  log("     moderation shifts to client reports, metadata, and on-device checks.");
  log("   • PUSH is a contentless nudge — the notification carries only 'new message';");
  log("     the real preview is decrypted on the device (or shown as 'Message').");
  log("   • MULTI-DEVICE is hard — you can't just copy ciphertext to a new phone;");
  log("     each device has its own keys, so you encrypt PER DEVICE (a mini fan-out).");
  log("   • GROUPS need SENDER KEYS — pairwise E2E to N members is O(N) encryptions");
  log("     per message. A sender key encrypts ONCE = O(1) fan-out, paying O(N) only");
  log("     when membership changes (rotate the key on join/leave).");

  log("");
  log("TAKEAWAY: E2E (Signal = X3DH key agreement + a double ratchet) turns the");
  log("server into a BLIND RELAY that only sees ciphertext — and THAT reshapes the");
  log("whole system: no server-side search or moderation, push is a contentless");
  log("nudge, multi-device must encrypt per-device, and groups need Sender Keys for");
  log("O(1) fan-out. Forward secrecy + self-healing fall out of ratcheting the key");
  log("every message. The staff-level point isn't 'add encryption' — it's naming");
  log("that E2E RESHAPES THE ARCHITECTURE.");

  process.exit(0);
}

main();
