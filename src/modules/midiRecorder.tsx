import { useLive } from '../engine/engine';
import { store } from '../engine/doc';
import type { ModuleDef, PanelProps } from '../engine/types';

// ---------------------------------------------------------------------------
// MIDI Recorder: captures notes played into it as a loop, then plays the loop back.
//
// The loop is saved in the document, so every device plays it back in sync.
// Arming is local: only the device where Record was pressed writes the take,
// even though live notes from other devices reach every recorder.
// ---------------------------------------------------------------------------

/** s = start and l = length, both in 16th-note steps (fractional when not quantized) */
export interface RecNote {
  s: number;
  n: number;
  v: number;
  l: number;
}

type RecState = 'idle' | 'armed' | 'recording';

interface RecLive {
  state: RecState;
  /** Playhead, in steps within the loop */
  pos: number;
  /** Bars left in a one-pass recording */
  barsLeft?: number;
}

const LOOP_BARS = [1, 2, 4, 8];
/** Grid size in steps for each quantize option (0 = off) */
const GRID = [0, 1, 2];
/** A note played this many steps before the take starts still counts (players often hit slightly early) */
const EARLY = 0.5;
/** Steps to wait after a pass ends before saving it, so late-arriving notes are included */
const SETTLE = 4;

const mod = (x: number, m: number) => ((x % m) + m) % m;

export const midiRecorder: ModuleDef = {
  type: 'midiRecorder',
  title: 'MIDI Recorder',
  category: 'sequencer',
  width: 300,
  inputs: [{ id: 'midi', label: 'In', type: 'midi' }],
  outputs: [{ id: 'midi', label: 'Out', type: 'midi' }],
  params: [
    { id: 'bars', label: 'Length', kind: 'enum', options: ['1', '2', '4', '8'], default: 1 },
    { id: 'quantize', label: 'Quantize', kind: 'enum', options: ['Off', '1/16', '1/8'], default: 1 },
    { id: 'overdub', label: 'Overdub', kind: 'toggle', default: 0 },
    { id: 'thru', label: 'Thru', kind: 'toggle', default: 1 },
  ],
  defaultData: () => ({ notes: [] as RecNote[] }),
  create({ id, ctx, emit, live }, p, data) {
    let notes = (data.notes as RecNote[]) ?? [];
    let state: RecState = 'idle';
    /** Latest step from the transport, to turn note times into step positions */
    let anchor: { step: number; time: number; dur: number } | null = null;
    /** Global step where the current take started, and where a one-pass take ends */
    let startStep = 0;
    let endStep = Infinity;
    /** Passes are saved a few steps after they end; this is the next step at which to save */
    let saveAt = Infinity;
    /** Notes from this take that are not saved yet */
    let take: RecNote[] = [];
    /** True when the take replaces the loop (one pass), false when it adds to it (overdub) */
    let replacing = false;
    /** Notes held down right now: note → global step position and velocity */
    const open = new Map<number, { g: number; v: number }>();

    const loopLen = () => 16 * LOOP_BARS[p.bars];
    const stepAt = (t: number) => (anchor ? anchor.step + (t - anchor.time) / anchor.dur : null);
    const publish = (pos: number, time?: number) => {
      const barsLeft = state === 'recording' && endStep < Infinity ? Math.ceil((endStep - (anchor?.step ?? 0)) / 16) : undefined;
      live({ state, pos, barsLeft } satisfies RecLive, time);
    };

    const capture = (n: number, g: number, end: number, v: number) => {
      const len = loopLen();
      const grid = GRID[p.quantize];
      const start = grid ? Math.round(g / grid) * grid : g;
      take.push({ s: mod(start, len), n, v, l: Math.max(0.25, end - g) });
    };

    /** Write what was captured into the document. Every device then plays it. */
    const save = (replace: boolean) => {
      if (!take.length && !replace) return;
      notes = replace ? take : [...notes, ...take];
      take = [];
      store.setData(id, { notes });
    };

    /** End the take at global step `g`: close notes still held and save. */
    const endTake = (g: number) => {
      open.forEach((o, n) => capture(n, o.g, g, o.v));
      open.clear();
      save(replacing);
      state = 'idle';
      replacing = false;
      endStep = Infinity;
      saveAt = Infinity;
    };

    return {
      onEvent(_port, ev) {
        if (p.thru) emit('midi', ev);
        if (state !== 'recording') return;
        const g = stepAt(ev.time);
        if (g === null) return;
        if (ev.type === 'noteOn') {
          if (g >= startStep - EARLY && g < endStep - EARLY) open.set(ev.note, { g, v: ev.velocity });
        } else {
          const o = open.get(ev.note);
          if (!o) return;
          open.delete(ev.note);
          capture(ev.note, o.g, Math.min(g, endStep), o.v);
        }
      },

      onStep(step, time, dur) {
        anchor = { step, time, dur };
        const len = loopLen();

        if (state === 'armed' && step % 16 === 0) {
          // Start on the next bar line
          state = 'recording';
          startStep = step;
          take = [];
          replacing = !p.overdub;
          if (replacing) {
            endStep = step + len;
            saveAt = endStep + SETTLE;
            // A new take replaces the loop, so stop playing the old one now
            notes = [];
          } else {
            endStep = Infinity;
            saveAt = step + len + SETTLE;
          }
        }

        if (state === 'recording' && step >= saveAt) {
          if (replacing) endTake(endStep);
          else {
            // Overdub keeps going: save each pass so it starts playing on the next loop
            save(false);
            saveAt += len;
          }
        }

        const pos = step % len;
        for (const n of notes) {
          if (n.s < pos || n.s >= pos + 1) continue;
          const t = time + (n.s - pos) * dur;
          emit('midi', { type: 'noteOn', note: n.n, velocity: n.v, time: t });
          emit('midi', { type: 'noteOff', note: n.n, velocity: 0, time: t + Math.max(0.01, n.l * dur - 0.005) });
        }
        publish(pos, time);
      },

      onStop() {
        if (state === 'recording') endTake(Math.min(stepAt(ctx.currentTime) ?? startStep, endStep));
        state = 'idle';
        anchor = null;
        publish(-1);
      },

      setParam(pid, v) {
        p[pid] = v;
      },
      setData(d) {
        // Keep the cleared loop while a replacing take is in progress
        if (state === 'recording' && replacing) return;
        notes = (d.notes as RecNote[]) ?? notes;
      },

      api: {
        record() {
          if (state !== 'idle') return;
          state = 'armed';
          publish(-1);
        },
        stop() {
          if (state === 'recording') endTake(Math.min(stepAt(ctx.currentTime) ?? startStep, endStep));
          state = 'idle';
          publish(-1);
        },
        clear() {
          notes = [];
          take = [];
          store.setData(id, { notes: [] });
        },
      },
    };
  },
  Panel: MidiRecorderPanel,
};

function MidiRecorderPanel({ id, node, engine }: PanelProps) {
  const s = useLive<RecLive>(id) ?? { state: 'idle', pos: -1 };
  const notes = (node.data.notes as RecNote[]) ?? [];
  const len = 16 * LOOP_BARS[node.params.bars ?? 1];
  const api = () => engine.instances.get(id)?.api;
  const pitches = notes.map((n) => n.n);
  const lo = pitches.length ? Math.min(...pitches) : 60;
  const hi = pitches.length ? Math.max(...pitches) : 60;
  const rows = hi - lo + 1;
  const playing = engine.transport.playing;

  const status =
    s.state === 'armed'
      ? playing
        ? 'Starts on the next bar…'
        : 'Armed. Press Play to start.'
      : s.state === 'recording'
        ? s.barsLeft !== undefined
          ? `Recording · ${s.barsLeft} bar${s.barsLeft === 1 ? '' : 's'} left`
          : 'Overdubbing…'
        : `${notes.length} note${notes.length === 1 ? '' : 's'}`;

  return (
    <div className="midirec nodrag">
      <div className="rec-row">
        {s.state === 'idle' ? (
          <button className="rec-btn" onClick={() => api()?.record()}>
            ● Record
          </button>
        ) : (
          <button className="rec-btn on" onClick={() => api()?.stop()}>
            ■ Stop
          </button>
        )}
        <button className="rec-btn" disabled={!notes.length || s.state !== 'idle'} onClick={() => api()?.clear()}>
          Clear
        </button>
        <span className="muted small">{status}</span>
      </div>
      <div className="midirec-roll" style={{ ['--bars' as string]: len / 16 }}>
        {notes
          .filter((n) => n.s < len)
          .map((n, i) => (
            <div
              key={i}
              className="midirec-note"
              style={{
                left: `${(n.s / len) * 100}%`,
                width: `${(Math.min(n.l, len - n.s) / len) * 100}%`,
                top: `${((hi - n.n) / rows) * 100}%`,
                height: `${Math.max(100 / rows, 4)}%`,
              }}
            />
          ))}
        {s.pos >= 0 && <div className="auto-head" style={{ left: `${(s.pos / len) * 100}%` }} />}
      </div>
    </div>
  );
}
