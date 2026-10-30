import type { ModuleDef } from '../engine/types';
import { at, attackTo, releaseTo, smooth } from './util';

// ---------------------------------------------------------------------------
// ADSR envelope: notes in, control signal out
// ---------------------------------------------------------------------------

/** Multipliers so one knob can reach a VCA (0..1) or a filter cutoff (thousands of Hz). */
const SCALES = [1, 100, 1000, 10000];

export const adsr: ModuleDef = {
  type: 'adsr',
  title: 'Envelope',
  category: 'modulation',
  inputs: [{ id: 'midi', label: 'Gate', type: 'midi' }],
  outputs: [{ id: 'out', label: 'Env', type: 'control' }],
  params: [
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.01, curve: 'log', unit: 's' },
    { id: 'decay', label: 'Decay', min: 0.01, max: 4, default: 0.3, curve: 'log', unit: 's' },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.6 },
    { id: 'release', label: 'Release', min: 0.01, max: 8, default: 0.5, curve: 'log', unit: 's' },
    { id: 'amount', label: 'Amount', min: -1, max: 1, default: 1 },
    { id: 'scale', label: 'Scale', kind: 'enum', options: ['×1', '×100', '×1k', '×10k'], default: 0 },
    { id: 'velocity', label: 'Vel sens', min: 0, max: 1, default: 0 },
  ],
  create({ ctx }, p) {
    const env = ctx.createConstantSource();
    const amount = ctx.createGain();
    env.offset.value = 0;
    amount.gain.value = p.amount * SCALES[p.scale];
    env.connect(amount);
    env.start();
    // Notes still held, so the envelope only releases when the last key lifts
    const held = new Set<number>();

    return {
      outputs: { out: amount },
      onEvent(_port, ev) {
        const t = at(ctx, ev.time);
        if (ev.type === 'noteOn') {
          held.add(ev.note);
          const peak = 1 - p.velocity * (1 - ev.velocity);
          attackTo(env.offset, peak, p.sustain, t, p.attack, p.decay);
        } else {
          held.delete(ev.note);
          if (held.size === 0) releaseTo(env.offset, 0, t, p.release);
        }
      },
      setParam(id, v, t) {
        p[id] = v;
        if (id === 'amount' || id === 'scale') smooth(amount.gain, p.amount * SCALES[p.scale], t);
      },
      onStop() {
        held.clear();
        releaseTo(env.offset, 0, ctx.currentTime, p.release);
      },
      dispose: () => env.stop(),
    };
  },
};
