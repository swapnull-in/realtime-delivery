/**
 * Capstone — a live realtime chat that ties every phase together.
 * Run with:  npm run chat   (needs Redis), then open http://localhost:5200 in
 * two or three browser tabs and chat between them.
 *
 * What it demonstrates, live:
 *   - TRANSPORT (Phase 1): a WebSocket per client (bidirectional).
 *   - ROUTING  (Phase 2): messages go onto a Redis pub/sub channel ("the bus"),
 *     and every gateway subscribed to it fans out to its local sockets. Run two
 *     copies on different ports and they still see each other — that's hop 1.
 *   - ORDERING (Phase 3): the server stamps a monotonic per-room sequence.
 *   - RECEIPTS (Phase 4): sent → delivered → read, driven by client acks.
 *   - PRESENCE (Phase 5): a live roster from a shared Redis set.
 *   - OFFLINE SYNC (Phase 6): on join, the client fetches recent history from
 *     the durable log by cursor.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { Redis } from "ioredis";
import { log } from "../lib/log.ts";

const PORT = Number(process.env.PORT ?? 5200);
const ROOM = "lobby";
const UI = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

const pub = new Redis();
const sub = new Redis();
const store = new Redis();

// Local sockets this gateway holds: socket → user name.
const clients = new Map<WebSocket, string>();
const send = (ws: WebSocket, obj: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
const broadcastLocal = (obj: unknown) => { for (const ws of clients.keys()) send(ws, obj); };

// ─── HTTP: serve the UI ─────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(UI);
  } else res.writeHead(404).end();
});

// ─── The bus (hop 1): anything published here fans out to ALL gateways ──────
sub.subscribe(`room:${ROOM}`, `room:${ROOM}:receipts`, `room:${ROOM}:presence`);
sub.on("message", (channel, payload) => {
  // Presence is a bare "changed" signal — don't JSON.parse it.
  if (channel.endsWith(":presence")) { void pushRoster(); return; }
  const data = JSON.parse(payload);
  if (channel.endsWith(":receipts")) broadcastLocal({ type: "receipt", ...data });
  else broadcastLocal({ type: "message", ...data }); // hop 2: deliver to local sockets
});

async function pushRoster() {
  const roster = await store.smembers(`online:${ROOM}`);
  broadcastLocal({ type: "roster", users: roster });
}

// ─── WebSocket gateway ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      clients.set(ws, msg.name);
      await store.sadd(`online:${ROOM}`, msg.name);
      log(`${msg.name} joined (${clients.size} local sockets)`);

      // Offline sync (Phase 6): send history after the client's cursor.
      const since = Number(msg.cursor ?? 0);
      const history = await store.lrange(`log:${ROOM}`, 0, -1);
      for (const item of history) {
        const m = JSON.parse(item);
        if (m.seq > since) send(ws, { type: "message", ...m });
      }
      await pub.publish(`room:${ROOM}:presence`, "changed"); // tell everyone the roster changed
    }

    if (msg.type === "chat") {
      const name = clients.get(ws);
      if (!name) return;
      const seq = await store.incr(`seq:${ROOM}`); // ordering (Phase 3)
      const out = { id: `${Date.now()}-${seq}`, seq, from: name, text: String(msg.text).slice(0, 500), ts: Date.now() };
      await store.rpush(`log:${ROOM}`, JSON.stringify(out)); // durable log (Phase 6)
      await store.ltrim(`log:${ROOM}`, -200, -1); // keep last 200
      await pub.publish(`room:${ROOM}`, JSON.stringify(out)); // onto the bus (hop 1)
    }

    if (msg.type === "delivered" || msg.type === "read") {
      const name = clients.get(ws);
      // Receipts fan out on their own channel (Phase 4).
      await pub.publish(`room:${ROOM}:receipts`, JSON.stringify({ seq: msg.seq, by: name, kind: msg.type }));
    }
  });

  ws.on("close", async () => {
    const name = clients.get(ws);
    clients.delete(ws);
    if (name && ![...clients.values()].includes(name)) {
      await store.srem(`online:${ROOM}`, name);
      await pub.publish(`room:${ROOM}:presence`, "changed");
      log(`${name} left`);
    }
  });
});

server.listen(PORT, () => {
  log(`realtime chat gateway on http://localhost:${PORT}`);
  log("open it in 2–3 browser tabs and chat. (Run a 2nd gateway: PORT=5201 npm run chat)");
});
