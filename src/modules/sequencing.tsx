import { useRef, type PointerEvent } from 'react';
import { useLive } from '../engine/engine';
import { store } from '../engine/doc';
import type { ModuleDef, PanelProps } from '../engine/types';
import { DRUM_NAMES, DRUM_NOTES } from './sound';

/** Lets you click-and-drag across cells to paint them on or off. */
function usePaint<T>(apply: (key: T, value: boolean) => void) {
  const paint = useRef<boolean | null>(null);
  const up = () => (paint.current = null);
  return (key: T, current: boolean) => ({
    onPointerDown(e: PointerEvent) {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      paint.current = !current;
      apply(key, !current);
      window.addEventListener('pointerup', up, { once: true });
    },
    onPointerEnter() {
      if (paint.current !== null && paint.current !== current) apply(key, paint.current);
    },
  });
}

// ---------------------------------------------------------------------------
// Drum step sequencer: 4 rows × 16 steps
// ---------------------------------------------------------------------------

const emptyPattern = () => DRUM_NOTES.map(() => Array(16).fill(0) as number[]);

export const sequencer: ModuleDef = {
  type: 'sequencer',
  title: 'Step Sequencer',
  category: 'sequencer',
  width: 380,
  inputs: [],
  outputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  params: [{ id: 'swing', label: 'Swing', min: 0, max: 0.6, default: 0 }],
  defaultData: () => {
    const p = emptyPattern();
    [0, 4, 8, 12].forEach((s) => (p[0][s] = 1));
    [4, 12].forEach((s) => (p[1][s] = 1));
    [2, 6, 10, 14].forEach((s) => (p[2][s] = 1));
    return { pattern: p };
  },
  create({ emit, live }, p, data) {
    let pattern = (data.pattern as number[][]) ?? emptyPattern();
    return {
      onStep(step, time, dur) {
        const s = step % 16;
        const t = time + (s % 2 === 1 ? p.swing * dur : 0);
        pattern.forEach((row, r) => {
          if (!row[s]) return;
          emit('midi', { type: 'noteOn', note: DRUM_NOTES[r], velocity: 1, time: t });
          emit('midi', { type: 'noteOff', note: DRUM_NOTES[r], velocity: 0, time: t + dur * 0.5 });
        });
        live(s, t);
      },
      onStop: () => live(-1),
      setParam(id, v) {
        p[id] = v;
      },
      setData(d) {
        pattern = (d.pattern as number[][]) ?? pattern;
      },
    };
  },
  Panel: SequencerPanel,
};

function SequencerPanel({ id, node, setData }: PanelProps) {
  const playhead = useLive<number>(id) ?? -1;
  const pattern = (node.data.pattern as number[][]) ?? emptyPattern();
  const cell = usePaint<[number, number]>(([r, s], on) => {
    const latest = (store.get().nodes[id]?.data.pattern as number[][]) ?? pattern;
    const next = latest.map((row) => [...row]);
    next[r][s] = on ? 1 : 0;
    setData({ pattern: next });
  });
  return (
    <div className="seq nodrag" style={{ touchAction: 'none' }}>
      {pattern.map((row, r) => (
        <div className="seq-row" key={r}>
          <span className="seq-label">{DRUM_NAMES[r]}</span>
          {row.map((on, s) => (
            <div
              key={s}
              className={`seq-cell ${on ? 'on' : ''} ${s === playhead ? 'head' : ''} ${s % 4 === 0 ? 'beat' : ''}`}
              {...cell([r, s], !!on)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automation lane: draw a curve over 1/2/4 bars; outputs a control signal
// ---------------------------------------------------------------------------

const POINTS = 32;
const BARS = [1, 2, 4];

export const automation: ModuleDef = {
  type: 'automation',
  title: 'Automation Lane',
  category: 'modulation',
  width: 300,
  inputs: [],
  outputs: [{ id: 'out', label: 'Mod', type: 'control' }],
  params: [
    { id: 'min', label: 'Min', min: -5000, max: 5000, default: 0 },
    { id: 'max', label: 'Max', min: -5000, max: 5000, default: 2500 },
    { id: 'bars', label: 'Length', kind: 'enum', options: ['1 bar', '2 bars', '4 bars'], default: 1 },
    { id: 'smooth', label: 'Smooth', min: 0, max: 1, default: 0.3 },
  ],
  defaultData: () => ({
    points: Array.from({ length: POINTS }, (_, i) => 0.5 - 0.5 * Math.cos((i / POINTS) * Math.PI * 2)),
  }),
  create({ ctx, live }, p, data) {
    let points = (data.points as number[]) ?? Array(POINTS).fill(0);
    const src = ctx.createConstantSource();
    src.offset.value = p.min + (p.max - p.min) * points[0];
    src.start();
    return {
      outputs: { out: src },
      onStep(step, time, dur) {
        const len = 16 * BARS[p.bars];
        const pos = step % len;
        const v = points[Math.floor((pos / len) * POINTS)];
        src.offset.setTargetAtTime(p.min + (p.max - p.min) * v, time, 0.003 + p.smooth * dur);
        live(pos / len, time);
      },
      onStop: () => live(-1),
      setParam(id, v) {
        p[id] = v;
      },
      setData(d) {
        points = (d.points as number[]) ?? points;
      },
      dispose: () => src.stop(),
    };
  },
  Panel: AutomationPanel,
};

function AutomationPanel({ id, node, setData }: PanelProps) {
  const head = useLive<number>(id) ?? -1;
  const points = (node.data.points as number[]) ?? Array(POINTS).fill(0);
  const box = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);

  const paint = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * POINTS);
    const v = 1 - (e.clientY - r.top) / r.height;
    if (i < 0 || i >= POINTS) return;
    // Read the latest doc, not this render's props: pointer moves can outrun React
    const next = [...((store.get().nodes[id]?.data.points as number[]) ?? points)];
    next[i] = Math.min(1, Math.max(0, v));
    setData({ points: next });
  };

  return (
    <div
      ref={box}
      className="auto nodrag"
      style={{ touchAction: 'none' }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = true;
        paint(e);
      }}
      onPointerMove={(e) => drawing.current && paint(e)}
      onPointerUp={() => (drawing.current = false)}
      onPointerCancel={() => (drawing.current = false)}
    >
      {points.map((v, i) => (
        <div key={i} className="auto-bar" style={{ height: `${v * 100}%` }} />
      ))}
      {head >= 0 && <div className="auto-head" style={{ left: `${head * 100}%` }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piano roll: notes with pitch and length over 1, 2 or 4 bars
// ---------------------------------------------------------------------------

/** s = start step, n = MIDI note, l = length in steps */
interface RollNote {
  s: number;
  n: number;
  l: number;
}

const ROWS = 24;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (n: number) => [1, 3, 6, 8, 10].includes(n % 12);
/** Lowest visible note: C of the chosen octave (octave 3 → C3 = 48) */
const bottomNote = (octave: number) => 12 * (octave + 1);

export const pianoRoll: ModuleDef = {
  type: 'pianoRoll',
  title: 'Piano Roll',
  category: 'sequencer',
  width: 440,
  inputs: [],
  outputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  params: [
    { id: 'bars', label: 'Length', kind: 'enum', options: ['1 bar', '2 bars', '4 bars'], default: 0 },
    { id: 'octave', label: 'View oct', min: 0, max: 7, step: 1, default: 2 },
    { id: 'velocity', label: 'Velocity', min: 0.05, max: 1, default: 0.8 },
  ],
  defaultData: () => ({
    notes: [
      { s: 0, n: 36, l: 3 },
      { s: 4, n: 43, l: 2 },
      { s: 8, n: 39, l: 3 },
      { s: 12, n: 41, l: 2 },
    ] as RollNote[],
  }),
  create({ ctx, emit, live }, p, data) {
    let notes = (data.notes as RollNote[]) ?? [];
    return {
      onStep(step, time, dur) {
        const len = 16 * BARS[p.bars];
        const pos = step % len;
        for (const n of notes) {
          if (n.s !== pos) continue;
          emit('midi', { type: 'noteOn', note: n.n, velocity: p.velocity, time });
          emit('midi', { type: 'noteOff', note: n.n, velocity: 0, time: time + Math.max(0.01, n.l * dur - 0.005) });
        }
        live(pos, time);
      },
      onStop: () => live(-1),
      setParam(id, v) {
        p[id] = v;
      },
      setData(d) {
        notes = (d.notes as RollNote[]) ?? notes;
      },
      api: {
        /** Play a note on this device only, so the person drawing hears what they place */
        preview(note: number) {
          const t = ctx.currentTime;
          emit('midi', { type: 'noteOn', note, velocity: p.velocity, time: t });
          emit('midi', { type: 'noteOff', note, velocity: 0, time: t + 0.15 });
        },
      },
    };
  },
  Panel: PianoRollPanel,
};

function PianoRollPanel({ id, node, engine, setData }: PanelProps) {
  const head = useLive<number>(id) ?? -1;
  const notes = (node.data.notes as RollNote[]) ?? [];
  const cols = 16 * BARS[node.params.bars ?? 0];
  const low = bottomNote(node.params.octave ?? 2);
  const grid = useRef<HTMLDivElement>(null);
  /** The note being stretched while the pointer is down */
  const drag = useRef<RollNote | null>(null);
  const lastLen = useRef(1);

  const latest = () => (store.get().nodes[id]?.data.notes as RollNote[]) ?? notes;
  const cellAt = (e: PointerEvent) => {
    const r = grid.current!.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * cols);
    const row = Math.floor(((e.clientY - r.top) / r.height) * ROWS);
    return { col: Math.max(0, Math.min(cols - 1, col)), note: low + (ROWS - 1 - Math.max(0, Math.min(ROWS - 1, row))) };
  };

  return (
    <div className="proll nodrag nopan" style={{ touchAction: 'none' }}>
      <div className="proll-keys">
        {Array.from({ length: ROWS }, (_, i) => {
          const n = low + ROWS - 1 - i;
          return (
            <div key={n} className={`proll-key ${isBlack(n) ? 'black' : ''}`}>
              {n % 12 === 0 ? `${NOTE_NAMES[0]}${n / 12 - 1}` : ''}
            </div>
          );
        })}
      </div>
      <div
        ref={grid}
        className="proll-grid"
        style={{ ['--cols' as string]: cols }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const { col, note } = cellAt(e);
          const all = latest();
          const hit = all.find((n) => n.n === note && n.s <= col && col < n.s + n.l);
          if (hit) {
            setData({ notes: all.filter((n) => n !== hit) });
            return;
          }
          const added = { s: col, n: note, l: Math.min(lastLen.current, cols - col) };
          drag.current = added;
          setData({ notes: [...all, added] });
          engine.instances.get(id)?.api?.preview(note);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const l = Math.max(1, cellAt(e).col - d.s + 1);
          if (l === d.l) return;
          const next = { ...d, l };
          drag.current = next;
          lastLen.current = l;
          setData({ notes: latest().map((n) => (n.s === d.s && n.n === d.n ? next : n)) });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {Array.from({ length: ROWS }, (_, i) => (
          <div key={i} className={`proll-row ${isBlack(low + ROWS - 1 - i) ? 'black' : ''}`} />
        ))}
        {notes
          .filter((n) => n.n >= low && n.n < low + ROWS && n.s < cols)
          .map((n) => (
            <div
              key={`${n.s}:${n.n}`}
              className="proll-note"
              style={{
                left: `${(n.s / cols) * 100}%`,
                width: `${(Math.min(n.l, cols - n.s) / cols) * 100}%`,
                top: `${((low + ROWS - 1 - n.n) / ROWS) * 100}%`,
                height: `${100 / ROWS}%`,
              }}
            />
          ))}
        {head >= 0 && head < cols && <div className="auto-head" style={{ left: `${(head / cols) * 100}%` }} />}
      </div>
    </div>
  );
}
