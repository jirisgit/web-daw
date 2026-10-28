/**
 * Latency bookkeeping for notes played on this device.
 * Every local note that carries an `origin` timestamp is measured in two stages:
 *   input → app:   physical input reaching the browser → our code handling it
 *   app → speaker: our code handling it → the sound card playing it (buffer + output device)
 */

export interface LatencySample {
  source: string;
  /** browser received input → our code ran (ms) */
  inputToApp: number;
  /** our code ran → sound leaves the output device (ms, estimated from the audio clock) */
  appToSpeaker: number;
  total: number;
  /** performance.now() when handled */
  at: number;
  /** AudioContext time the note was scheduled to play */
  ctxTime: number;
}

export interface Stall {
  at: number;
  duration: number;
}

const MAX_SAMPLES = 50;
const STALL_WINDOW_MS = 30_000;

class LatencyStats {
  samples: LatencySample[] = [];
  stalls: Stall[] = [];
  private inputListeners = new Set<(s: LatencySample) => void>();

  constructor() {
    // Long tasks (>50 ms) on the main thread delay every MIDI message that arrives meanwhile
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.stalls.push({ at: e.startTime, duration: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* not supported in this browser */
    }
  }

  record(s: LatencySample) {
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.inputListeners.forEach((l) => l(s));
  }

  /** Called for every measured local note (used by the meter's tap test). */
  onInput(fn: (s: LatencySample) => void) {
    this.inputListeners.add(fn);
    return () => {
      this.inputListeners.delete(fn);
    };
  }

  recentStalls() {
    const since = performance.now() - STALL_WINDOW_MS;
    this.stalls = this.stalls.filter((s) => s.at >= since);
    return this.stalls;
  }

  /** Forget stalls we caused ourselves (e.g. the meter's own analysis) */
  dropStallsSince(t: number) {
    this.stalls = this.stalls.filter((s) => s.at + s.duration < t);
    // Long-task entries arrive slightly later; catch those too
    setTimeout(() => (this.stalls = this.stalls.filter((s) => s.at + s.duration < t)), 200);
  }

  clear() {
    this.samples = [];
    this.stalls = [];
  }
}

export const latencyStats = new LatencyStats();

export function summarize(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
