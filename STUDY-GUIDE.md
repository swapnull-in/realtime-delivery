# Study Guide — Realtime Delivery ↔ Module 09 (Real-Time Systems)

This repo is the runnable half of [`Core Course/09-realtime-systems.md`](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/09-realtime-systems.md): every phase is a small script that *proves* one claim the module makes on paper. Study by pairing — read the module section, run the phase (`npm run phaseN`), and watch the logged numbers confirm the insight, then drill yourself with the Drill panel in the web lab (`npm run web`). Finish by running the live chat capstone (`npm run chat`, needs Redis) in multiple tabs and narrating every hop out loud, interview-style.

## Phase → module mapping

| Phase | What it builds | Module section | The staff insight |
|---|---|---|---|
| 1 | Long-poll vs SSE vs WebSocket, and the decision rule | §2 Transport options | "The interview-winning move is a decision tree, not a favorite… Decide, don't enumerate." |
| 2 | The two-hop pattern: user→gateway registry + Redis pub/sub routing | §5.1–5.3 Gateway, registry, routing | "A real-time system is a distributed routing problem, not a connection problem." |
| 3 | Per-conversation sequence IDs + a client reorder buffer | §8.2 Message ordering | "Never trust client timestamps for ordering… the server-assigned seqNo is the source of truth." |
| 4 | The sent→delivered→read state machine; twice / out-of-order / never | §8.1 Delivery semantics | "'Sent' must be backed by persistence, not by fan-out success." |
| 5 | Heartbeat-derived presence, the fan-out monster, flap damping | §6 Presence systems | "Presence is a fan-out amplification problem… the cheapest update is the one you never send." |
| 6 | Fetch-since cursor sync (not "replay the queue") + jittered reconnect | §8.5 Offline queue & multi-device sync | "The gap between cursor and head *is* the queue." |
| 7 | The online↔push race, dedup, collapse keys, token pruning | §7 Push notifications | "Push is the *signal*, the inbox is the *source of truth*." |
| 8 | Group fan-out: write vs read, the threshold hybrid, the celebrity problem | §8.3–8.4 Group fan-out & storage model | "It's a threshold-based hybrid, and the threshold is where write-amplification cost crosses read-query cost." |
| 9 | Backpressure: one slow 2G client OOMs a node; bound the buffer, drop the consumer | §3.2 Heartbeats, backpressure & flow control | "We bound every send buffer and drop slow consumers — node availability beats one degraded client." |
| 10 | Graceful deploys: slow drain + jitter + headroom + cursor resume vs the naive storm | §3.5 Draining, §9 Scaling & reliability | "You never want your disaster-recovery code to be the code that only runs during disasters." |
| 11 | C10K→C10M capacity derivation: memory-bound math, event loop vs thread-per-conn | §3.3 C10K → C10M | "Capacity planning for the failure case, not the steady state, is the staff-level distinction." |
| 12 | X3DH + double ratchet with real `node:crypto`; the blind-relay consequence | §8.7 End-to-end encryption | "Knowing E2E *reshapes the entire architecture* — the server becomes a blind relay by design." |
| Capstone (`src/app`) | A live multi-gateway chat: WS transport, Redis bus, seqNo ordering, receipts, presence roster, cursor history sync | §5.4 Full message path | "If you can draw this one diagram and narrate every arrow's decision, you've shown you can design the system." |

## Go deeper

- [`Deep Dives/13-realtime-updates.md`](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/13-realtime-updates.md) — the transport and fan-out patterns generalized beyond chat (live dashboards, feeds, collaborative editing).
- [`Deep Dives/02-kafka.md`](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/02-kafka.md) — the durable-log backplane underneath "persist before you fan out": partitions as ordering domains, consumer cursors.
- [`Core Course/18a-design-chat-social.md`](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/18a-design-chat-social.md) — the full WhatsApp/Slack design problems that Module 09's building blocks assemble into.
- [`Core Course/36-design-live-streaming.md`](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/36-design-live-streaming.md) — one-to-millions delivery where WebSocket fan-out gives way to HLS/CDN; the other end of the fan-out spectrum.
- [`Core Course/41-design-multiplayer-game.md`](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/41-design-multiplayer-game.md) — when even TCP is too slow: unreliable datagrams, tick loops, and state sync under 50 ms budgets.
