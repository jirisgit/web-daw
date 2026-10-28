/**
 * Everything about "being in a shared session":
 * - ydoc + provider: the shared patch document (Yjs over WebSocket)
 * - awareness: who's here, their name/color/cursor
 * - clock: estimate of the server's clock, for starting the transport in sync
 * - realtime: low-latency channel for live notes (keyboard, pads, MIDI)
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useSyncExternalStore } from 'react';

export const room = new URLSearchParams(location.search).get('room') || 'main';
const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

export const ydoc = new Y.Doc();
/** Browser copy of the patch: survives reloads and works offline, merges on reconnect */
export const browserStore = new IndexeddbPersistence(`web-daw:${room}`, ydoc);
export const provider = new WebsocketProvider(`${wsBase}/yjs`, room, ydoc);
export const awareness = provider.awareness;

// ---------------------------------------------------------------------------
// Identity & presence
// ---------------------------------------------------------------------------

export interface User {
  name: string;
  color: string;
}

const COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#22d3ee', '#818cf8', '#e879f9', '#f472b6'];

function loadUser(): User {
  try {
    const saved = JSON.parse(localStorage.getItem('web-daw-user') ?? 'null');
    if (saved?.name && saved?.color) return saved;
  } catch {
    /* ignore */
  }
  return {
    name: `Guest ${Math.floor(100 + Math.random() * 900)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
}

export let me: User = loadUser();
awareness.setLocalStateField('user', me);

export function renameMe(name: string) {
  me = { ...me, name };
  try {
    localStorage.setItem('web-daw-user', JSON.stringify(me));
  } catch {
    /* ignore */
  }
  awareness.setLocalStateField('user', me);
}

export interface Peer {
  clientId: number;
  user: User;
  cursor: { x: number; y: number } | null;
  isMe: boolean;
}

let peers: Peer[] = [];
const readPeers = () => {
  peers = [...awareness.getStates().entries()]
    .filter(([, s]) => s.user)
    .map(([clientId, s]) => ({
      clientId,
      user: s.user as User,
      cursor: (s.cursor as Peer['cursor']) ?? null,
      isMe: clientId === ydoc.clientID,
    }));
};
readPeers();
const peerListeners = new Set<() => void>();
awareness.on('change', () => {
  readPeers();
  peerListeners.forEach((l) => l());
});

export function usePeers() {
  return useSyncExternalStore(
    (fn) => {
      peerListeners.add(fn);
      return () => {
        peerListeners.delete(fn);
      };
    },
    () => peers,
  );
}

let lastCursor = 0;
export function setCursor(pos: { x: number; y: number } | null) {
  const now = performance.now();
  if (pos && now - lastCursor < 40) return;
  lastCursor = now;
  awareness.setLocalStateField('cursor', pos);
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

export type ConnStatus = 'connecting' | 'connected' | 'disconnected';
let status: ConnStatus = 'connecting';
const statusListeners = new Set<() => void>();
const setStatus = (s: ConnStatus) => {
  status = s;
  statusListeners.forEach((l) => l());
};
provider.on('status', (e: { status: ConnStatus }) => setStatus(e.status));

export function useConnStatus() {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    () => status,
  );
}

/**
 * Run `seed` once if the doc is still empty after loading the browser copy
 * and syncing with the server (or giving up on the server).
 */
export async function seedWhenEmpty(isEmpty: () => boolean, seed: () => void) {
  await browserStore.whenSynced;
  if (!provider.synced) {
    await new Promise<void>((resolve) => {
      provider.once('sync', () => resolve());
      setTimeout(resolve, 2500); // no server reachable: work offline
    });
  }
  if (isEmpty()) seed();
}

// ---------------------------------------------------------------------------
// Clock: NTP-style offset between performance.now() and the server's clock
// ---------------------------------------------------------------------------

class Clock {
  /** serverMs = performance.now() + offset */
  offset = Date.now() - performance.now();
  rtt = NaN;
  synced = false;
  private samples: { rtt: number; offset: number }[] = [];

  serverNow() {
    return performance.now() + this.offset;
  }

  addSample(t0: number, server: number) {
    const t1 = performance.now();
    const rtt = t1 - t0;
    this.samples.push({ rtt, offset: server + rtt / 2 - t1 });
    if (this.samples.length > 16) this.samples.shift();
    // The fastest round trips have the least queueing, so trust those most
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = this.synced ? this.offset + (best.offset - this.offset) * 0.3 : best.offset;
    this.rtt = best.rtt;
    this.synced = true;
  }
}

export const clock = new Clock();

// ---------------------------------------------------------------------------
// Realtime channel: clock pings + relayed live events
// ---------------------------------------------------------------------------

export interface LiveMsg {
  t: 'ev';
  /** 'out' = event leaving a module's output port, 'in' = event going into an input port */
  dir: 'out' | 'in';
  node: string;
  port: string;
  type: 'noteOn' | 'noteOff';
  note: number;
  vel: number;
  /** server-clock ms at which the sender heard it */
  s: number;
}

class Realtime {
  private ws: WebSocket | null = null;
  private pingTimer: number | undefined;
  private handlers = new Set<(m: LiveMsg) => void>();

  constructor() {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${wsBase}/rt/${encodeURIComponent(room)}`);
    this.ws = ws;
    ws.onopen = () => {
      // A quick burst for a fast first estimate, then keep refreshing
      let burst = 0;
      const ping = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'ping', t0: performance.now() }));
      const b = window.setInterval(() => {
        ping();
        if (++burst >= 10) clearInterval(b);
      }, 60);
      this.pingTimer = window.setInterval(ping, 2000);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'pong') clock.addSample(m.t0, m.s);
      else if (m.t === 'ev') this.handlers.forEach((h) => h(m));
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      window.setTimeout(() => this.connect(), 1500);
    };
  }

  send(m: LiveMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  onEvent(fn: (m: LiveMsg) => void) {
    this.handlers.add(fn);
  }
}

export const realtime = new Realtime();
