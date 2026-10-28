import { useEffect, useRef, type DragEvent, type PointerEvent } from 'react';
import { useLive } from '../engine/engine';
import type { ModuleDef, NoteEvent, PanelProps } from '../engine/types';
import { at, releaseTo, smooth } from './util';

// ---------------------------------------------------------------------------
// Drums: 4 synthesized one-shot samples, playable from MIDI or by tapping pads
// ---------------------------------------------------------------------------

export const DRUM_NAMES = ['Kick', 'Snare', 'Hat', 'Clap'];
export const DRUM_NOTES = [36, 38, 42, 39];
/** Pitch class → pad, so any keyboard octave works (C kick, D snare, D# clap, F# hat) */
const PAD_BY_PITCH: Record<number, number> = { 0: 0, 2: 1, 6: 2, 3: 3 };

function render(ctx: BaseAudioContext, seconds: number, fn: (t: number, noise: number) => number) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = fn(i / sr, Math.random() * 2 - 1);
  return buf;
}

function drumKit(ctx: BaseAudioContext) {
  let phase = 0;
  const sr = ctx.sampleRate;
  const kick = render(ctx, 0.6, (t) => {
    phase += (2 * Math.PI * (45 + 110 * Math.exp(-t * 28))) / sr;
    return Math.sin(phase) * Math.exp(-t * 6) + (t < 0.002 ? 0.4 : 0);
  });
  let prev = 0;
  const hp = (x: number) => {
    const y = x - prev;
    prev = x;
    return y;
  };
  const snare = render(ctx, 0.3, (t, n) => hp(n) * 0.5 * Math.exp(-t * 16) + Math.sin(2 * Math.PI * 185 * t) * 0.5 * Math.exp(-t * 28));
  const hat = render(ctx, 0.12, (_t, n) => hp(n) * 0.35 * Math.exp(-_t * 40));
  const clap = render(ctx, 0.4, (t, n) => {
    let env = 0;
    for (const t0 of [0, 0.011, 0.022]) if (t >= t0) env = Math.max(env, Math.exp(-(t - t0) * 160));
    if (t > 0.03) env = Math.max(env, 0.6 * Math.exp(-(t - 0.03) * 11));
    return hp(n) * 0.6 * env;
  });
  return [kick, snare, hat, clap];
}

export const drums: ModuleDef = {
  type: 'drums',
  title: 'Drum Sampler',
  category: 'instrument',
  inputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'l0', label: 'Kick', min: 0, max: 1.2, default: 1 },
    { id: 'l1', label: 'Snare', min: 0, max: 1.2, default: 0.8 },
    { id: 'l2', label: 'Hat', min: 0, max: 1.2, default: 0.6 },
    { id: 'l3', label: 'Clap', min: 0, max: 1.2, default: 0.7 },
    { id: 'tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st' },
    { id: 'volume', label: 'Volume', min: 0, max: 1, default: 0.8 },
  ],
  create({ ctx, live }, p) {
    const out = ctx.createGain();
    out.gain.value = p.volume;
    const kit = drumKit(ctx);
    const hits = [0, 0, 0, 0];

    const hit = (pad: number, velocity = 1, time = ctx.currentTime) => {
      const t = at(ctx, time);
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      src.buffer = kit[pad];
      src.playbackRate.value = Math.pow(2, p.tune / 12);
      g.gain.value = p[`l${pad}`] * velocity;
      src.connect(g).connect(out);
      src.onended = () => g.disconnect();
      src.start(t);
      hits[pad]++;
      live([...hits], t);
    };

    return {
      outputs: { out },
      onEvent(_port, ev) {
        if (ev.type !== 'noteOn') return;
        const pad = PAD_BY_PITCH[ev.note % 12];
        if (pad !== undefined) hit(pad, ev.velocity, ev.time);
      },
      setParam(id, v, t) {
        p[id] = v;
        if (id === 'volume') smooth(out.gain, v, t);
      },
      api: { hit },
    };
  },
  Panel: DrumPads,
};

function DrumPads({ id, engine }: PanelProps) {
  const hits = useLive<number[]>(id) ?? [0, 0, 0, 0];
  return (
    <div className="pads nodrag nopan" style={{ touchAction: 'none' }} onContextMenu={(e) => e.preventDefault()}>
      {DRUM_NAMES.map((name, i) => (
        <button
          key={name}
          className="pad"
          onPointerDown={(e: PointerEvent) => {
            e.preventDefault();
            // Sound first, everything else after. Goes through the engine so the tap is also heard on other devices
            engine.input(id, 'midi', {
              type: 'noteOn',
              note: DRUM_NOTES[i],
              velocity: 1,
              time: engine.ctx.currentTime,
              origin: e.timeStamp,
              source: e.pointerType === 'touch' ? 'Drum pad (touch)' : 'Drum pad (mouse)',
            });
            if (engine.ctx.state !== 'running') engine.resume();
          }}
        >
          <span key={hits[i]} className={hits[i] ? 'flash' : ''} />
          {name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sampler: plays one sample pitched across the keyboard. Drop an audio file on it.
// ---------------------------------------------------------------------------

/** Default sample: a plucked string (Karplus–Strong) at middle C */
function pluck(ctx: BaseAudioContext) {
  const sr = ctx.sampleRate;
  const N = Math.round(sr / 261.63);
  const len = Math.floor(sr * 1.6);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = i < N ? Math.random() * 2 - 1 : 0.996 * 0.5 * (d[i - N] + d[i - N - 1 < 0 ? 0 : i - N - 1]);
  }
  for (let i = 0; i < len; i++) d[i] *= 0.6;
  return buf;
}

interface SamplerLive {
  name: string;
  version: number;
}

export const sampler: ModuleDef = {
  type: 'sampler',
  title: 'Sampler',
  category: 'instrument',
  width: 250,
  inputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'root', label: 'Root', min: 24, max: 96, step: 1, default: 60 },
    { id: 'attack', label: 'Attack', min: 0.001, max: 1, default: 0.002, curve: 'log', unit: 's' },
    { id: 'release', label: 'Release', min: 0.01, max: 3, default: 0.4, curve: 'log', unit: 's' },
    { id: 'gate', label: 'Gate', kind: 'toggle', default: 0 },
    { id: 'volume', label: 'Volume', min: 0, max: 1.5, default: 0.8 },
  ],
  create({ ctx, live }, p) {
    const out = ctx.createGain();
    out.gain.value = p.volume;
    let buffer = pluck(ctx);
    let version = 0;
    const voices = new Map<number, { src: AudioBufferSourceNode; g: GainNode }>();
    live({ name: 'Pluck (built-in)', version } satisfies SamplerLive);

    const stop = (note: number, time: number) => {
      const v = voices.get(note);
      if (!v) return;
      releaseTo(v.g.gain, 0, time, p.release);
      v.src.stop(time + p.release * 2 + 0.05);
      voices.delete(note);
    };

    const play = (ev: NoteEvent) => {
      {
        const t = at(ctx, ev.time);
        if (ev.type === 'noteOff') {
          if (p.gate) stop(ev.note, t);
          return;
        }
        stop(ev.note, t);
        const src = ctx.createBufferSource();
        const g = ctx.createGain();
        src.buffer = buffer;
        src.playbackRate.value = Math.pow(2, (ev.note - p.root) / 12);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(ev.velocity, t + p.attack);
        src.connect(g).connect(out);
        src.onended = () => {
          g.disconnect();
          if (voices.get(ev.note)?.src === src) voices.delete(ev.note);
        };
        src.start(t);
        voices.set(ev.note, { src, g });
      }
    };

    return {
      outputs: { out },
      onEvent: (_port, ev) => play(ev),
      setParam(id, v, t) {
        p[id] = v;
        if (id === 'volume') smooth(out.gain, v, t);
      },
      onStop() {
        voices.forEach((_v, n) => stop(n, ctx.currentTime));
      },
      api: {
        async load(file: File) {
          buffer = await ctx.decodeAudioData(await file.arrayBuffer());
          live({ name: file.name, version: ++version } satisfies SamplerLive);
        },
        getBuffer: () => buffer,
        preview: () => play({ type: 'noteOn', note: p.root, velocity: 1, time: ctx.currentTime }),
      },
    };
  },
  Panel: SamplerPanel,
};

function SamplerPanel({ id, engine }: PanelProps) {
  const info = useLive<SamplerLive>(id);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const api = () => engine.instances.get(id)?.api;

  useEffect(() => {
    const c = canvas.current;
    const buf: AudioBuffer | undefined = api()?.getBuffer();
    if (!c || !buf) return;
    const g = c.getContext('2d')!;
    const data = buf.getChannelData(0);
    const w = c.width;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(c).color;
    const step = Math.max(1, Math.floor(data.length / w));
    for (let x = 0; x < w; x++) {
      let peak = 0;
      for (let i = x * step; i < (x + 1) * step && i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i]));
      const bar = Math.max(1, peak * h);
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [info?.version]);

  const load = (file?: File) => {
    if (file) api()?.load(file).catch(() => alert('Could not decode that file.'));
  };

  return (
    <div
      className="sampler nodrag"
      onDragOver={(e: DragEvent) => e.preventDefault()}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        load(e.dataTransfer.files[0]);
      }}
    >
      <canvas ref={canvas} width={220} height={44} className="wave" onPointerDown={() => api()?.preview()} />
      <div className="sampler-row">
        <span className="sample-name" title={info?.name}>{info?.name}</span>
        <button onClick={() => fileInput.current?.click()}>Load…</button>
      </div>
      <div className="muted small">Drop an audio file here. Click the waveform to preview.</div>
      <input ref={fileInput} type="file" accept="audio/*" hidden onChange={(e) => load(e.target.files?.[0])} />
    </div>
  );
}
