import type { ModuleDef } from '../engine/types';

// ---------------------------------------------------------------------------
// Arpeggiator: plays the held notes one at a time, in time with the transport
// ---------------------------------------------------------------------------

interface Held {
  note: number;
  velocity: number;
  /** Audio time the key went down / up. Using event times (not arrival times) keeps devices in step. */
  on: number;
  off?: number;
}

/** Steps (16ths) per arp note for each rate option */
const RATE_STEPS = [4, 2, 1];

export const arp: ModuleDef = {
  type: 'arp',
  title: 'Arpeggiator',
  category: 'sequencer',
  inputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  outputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  params: [
    { id: 'mode', label: 'Mode', kind: 'enum', options: ['Up', 'Down', 'Up/Dn', 'Played'], default: 0 },
    { id: 'rate', label: 'Rate', kind: 'enum', options: ['1/4', '1/8', '1/16'], default: 2 },
    { id: 'octaves', label: 'Octaves', min: 1, max: 4, step: 1, default: 1 },
    { id: 'gate', label: 'Gate', min: 0.05, max: 1, default: 0.5 },
  ],
  create({ emit }, p) {
    let held: Held[] = [];
    let index = 0;

    const sequence = (active: Held[]) => {
      const base =
        p.mode === 3
          ? active.map((h) => h.note)
          : [...new Set(active.map((h) => h.note))].sort((a, b) => a - b);
      const notes: number[] = [];
      for (let o = 0; o < p.octaves; o++) base.forEach((n) => notes.push(n + 12 * o));
      if (p.mode === 1) notes.reverse();
      if (p.mode === 2 && notes.length > 2) notes.push(...notes.slice(1, -1).reverse());
      return notes;
    };

    return {
      onEvent(_port, ev) {
        if (ev.type === 'noteOn') {
          held.push({ note: ev.note, velocity: ev.velocity, on: ev.time });
        } else {
          const h = held.find((x) => x.note === ev.note && x.off === undefined);
          if (h) h.off = ev.time;
        }
      },
      onStep(step, time, dur) {
        held = held.filter((h) => h.off === undefined || h.off > time - 1);
        const div = RATE_STEPS[p.rate] ?? 1;
        if (step % div !== 0) return;
        const active = held.filter((h) => h.on <= time + 1e-3 && (h.off === undefined || h.off > time + 1e-3));
        if (!active.length) {
          index = 0;
          return;
        }
        const notes = sequence(active);
        const note = notes[index % notes.length];
        index++;
        const velocity = active[active.length - 1].velocity;
        emit('midi', { type: 'noteOn', note, velocity, time });
        emit('midi', { type: 'noteOff', note, velocity: 0, time: time + div * dur * p.gate });
      },
      onStop() {
        index = 0;
      },
      setParam(id, v) {
        p[id] = v;
      },
    };
  },
};
