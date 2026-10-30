import type { ModuleDef, NoteEvent } from '../engine/types';
import { at, attackTo, holdAt, mtof, releaseTo, smooth } from './util';

const WAVES: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
const MAX_VOICES = 12;

interface Voice {
  note: number;
  oscs: OscillatorNode[];
  filter: BiquadFilterNode;
  amp: GainNode;
}

export const synth: ModuleDef = {
  type: 'synth',
  title: 'Poly Synth',
  category: 'instrument',
  inputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'wave', label: 'Wave', kind: 'enum', options: ['Saw', 'Sqr', 'Tri', 'Sin'], default: 0 },
    { id: 'detune', label: 'Detune', min: 0, max: 50, default: 8, unit: 'ct' },
    { id: 'cutoff', label: 'Cutoff', min: 50, max: 15000, default: 1800, curve: 'log', unit: 'Hz' },
    { id: 'reso', label: 'Reso', min: 0.1, max: 15, default: 2 },
    { id: 'envAmt', label: 'Env→Flt', min: 0, max: 8000, default: 2500, unit: 'Hz' },
    { id: 'attack', label: 'Attack', min: 0.001, max: 2, default: 0.005, curve: 'log', unit: 's' },
    { id: 'decay', label: 'Decay', min: 0.01, max: 2, default: 0.25, curve: 'log', unit: 's' },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.5 },
    { id: 'release', label: 'Release', min: 0.01, max: 4, default: 0.3, curve: 'log', unit: 's' },
    { id: 'volume', label: 'Volume', min: 0, max: 1, default: 0.4 },
  ],
  create({ ctx }, params) {
    const out = ctx.createGain();
    out.gain.value = params.volume;
    let voices: Voice[] = [];

    const noteOff = (note: number, time: number) => {
      for (const v of voices.filter((v) => v.note === note)) {
        releaseTo(v.amp.gain, 0, time, params.release);
        releaseTo(v.filter.frequency, params.cutoff, time, params.release);
        v.oscs.forEach((o) => o.stop(time + params.release * 2 + 0.05));
        voices = voices.filter((x) => x !== v);
      }
    };

    const noteOn = (ev: NoteEvent) => {
      const t = at(ctx, ev.time);
      noteOff(ev.note, t);
      if (voices.length >= MAX_VOICES) noteOff(voices[0].note, t);

      const amp = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = params.reso;
      const freq = mtof(ev.note);
      const oscs = [-1, 1].map((sign) => {
        const o = ctx.createOscillator();
        o.type = WAVES[params.wave] ?? 'sawtooth';
        o.frequency.value = freq;
        o.detune.value = sign * params.detune;
        o.connect(filter);
        o.start(t);
        return o;
      });
      filter.connect(amp).connect(out);

      const { attack: a, decay: d, sustain: s, cutoff: c, envAmt: e } = params;
      const peak = 0.5 * ev.velocity;
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + a);
      amp.gain.setTargetAtTime(peak * s, t + a, d / 3);
      filter.frequency.setValueAtTime(c, t);
      filter.frequency.linearRampToValueAtTime(Math.min(c + e, 20000), t + a);
      filter.frequency.setTargetAtTime(Math.min(c + e * s, 20000), t + a, d / 3);

      oscs[0].onended = () => amp.disconnect();
      voices.push({ note: ev.note, oscs, filter, amp });
    };

    return {
      outputs: { out },
      onEvent(_port, ev) {
        if (ev.type === 'noteOn') noteOn(ev);
        else noteOff(ev.note, at(ctx, ev.time));
      },
      setParam(id, value, time) {
        params[id] = value;
        if (id === 'volume') smooth(out.gain, value, time);
      },
      onStop() {
        voices.forEach((v) => noteOff(v.note, ctx.currentTime));
      },
      dispose() {
        voices.forEach((v) => v.oscs.forEach((o) => o.stop()));
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Mono synth: one voice with a sub oscillator, glide and last-note priority
// ---------------------------------------------------------------------------

export const monoSynth: ModuleDef = {
  type: 'monoSynth',
  title: 'Mono Synth',
  category: 'instrument',
  inputs: [
    { id: 'midi', label: 'MIDI', type: 'midi' },
    { id: 'cutoff', label: 'Cutoff mod', type: 'control' },
  ],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'wave', label: 'Wave', kind: 'enum', options: ['Saw', 'Sqr', 'Tri', 'Sin'], default: 0 },
    { id: 'sub', label: 'Sub', min: 0, max: 1, default: 0.4 },
    { id: 'glide', label: 'Glide', min: 0, max: 1, default: 0.05, unit: 's' },
    { id: 'cutoff', label: 'Cutoff', min: 40, max: 12000, default: 600, curve: 'log', unit: 'Hz' },
    { id: 'reso', label: 'Reso', min: 0.1, max: 20, default: 6 },
    { id: 'envAmt', label: 'Env→Flt', min: 0, max: 8000, default: 2000, unit: 'Hz' },
    { id: 'attack', label: 'Attack', min: 0.001, max: 2, default: 0.003, curve: 'log', unit: 's' },
    { id: 'decay', label: 'Decay', min: 0.01, max: 2, default: 0.2, curve: 'log', unit: 's' },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.4 },
    { id: 'release', label: 'Release', min: 0.01, max: 4, default: 0.15, curve: 'log', unit: 's' },
    { id: 'volume', label: 'Volume', min: 0, max: 1, default: 0.5 },
  ],
  create({ ctx }, p) {
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const amp = ctx.createGain();
    const out = ctx.createGain();
    osc.type = WAVES[p.wave] ?? 'sawtooth';
    sub.type = 'square';
    subGain.gain.value = p.sub * 0.6;
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    filter.Q.value = p.reso;
    amp.gain.value = 0;
    out.gain.value = p.volume;
    osc.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(amp).connect(out);
    osc.start();
    sub.start();

    /** Held notes, oldest first. The newest one sounds. */
    let stack: number[] = [];

    const setPitch = (note: number, time: number, glide: boolean) => {
      const f = mtof(note);
      for (const [param, freq] of [
        [osc.frequency, f],
        [sub.frequency, f / 2],
      ] as const) {
        holdAt(param, time);
        if (glide && p.glide > 0.001) param.setTargetAtTime(freq, time, p.glide / 3);
        else param.setValueAtTime(freq, time);
      }
    };

    const trigger = (velocity: number, t: number) => {
      const peak = 0.6 * velocity;
      attackTo(amp.gain, peak, p.sustain, t, p.attack, p.decay);
      const top = Math.min(p.cutoff + p.envAmt, 20000);
      holdAt(filter.frequency, t);
      filter.frequency.linearRampToValueAtTime(top, t + p.attack);
      filter.frequency.setTargetAtTime(Math.min(p.cutoff + p.envAmt * p.sustain, 20000), t + p.attack, p.decay / 3);
    };

    const release = (t: number) => {
      releaseTo(amp.gain, 0, t, p.release);
      releaseTo(filter.frequency, p.cutoff, t, p.release);
    };

    return {
      inputs: { cutoff: filter.frequency },
      outputs: { out },
      onEvent(_port, ev) {
        const t = at(ctx, ev.time);
        if (ev.type === 'noteOn') {
          const legato = stack.length > 0;
          stack = [...stack.filter((n) => n !== ev.note), ev.note];
          setPitch(ev.note, t, legato);
          if (!legato) trigger(ev.velocity, t);
          return;
        }
        const wasTop = stack[stack.length - 1] === ev.note;
        stack = stack.filter((n) => n !== ev.note);
        if (!wasTop) return;
        if (stack.length) setPitch(stack[stack.length - 1], t, true);
        else release(t);
      },
      setParam(id, v, t) {
        p[id] = v;
        if (id === 'wave') osc.type = WAVES[v] ?? 'sawtooth';
        if (id === 'sub') smooth(subGain.gain, v * 0.6, t);
        if (id === 'reso') smooth(filter.Q, v, t);
        if (id === 'volume') smooth(out.gain, v, t);
        if (id === 'cutoff' && stack.length === 0) smooth(filter.frequency, v, t);
      },
      onStop() {
        stack = [];
        release(ctx.currentTime);
      },
      dispose() {
        osc.stop();
        sub.stop();
      },
    };
  },
};
