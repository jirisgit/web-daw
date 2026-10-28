import type { Category, ModuleDef } from '../engine/types';
import { keyboard, midiIn } from './inputs';
import { automation, sequencer } from './sequencing';
import { drums, sampler } from './sound';
import { synth } from './synth';
import { delay, filter, lfo, reverb } from './effects';
import { mixer, output } from './mixing';
import { latencyMeter } from './meter';

export const MODULES: ModuleDef[] = [
  keyboard,
  midiIn,
  sequencer,
  automation,
  lfo,
  synth,
  drums,
  sampler,
  filter,
  delay,
  reverb,
  mixer,
  output,
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
