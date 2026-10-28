/**
 * Audio engine: follows the document and keeps a matching Web Audio graph.
 * Each client runs its own engine; only the document and live notes are shared.
 */
import { useSyncExternalStore } from 'react';
import { store, type Doc, type DocEdge } from './doc';
import { Transport, type Timebase } from './transport';
import type { ModuleDef, ModuleInstance, NoteEvent } from './types';
import { clock, realtime, type LiveMsg } from '../sync/session';
import { latencyStats } from './latency';

/**
 * How incoming edits and remote notes reach the audio:
 * - instant: right away (jam mode, same Wi-Fi)
 * - bar: edits on the next bar line, remote notes on the next step (studio mode, internet)
 */
export type EditPolicy = 'instant' | 'bar';

/** Remote live notes are delayed by this much so network jitter doesn't smear their timing. */
export const JAM_DELAY = 0.02;
/** How far ahead a shared "play" is scheduled, so every device gets the message in time. */
const START_LEAD_MS = 200;

type Pending = (time: number) => void;

const SPEAKER_KEY = 'web-daw-speaker-delay-ms';
const OUTPUT_KEY = 'web-daw-output-device';
const BUFFER_KEY = 'web-daw-buffer';

/**
 * Audio buffer size, per device. 'smallest' asks for 0 s, which the browser clamps
 * to the smallest buffer the sound card allows (can be below 'interactive' on some drivers).
 */
export type BufferMode = 'default' | 'smallest';
export const bufferMode: BufferMode = (() => {
  try {
    return localStorage.getItem(BUFFER_KEY) === 'smallest' ? 'smallest' : 'default';
  } catch {
    return 'default';
  }
})();
/** Takes effect after a reload (the audio context has to be recreated) */
export function setBufferMode(m: BufferMode) {
  try {
    if (m === 'smallest') localStorage.setItem(BUFFER_KEY, m);
    else localStorage.removeItem(BUFFER_KEY);
  } catch {
    /* ignore */
  }
  location.reload();
}

export class Engine implements Timebase {
  readonly ctx: AudioContext;
  readonly transport: Transport;
  readonly instances = new Map<string, ModuleInstance>();
  policy: EditPolicy = 'instant';
  /** Extra output delay this device can't detect itself (e.g. Bluetooth speakers), set by the user */
  speakerDelayMs = Number(localStorage.getItem(SPEAKER_KEY) ?? 0) || 0;

  private doc: Doc | null = null;
  private outEdges = new Map<string, DocEdge[]>();
  private pending: Pending[] = [];
  private liveValues = new Map<string, unknown>();
  private liveListeners = new Map<string, Set<() => void>>();
  private remoteOnTimes = new Map<string, number>();

  constructor() {
    this.ctx = new AudioContext({ latencyHint: bufferMode === 'smallest' ? 0 : 'interactive' });
    this.transport = new Transport(this.ctx, this);
    this.transport.onStep((step, time, dur) => {
      if (step % 16 === 0) this.flush(time);
      this.instances.forEach((i) => i.onStep?.(step, time, dur));
    });
    this.transport.onState((playing) => {
      if (!playing) {
        this.flush(this.ctx.currentTime);
        this.instances.forEach((i) => i.onStop?.());
      }
    });
    realtime.onEvent((m) => this.onRemote(m));
    store.subscribe((d) => this.reconcile(d));
    this.reconcile(store.get());

    // Go back to the output device chosen last time on this computer
    const savedOutput = localStorage.getItem(OUTPUT_KEY);
    if (savedOutput) this.setOutputDevice(savedOutput).catch(() => this.setOutputDevice('').catch(() => {}));
  }

  // ---------- output device (per computer, not shared) ----------

  /** '' = system default */
  outputDeviceId = '';
  private outputListeners = new Set<() => void>();

  get canChooseOutput() {
    return 'setSinkId' in AudioContext.prototype;
  }

  async setOutputDevice(id: string) {
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (!ctx.setSinkId) throw new Error('Choosing an output device needs Chrome or Edge 110 or newer.');
    await ctx.setSinkId(id);
    this.outputDeviceId = id;
    try {
      if (id) localStorage.setItem(OUTPUT_KEY, id);
      else localStorage.removeItem(OUTPUT_KEY);
    } catch {
      /* ignore */
    }
    this.outputListeners.forEach((l) => l());
  }

  onOutputChange(fn: () => void) {
    this.outputListeners.add(fn);
    return () => {
      this.outputListeners.delete(fn);
    };
  }

  /**
   * The module catalog is handed in at startup (see main.tsx) instead of imported,
   * so engine ↔ modules don't import each other (that breaks hot reload).
   */
  private lookup: (type: string) => ModuleDef | undefined = () => undefined;

  setModuleLookup(fn: (type: string) => ModuleDef | undefined) {
    this.lookup = fn;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setSpeakerDelay(ms: number) {
    this.speakerDelayMs = ms;
    try {
      localStorage.setItem(SPEAKER_KEY, String(ms));
    } catch {
      /* ignore */
    }
  }

  // ---------- time conversion ----------

  /** Maps context time ↔ performance.now(), including the sound card's output latency */
  private outputStamp() {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime) return { ctx: ts.contextTime!, perf: ts.performanceTime };
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return { ctx: this.ctx.currentTime - latency, perf: performance.now() };
  }

  toAudioTime(serverMs: number) {
    const s = this.outputStamp();
    return s.ctx + (serverMs - clock.offset - s.perf) / 1000 - this.speakerDelayMs / 1000;
  }

  fromAudioTime(t: number) {
    const s = this.outputStamp();
    return s.perf + (t + this.speakerDelayMs / 1000 - s.ctx) * 1000 + clock.offset;
  }

  // ---------- shared transport controls (they write to the doc; every client follows) ----------

  play() {
    store.setTransport({ playing: true, anchorMs: clock.serverNow() + START_LEAD_MS, anchorStep: 0 });
  }

  stop() {
    store.setTransport({ playing: false });
  }

  setBpm(bpm: number) {
    const s = store.get().transport;
    if (!s.playing) return store.setTransport({ bpm });
    // Re-anchor on a step a little in the future, so everyone switches tempo on the same step
    const stepMs = 60000 / s.bpm / 4;
    const k = s.anchorStep + Math.ceil((clock.serverNow() + START_LEAD_MS - s.anchorMs) / stepMs);
    store.setTransport({ bpm, anchorStep: k, anchorMs: s.anchorMs + (k - s.anchorStep) * stepMs });
  }

  // ---------- edit scheduling ----------

  private schedule(fn: Pending) {
    if (this.policy === 'bar' && this.transport.playing) this.pending.push(fn);
    else fn(this.ctx.currentTime);
  }

  private flush(time: number) {
    const list = this.pending;
    this.pending = [];
    list.forEach((fn) => fn(time));
  }

  // ---------- document → audio graph ----------

  private reconcile(next: Doc) {
    const prev: Doc = this.doc ?? { transport: { ...next.transport, playing: false }, nodes: {}, edges: {} };
    this.doc = next;
    if (next.transport !== prev.transport) this.transport.apply(next.transport);

    for (const id in prev.edges) {
      if (!next.edges[id]) this.disconnect(prev.edges[id]);
    }

    for (const id in prev.nodes) {
      if (!next.nodes[id]) {
        const inst = this.instances.get(id);
        if (inst) {
          Object.values(inst.outputs ?? {}).forEach((n) => n.disconnect());
          inst.dispose?.();
        }
        this.instances.delete(id);
      }
    }

    for (const id in next.nodes) {
      const n = next.nodes[id];
      const p = prev.nodes[id];
      if (!p || !this.instances.has(id)) {
        this.create(id);
        continue;
      }
      if (n === p) continue;
      const inst = this.instances.get(id)!;
      for (const key in n.params) {
        if (n.params[key] !== p.params[key]) {
          const v = n.params[key];
          this.schedule((t) => inst.setParam?.(key, v, t));
        }
      }
      if (n.data !== p.data) {
        const data = n.data;
        this.schedule(() => inst.setData?.(data));
      }
    }

    for (const id in next.edges) {
      if (!prev.edges[id]) this.connect(next.edges[id]);
    }

    this.outEdges.clear();
    for (const e of Object.values(next.edges)) {
      const key = `${e.source}:${e.sourceHandle}`;
      if (!this.outEdges.has(key)) this.outEdges.set(key, []);
      this.outEdges.get(key)!.push(e);
    }
  }

  private create(id: string) {
    const n = this.doc!.nodes[id];
    const def = this.lookup(n.type);
    if (!def) return;
    const params: Record<string, number> = {};
    def.params.forEach((p) => (params[p.id] = n.params[p.id] ?? p.default));
    const shareInput = def.category === 'input';
    const inst = def.create(
      {
        id,
        ctx: this.ctx,
        engine: this,
        emit: (port, ev) => {
          const handled = performance.now();
          this.emit(id, port, ev);
          if (shareInput) {
            this.measure(ev, handled);
            // Notes played on an input module are heard on every device
            this.broadcast('out', id, port, ev);
          }
        },
        live: (value, at) => this.publishLive(id, value, at),
      },
      params,
      n.data,
    );
    this.instances.set(id, inst);
  }

  private connect(e: DocEdge) {
    const from = this.instances.get(e.source)?.outputs?.[e.sourceHandle];
    const to = this.instances.get(e.target)?.inputs?.[e.targetHandle];
    if (!from || !to) return; // midi cables are routed in emit()
    from.connect(to as AudioNode);
  }

  private disconnect(e: DocEdge) {
    const from = this.instances.get(e.source)?.outputs?.[e.sourceHandle];
    const to = this.instances.get(e.target)?.inputs?.[e.targetHandle];
    if (!from || !to) return;
    try {
      from.disconnect(to as AudioNode);
    } catch {
      /* already disconnected */
    }
  }

  // ---------- note events ----------

  emit(sourceId: string, port: string, ev: NoteEvent) {
    const edges = this.outEdges.get(`${sourceId}:${port}`);
    if (!edges) return;
    for (const e of edges) this.instances.get(e.target)?.onEvent?.(e.targetHandle, ev);
  }

  /** Play a note into a module's input (e.g. tapping a drum pad), here and on every other device. */
  input(nodeId: string, port: string, ev: NoteEvent) {
    const handled = performance.now();
    this.instances.get(nodeId)?.onEvent?.(port, ev);
    this.measure(ev, handled);
    this.broadcast('in', nodeId, port, ev);
  }

  /** performance.now() time at which audio scheduled for context time `t` comes out of the speakers */
  perfTimeHeard(t: number) {
    const s = this.outputStamp();
    return s.perf + (Math.max(t, this.ctx.currentTime) - s.ctx) * 1000 + this.speakerDelayMs;
  }

  private measure(ev: NoteEvent, handled: number) {
    if (ev.type !== 'noteOn' || ev.origin === undefined || this.ctx.state !== 'running') return;
    const heard = this.perfTimeHeard(ev.time);
    latencyStats.record({
      source: ev.source ?? 'Unknown',
      inputToApp: handled - ev.origin,
      appToSpeaker: heard - handled,
      total: heard - ev.origin,
      at: handled,
      ctxTime: Math.max(ev.time, this.ctx.currentTime),
    });
  }

  private broadcast(dir: 'in' | 'out', node: string, port: string, ev: NoteEvent) {
    realtime.send({ t: 'ev', dir, node, port, type: ev.type, note: ev.note, vel: ev.velocity, s: this.fromAudioTime(ev.time) });
  }

  private onRemote(m: LiveMsg) {
    if (this.ctx.state !== 'running') return;
    let time = this.toAudioTime(m.s) + JAM_DELAY;
    const key = `${m.node}:${m.note}`;
    if (this.policy === 'bar' && this.transport.playing) {
      // Studio mode: too much latency to play "live", so land notes on the step grid
      if (m.type === 'noteOn') time = this.transport.nextStepTime(Math.max(time, this.ctx.currentTime));
      else time = Math.max(time, (this.remoteOnTimes.get(key) ?? 0) + this.transport.stepDur);
    }
    time = Math.max(time, this.ctx.currentTime);
    if (m.type === 'noteOn') this.remoteOnTimes.set(key, time);
    const ev: NoteEvent = { type: m.type, note: m.note, velocity: m.vel, time };
    if (m.dir === 'out') this.emit(m.node, m.port, ev);
    else this.instances.get(m.node)?.onEvent?.(m.port, ev);
  }

  // ---------- UI-only live state (playheads, meters, device lists) ----------

  private liveQueue = new Map<string, unknown>();
  private liveFrame = 0;

  /**
   * UI updates are collected and applied on the next animation frame, so screen
   * redraws never run in the middle of handling a note.
   */
  private publishLive(id: string, value: unknown, at?: number) {
    const queue = () => {
      this.liveQueue.set(id, value);
      if (!this.liveFrame) this.liveFrame = requestAnimationFrame(this.flushLive);
    };
    const delay = at === undefined ? 0 : (at - this.ctx.currentTime) * 1000;
    if (delay > 1) window.setTimeout(queue, delay);
    else queue();
  }

  private flushLive = () => {
    this.liveFrame = 0;
    const batch = [...this.liveQueue];
    this.liveQueue.clear();
    for (const [id, value] of batch) {
      this.liveValues.set(id, value);
      this.liveListeners.get(id)?.forEach((l) => l());
    }
  };

  subscribeLive(id: string, fn: () => void) {
    if (!this.liveListeners.has(id)) this.liveListeners.set(id, new Set());
    this.liveListeners.get(id)!.add(fn);
    return () => {
      this.liveListeners.get(id)?.delete(fn);
    };
  }

  getLive(id: string) {
    return this.liveValues.get(id);
  }
}

export const engine = new Engine();

export function useLive<T>(id: string): T | undefined {
  return useSyncExternalStore(
    (fn) => engine.subscribeLive(id, fn),
    () => engine.getLive(id) as T | undefined,
  );
}
