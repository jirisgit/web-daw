import { useState, type PointerEvent } from 'react';
import { useLive } from '../engine/engine';
import type { ModuleDef, ParamDef, PanelProps } from '../engine/types';
import { Knob } from '../ui/controls';
import { at, smooth } from './util';

// ---------------------------------------------------------------------------
// Drum Sampler: 16 synthesized one-shots on MIDI notes 36–51 (General MIDI layout)
// ---------------------------------------------------------------------------

/** Slot i plays on note 36 + i. The names follow General MIDI where it has a matching sound. */
export const DRUM_NAMES = [
  'Kick', 'Rim', 'Snare', 'Clap',
  'Snare 2', 'Tom L', 'Hat', 'Tom M',
  'Shaker', 'Tom H', 'Open hat', 'Cowbell',
  '808', 'Crash', 'Zap', 'Ride',
];
export const DRUM_BASE = 36;
export const SLOTS = 16;
const CLOSED_HAT = 6;
const OPEN_HAT = 10;

/**
 * Notes 36–51 map straight to slots. Any other note uses its pitch class,
 * so every keyboard octave reaches the first 12 slots (C kick, D snare, F# hat…).
 */
export const slotForNote = (n: number) => (n >= DRUM_BASE && n < DRUM_BASE + SLOTS ? n - DRUM_BASE : n % 12);

function render(ctx: BaseAudioContext, seconds: number, fn: (t: number, noise: number) => number) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = fn(i / sr, Math.random() * 2 - 1);
  return buf;
}

/** One-pole high-pass, with its own state for each sound */
function highpass() {
  let prev = 0;
  return (x: number) => {
    const y = x - prev;
    prev = x;
    return y;
  };
}

/** A sine whose pitch falls from `start × base` to `base` (kicks, toms, zaps) */
function sweep(sr: number, base: number, start: number, speed: number) {
  let phase = 0;
  return (t: number) => {
    phase += (2 * Math.PI * base * (1 + (start - 1) * Math.exp(-t * speed))) / sr;
    return Math.sin(phase);
  };
}

/** Six detuned square waves, the classic analog cymbal/hat source */
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];
const metal = (t: number, scale: number) => METAL.reduce((s, f) => s + Math.sign(Math.sin(2 * Math.PI * f * scale * t)), 0) / METAL.length;

function drumKit(ctx: BaseAudioContext): AudioBuffer[] {
  const sr = ctx.sampleRate;
  const kick = sweep(sr, 45, 3.4, 28);
  const hpSnare = highpass();
  const hpSnare2 = highpass();
  const hpHat = highpass();
  const hpRim = highpass();
  const hpShaker1 = highpass();
  const hpShaker2 = highpass();
  const hpOpen = highpass();
  const hpCrash = highpass();
  const hpRide = highpass();
  const hpClap = highpass();
  const tom = (base: number) => {
    const s = sweep(sr, base, 1.6, 20);
    return (t: number) => s(t) * 0.8 * Math.exp(-t * 7);
  };
  const boom = sweep(sr, 48, 1.5, 15);
  const zap = sweep(sr, 100, 12, 40);

  return [
    render(ctx, 0.6, (t) => kick(t) * Math.exp(-t * 6) + (t < 0.002 ? 0.4 : 0)),
    render(ctx, 0.08, (t, n) => Math.sin(2 * Math.PI * 1700 * t) * 0.45 * Math.exp(-t * 90) + hpRim(n) * 0.3 * Math.exp(-t * 200)),
    render(ctx, 0.3, (t, n) => hpSnare(n) * 0.5 * Math.exp(-t * 16) + Math.sin(2 * Math.PI * 185 * t) * 0.5 * Math.exp(-t * 28)),
    render(ctx, 0.4, (t, n) => {
      let env = 0;
      for (const t0 of [0, 0.011, 0.022]) if (t >= t0) env = Math.max(env, Math.exp(-(t - t0) * 160));
      if (t > 0.03) env = Math.max(env, 0.6 * Math.exp(-(t - 0.03) * 11));
      return hpClap(n) * 0.6 * env;
    }),
    render(ctx, 0.2, (t, n) => hpSnare2(n) * 0.6 * Math.exp(-t * 30) + Math.sin(2 * Math.PI * 240 * t) * 0.4 * Math.exp(-t * 40)),
    render(ctx, 0.6, tom(90)),
    render(ctx, 0.12, (t, n) => hpHat(n) * 0.35 * Math.exp(-t * 40)),
    render(ctx, 0.5, tom(130)),
    render(ctx, 0.15, (t, n) => hpShaker2(hpShaker1(n)) * 0.35 * Math.min(1, t / 0.012) * Math.exp(-t * 25)),
    render(ctx, 0.45, tom(180)),
    render(ctx, 0.5, (t, n) => hpOpen(metal(t, 1) * 0.6 + n * 0.4) * 0.3 * Math.exp(-t * 7)),
    render(ctx, 0.35, (t) => (Math.sign(Math.sin(2 * Math.PI * 540 * t)) + Math.sign(Math.sin(2 * Math.PI * 800 * t))) * 0.12 * Math.exp(-t * 12)),
    render(ctx, 1.4, (t) => Math.tanh(boom(t) * 1.5 * Math.exp(-t * 2.2)) * 0.9),
    render(ctx, 1.8, (t, n) => hpCrash(metal(t, 1.4) * 0.5 + n * 0.5) * 0.3 * Math.exp(-t * 2.5)),
    render(ctx, 0.25, (t) => zap(t) * 0.5 * Math.exp(-t * 12)),
    render(ctx, 1.5, (t, n) => hpRide(metal(t, 2) * 0.7 + n * 0.3) * 0.15 * Math.exp(-t * 3) + Math.sin(2 * Math.PI * 3200 * t) * 0.05 * Math.exp(-t * 5)),
  ];
}

const SLOT_IDS = Array.from({ length: SLOTS }, (_, i) => i);
const levelParam = (i: number): ParamDef => ({ id: `g${i}`, label: 'Level', min: 0, max: 1.2, default: 0.8 });
const pitchParam = (i: number): ParamDef => ({ id: `p${i}`, label: 'Pitch', min: -12, max: 12, step: 1, default: 0, unit: 'st' });
const TUNE: ParamDef = { id: 'tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st' };
const VOLUME: ParamDef = { id: 'volume', label: 'Volume', min: 0, max: 1, default: 0.8 };

export const drums: ModuleDef = {
  type: 'drums',
  title: 'Drum Sampler',
  category: 'instrument',
  width: 300,
  showParams: false,
  inputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [...SLOT_IDS.flatMap((i) => [levelParam(i), pitchParam(i)]), TUNE, VOLUME],
  create({ ctx, live }, p) {
    const out = ctx.createGain();
    out.gain.value = p.volume;
    const kit = drumKit(ctx);
    const hits = SLOT_IDS.map(() => 0);
    /** The open hat still ringing, so a closed hat can cut it off like on a real kit */
    let openHat: GainNode | null = null;

    const hit = (slot: number, velocity = 1, time = ctx.currentTime) => {
      const t = at(ctx, time);
      if (slot === CLOSED_HAT && openHat) {
        openHat.gain.setTargetAtTime(0, t, 0.01);
        openHat = null;
      }
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      src.buffer = kit[slot];
      src.playbackRate.value = Math.pow(2, (p.tune + p[`p${slot}`]) / 12);
      g.gain.value = p[`g${slot}`] * velocity;
      src.connect(g).connect(out);
      src.onended = () => {
        g.disconnect();
        if (openHat === g) openHat = null;
      };
      src.start(t);
      if (slot === OPEN_HAT) openHat = g;
      hits[slot]++;
      live([...hits], t);
    };

    return {
      outputs: { out },
      onEvent(_port, ev) {
        if (ev.type === 'noteOn') hit(slotForNote(ev.note), ev.velocity, ev.time);
      },
      setParam(id, v, t) {
        p[id] = v;
        if (id === 'volume') smooth(out.gain, v, t);
      },
      api: { hit },
    };
  },
  Panel: DrumPanel,
};

/** Pads in 4 rows with slot 0 at the bottom left, like most drum machines */
export const PAD_ORDER = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];

function DrumPanel({ id, node, engine, setParam }: PanelProps) {
  const hits = useLive<number[]>(id) ?? [];
  const [selected, setSelected] = useState(0);
  const val = (d: ParamDef) => node.params[d.id] ?? d.default;
  const level = levelParam(selected);
  const pitch = pitchParam(selected);
  return (
    <>
      <div className="pads nodrag nopan" style={{ touchAction: 'none' }} onContextMenu={(e) => e.preventDefault()}>
        {PAD_ORDER.map((slot) => (
          <button
            key={slot}
            className={`pad ${slot === selected ? 'selected' : ''}`}
            onPointerDown={(e: PointerEvent) => {
              e.preventDefault();
              // Sound first, everything else after. Goes through the engine so the tap is also heard on other devices
              engine.input(id, 'midi', {
                type: 'noteOn',
                note: DRUM_BASE + slot,
                velocity: 1,
                time: engine.ctx.currentTime,
                origin: e.timeStamp,
                source: e.pointerType === 'touch' ? 'Drum pad (touch)' : 'Drum pad (mouse)',
              });
              if (engine.ctx.state !== 'running') engine.resume();
              setSelected(slot);
            }}
          >
            <span key={hits[slot]} className={hits[slot] ? 'flash' : ''} />
            {DRUM_NAMES[slot]}
          </button>
        ))}
      </div>
      <div className="drum-edit nodrag">
        <span className="drum-edit-name">{DRUM_NAMES[selected]}</span>
        <Knob def={level} value={val(level)} onChange={(v) => setParam(level.id, v)} size={28} />
        <Knob def={pitch} value={val(pitch)} onChange={(v) => setParam(pitch.id, v)} size={28} />
        <Knob def={TUNE} value={val(TUNE)} onChange={(v) => setParam(TUNE.id, v)} size={28} />
        <Knob def={VOLUME} value={val(VOLUME)} onChange={(v) => setParam(VOLUME.id, v)} size={28} />
      </div>
    </>
  );
}
