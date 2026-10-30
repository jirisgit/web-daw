# Module roadmap

What a full music suite still needs, grouped by palette category and ranked by how much engine work each module depends on. To build a module, follow [MODULES.md](MODULES.md).

## What exists today

| Category | Modules |
| --- | --- |
| Inputs | Keyboard (`keyboard`), MIDI In (`midiIn`) |
| Sequencers | Step Sequencer (`sequencer`), Piano Roll (`pianoRoll`), Arpeggiator (`arp`) |
| Modulation | Automation Lane (`automation`), LFO (`lfo`), Envelope (`adsr`) |
| Instruments | Poly Synth (`synth`), Mono Synth (`monoSynth`), Drum Sampler (`drums`), Sampler (`sampler`) |
| Effects | Filter (`filter`), EQ (`eq`), Compressor (`compressor`), Distortion (`distortion`), Delay (`delay`), Reverb (`reverb`), Panner (`panner`) |
| Mixing / output | Mixer (`mixer`), VCA (`vca`), Audio Out (`output`), Recorder (`recorder`) |
| Tools | Scope (`scope`), Spectrum (`spectrum`), Latency Meter (`latencyMeter`) |

Modules marked **✓ built** in the tables below are done (build order step 1).

## Tiers

- **T1**: plain Web Audio on the current `ModuleDef` API. Can be built today.
- **T2**: needs one of the small engine additions below (seeded random, asset store, shared scene state, local audio input).
- **T3**: needs AudioWorklet support or a large new system (offline render).

## Engine rules every module must follow

These come from how the engine and sync work. They decide which tier a module lands in.

1. **Each device runs its own engine.** Only the document (params, data, cables) and notes from `input` modules are sent over the network. A module that uses `Math.random()` will sound different on every device. Random modules must use a seeded generator keyed on `(module id, step)`. → Add `seededRandom(id, step)` to [src/modules/util.ts](../src/modules/util.ts).
2. **`data` is small JSON.** Samples, impulse responses and recordings can't go in it. → Needs an **asset store**: the document holds a content hash, the bytes live in IndexedDB and are fetched from the server or another peer when missing.
3. **Live audio input stays local.** A mic or line input is heard only on the device it's plugged into. See the experiments in [parked/mic-tests/](../parked/mic-tests/).
4. **Three port types are enough for now.** Gates, triggers and clocks travel as `midi` noteOn/noteOff. Don't add a new port type until something needs it.
5. **The transport gives 16th-note steps only** (`onStep`). Song structure is a module (scene launcher / pattern chain), not a separate timeline.
6. **Schedule at the `time` you're given.** In studio mode, edits land on the next bar line (see the sync modes decision: LAN = live jam, internet = co-editing studio).
7. **Sample-accurate DSP needs AudioWorklet**, which the engine doesn't load yet. → Needs a worklet loader (one `addModule` per processor, shared across instances).

## Modules to add

Each table lists the proposed `type` id (never rename after release), ports, main params, the file it goes in, and its tier.

### Inputs

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Pad Grid | `padGrid` | out: `midi` | root note, scale, rows | `inputs.tsx` | T1 |
| XY Pad | `xyPad` | out: `x`, `y` (control) | range X, range Y, glide | `inputs.tsx` | T1 |
| Audio In | `audioIn` | out: `out` (audio) | gain, monitor on/off | `inputs.tsx` | T2 (local only, rule 3) |

### Sequencers and note tools

Note processors (MIDI in → MIDI out) could get their own category, `notes` ("Note tools"), so the Sequencers group stays short. See [Adding a new category](MODULES.md#adding-a-new-category).

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Piano Roll | `pianoRoll` | out: `midi` | length (1/2/4 bars), view octave, velocity | `sequencing.tsx` | ✓ built |
| Euclidean | `euclid` | out: `midi` | steps, hits, rotate, note (×4 rows) | `sequencing.tsx` | T1 |
| Clock Divider | `clockDiv` | out: `/2`, `/4`, `/8`, `x2` (midi) | swing | `sequencing.tsx` | T1 |
| Scene Launcher | `scenes` | none (controls other sequencers) | scene count, launch quantize | `sequencing.tsx` | T2 (shared current scene in the doc) |
| Arpeggiator | `arp` | in: `midi`, out: `midi` | mode (up/down/up-down/played), rate, octaves, gate | `notes.ts` (Sequencers category) | ✓ built (random mode: T2) |
| Chord | `chord` | in: `midi`, out: `midi` | chord type, inversion, spread | `notes.ts` | T1 |
| Scale Quantizer | `scale` | in: `midi`, out: `midi` | root, scale, transpose | `notes.ts` | T1 |
| Humanize | `humanize` | in: `midi`, out: `midi` | timing amount, velocity amount | `notes.ts` | T2 (seeded random) |
| Probability | `chance` | in: `midi`, out: `midi` | chance %, seed | `notes.ts` | T2 (seeded random) |

### Modulation

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Envelope (ADSR) | `adsr` | in: `midi`, out: `out` (control) | attack, decay, sustain, release, amount, scale, velocity | `modulation.ts` | ✓ built |
| Envelope Follower | `follower` | in: `in` (audio), out: `out` (control) | attack, release, amount | `modulation.ts` | T1 |
| Macro | `macro` | out: `a`–`d` (control) | value, amount a–d | `modulation.ts` | T1 |
| Random / S&H | `sampleHold` | out: `out` (control) | rate (synced), smooth, amount | `modulation.ts` | T2 (seeded random) |

### Instruments

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Mono Synth | `monoSynth` | in: `midi`, `cutoff` (control), out: `out` | wave, sub, glide, cutoff, resonance, env amount, ADSR | `synth.ts` | ✓ built |
| FM Synth | `fmSynth` | in: `midi`, out: `out` | ratio, index, feedback, algorithm, ADSR | `synth.ts` | T1 |
| Wavetable Synth | `wavetable` | in: `midi`, out: `out` | table, position, ADSR | `synth.ts` | T1 (`PeriodicWave`) |
| Drum Synth | `drumSynth` | in: `midi`, out: `out` | kick pitch/decay, snare tone/noise, hat decay | `sound.tsx` | T1 |
| Noise | `noise` | out: `out` | color (white/pink/brown), level | `sound.tsx` | T1 |
| Sample upload (for `sampler`, `drums`) | existing types | — | new data key: asset hash | `sound.tsx` | T2 (asset store) |
| Plucked String | `pluck` | in: `midi`, out: `out` | damping, brightness | `synth.ts` | T3 (worklet) |
| Granular | `granular` | in: `midi`, out: `out` | position, grain size, density, spray | `sound.tsx` | T3 (asset store + worklet) |

### Effects

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Compressor | `compressor` | in: `in`, out: `out` | threshold, ratio, attack, release, knee, makeup | `effects.ts` | ✓ built (no sidechain: the browser compressor has no sidechain input; use Gate / Ducker) |
| EQ | `eq` | in: `in`, out: `out` | low, mid, mid freq, mid Q, high | `effects.ts` | ✓ built |
| Distortion | `distortion` | in: `in`, out: `out` | shape (soft/hard/fold), drive, tone, mix, level | `effects.ts` | ✓ built |
| Chorus | `chorus` | in: `in`, out: `out` | rate, depth, mix | `effects.ts` | T1 |
| Phaser | `phaser` | in: `in`, out: `out` | rate, depth, stages, feedback | `effects.ts` | T1 |
| Flanger | `flanger` | in: `in`, out: `out` | rate, depth, feedback, mix | `effects.ts` | T1 |
| Tremolo | `tremolo` | in: `in`, out: `out` | rate, depth | `effects.ts` | T1 (the example in MODULES.md) |
| Panner | `panner` | in: `in`, `pan` (control), out: `out` | pan, width, auto-pan rate and depth | `effects.ts` | ✓ built |
| Gate / Ducker | `gate` | in: `in`, `side`, out: `out` | threshold, attack, release, mode | `effects.ts` | T1 |
| Convolution Reverb | `convolver` | in: `in`, out: `out` | IR (asset), pre-delay, mix | `effects.ts` | T2 (asset store) |
| Vocoder | `vocoder` | in: `carrier`, `modulator`, out: `out` | bands, release | `effects.ts` | T2 (heavy filter bank) |
| Bitcrusher | `bitcrush` | in: `in`, out: `out` | bits, rate reduction, mix | `effects.ts` | T3 (worklet) |
| Pitch Shifter | `pitchShift` | in: `in`, out: `out` | semitones, mix | `effects.ts` | T3 (worklet) |

### Mixing

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| VCA | `vca` | in: `in`, `cv` (control), out: `out` | gain, mute | `mixing.tsx` | ✓ built |
| Send / Return | `sendBus` | in: `in`, `return`, out: `out`, `send` | send level, return level | `mixing.tsx` | T1 |
| Crossfader | `xfade` | in: `a`, `b`, `pos` (control), out: `out` | position, curve | `mixing.tsx` | T1 |

### Output and recording

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Recorder | `recorder` | in: `in`, out: `out` (thru) | start on bar | `mixing.tsx` | ✓ built (WebM/Opus file on this computer) |
| Looper | `looper` | in: `in`, out: `out` | length (bars), overdub, feedback | `sound.tsx` | T2 (asset store to share loops) |
| Bounce / Export WAV | engine feature | — | length, format | engine | T3 (rebuild graph in OfflineAudioContext) |

### Tools and analysis

| Module | `type` | Ports | Main params | File | Tier |
| --- | --- | --- | --- | --- | --- |
| Scope | `scope` | in: `in` (audio), out: `out` (pass-through) | span, zoom | `analysis.tsx` | ✓ built |
| Spectrum | `spectrum` | in: `in`, out: `out` | smoothing, floor | `analysis.tsx` | ✓ built |
| Level Meter | `levelMeter` | in: `in`, out: `out` | peak hold, LUFS on/off | `analysis.tsx` | T1 |
| Tuner | `tuner` | in: `in` | reference pitch | `analysis.tsx` | T1 |
| MIDI Monitor | `midiMonitor` | in: `midi`, out: `midi` | — | `analysis.tsx` | T1 |
| Note | `note` | none | — (text in `data`) | `analysis.tsx` | T1 |

Analysis modules publish what they draw with `live`, so they never touch the shared document.

## Build order

1. **✓ Done. Make full tracks possible (T1):** ADSR, Compressor, EQ, Distortion, Mono Synth, VCA, Panner, Scope, Spectrum, Arpeggiator, Piano Roll, Recorder.
2. **Engine:** `seededRandom` helper in `util.ts`, then the asset store.
3. **T2 modules:** Probability, Humanize, Random / S&H, sample upload, Convolution Reverb, Scene Launcher, Looper, Audio In.
4. **Engine:** AudioWorklet loader, then T3: Bitcrusher, Plucked String, Granular, Pitch Shifter, and offline export.

The remaining T1 modules (FM, wavetable, chorus, phaser, etc.) can be picked up at any point; they don't block anything.

## New files this roadmap introduces

- `src/modules/notes.ts` for note tools (and the optional `notes` category).
- `src/modules/modulation.ts` for envelopes and macros. The existing `lfo` can stay in `effects.ts`; its `type` doesn't depend on the file.
- `src/modules/analysis.tsx` for scopes and meters.
