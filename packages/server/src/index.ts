/**
 * HTTP for creating and finding rooms; WebSocket for everything that happens
 * inside one. The socket carries no authority of its own -- it validates the
 * envelope, names the sender, and hands the intent to the room.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  isClientMessage,
  isRulesetId,
  PROTOCOL_VERSION,
  RULESETS,
  type ClientMessage,
} from '@patte/core';
import FastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomManager } from './manager.js';
import type { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8787);
/**
 * Loopback by default, every interface when asked.
 *
 * A development server that answered the whole network by default would be a
 * poor default; a container that answers only itself is useless, which is why
 * a deployment sets `HOST=0.0.0.0` explicitly.
 */
const HOST = process.env.HOST ?? '127.0.0.1';
/**
 * Where the built client lives, when this process is also serving it.
 *
 * Unset in development -- Vite serves the client and proxies here -- and set
 * in a deployment, where one process serving one origin means the client's
 * relative `/api` and `/ws` need no configuration at all.
 */
const CLIENT_DIR = process.env.CLIENT_DIR;
/**
 * Whether to believe `X-Forwarded-For`.
 *
 * Only ever true behind a proxy that overwrites the header itself. Trusting it
 * on a directly exposed server would let a client claim any address it liked,
 * which is exactly the thing the rate limit below is counting.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
/** How many tables one address may open per hour. */
const CREATE_LIMIT = Number(process.env.CREATE_LIMIT ?? 30);
const CREATE_WINDOW_MS = 60 * 60_000;
/** Anything larger than this is not a card game. */
const MAX_MESSAGE_BYTES = 64 * 1024;

const manager = new RoomManager();
manager.start();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: TRUST_PROXY,
});

/**
 * A table-opening budget per address.
 *
 * Hand-rolled rather than pulled in: it is a Map and a clock, and the one
 * thing a rate limiter must not do is become the exhaustion it prevents --
 * so the table of callers is itself capped, and the oldest entry goes when it
 * is full. A limiter that grows without bound is just a slower leak.
 */
const seen = new Map<string, { count: number; resetAt: number }>();
const MAX_TRACKED = 10_000;

function withinBudget(address: string): boolean {
  const now = Date.now();
  const entry = seen.get(address);

  if (!entry || entry.resetAt <= now) {
    if (seen.size >= MAX_TRACKED) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.set(address, { count: 1, resetAt: now + CREATE_WINDOW_MS });
    return true;
  }

  entry.count++;
  return entry.count <= CREATE_LIMIT;
}

app.get('/health', async () => ({ ok: true, rooms: manager.size }));

app.get('/api/rulesets', async () => ({
  rulesets: RULESETS.map((ruleset) => ({
    id: ruleset.id,
    name: ruleset.name,
    blurb: ruleset.blurb,
    minPlayers: ruleset.minPlayers,
    maxPlayers: ruleset.maxPlayers,
  })),
}));

app.post<{ Body?: { rulesetId?: string; rounds?: number } }>('/api/rooms', async (request, reply) => {
  const requested = request.body?.rulesetId;
  if (requested !== undefined && !isRulesetId(requested)) {
    return reply.code(400).send({ error: `unknown game: ${requested}` });
  }

  const rounds = request.body?.rounds;
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > 50)) {
    return reply.code(400).send({ error: 'rounds must be a whole number between 1 and 50' });
  }

  if (!withinBudget(request.ip)) {
    return reply.code(429).send({ error: 'too many tables from here — try again later' });
  }
  if (manager.isFull) {
    return reply.code(503).send({ error: 'this server is full — try again in a little while' });
  }

  const room = manager.create(requested, rounds);
  app.log.info(
    { roomId: room.id, rulesetId: room.table.ruleset.id, rounds: room.table.state.match.rounds },
    'room created',
  );
  return {
    roomId: room.id,
    rulesetId: room.table.ruleset.id,
    rounds: room.table.state.match.rounds,
  };
});

app.get<{ Params: { id: string } }>('/api/rooms/:id', async (request, reply) => {
  const room = manager.get(request.params.id);
  if (!room) return reply.code(404).send({ error: 'no such room' });
  return {
    roomId: room.id,
    rulesetId: room.table.ruleset.id,
    phase: room.table.state.phase,
    players: Object.values(room.table.state.players).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
    })),
  };
});

/*
 * The client, served by the same process on the same origin.
 *
 * That is the whole deployment story: the client asks for `/api/rooms` and
 * `/ws` relatively and derives `wss:` from the page's own protocol, so served
 * this way it needs no configuration, no CORS, and no knowledge of where it
 * is hosted.
 *
 * No history fallback is needed, and that is not an oversight: a table's code
 * lives in the query string, so every URL this app produces is `/`.
 */
if (CLIENT_DIR) {
  await app.register(FastifyStatic, {
    root: fileURLToPath(new URL(CLIENT_DIR, `file://${process.cwd()}/`)),
    // The hashed asset filenames are content-addressed and may be cached hard;
    // `index.html` names them, so it must not be.
    maxAge: '1y',
    setHeaders(reply, path) {
      if (path.endsWith('.html')) reply.header('cache-control', 'no-cache');
    },
  });
}

// --- sockets ---------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket: WebSocket) => {
  let room: Room | null = null;
  let playerId: string | null = null;
  let mySocket: { send(data: string): void; close(): void } | null = null;

  const fail = (message: string): void => {
    try {
      socket.send(JSON.stringify({ t: 'error', message }));
    } finally {
      socket.close();
    }
  };

  socket.on('message', (raw) => {
    if (raw.toString().length > MAX_MESSAGE_BYTES) return fail('message too large');

    let message: ClientMessage;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isClientMessage(parsed)) return fail('malformed message');
      message = parsed;
    } catch {
      return fail('malformed message');
    }

    // Nothing but `hello` is accepted until the sender has a seat.
    if (!room || !playerId) {
      if (message.t !== 'hello') return fail('say hello first');
      if (message.version !== PROTOCOL_VERSION) return fail('client is out of date');

      // Join, never create. Opening a table is what `POST /api/rooms` is
      // for, and it is the path that counts and caps them -- a socket that
      // could conjure a room by naming one would walk straight past both.
      //
      // It also replaces this app's most confusing failure. A code with no
      // room behind it used to quietly become a brand new empty table, so a
      // typo, or a table that had been reaped, or a server that had restarted
      // all looked identical: your game, silently replaced by a sandbox.
      const found = manager.get(message.roomId);
      if (!found) return fail('That table has closed. Ask for a new code, or start your own.');
      room = found;
      playerId = message.playerId?.slice(0, 64) || crypto.randomUUID();
      const name = (message.name || 'Player').slice(0, 24);
      mySocket = { send: (d) => socket.send(d), close: () => socket.close() };
      room.join(playerId, name, mySocket);
      app.log.info({ roomId: room.id, playerId }, 'player joined');
      return;
    }

    switch (message.t) {
      case 'intent':
        room.submit(playerId, message.id, message.intent);
        return;
      case 'cursor':
        room.setCursor(playerId, {
          x: message.x,
          y: message.y,
          ...(message.zone ? { zone: message.zone, dx: message.dx, dy: message.dy } : {}),
        });
        return;
      case 'resync':
        room.resync(playerId);
        return;
      case 'ping':
        socket.send(JSON.stringify({ t: 'pong' }));
        return;
      case 'hello':
        return; // already seated
    }
  });

  socket.on('close', () => {
    // Pass our own socket so a close arriving after a reconnect cannot tear
    // down the connection that replaced us.
    if (room && playerId && mySocket) {
      room.leave(playerId, mySocket);
      app.log.info({ roomId: room.id, playerId }, 'player left');
    }
  });

  socket.on('error', () => socket.close());
});

// --- wiring ----------------------------------------------------------------

const server = createServer();

server.on('request', (req, res) => {
  app.ready().then(() => app.routing(req, res));
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

/**
 * The most common way to start this server is with another copy of it already
 * running, usually one left over from an earlier session. Node's default
 * response is an unhandled 'error' event and a stack trace, which says what
 * went wrong but not what to do about it.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(
    [
      '',
      `  Port ${PORT} is already in use — most likely a patte server that is still running.`,
      '',
      `    See what has it:   lsof -i :${PORT}`,
      `    Stop it:           kill $(lsof -ti :${PORT})`,
      '',
      '  (The client proxies to this exact port, so moving it means editing',
      '   `server.proxy` in packages/client/vite.config.ts too.)',
      '',
    ].join('\n'),
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  app.log.info(`patte server listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    manager.stop();
    server.close(() => process.exit(0));
  });
}
