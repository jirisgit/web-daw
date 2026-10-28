/**
 * The shared document: modules, positions, params, cables, pattern data, transport.
 *
 * Stored in a Yjs doc (synced between users, saved in the browser and on the
 * server). The rest of the app sees plain immutable snapshots: a node object
 * only changes identity when that node changed, so React and the audio engine
 * can cheaply tell what's different.
 */
import * as Y from 'yjs';
import { useSyncExternalStore } from 'react';
import { ydoc } from '../sync/session';

export interface DocNode {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, number>;
  data: Record<string, unknown>;
}

export interface DocEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/**
 * Shared transport. While playing, step `anchorStep` sounds at server time `anchorMs`;
 * every client derives all other step times from that, so they play in sync.
 */
export interface TransportState {
  playing: boolean;
  bpm: number;
  anchorMs: number;
  anchorStep: number;
}

export interface Doc {
  transport: TransportState;
  nodes: Record<string, DocNode>;
  edges: Record<string, DocEdge>;
}

type Listener = (doc: Doc, prev: Doc) => void;

export const uid = (prefix = 'n') => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

const DEFAULT_TRANSPORT: TransportState = { playing: false, bpm: 120, anchorMs: 0, anchorStep: 0 };

// ---------- JSON <-> Yjs helpers ----------
// Arrays become Y.Arrays and are updated element by element, so two people
// painting different sequencer cells at once both keep their edits.

const toY = (v: unknown): unknown => {
  if (!Array.isArray(v)) return v;
  const a = new Y.Array<unknown>();
  a.push(v.map(toY));
  return a;
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function syncArray(ya: Y.Array<unknown>, arr: unknown[]) {
  if (ya.length !== arr.length) {
    ya.delete(0, ya.length);
    ya.push(arr.map(toY));
    return;
  }
  arr.forEach((v, i) => {
    const cur = ya.get(i);
    if (Array.isArray(v) && cur instanceof Y.Array) syncArray(cur, v);
    else if (!same(cur instanceof Y.AbstractType ? cur.toJSON() : cur, v)) {
      ya.delete(i, 1);
      ya.insert(i, [toY(v)]);
    }
  });
}

function writeValue(map: Y.Map<unknown>, key: string, value: unknown) {
  const cur = map.get(key);
  if (Array.isArray(value) && cur instanceof Y.Array) syncArray(cur, value);
  else if (!same(cur instanceof Y.AbstractType ? cur.toJSON() : cur, value)) map.set(key, toY(value));
}

// ---------- store ----------

const LOCAL = { local: true };

class DocStore {
  private yNodes = ydoc.getMap<Y.Map<unknown>>('nodes');
  private yEdges = ydoc.getMap<DocEdge>('edges');
  private yTransport = ydoc.getMap<unknown>('transport');
  private snapshot: Doc = { transport: DEFAULT_TRANSPORT, nodes: {}, edges: {} };
  private listeners = new Set<Listener>();
  private dirtyNodes = new Map<string, Set<string>>();
  private edgesDirty = false;
  private transportDirty = false;

  readonly undoManager = new Y.UndoManager([this.yNodes, this.yEdges], {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 400,
  });

  constructor() {
    this.yNodes.observeDeep((events) => {
      for (const ev of events) {
        if (ev.target === this.yNodes) {
          ev.changes.keys.forEach((_c, id) => this.markNode(id, 'all'));
        } else {
          const id = ev.path[0] as string;
          this.markNode(id, ev.path.length === 1 ? 'self' : (ev.path[1] as string));
        }
      }
    });
    this.yEdges.observe(() => (this.edgesDirty = true));
    this.yTransport.observe(() => (this.transportDirty = true));
    ydoc.on('afterTransaction', () => this.rebuild());
  }

  private markNode(id: string, part: string) {
    if (!this.dirtyNodes.has(id)) this.dirtyNodes.set(id, new Set());
    this.dirtyNodes.get(id)!.add(part);
  }

  private readNode(id: string, ym: Y.Map<unknown>, prev: DocNode | undefined, parts: Set<string>): DocNode {
    const all = !prev || parts.has('all');
    return {
      id,
      type: ym.get('type') as string,
      x: ym.get('x') as number,
      y: ym.get('y') as number,
      params: all || parts.has('params') ? (ym.get('params') as Y.Map<number>).toJSON() : prev.params,
      data: all || parts.has('data') ? (ym.get('data') as Y.Map<unknown>).toJSON() : prev.data,
    };
  }

  private rebuild() {
    if (!this.dirtyNodes.size && !this.edgesDirty && !this.transportDirty) return;
    const prev = this.snapshot;
    let nodes = prev.nodes;
    if (this.dirtyNodes.size) {
      nodes = { ...prev.nodes };
      this.dirtyNodes.forEach((parts, id) => {
        const ym = this.yNodes.get(id);
        if (!ym || !ym.get('params')) delete nodes[id];
        else nodes[id] = this.readNode(id, ym, prev.nodes[id], parts);
      });
    }
    const edges = this.edgesDirty ? (this.yEdges.toJSON() as Record<string, DocEdge>) : prev.edges;
    const transport = this.transportDirty
      ? ({ ...DEFAULT_TRANSPORT, ...this.yTransport.toJSON() } as TransportState)
      : prev.transport;
    this.dirtyNodes.clear();
    this.edgesDirty = this.transportDirty = false;
    this.snapshot = { transport, nodes, edges };
    this.listeners.forEach((l) => l(this.snapshot, prev));
  }

  get = () => this.snapshot;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private tx(fn: () => void) {
    ydoc.transact(fn, LOCAL);
  }

  isEmpty() {
    return this.yNodes.size === 0;
  }

  replace(doc: Doc) {
    this.tx(() => {
      this.yNodes.clear();
      this.yEdges.clear();
      Object.values(doc.nodes).forEach((n) => this.insertNode(n));
      Object.values(doc.edges).forEach((e) => this.yEdges.set(e.id, e));
      this.setTransportRaw({ ...doc.transport, playing: false });
    });
  }

  private insertNode(n: DocNode) {
    const ym = new Y.Map<unknown>();
    this.yNodes.set(n.id, ym);
    ym.set('type', n.type);
    ym.set('x', n.x);
    ym.set('y', n.y);
    const params = new Y.Map<number>();
    ym.set('params', params);
    Object.entries(n.params).forEach(([k, v]) => params.set(k, v));
    const data = new Y.Map<unknown>();
    ym.set('data', data);
    Object.entries(n.data).forEach(([k, v]) => writeValue(data, k, v));
  }

  private setTransportRaw(t: Partial<TransportState>) {
    Object.entries(t).forEach(([k, v]) => this.yTransport.set(k, v));
  }

  setTransport(t: Partial<TransportState>) {
    // Not undoable on purpose: undo shouldn't stop playback
    ydoc.transact(() => this.setTransportRaw(t));
  }

  addNode(node: DocNode) {
    this.tx(() => this.insertNode(node));
  }

  removeNode(id: string) {
    this.tx(() => {
      this.yNodes.delete(id);
      this.yEdges.forEach((e, eid) => {
        if (e.source === id || e.target === id) this.yEdges.delete(eid);
      });
    });
  }

  moveNode(id: string, x: number, y: number) {
    const ym = this.yNodes.get(id);
    if (!ym) return;
    this.tx(() => {
      ym.set('x', x);
      ym.set('y', y);
    });
  }

  setParam(id: string, param: string, value: number) {
    const params = this.yNodes.get(id)?.get('params') as Y.Map<number> | undefined;
    if (params && params.get(param) !== value) this.tx(() => params.set(param, value));
  }

  setData(id: string, patch: Record<string, unknown>) {
    const data = this.yNodes.get(id)?.get('data') as Y.Map<unknown> | undefined;
    if (data) this.tx(() => Object.entries(patch).forEach(([k, v]) => writeValue(data, k, v)));
  }

  addEdge(edge: DocEdge) {
    const dup = Object.values(this.snapshot.edges).some(
      (e) =>
        e.source === edge.source &&
        e.sourceHandle === edge.sourceHandle &&
        e.target === edge.target &&
        e.targetHandle === edge.targetHandle,
    );
    if (!dup) this.tx(() => this.yEdges.set(edge.id, edge));
  }

  removeEdge(id: string) {
    if (this.yEdges.has(id)) this.tx(() => this.yEdges.delete(id));
  }

  undo() {
    this.undoManager.undo();
  }

  redo() {
    this.undoManager.redo();
  }
}

/** Patch saved by the first (single-user) prototype, if any — used once to seed a new room. */
export function loadLegacyDoc(): Doc | null {
  try {
    const raw = localStorage.getItem('web-daw-doc-v1');
    if (!raw) return null;
    const old = JSON.parse(raw) as { bpm?: number; nodes: Doc['nodes']; edges: Doc['edges'] };
    return { transport: { ...DEFAULT_TRANSPORT, bpm: old.bpm ?? 120 }, nodes: old.nodes, edges: old.edges };
  } catch {
    return null;
  }
}

export const store = new DocStore();

export function useDoc<T>(select: (d: Doc) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
