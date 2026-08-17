/** Drill data — mined from Core Course/09-realtime-systems.md. Loaded by index.html's Drill panel. */
window.DRILL = {
  module: "Module 09 — Real-Time Systems",
  source: "Core Course/09-realtime-systems.md",
  cheats: [
    "Real-time is a <b>routing problem, not a connection problem</b> — lead with the connection registry + backplane, not 'we use WebSockets'.",
    "<b>Persist before you fan out.</b> The durable log is the source of truth; the live push is a latency optimization. Pub/sub is never the durability layer.",
    "<b>At-least-once delivery + idempotent processing</b> (client-generated <code>clientMsgId</code>) = effectively-exactly-once. Never claim exactly-once on the wire.",
    "<b>Per-conversation ordering</b>, not global: conversation is the partition/serialization key, server assigns a monotonic seqNo. <em>Never trust client clocks.</em>",
    "<b>Store the message once</b> (shared conversation log) + <b>per-user cursors</b> for read/delivery/sync state — one primitive solves offline catch-up, gap-fill, and multi-device sync.",
    "Groups are a <b>threshold hybrid</b>: fan-out-on-write below ~a few hundred members, shared log + cursor above — and live-push only to <em>currently online</em> members.",
    "<b>Presence is fan-out amplification</b> — subscribe-on-view, pull-for-visible, debounce offline 30–60s, aggregate counts for huge groups. Eventually consistent by design.",
    "<b>Push is a wake-up nudge, not delivery</b> — the durable inbox sync on app open is the real delivery mechanism. 'Sent to APNs' is not 'delivered'.",
    "<b>Bound every send buffer and drop slow consumers</b> — node availability beats one degraded client; they re-sync from a cursor anyway.",
    "<b>Design for the recovery storm</b>, not the steady state: jittered backoff, staggered windows, capacity headroom on survivors, cheap cursor-resume, continuous connection rotation.",
    "Transport decision tree: push-dominant feed → <b>SSE</b> (free reconnect + replay); bidirectional low-latency → <b>WebSocket</b>; flaky mobile / IoT → <b>MQTT</b>; any-proxy fallback → <b>long poll</b>; roaming/HOL pain → <b>WebTransport</b>.",
    "<b>Media never touches the message path</b> — pre-signed direct-to-S3 upload, CDN download, message carries only a reference + blurhash thumbnail.",
    "Numbers: idle WS ~30 KB/conn → ~500k–2M per node (memory-bound, cap for failover headroom); heartbeat ~30s, dead after 2–3 missed pongs; MQTT header 2 B vs HTTP's hundreds.",
    "LB stickiness and message routing are <b>two different problems</b>: stickiness keeps a flow on a node; the <b>registry + backplane</b> tells node Y where node X's user lives."
  ],
  cards: [
    {
      topic: "transport",
      q: "WebSocket vs SSE vs long polling — when each, and why?",
      a: "Decide by traffic shape. <b>SSE</b> for server-push-dominant workloads (feeds, notifications, LLM streams) — auto-reconnect and <code>Last-Event-ID</code> replay come free over plain HTTP. <b>WebSocket</b> for genuinely bidirectional low-latency chat, where typing and receipts flow client-to-server constantly. <b>Long polling</b> is the universal fallback when proxies strip the Upgrade header, so ship a negotiation chain: WS → SSE → long poll. Name WS's cost: you trade HTTP statelessness for a stateful tier needing a registry, sticky routing, and draining."
    },
    {
      topic: "message path",
      q: "Design the message path from Alice to Bob. Walk every hop.",
      a: "Alice → Gateway A → Chat Service, which checks idempotency on <code>clientMsgId</code>, <b>persists + assigns the conversation seqNo</b>, then ACKs Alice — 'sent' means durability, not delivery. Then the fan-out decision: registry lookup for Bob's devices. Online → publish to Bob's gateway via Redis pub/sub → push down the socket → delivered receipt relays back. Offline → enqueue an APNs/FCM push (a wake-up nudge) and Bob syncs from his cursor on reconnect. Key decisions: persist-before-fan-out, ACK-from-persistence, the online/offline fork, receipts reversing the path."
    },
    {
      topic: "C10M",
      q: "How do you hold and scale to 10M concurrent connections?",
      a: "Idle connections are <b>memory-bound</b> (~30 KB each), so it's a kernel + runtime problem: epoll/kqueue event loops, raised fd limits, tuned TCP buffers, a lean runtime (Erlang, Go, Rust). Cap each node at ~500k–800k — not the theoretical ~2M — to reserve <b>failover headroom</b>, because a dead neighbor's connections stampede onto survivors. 10M / ~600k ≈ 17 nodes plus ~20% spare ≈ 20; scale the stateless gateway tier behind an L4 LB and route via registry + pub/sub. Derive the number, never quote it."
    },
    {
      topic: "recovery storm",
      q: "How do you deploy new code without dropping millions of live connections?",
      a: "Three pillars. <b>(1) Slow drain</b>: deregister from the LB and migrate connections over 5–30 minutes, rolling a small % of the fleet at a time. <b>(2) Jittered staggered reconnect</b>: clients get a random reconnect window plus exponential backoff — jitter is everything or you recreate the thundering herd. <b>(3) Cheap resume</b>: clients reconnect with a cursor and fetch only the gap. Kicker: run continuous ~1% connection rotation in steady state so the recovery path is always warm, and note most deploys never touch the gateway tier at all."
    },
    {
      topic: "presence",
      q: "Design presence (online / last-seen / typing) for users with thousands of contacts.",
      a: "Presence is ephemeral soft state: Redis TTL keys refreshed by heartbeat — expiry means offline, last write is last-seen, self-healing on crash. The real problem is <b>fan-out amplification</b>: one flip times thousands of watchers is millions of pushes/sec naively. So subscribe-on-view (watch the ~20 contacts on screen, not 5,000), pull-for-visible, debounce offline 30–60s to absorb mobile flapping, and aggregate to a count for huge groups. Typing is throttled to one event per 3–5s, QoS 0, never persisted. State it plainly: presence is eventually consistent by design."
    },
    {
      topic: "receipts",
      q: "Implement the sent / delivered / read ticks reliably.",
      a: "<b>Sent</b> = server durably persisted + assigned seqNo — a server-side fact decoupled from fan-out, so a delivery hiccup never looks like a send failure. <b>Delivered</b> = recipient device ACKed; <b>read</b> = recipient opened the conversation. Each transition is a small message routed back through the same gateway path. Critically, <b>collapse receipts</b> — 'read up to seqNo N' in one message — or a 50-person group generates 50x more receipt traffic than message traffic. Read state replicates across the user's own devices."
    },
    {
      topic: "ordering",
      q: "How do you guarantee message ordering, especially with multiple devices?",
      a: "You need <b>per-conversation ordering, not global</b> — the conversation is the partition/serialization key. The server assigns a monotonic seqNo on persist; everyone renders by seqNo, so all participants see the identical order. Never trust client timestamps (clock skew, malicious clients) — server seqNo is truth, client time is a display hint. The same seqNo powers gap detection on reconnect and multi-device consistency: one primitive, three problems solved."
    },
    {
      topic: "fan-out",
      q: "Fan-out-on-write vs fan-out-on-read — design for a 100k-member group.",
      a: "It's a <b>threshold hybrid</b>: small/medium groups get fan-out-on-write (copy to each inbox, O(1) pre-materialized reads); large groups get fan-out-on-read — store once in a shared log, each member tracks a cursor. At 100k members, fan-out-on-write is catastrophic (~50k inbox writes/sec for one busy group — the celebrity problem). Fan out the <b>live push only to currently-connected members</b> (the registry tells you who); the offline majority syncs from the log on reconnect. Storage mirrors this: wide-column log partitioned by convId, clustered by seqNo, plus lightweight per-user cursors."
    },
    {
      topic: "idempotency",
      q: "How do you prevent duplicate messages with at-least-once delivery?",
      a: "Deliberately choose <b>at-least-once + idempotent processing</b> over exactly-once, which is impractical on the wire. The sender's client generates a <code>clientMsgId</code> UUID at compose time and reuses it on every retry; the server dedups on it — a retry returns the existing seqNo instead of creating a duplicate. The receiving client also dedups on serverMsgId/seqNo so a message arriving via both socket and push renders once. Framing: exactly-once is a property of <em>processing</em>, not <em>delivery</em>."
    },
    {
      topic: "low-end mobile",
      q: "How would you optimize chat for low-end Android on 2G in emerging markets?",
      a: "Minimize radio wake-ups and bytes-on-wire — that's battery and latency on cellular. Use <b>MQTT or an MQTT-like custom binary protocol</b>: 2-byte headers vs HTTP's hundreds, QoS 1 at-least-once, persistent sessions for offline queueing, LWT + keep-alive for presence, retained messages for current state — chat primitives nearly free. That's why Messenger adopted MQTT and WhatsApp built a custom binary protocol. Add notification collapsing (one '7 messages' buzz), blurhash thumbnails before media download, and heartbeat intervals tuned against NAT timeouts."
    },
    {
      topic: "correlated failure",
      q: "What's the hardest part of operating real-time chat at scale?",
      a: "Not holding connections — that's the easy 20%. The hard part is <b>correlated failure</b>: a deploy, partition, or AZ loss fails millions of connections simultaneously, and the recovery — reconnect, re-auth, re-register, presence re-flap, sync — is itself a load spike that can topple the survivors. Everything in the design (jittered backoff, failover headroom, cheap cursor resume, continuous rotation, persist-before-fan-out, bounded buffers) exists to <b>decorrelate failures and flatten the recovery spike</b>. Designing for the recovery storm rather than the steady state is the whole game."
    },
    {
      topic: "altitude",
      q: "35 minutes to design WhatsApp — how do you spend them, and what do you skip?",
      a: "Front-load the decisions: ~3 minutes stating WebSocket transport, shared log + per-user cursors, at-least-once + idempotency, per-conversation seqNo — decisively. Spend ~20 minutes on the <b>crux</b>: gateway + registry + backplane (the routing problem), the full message path, the group fan-out threshold, and presence at scale. Name-and-move-on the WS handshake, frame formats, and 'we use Redis/a CDN' — table stakes, not differentiators. Earmark the hard parts out loud — multi-device E2E, the dead-node registry window, the reconnect storm — and spend remaining minutes there. Altitude control is the meta-skill."
    },
    {
      topic: "trade-offs",
      q: "The interviewer says 'it depends' is a non-answer. How do you handle a genuine trade-off?",
      a: "Commit to a default and bound it with a trigger: <em>X because requirement; revisit if trigger</em>. Example: 'Redis pub/sub for the live hop because sub-ms latency matters and a durable log sits underneath; I'd move to Kafka end-to-end if I needed replayable cross-region ordering or audit.' That states the decision, the reason, and the precise condition that flips it. The trap is enumerating options without choosing; if a fact is genuinely missing, say what you'd measure and what each outcome implies — still a decision, just conditional."
    }
  ]
};
