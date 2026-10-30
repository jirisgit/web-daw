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

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

const dbToGain = (db: number) => Math.pow(10, db / 20);

export const compressor: ModuleDef = {
  type: 'compressor',
  title: 'Compressor',
  category: 'effect',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'threshold', label: 'Thresh', min: -60, max: 0, default: -24, unit: 'dB' },
    { id: 'ratio', label: 'Ratio', min: 1, max: 20, default: 4, curve: 'log' },
    { id: 'attack', label: 'Attack', min: 0.001, max: 0.5, default: 0.01, curve: 'log', unit: 's' },
    { id: 'release', label: 'Release', min: 0.02, max: 1, default: 0.25, curve: 'log', unit: 's' },
    { id: 'knee', label: 'Knee', min: 0, max: 40, default: 6, unit: 'dB' },
    { id: 'makeup', label: 'Makeup', min: 0, max: 24, default: 0, unit: 'dB' },
  ],
  create({ ctx }, p) {
    const comp = ctx.createDynamicsCompressor();
    const out = ctx.createGain();
    comp.threshold.value = p.threshold;
    comp.ratio.value = p.ratio;
    comp.attack.value = p.attack;
    comp.release.value = p.release;
    comp.knee.value = p.knee;
    out.gain.value = dbToGain(p.makeup);
    comp.connect(out);
    return {
      inputs: { in: comp },
      outputs: { out },
      setParam(id, v, t) {
        if (id === 'makeup') smooth(out.gain, dbToGain(v), t);
        else if (id in comp) smooth((comp as unknown as Record<string, AudioParam>)[id], v, t);
      },
      api: { reduction: () => comp.reduction },
    };
  },
};

// ---------------------------------------------------------------------------
// 3-band EQ: low shelf, sweepable mid, high shelf
// ---------------------------------------------------------------------------

export const eq: ModuleDef = {
  type: 'eq',
  title: 'EQ',
  category: 'effect',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'low', label: 'Low', min: -18, max: 18, default: 0, unit: 'dB' },
    { id: 'mid', label: 'Mid', min: -18, max: 18, default: 0, unit: 'dB' },
    { id: 'midFreq', label: 'Mid freq', min: 150, max: 8000, default: 1000, curve: 'log', unit: 'Hz' },
    { id: 'midQ', label: 'Mid Q', min: 0.3, max: 8, default: 1, curve: 'log' },
    { id: 'high', label: 'High', min: -18, max: 18, default: 0, unit: 'dB' },
  ],
  create({ ctx }, p) {
    const low = ctx.createBiquadFilter();
    const mid = ctx.createBiquadFilter();
    const high = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 200;
    low.gain.value = p.low;
    mid.type = 'peaking';
    mid.frequency.value = p.midFreq;
    mid.Q.value = p.midQ;
    mid.gain.value = p.mid;
    high.type = 'highshelf';
    high.frequency.value = 5000;
    high.gain.value = p.high;
    low.connect(mid).connect(high);
    return {
      inputs: { in: low },
      outputs: { out: high },
      setParam(id, v, t) {
        if (id === 'low') smooth(low.gain, v, t);
        if (id === 'mid') smooth(mid.gain, v, t);
        if (id === 'midFreq') smooth(mid.frequency, v, t);
        if (id === 'midQ') smooth(mid.Q, v, t);
        if (id === 'high') smooth(high.gain, v, t);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Distortion: waveshaper with three curve shapes, a tone filter and dry/wet
// ---------------------------------------------------------------------------

function shaperCurve(drive: number, shape: number) {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1 + drive * 30;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    if (shape === 0) curve[i] = Math.tanh(k * x) / Math.tanh(k);
    else if (shape === 1) curve[i] = Math.max(-1, Math.min(1, k * x * 0.5));
    else curve[i] = Math.sin(x * (1 + drive * 6) * Math.PI * 0.5);
  }
  return curve;
}

export const distortion: ModuleDef = {
  type: 'distortion',
  title: 'Distortion',
  category: 'effect',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'shape', label: 'Shape', kind: 'enum', options: ['Soft', 'Hard', 'Fold'], default: 0 },
    { id: 'drive', label: 'Drive', min: 0, max: 1, default: 0.4 },
    { id: 'tone', label: 'Tone', min: 300, max: 18000, default: 6000, curve: 'log', unit: 'Hz' },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1 },
    { id: 'level', label: 'Level', min: 0, max: 1.5, default: 0.7 },
  ],
  create({ ctx }, p) {
    const input = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const out = ctx.createGain();
    shaper.curve = shaperCurve(p.drive, p.shape);
    shaper.oversample = '4x';
    tone.type = 'lowpass';
    tone.frequency.value = p.tone;
    dry.gain.value = 1 - p.mix;
    wet.gain.value = p.mix;
    out.gain.value = p.level;
    input.connect(dry).connect(out);
    input.connect(shaper).connect(tone).connect(wet).connect(out);
    return {
      inputs: { in: input },
      outputs: { out },
      setParam(id, v, t) {
        p[id] = v;
        // A curve can't be scheduled, but it is cheap to rebuild
        if (id === 'drive' || id === 'shape') shaper.curve = shaperCurve(p.drive, p.shape);
        if (id === 'tone') smooth(tone.frequency, v, t);
        if (id === 'level') smooth(out.gain, v, t);
        if (id === 'mix') {
          smooth(dry.gain, 1 - v, t);
          smooth(wet.gain, v, t);
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Panner: stereo width, pan, and an optional auto-pan LFO
// ---------------------------------------------------------------------------

export const panner: ModuleDef = {
  type: 'panner',
  title: 'Panner',
  category: 'effect',
  inputs: [
    { id: 'in', label: 'In', type: 'audio' },
    { id: 'pan', label: 'Pan mod', type: 'control' },
  ],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'pan', label: 'Pan', min: -1, max: 1, default: 0 },
    { id: 'width', label: 'Width', min: 0, max: 2, default: 1 },
    { id: 'rate', label: 'Auto rate', min: 0.05, max: 10, default: 1, curve: 'log', unit: 'Hz' },
    { id: 'depth', label: 'Auto depth', min: 0, max: 1, default: 0 },
  ],
  create({ ctx }, p) {
    // Force stereo so a mono source reaches both sides of the splitter
    const input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    // L' = a·L + b·R, R' = a·R + b·L, with a = (1+w)/2, b = (1-w)/2
    const ll = ctx.createGain();
    const rr = ctx.createGain();
    const lr = ctx.createGain();
    const rl = ctx.createGain();
    const setWidth = (w: number, t: number) => {
      [ll, rr].forEach((g) => smooth(g.gain, (1 + w) / 2, t));
      [lr, rl].forEach((g) => smooth(g.gain, (1 - w) / 2, t));
    };
    [ll, rr].forEach((g) => (g.gain.value = (1 + p.width) / 2));
    [lr, rl].forEach((g) => (g.gain.value = (1 - p.width) / 2));
    input.connect(split);
    split.connect(ll, 0).connect(merge, 0, 0);
    split.connect(rl, 1).connect(merge, 0, 0);
    split.connect(rr, 1).connect(merge, 0, 1);
    split.connect(lr, 0).connect(merge, 0, 1);

    const pan = ctx.createStereoPanner();
    pan.pan.value = p.pan;
    merge.connect(pan);

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = p.rate;
    lfoGain.gain.value = p.depth;
    lfo.connect(lfoGain).connect(pan.pan);
    lfo.start();

    return {
      inputs: { in: input, pan: pan.pan },
      outputs: { out: pan },
      setParam(id, v, t) {
        if (id === 'pan') smooth(pan.pan, v, t);
        if (id === 'width') setWidth(v, t);
        if (id === 'rate') smooth(lfo.frequency, v, t);
        if (id === 'depth') smooth(lfoGain.gain, v, t);
      },
      dispose: () => lfo.stop(),
    };
  },
};
