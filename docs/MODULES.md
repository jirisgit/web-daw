# Creating modules

A module is one box on the canvas: a synth, an effect, a sequencer, a tool. Each module is a single `ModuleDef` object. It describes the module's ports and knobs, builds its Web Audio nodes, and can draw a custom panel.

The types live in [src/engine/types.ts](../src/engine/types.ts). The existing modules are in [src/modules/](../src/modules/) and are the best examples.

For the list of modules still to build, see [MODULE_ROADMAP.md](MODULE_ROADMAP.md).

## Quick start

1. Create a file in `src/modules/` (or add to an existing one, such as `effects.ts`).
2. Export a `ModuleDef`.
3. Add it to the `MODULES` list in [src/modules/registry.ts](../src/modules/registry.ts).

It then appears in the palette under its category. You don't need to register it anywhere else.

## A minimal example: Tremolo

An audio effect with one input, one output and two knobs.

```ts
// src/modules/effects.ts
import type { ModuleDef } from '../engine/types';
import { smooth } from './util';

export const tremolo: ModuleDef = {
  type: 'tremolo',            // stable id, saved in documents: never rename it
  title: 'Tremolo',
  category: 'effect',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    { id: 'rate', label: 'Rate', min: 0.1, max: 20, default: 5, curve: 'log', unit: 'Hz' },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5 },
  ],
  create({ ctx }, p) {
    const amp = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    amp.gain.value = 1 - p.depth / 2;
    lfo.frequency.value = p.rate;
    lfoGain.gain.value = p.depth / 2;
    lfo.connect(lfoGain).connect(amp.gain);
    lfo.start();

    return {
      inputs: { in: amp },
      outputs: { out: amp },
      setParam(id, v, t) {
        if (id === 'rate') smooth(lfo.frequency, v, t);
        if (id === 'depth') {
          smooth(amp.gain, 1 - v / 2, t);
          smooth(lfoGain.gain, v / 2, t);
        }
      },
      dispose: () => lfo.stop(),
    };
  },
};
```

```ts
// src/modules/registry.ts
import { delay, filter, lfo, reverb, tremolo } from './effects';

export const MODULES: ModuleDef[] = [
  // ...
  reverb,
  tremolo,
  // ...
];
```

The module gets a knob grid for `rate` and `depth` automatically.

## The definition (`ModuleDef`)

| Field | What it does |
| --- | --- |
| `type` | Unique id. It is saved in every document, so **never rename it** once people have used the module. Documents with an unknown type are skipped. |
| `title` | Name shown on the module header and in the palette. |
| `category` | Palette group and header color: `input`, `sequencer`, `modulation`, `instrument`, `effect`, `mixer`, `output`, `utility`. |
| `inputs` / `outputs` | Ports (see below). |
| `params` | Knobs, switches and dropdowns (see below). |
| `width` | Width in pixels. The default is 220. |
| `showParams` | Set to `false` to hide the automatic knob grid, for example when your panel draws its own controls (the mixer does this). |
| `defaultData` | Returns the starting value of the module's non-numeric data, such as a pattern (see [Data](#data-patterns-samples-lists)). |
| `create` | Builds the running module (see below). |
| `Panel` | Optional React component drawn under the knobs. |

### Ports

```ts
{ id: 'in', label: 'In', type: 'audio' }
```

There are three port types. Cables only join ports of the same type.

| Type | Carries | In `create`, map the port id to |
| --- | --- | --- |
| `audio` | Sound | An `AudioNode`, in `inputs` or `outputs` |
| `control` | A modulation signal, added to a parameter's value | Input: an `AudioParam` (for example `filter.frequency`). Output: an `AudioNode` that produces the signal. |
| `midi` | Note events | Nothing. Notes arrive in `onEvent` and you send them with `emit` |

The engine connects and disconnects audio and control cables for you, using the `inputs` and `outputs` maps your instance returns. MIDI cables go through `emit` and `onEvent`.

### Params

Params are numbers. They are saved in the document and shared live with everyone in the session.

```ts
{ id: 'cutoff', label: 'Cutoff', min: 20, max: 18000, default: 1200, curve: 'log', unit: 'Hz' }
{ id: 'wave', label: 'Wave', kind: 'enum', options: ['Saw', 'Sqr'], default: 0 }   // value = index
{ id: 'on', label: 'On', kind: 'toggle', default: 1 }                              // 0 or 1
{ id: 'octave', label: 'Octave', min: 1, max: 7, step: 1, default: 4 }             // whole numbers
```

- `kind` defaults to `knob`.
- Use `curve: 'log'` for frequencies and times, so the knob spends more of its travel on low values.
- You can add new params later. Old documents that lack a param use its `default`.

## The running module (`create`)

```ts
create(mc, params, data) => ModuleInstance
```

`create` runs once on each device, whenever the module appears in the document. Every device runs its own audio engine. Only the document (params, data, cables) and notes played on input modules are sent over the network.

### What you receive

- `mc.ctx`: the `AudioContext`.
- `mc.emit(portId, event)`: sends a note out of one of your MIDI outputs.
- `mc.live(value, atTime?)`: publishes UI-only state, such as a playhead (see [Live state](#live-state-playheads-meters)).
- `mc.engine`, `mc.id`: the engine and this module's id, for advanced use.
- `params`: current values of all params, already filled with defaults. The object belongs to you, so you can keep it and update it.
- `data`: the module's data object.

### What you return (`ModuleInstance`)

All fields are optional.

| Field | Called when |
| --- | --- |
| `inputs`, `outputs` | Port id → `AudioNode` or `AudioParam`, as described in [Ports](#ports). |
| `setParam(id, value, time)` | A param changed (here or on another device). Schedule the change at `time`, not "now": in studio mode, edits are held until the next bar line, and `time` is that bar line. |
| `setData(data)` | The module's data changed. You get the whole data object. |
| `onEvent(portId, event)` | A note arrived on a MIDI input. |
| `onStep(step, time, stepDur)` | Every 16th note while the transport plays. `step` keeps counting up, so use `step % 16` for a one-bar loop. `time` is the audio time of the step. |
| `onStop()` | The transport stopped. Release held notes and reset playheads here. |
| `dispose()` | The module was removed. Stop oscillators and sources, remove event listeners, clear timers. The engine already disconnects your outputs. |
| `api` | Any functions you want your panel to call directly. |

### Rules for good timing

- **Schedule at the time you're given.** Use `event.time`, the `time` from `onStep`, or the `time` from `setParam`. Don't use `ctx.currentTime` unless nothing else is available.
- **Use the helpers** in [src/modules/util.ts](../src/modules/util.ts):
  - `smooth(param, value, time)` glides a param to a new value without clicks.
  - `at(ctx, time)` clamps a time that has already passed to now.
  - `releaseTo(param, target, time, release)` cuts an envelope short and releases it.
  - `mtof(note)` converts a MIDI note number to a frequency.
- **Store values you read later.** If a param is only used when a note starts (like `attack` in the synth), write `params[id] = value` in `setParam`, so the next note uses the new value.
- **Avoid heavy work in `setParam`.** Rebuilding a buffer on every knob move causes stutters. The reverb waits 150 ms (a debounce) before it rebuilds its impulse response.

## Notes (MIDI)

A note event looks like this:

```ts
{ type: 'noteOn' | 'noteOff', note: 60, velocity: 0.8, time: ctx.currentTime }
```

**Receiving notes (instruments).** Declare a `midi` input and handle `onEvent`:

```ts
onEvent(_port, ev) {
  if (ev.type === 'noteOn') noteOn(ev.note, ev.velocity, at(ctx, ev.time));
  else noteOff(ev.note, at(ctx, ev.time));
},
```

**Sending notes (sequencers).** Declare a `midi` output and call `emit` from `onStep`:

```ts
onStep(step, time, dur) {
  if (pattern[step % 16]) {
    emit('midi', { type: 'noteOn', note: 36, velocity: 1, time });
    emit('midi', { type: 'noteOff', note: 36, velocity: 0, time: time + dur * 0.5 });
  }
},
```

**Notes and other devices.** Each device's transport is synced, so a sequencer plays its notes on every device by itself. Nothing is sent over the network for it.

The only notes sent over the network are:

- Notes emitted by modules in the **`input` category** (keyboard, MIDI in). The engine sends these to everyone automatically. To get correct latency numbers, also set `origin` (the browser event's `timeStamp`) and `source` (a readable name).
- Notes your **panel** plays into a module with `engine.input(id, port, event)`. The drum pads use this so a tap is heard everywhere.

## Data (patterns, samples, lists)

For anything that isn't a single number, use `data`. It is a JSON object stored in the shared document.

```ts
defaultData: () => ({ pattern: Array(16).fill(0) }),

create({ emit }, p, data) {
  let pattern = (data.pattern as number[]) ?? Array(16).fill(0);
  return {
    setData(d) { pattern = (d.pattern as number[]) ?? pattern; },
    // ...
  };
},
```

From the panel, change it with `setData({ pattern: next })`. Only the keys you pass are updated, and arrays are synced element by element.

- Keep data JSON-only: numbers, strings, booleans, arrays and plain objects. No `AudioBuffer` or class instances.
- Data is shared with everyone and saved, so keep it small. Don't put raw audio in it.
- Always handle a missing key with a fallback (`?? default`), because older documents won't have new keys.

## Panels

A panel is a React component drawn inside the module, under the knobs.

```tsx
import type { PanelProps } from '../engine/types';
import { useLive } from '../engine/engine';

function StepsPanel({ id, node, engine, setData, setParam }: PanelProps) {
  const playhead = useLive<number>(id) ?? -1;
  const pattern = (node.data.pattern as number[]) ?? Array(16).fill(0);
  return (
    <div className="nodrag nopan" style={{ touchAction: 'none' }}>
      {pattern.map((on, s) => (
        <button
          key={s}
          className={s === playhead ? 'head' : ''}
          onClick={() => setData({ pattern: pattern.map((v, i) => (i === s ? 1 - v : v)) })}
        >
          {on ? '■' : '□'}
        </button>
      ))}
    </div>
  );
}
```

- `node` holds the current `params` and `data` from the document.
- `setParam(id, value)` and `setData(patch)` write to the shared document. The engine then calls your instance's `setParam` or `setData` on every device.
- Add the class `nodrag` (and `nopan` if the user drags inside the panel) so that clicking the panel doesn't move the module or pan the canvas. Use `touchAction: 'none'` for touch input.
- During fast pointer edits (painting cells, drawing curves), read the newest data with `store.get().nodes[id].data` instead of `node.data`. Pointer events can arrive before React re-renders. See `SequencerPanel` and `AutomationPanel` in [sequencing.tsx](../src/modules/sequencing.tsx).
- To build your own controls, reuse `Knob`, `Fader`, `Toggle` and `EnumControl` from [src/ui/controls.tsx](../src/ui/controls.tsx) (the mixer does this).

### Live state (playheads, meters)

Some state is only for the screen: a playhead position, a level meter, a list of MIDI devices. Don't put it in the document. Publish it from the instance with `live`:

```ts
live(step % 16, time);   // shown when `time` is heard, not when it is scheduled
live(-1);                // right away
```

Read it in the panel with `useLive<T>(id)`. Live state stays on the device that produced it and is never saved. Updates are grouped into one per animation frame, so you can call `live` often.

## Checklist

- [ ] `type` is unique and won't change.
- [ ] Added to `MODULES` in `registry.ts`.
- [ ] Every port id in `inputs`/`outputs` has a matching entry in the instance's `inputs`/`outputs`. MIDI ports are the exception: they need `onEvent` or `emit` instead.
- [ ] `setParam` handles every param, schedules at `time`, and uses `smooth` for audio params.
- [ ] `dispose` stops sources and removes listeners and timers.
- [ ] `onStop` releases held notes, if the module plays notes.
- [ ] Data reads have fallbacks for old documents.
- [ ] Panels use `nodrag`.
- [ ] Tested with two browser windows in the same session: changes on one should be heard on the other.

## Adding a new category

1. Add it to the `Category` type in [src/engine/types.ts](../src/engine/types.ts).
2. Add a label to `CATEGORY_LABELS` in [src/modules/registry.ts](../src/modules/registry.ts). This also sets its place in the palette.
3. Add a color in [src/styles.css](../src/styles.css): `.cat-yourcategory { --c: #hex; }`.
