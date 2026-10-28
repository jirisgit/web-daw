import type { ModuleDef, NoteEvent } from '../engine/types';
import { at, mtof, releaseTo, smooth } from './util';

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
