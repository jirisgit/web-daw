import type { PointerEvent } from 'react';
import { useLive } from '../engine/engine';
import type { ModuleDef, PanelProps } from '../engine/types';

// ---------------------------------------------------------------------------
// Keyboard: on-screen keys (mouse + multi-touch) and the computer keyboard
// ---------------------------------------------------------------------------

/** a w s e d f t g y h u j k o l p ; → C … E an octave up */
const PC_KEYS = 'awsedftgyhujkolp;';
const BLACK = new Set([1, 3, 6, 8, 10]);

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export const keyboard: ModuleDef = {
  type: 'keyboard',
  title: 'Keyboard',
  category: 'input',
  width: 330,
  inputs: [],
  outputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  params: [
    { id: 'octave', label: 'Octave', min: 1, max: 7, step: 1, default: 4 },
    { id: 'velocity', label: 'Velocity', min: 0.05, max: 1, default: 0.8 },
    { id: 'pckeys', label: 'PC keys', kind: 'toggle', default: 1 },
  ],
  create({ ctx, emit, live }, p) {
    const held = new Set<number>();
    const noteOn = (note: number, origin?: number, source = 'On-screen keys') => {
      if (held.has(note)) return;
      held.add(note);
      emit('midi', { type: 'noteOn', note, velocity: p.velocity, time: ctx.currentTime, origin, source });
      live([...held]);
    };
    const noteOff = (note: number) => {
      if (!held.delete(note)) return;
      emit('midi', { type: 'noteOff', note, velocity: 0, time: ctx.currentTime });
      live([...held]);
    };
    const pcNote = (e: KeyboardEvent) => {
      const i = PC_KEYS.indexOf(e.key.toLowerCase());
      return i < 0 ? -1 : (p.octave + 1) * 12 + i;
    };
    const down = (e: KeyboardEvent) => {
      if (!p.pckeys || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      const n = pcNote(e);
      if (n >= 0) noteOn(n, e.timeStamp, 'Computer keys');
    };
    const up = (e: KeyboardEvent) => {
      const n = pcNote(e);
      if (n >= 0) noteOff(n);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return {
      setParam(id, v) {
        p[id] = v;
      },
      api: { noteOn, noteOff },
      dispose() {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
        [...held].forEach(noteOff);
      },
    };
  },
  Panel: KeyboardPanel,
};

function KeyboardPanel({ id, node, engine }: PanelProps) {
  const held = useLive<number[]>(id) ?? [];
  const base = ((node.params.octave ?? 4) + 1) * 12;
  const api = () => engine.instances.get(id)?.api;
  const keys = Array.from({ length: 25 }, (_, i) => base + i);
  const whites = keys.filter((n) => !BLACK.has(n % 12));

  const handlers = (note: number) => ({
    onPointerDown(e: PointerEvent) {
      // Release implicit touch capture so you can slide across keys
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      api()?.noteOn(note, e.timeStamp, e.pointerType === 'touch' ? 'Touch keys' : 'On-screen keys');
      if (engine.ctx.state !== 'running') engine.resume();
    },
    onPointerEnter(e: PointerEvent) {
      if (e.buttons) api()?.noteOn(note, e.timeStamp, e.pointerType === 'touch' ? 'Touch keys' : 'On-screen keys');
    },
    onPointerUp: () => api()?.noteOff(note),
    onPointerLeave: () => api()?.noteOff(note),
    onPointerCancel: () => api()?.noteOff(note),
  });

  return (
    <div className="keys nodrag nopan" style={{ touchAction: 'none' }} onContextMenu={(e) => e.preventDefault()}>
      {whites.map((n) => (
        <div key={n} className={`key white ${held.includes(n) ? 'down' : ''}`} {...handlers(n)}>
          {n % 12 === 0 && <span>C{n / 12 - 1}</span>}
        </div>
      ))}
      {keys
        .filter((n) => BLACK.has(n % 12))
        .map((n) => {
          const whiteIndex = whites.filter((w) => w < n).length;
          return (
            <div
              key={n}
              className={`key black ${held.includes(n) ? 'down' : ''}`}
              style={{ left: `calc(${(whiteIndex / whites.length) * 100}% - 7px)` }}
              {...handlers(n)}
            />
          );
        })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MIDI In: USB MIDI and BLE MIDI (BLE devices show up here once paired in the OS)
// ---------------------------------------------------------------------------

interface MidiLive {
  status: string;
  devices: { name: string; on: boolean }[];
  last?: number;
  /** notes dropped because another port of the same device already sent them */
  duplicates: number;
}

/** Devices switched off on this computer (devices differ per machine, so this isn't shared) */
const OFF_KEY = 'web-daw-midi-off';
const loadOff = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(OFF_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
};
const saveOff = (s: Set<string>) => {
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
};

/** Same note from a different port within this window = one key press reported twice */
const DUPLICATE_MS = 30;

export const midiIn: ModuleDef = {
  type: 'midiIn',
  title: 'MIDI In',
  category: 'input',
  inputs: [],
  outputs: [{ id: 'midi', label: 'MIDI', type: 'midi' }],
  params: [
    { id: 'channel', label: 'Channel', min: 0, max: 16, step: 1, default: 0 },
    { id: 'transpose', label: 'Transpose', min: -24, max: 24, step: 1, default: 0 },
  ],
  create({ ctx, emit, live }, p) {
    let access: MIDIAccess | null = null;
    let disposed = false;
    const state: MidiLive = { status: 'Requesting access…', devices: [], duplicates: 0 };
    const publish = () => live({ ...state });
    const off = loadOff();
    const lastSeen = new Map<string, { t: number; port: string }>();

    const onMessage = (e: MIDIMessageEvent) => {
      const d = e.data;
      if (!d || d.length < 3) return;
      const cmd = d[0] & 0xf0;
      const ch = (d[0] & 0x0f) + 1;
      if (p.channel && ch !== p.channel) return;
      const isOn = cmd === 0x90 && d[2] > 0;
      const isOff = cmd === 0x80 || (cmd === 0x90 && d[2] === 0);
      if (!isOn && !isOff) return;

      // Some controllers (e.g. Launchpad X) send every pad on two ports at once
      const port = (e.target as MIDIInput | null)?.id ?? '';
      const key = `${isOn ? 1 : 0}:${ch}:${d[1]}`;
      const prev = lastSeen.get(key);
      lastSeen.set(key, { t: e.timeStamp, port });
      if (prev && prev.port !== port && Math.abs(e.timeStamp - prev.t) < DUPLICATE_MS) {
        if (isOn) {
          state.duplicates++;
          publish();
        }
        return;
      }

      const note = d[1] + p.transpose;
      const time = ctx.currentTime;
      if (isOn) {
        // e.timeStamp = when the browser received the message, for the latency meter
        const source = (e.target as MIDIInput | null)?.name ?? 'MIDI';
        emit('midi', { type: 'noteOn', note, velocity: d[2] / 127, time, origin: e.timeStamp, source });
        state.last = note;
        publish();
      } else {
        emit('midi', { type: 'noteOff', note, velocity: 0, time });
      }
    };

    const bind = () => {
      if (!access) return;
      state.devices = [];
      access.inputs.forEach((input) => {
        const name = input.name ?? 'Unknown device';
        const on = !off.has(name);
        input.onmidimessage = on ? onMessage : null;
        state.devices.push({ name, on });
      });
      state.status = state.devices.length ? 'Listening' : 'No MIDI devices found';
      publish();
    };

    if (!navigator.requestMIDIAccess) {
      state.status = 'Web MIDI is not supported in this browser (try Chrome, Edge or Firefox)';
      publish();
    } else {
      navigator.requestMIDIAccess().then(
        (a) => {
          if (disposed) return;
          access = a;
          a.onstatechange = bind;
          bind();
        },
        () => {
          state.status = 'MIDI access was denied';
          publish();
        },
      );
    }
    publish();

    return {
      setParam(id, v) {
        p[id] = v;
      },
      api: {
        toggleDevice(name: string) {
          if (off.has(name)) off.delete(name);
          else off.add(name);
          saveOff(off);
          bind();
        },
      },
      dispose() {
        disposed = true;
        access?.inputs.forEach((i) => (i.onmidimessage = null));
        if (access) access.onstatechange = null;
      },
    };
  },
  Panel: MidiInPanel,
};

function MidiInPanel({ id, engine }: PanelProps) {
  const s = useLive<MidiLive>(id);
  return (
    <div className="midi-status nodrag nopan">
      <div>{s?.status ?? '…'}</div>
      {s?.devices.map((d) => (
        <label key={d.name} className={`device ${d.on ? '' : 'off'}`} title="Listen to this device on this computer">
          <input type="checkbox" checked={d.on} onChange={() => engine.instances.get(id)?.api?.toggleDevice(d.name)} />
          {d.name}
        </label>
      ))}
      {s?.last !== undefined && <div className="muted">Last note: {s.last}</div>}
      {!!s?.duplicates && (
        <div className="muted small">Ignored {s.duplicates} duplicate notes sent on a second port of the same device.</div>
      )}
    </div>
  );
}
