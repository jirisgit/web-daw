/**
 * Collaboration endpoints, attached to the Vite dev/preview HTTP server:
 *   /yjs/<room>  – Yjs document sync (the shared patch)
 *   /rt/<room>   – realtime channel: clock pings + live note relay
 *   /api/lan     – this machine's LAN addresses, for the "share" link
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const require = createRequire(import.meta.url);
type YDoc = { on(e: 'update', fn: () => void): void };
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils') as {
  setupWSConnection(ws: WebSocket, req: IncomingMessage, opts?: { docName?: string; gc?: boolean }): void;
  setPersistence(p: { bindState(name: string, doc: YDoc): void; writeState(name: string, doc: YDoc): Promise<void> }): void;
};
// Same Yjs instance that y-websocket uses internally (mixing instances breaks Yjs)
const Y = require('yjs') as {
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  encodeStateAsUpdate(doc: YDoc): Uint8Array;
};

// ---------------------------------------------------------------------------
// Rooms are saved to ./data/<room>.ydoc so the shared patch survives restarts
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(process.cwd(), 'data');
const fileFor = (name: string) => join(DATA_DIR, `${encodeURIComponent(name)}.ydoc`);

function save(name: string, doc: YDoc) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = fileFor(name);
  writeFileSync(`${file}.tmp`, Y.encodeStateAsUpdate(doc));
  renameSync(`${file}.tmp`, file);
}

setPersistence({
  bindState(name, doc) {
    const file = fileFor(name);
    if (existsSync(file)) Y.applyUpdate(doc, readFileSync(file));
    let timer: NodeJS.Timeout | undefined;
    doc.on('update', () => {
      clearTimeout(timer);
      timer = setTimeout(() => save(name, doc), 1000);
    });
  },
  async writeState(name, doc) {
    save(name, doc);
  },
});

/** High-resolution wall clock in ms */
const serverNow = () => performance.timeOrigin + performance.now();

export function attachSync(http: Server) {
  const yjs = new WebSocketServer({ noServer: true });
  const rt = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Set<WebSocket>>();

  rt.on('connection', (ws: WebSocket, room: string) => {
    if (!rooms.has(room)) rooms.set(room, new Set());
    const peers = rooms.get(room)!;
    peers.add(ws);

    ws.on('message', (raw) => {
      const text = raw.toString();
      // Answer clock pings immediately, without parsing more than needed
      if (text.startsWith('{"t":"ping"')) {
        const { t0 } = JSON.parse(text);
        ws.send(JSON.stringify({ t: 'pong', t0, s: serverNow() }));
        return;
      }
      for (const peer of peers) if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(text);
    });
    ws.on('close', () => {
      peers.delete(ws);
      if (!peers.size) rooms.delete(room);
    });
  });

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (url.startsWith('/yjs/')) {
      const docName = decodeURIComponent(url.slice(5).split('?')[0]) || 'main';
      yjs.handleUpgrade(req, socket, head, (ws) => setupWSConnection(ws, req, { docName, gc: true }));
    } else if (url.startsWith('/rt/')) {
      const room = decodeURIComponent(url.slice(4).split('?')[0]) || 'main';
      rt.handleUpgrade(req, socket, head, (ws) => rt.emit('connection', ws, room));
    }
    // anything else (e.g. Vite HMR) is left to other listeners
  });
}

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address)
    .filter((ip) => !ip.startsWith('169.254.')) // link-local: not reachable from other devices
    .sort((a, b) => Number(/^(192\.168|10\.)/.test(b)) - Number(/^(192\.168|10\.)/.test(a)));
}
