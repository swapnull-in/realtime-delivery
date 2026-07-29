# Learn Realtime Delivery in TypeScript

A hands-on, runnable project for understanding realtime systems at a Staff/EM
level — how a chat/notification/live system actually pushes bytes to millions of
devices.

Every phase is a small script you can run and read. No build step: modern Node
runs the TypeScript directly.

> Built to match a Staff-level study path. The through-line: **realtime is two
> hops** — **routing** ("which gateway holds this user's connection?", a pub/sub
> problem) and **transport** ("how do bytes reach the device?", a
> connection-lifecycle problem). Everything else — presence, ordering, offline,
> fan-out — is bookkeeping around those two hops.

## Prerequisites

- **Node.js 22+** (uses native `.ts` execution)
- **Redis** on `localhost:6379` for Phases 2, 6 and the chat app
  ```bash
  # macOS:   brew install redis && brew services start redis
  # Docker:  docker run -d -p 6379:6379 redis
  ```

## Setup

```bash
npm install
```

## The lessons

Each prints a timestamped log so you can watch messages route, reorder, ack,
and sync.

| Command | What you learn | Maps to |
|---|---|---|
| `npm run phase1` | **Transports** — long-poll vs SSE vs WebSocket, and the decision rule | transport (hop 2) |
| `npm run phase2` | **The two-hop pattern** — user→gateway registry + Redis pub/sub routing | routing (hop 1) |
| `npm run phase3` | **Ordering** — per-conversation sequence IDs + a client reorder buffer | ordering |
| `npm run phase4` | **Delivery receipts** — the sent→delivered→read state machine; twice/out-of-order/never | receipts |
| `npm run phase5` | **Presence** — heartbeats, the fan-out monster, flap damping | presence |
| `npm run phase6` | **Offline sync** — fetch-since (not "replay the queue") + jittered reconnect | offline |

## Capstone: a live chat app

```bash
npm run chat        # gateway + UI on http://localhost:5200
```

Open it in **two or three browser tabs**, pick names, and chat. It ties every
phase together: WebSocket transport, Redis pub/sub routing, per-message sequence
ordering, delivery/read receipts, a live presence roster, and history sync on
join. Run a second gateway (`PORT=5201 npm run chat`) and the tabs still see
each other — that's hop 1 working across gateways.

![Realtime chat](docs/chat.jpg)

## What each phase proves (the money quotes)

- **Phase 2** — alice on gateway-1 messages bob on gateway-3; the message hops
  the Redis bus to the right gateway, and an offline carol's message lands in her
  inbox for reconnect.
- **Phase 5** — a flapping user with 500 watchers costs **2500** notifications
  naively vs **500** with flap damping.
- **Phase 6** — a 10,000-client reconnect storm spread from one lethal instant to
  ~2,000/sec across 5s of jittered backoff.

## Project layout

```
src/
  lib/log.ts              shared timestamped logger
  phase1/  transports (long-poll / SSE / WebSocket)
  phase2/  two-hop routing (registry + Redis pub/sub)
  phase3/  per-conversation ordering + reorder buffer
  phase4/  delivery-receipt state machine
  phase5/  presence + flap damping
  phase6/  offline sync + reconnect storms
  app/     the live chat gateway + browser UI
```

## License

MIT — use it, fork it, learn from it.
