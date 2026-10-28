import type { ModuleDef } from '../engine/types';
import { smooth } from './util';

const FILTER_TYPES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch'];

export const filter: ModuleDef = {
  type: 'filter',
  title: 'Filter',
  category: 'effect',
  inputs: [
    { id: 'in', label: 'In', type: 'audio' },
    { id: 'cutoff', label: 'Cutoff mod', type: 'control' },
  ],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'type', label: 'Type', kind: 'enum', options: ['LP', 'HP', 'BP', 'Notch'], default: 0 },
    { id: 'cutoff', label: 'Cutoff', min: 20, max: 18000, default: 1200, curve: 'log', unit: 'Hz' },
    { id: 'q', label: 'Reso', min: 0.1, max: 20, default: 1 },
  ],
  create({ ctx }, p) {
    const f = ctx.createBiquadFilter();
    f.type = FILTER_TYPES[p.type];
    f.frequency.value = p.cutoff;
    f.Q.value = p.q;
    return {
      inputs: { in: f, cutoff: f.frequency },
      outputs: { out: f },
      setParam(id, v, t) {
        if (id === 'type') f.type = FILTER_TYPES[v];
        if (id === 'cutoff') smooth(f.frequency, v, t);
        if (id === 'q') smooth(f.Q, v, t);
      },
    };
  },
};

export const delay: ModuleDef = {
  type: 'delay',
  title: 'Delay',
  category: 'effect',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'time', label: 'Time', min: 0.02, max: 1.5, default: 0.375, curve: 'log', unit: 's' },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.4 },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3 },
  ],
  create({ ctx }, p) {
    const input = ctx.createGain();
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const fb = ctx.createGain();
    const d = ctx.createDelay(2);
    d.delayTime.value = p.time;
    fb.gain.value = p.feedback;
    dry.gain.value = 1 - p.mix;
    wet.gain.value = p.mix;
    input.connect(dry).connect(out);
    input.connect(d).connect(wet).connect(out);
    d.connect(fb).connect(d);
    return {
      inputs: { in: input },
      outputs: { out },
      setParam(id, v, t) {
        if (id === 'time') smooth(d.delayTime, v, t, 0.05);
        if (id === 'feedback') smooth(fb.gain, v, t);
        if (id === 'mix') {
          smooth(dry.gain, 1 - v, t);
          smooth(wet.gain, v, t);
        }
      },
    };
  },
};

function impulse(ctx: BaseAudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export const reverb: ModuleDef = {
  type: 'reverb',
  title: 'Reverb',
  category: 'effect',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'size', label: 'Size', min: 0.3, max: 6, default: 2.2, unit: 's' },
    { id: 'decay', label: 'Decay', min: 1, max: 8, default: 3 },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.2 },
  ],
  create({ ctx }, p) {
    const input = ctx.createGain();
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, p.size, p.decay);
    dry.gain.value = 1 - p.mix;
    wet.gain.value = p.mix;
    input.connect(dry).connect(out);
    input.connect(conv).connect(wet).connect(out);
    let timer: number | undefined;
    return {
      inputs: { in: input },
      outputs: { out },
      setParam(id, v, t) {
        p[id] = v;
        if (id === 'mix') {
          smooth(dry.gain, 1 - v, t);
          smooth(wet.gain, v, t);
        } else {
          clearTimeout(timer);
          timer = window.setTimeout(() => (conv.buffer = impulse(ctx, p.size, p.decay)), 150);
        }
      },
      dispose: () => clearTimeout(timer),
    };
  },
};

export const lfo: ModuleDef = {
  type: 'lfo',
  title: 'LFO',
  category: 'modulation',
  inputs: [],
  outputs: [{ id: 'out', label: 'Mod', type: 'control' }],
  params: [
    { id: 'wave', label: 'Wave', kind: 'enum', options: ['Sin', 'Tri', 'Sqr', 'Saw'], default: 0 },
    { id: 'rate', label: 'Rate', min: 0.05, max: 20, default: 0.5, curve: 'log', unit: 'Hz' },
    { id: 'depth', label: 'Depth', min: 0, max: 5000, default: 800 },
  ],
  create({ ctx }, p) {
    const waves: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth'];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = waves[p.wave];
    osc.frequency.value = p.rate;
    gain.gain.value = p.depth;
    osc.connect(gain);
    osc.start();
    return {
      outputs: { out: gain },
      setParam(id, v, t) {
        if (id === 'wave') osc.type = waves[v];
        if (id === 'rate') smooth(osc.frequency, v, t);
        if (id === 'depth') smooth(gain.gain, v, t);
      },
      dispose: () => osc.stop(),
    };
  },
};
