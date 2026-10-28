import type { FC } from 'react';
import type { Engine } from './engine';
import type { DocNode } from './doc';

/** audio = sound, midi = note events, control = modulation signal into an AudioParam */
export type PortType = 'audio' | 'midi' | 'control';

export interface PortDef {
  id: string;
  label: string;
  type: PortType;
}

export interface ParamDef {
  id: string;
  label: string;
  /** knob = continuous, enum = pick one of `options` (value is the index), toggle = 0/1 */
  kind?: 'knob' | 'enum' | 'toggle';
  min?: number;
  max?: number;
  default: number;
  curve?: 'lin' | 'log';
  step?: number;
  unit?: string;
  options?: string[];
}

export interface NoteEvent {
  type: 'noteOn' | 'noteOff';
  note: number;
  velocity: number;
  /** AudioContext time at which the event should sound */
  time: number;
  /** performance.now() time when the physical input reached the browser (key, pad, MIDI message) */
  origin?: number;
  /** Where it came from, for the latency meter ("Launchpad X", "Computer keys"…) */
  source?: string;
}

export type Category = 'input' | 'sequencer' | 'instrument' | 'effect' | 'mixer' | 'modulation' | 'output' | 'utility';

/** What a module gets from the engine when it is created. */
export interface ModuleContext {
  id: string;
  ctx: AudioContext;
  engine: Engine;
  /** Send a note event out of one of this module's midi output ports. */
  emit(portId: string, ev: NoteEvent): void;
  /** Publish UI-only state (playhead, device list…) at an audio time, or now. */
  live(value: unknown, atTime?: number): void;
}

/** A running module inside the audio engine. */
export interface ModuleInstance {
  /** Audio/control input ports → node or param to connect into. */
  inputs?: Record<string, AudioNode | AudioParam>;
  /** Audio/control output ports → node to connect from. */
  outputs?: Record<string, AudioNode>;
  onEvent?(portId: string, ev: NoteEvent): void;
  /** `time` is when the change should take effect (audio time). Lets edits land on the musical grid. */
  setParam?(id: string, value: number, time: number): void;
  setData?(data: Record<string, unknown>): void;
  /** Called by the transport for every 16th-note step. */
  onStep?(step: number, time: number, stepDur: number): void;
  onStop?(): void;
  dispose?(): void;
  /** Free-form handle for the module's own panel (e.g. trigger a pad). */
  api?: Record<string, (...args: any[]) => any>;
}

export interface PanelProps {
  id: string;
  node: DocNode;
  engine: Engine;
  setData(patch: Record<string, unknown>): void;
  setParam(id: string, value: number): void;
}

export interface ModuleDef {
  type: string;
  title: string;
  category: Category;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  width?: number;
  /** Render the generic knob grid (default true). */
  showParams?: boolean;
  defaultData?: () => Record<string, unknown>;
  create(mc: ModuleContext, params: Record<string, number>, data: Record<string, unknown>): ModuleInstance;
  Panel?: FC<PanelProps>;
}
