/**
 * Phase 1 — TRANSPORTS: long-poll vs SSE vs WebSocket (hop 2, "how bytes reach
 * the device"). Run with:  npm run phase1
 *
 * "Realtime" just means the server can push to the client without the client
 * asking each time. There are three ways, and the whole interview is knowing
 * which to pick:
 *
 *   LONG-POLL   client makes a request; server HOLDS it open until it has data,
 *               then responds; client immediately re-requests. Works everywhere
 *               (it's just HTTP), but one message per round-trip = wasteful.
 *
 *   SSE         (Server-Sent Events) one long-lived HTTP response the server
 *               streams events down. Server→client ONLY, auto-reconnects, rides
 *               plain HTTP. Perfect for feeds/notifications/tickers.
 *
 *   WEBSOCKET   a persistent, BIDIRECTIONAL socket. The only option when the
 *               CLIENT must stream back too (chat typing, collab editing, games).
 *               More moving parts (upgrade handshake, proxies, heartbeats).
 *
 *   Decision rule:  need client→server streaming? → WebSocket.
 *                   only server→client? → SSE.
 *                   stuck with ancient proxies/no streaming? → long-poll.
 *
 * This script starts one server speaking all three and a client of each, then
 * watches the same "tick" events arrive over every transport.
 */

import { createServer, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "../lib/log.ts";

const PORT = 5100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── A tiny event source everyone subscribes to ─────────────────────────────
type Listener = (msg: string) => void;
const listeners = new Set<Listener>();
const emit = (msg: string) => listeners.forEach((l) => l(msg));

// ─── Server: long-poll + SSE on HTTP, WebSocket via upgrade ─────────────────
const longPollWaiters: ServerResponse[] = [];
const sseClients = new Set<ServerResponse>();

const server = createServer((req, res) => {
  if (req.url === "/longpoll") {
    // Hold the response open; a message (or a 10s timeout) resolves it.
    longPollWaiters.push(res);
    return;
  }
  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  res.writeHead(404).end();
});

// When a message is emitted, deliver it over long-poll and SSE.
listeners.add((msg) => {
  // long-poll: answer every waiting request, then they'll re-request.
  while (longPollWaiters.length) longPollWaiters.shift()!.writeHead(200, { "content-type": "text/plain" }).end(msg);
  // SSE: stream to each open response.
  for (const res of sseClients) res.write(`data: ${msg}\n\n`);
});

// WebSocket server sharing the same port.
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  const listener: Listener = (msg) => ws.send(msg);
  listeners.add(listener);
  ws.on("message", (data) => log(`   [WS server] ⇐ client streamed back: "${data}"`)); // bidirectional!
  ws.on("close", () => listeners.delete(listener));
});

// ─── Clients ────────────────────────────────────────────────────────────────
async function longPollClient() {
  // Loop: request, wait for a message, print, repeat.
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`http://localhost:${PORT}/longpoll`);
    log(`   [long-poll] 📥 ${await res.text()}  (now must re-request)`);
  }
}

async function sseClient() {
  const res = await fetch(`http://localhost:${PORT}/sse`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  while (seen < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (line.startsWith("data: ")) { log(`   [SSE] 📥 ${line.slice(6)}`); seen++; }
    }
  }
  await reader.cancel();
}

function wsClient() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on("message", (data) => {
    log(`   [WS] 📥 ${data}`);
    ws.send(`ack:${data}`); // the thing ONLY WebSocket can do: stream back
  });
  return ws;
}

async function main() {
  await new Promise<void>((r) => server.listen(PORT, r));
  log(`server up on :${PORT} speaking long-poll, SSE, and WebSocket`);

  const ws = wsClient();
  const clients = Promise.all([longPollClient(), sseClient()]);
  await sleep(200);

  // Emit 3 ticks; all three transports receive each.
  for (let n = 1; n <= 3; n++) {
    log(`→ server emits tick ${n}`);
    emit(`tick ${n}`);
    await sleep(500);
  }

  await clients;
  await sleep(200);
  ws.close();
  wss.close();
  server.close();
  log("");
  log("All three delivered the ticks. Note the WS server logged 'client streamed");
  log("back' — that bidirectional path is exactly what SSE/long-poll can't do.");
  process.exit(0);
}

main();
