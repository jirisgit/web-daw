import { useRef, type PointerEvent } from 'react';
import { useLive } from '../engine/engine';
import type { ModuleDef, PanelProps } from '../engine/types';
import { DRUM_BASE, DRUM_NAMES, PAD_ORDER, SLOTS } from './drums';

// ---------------------------------------------------------------------------
// Pads: 16 touch pads for finger drumming. Sends MIDI, so it can play anything.
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
/** Drum names when the pads cover the drum sampler's notes, note names otherwise */
const padLabel = (n: number) => (n >= DRUM_BASE && n < DRUM_BASE + SLOTS ? DRUM_NAMES[n - DRUM_BASE] : noteName(n));

export const pads: ModuleDef = {
  type: 'pads',
  title: 'Pads',
  category: 'input',
  width: 320,
  inputs: [],
  outputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  params: [
    { id: 'base', label: 'Base note', min: 0, max: 112, step: 1, default: DRUM_BASE },
    { id: 'velocity', label: 'Velocity', min: 0.05, max: 1, default: 0.9 },
    { id: 'velY', label: 'Vel by height', kind: 'toggle', default: 0 },
  ],
  create({ ctx, emit, live }, p) {
    /** How many fingers are on each note. Every tap retriggers (for rolls); the note ends when the last finger lifts. */
    const fingers = new Map<number, number>();
    const publish = () => live([...fingers.keys()]);

    const noteOn = (note: number, velocity?: number, origin?: number, source = 'Pads') => {
      emit('midi', { type: 'noteOn', note, velocity: velocity ?? p.velocity, time: ctx.currentTime, origin, source });
      fingers.set(note, (fingers.get(note) ?? 0) + 1);
      publish();
    };
    const noteOff = (note: number) => {
      const n = fingers.get(note);
      if (!n) return;
      if (n > 1) fingers.set(note, n - 1);
      else {
        fingers.delete(note);
        emit('midi', { type: 'noteOff', note, velocity: 0, time: ctx.currentTime });
      }
      publish();
    };

    return {
      setParam(id, v) {
        p[id] = v;
      },
      api: { noteOn, noteOff },
      dispose() {
        for (const note of [...fingers.keys()]) {
          fingers.set(note, 1);
          noteOff(note);
        }
      },
    };
  },
  Panel: PadsPanel,
};

function PadsPanel({ id, node, engine }: PanelProps) {
  const held = useLive<number[]>(id) ?? [];
  const base = node.params.base ?? DRUM_BASE;
  const velY = !!node.params.velY;
  /** Which note each finger (pointer) is holding, so lifting it releases the right pad */
  const pointers = useRef(new Map<number, number>());
  const api = () => engine.instances.get(id)?.api;

  const release = (e: PointerEvent) => {
    const note = pointers.current.get(e.pointerId);
    if (note === undefined) return;
    pointers.current.delete(e.pointerId);
    api()?.noteOff(note);
  };

  return (
    <div className="pads big nodrag nopan" style={{ touchAction: 'none' }} onContextMenu={(e) => e.preventDefault()}>
      {PAD_ORDER.map((slot) => {
        const note = base + slot;
        return (
          <button
            key={slot}
            className={`pad ${held.includes(note) ? 'down' : ''}`}
            onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
              e.preventDefault();
              let velocity: number | undefined;
              if (velY) {
                // Higher on the pad = louder
                const r = e.currentTarget.getBoundingClientRect();
                velocity = 0.25 + 0.75 * Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
              }
              // Sound first, everything else after
              api()?.noteOn(note, velocity, e.timeStamp, e.pointerType === 'touch' ? 'Pads (touch)' : 'Pads (mouse)');
              e.currentTarget.setPointerCapture(e.pointerId);
              pointers.current.set(e.pointerId, note);
              if (engine.ctx.state !== 'running') engine.resume();
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
          >
            <span />
            {padLabel(note)}
          </button>
        );
      })}
    </div>
  );
}
