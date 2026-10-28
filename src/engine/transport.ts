/**
 * Look-ahead step clock that follows the shared transport state.
 *
 * The doc says "step N sounds at server time T". Each client converts T to its
 * own AudioContext time (via the clock offset and the sound card's output
 * timestamp) and schedules steps from there, so all devices play in sync.
 */
import type { TransportState } from './doc';

export type StepListener = (step: number, time: number, stepDur: number) => void;

export interface Timebase {
  /** Server-clock ms → AudioContext time at which to schedule so it is *heard* then */
  toAudioTime(serverMs: number): number;
}

const LOOKAHEAD = 0.12;
const INTERVAL_MS = 25;

interface Anchor {
  audio: number;
  step: number;
  dur: number;
}

export class Transport {
  bpm = 120;
  playing = false;
  private anchorMs = 0;
  private anchorStep = 0;
  private anchorAudio = 0;
  /** Timing for steps before the current anchor (after a tempo change) */
  private prev: Anchor | null = null;
  private nextStep = 0;
  private lastScheduled = -Infinity;
  private resync = true;
  private timer: number | undefined;
  private stepListeners = new Set<StepListener>();
  private stateListeners = new Set<(playing: boolean) => void>();

  constructor(
    private ctx: AudioContext,
    private tb: Timebase,
  ) {}

  get stepDur() {
    return 60 / this.bpm / 4;
  }

  onStep(fn: StepListener) {
    this.stepListeners.add(fn);
    return () => {
      this.stepListeners.delete(fn);
    };
  }

  onState(fn: (playing: boolean) => void) {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }

  /** Follow the shared transport state from the document. */
  apply(s: TransportState) {
    if (!s.playing) {
      this.bpm = s.bpm;
      this.halt();
      return;
    }
    const moved = s.anchorMs !== this.anchorMs || s.anchorStep !== this.anchorStep;
    if (this.playing && moved) {
      // Tempo change: steps before the new anchor keep the old timing
      this.prev = { audio: this.anchorAudio, step: this.anchorStep, dur: this.stepDur };
    }
    this.bpm = s.bpm;
    this.anchorMs = s.anchorMs;
    this.anchorStep = s.anchorStep;
    if (!this.playing) {
      this.playing = true;
      this.prev = null;
      this.resync = true;
      this.lastScheduled = -Infinity;
      this.timer = window.setInterval(this.tick, INTERVAL_MS);
      this.stateListeners.forEach((l) => l(true));
    }
    this.tick();
  }

  private halt() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.stateListeners.forEach((l) => l(false));
  }

  private stepTime(k: number) {
    if (k < this.anchorStep && this.prev) return this.prev.audio + (k - this.prev.step) * this.prev.dur;
    return this.anchorAudio + (k - this.anchorStep) * this.stepDur;
  }

  /** Audio time of the first step at or after `t` (for quantizing remote notes). */
  nextStepTime(t: number) {
    const k = Math.ceil(this.anchorStep + (t - this.anchorAudio) / this.stepDur - 1e-6);
    return this.stepTime(k);
  }

  private tick = () => {
    if (!this.playing) return;
    if (this.ctx.state !== 'running') {
      this.resync = true; // audio not started yet: join in when it is
      return;
    }
    // Follow the clock estimate, gliding small corrections to avoid jitter
    const target = this.tb.toAudioTime(this.anchorMs);
    const diff = target - this.anchorAudio;
    this.anchorAudio = this.resync || Math.abs(diff) > 0.05 ? target : this.anchorAudio + diff * 0.05;

    const now = this.ctx.currentTime;
    if (this.resync) {
      const from = Math.max(now, this.lastScheduled + 0.001);
      this.nextStep = Math.max(this.anchorStep, Math.ceil(this.anchorStep + (from - this.anchorAudio) / this.stepDur - 1e-6));
      this.resync = false;
    }
    for (;;) {
      const t = this.stepTime(this.nextStep);
      if (t >= now + LOOKAHEAD) break;
      if (t > this.lastScheduled + 0.001 && t >= now - 0.005) {
        const dur = this.nextStep < this.anchorStep && this.prev ? this.prev.dur : this.stepDur;
        this.stepListeners.forEach((l) => l(this.nextStep, t, dur));
        this.lastScheduled = t;
      }
      this.nextStep++;
    }
  };
}
