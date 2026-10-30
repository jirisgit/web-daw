import type { Category, ModuleDef } from '../engine/types';
import { keyboard, midiIn } from './inputs';
import { automation, pianoRoll, sequencer } from './sequencing';
import { arp } from './notes';
import { adsr } from './modulation';
import { drums, sampler } from './sound';
import { monoSynth, synth } from './synth';
import { compressor, delay, distortion, eq, filter, lfo, panner, reverb } from './effects';
import { mixer, output, recorder, vca } from './mixing';
import { latencyMeter } from './meter';
import { scope, spectrum } from './analysis';

export const MODULES: ModuleDef[] = [
  keyboard,
  midiIn,
  sequencer,
  pianoRoll,
  arp,
  automation,
  lfo,
  adsr,
  synth,
  monoSynth,
  drums,
  sampler,
  filter,
  eq,
  compressor,
  distortion,
  delay,
  reverb,
  panner,
  mixer,
  vca,
  output,
  recorder,
  scope,
  spectrum,
  latencyMeter,
];

export const CATEGORY_LABELS: Record<Category, string> = {
  input: 'Inputs',
  sequencer: 'Sequencers',
  modulation: 'Modulation & automation',
  instrument: 'Instruments & samplers',
  effect: 'Effects',
  mixer: 'Mixing',
  output: 'Output',
  utility: 'Tools',
};

const byType = new Map(MODULES.map((m) => [m.type, m]));
export const getDef = (type: string) => byType.get(type);
