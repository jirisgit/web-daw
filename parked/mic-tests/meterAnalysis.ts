/**
 * Signal analysis for the Latency Meter's microphone tests.
 * Pure functions (no browser APIs), so they can be tested with plain Node.
 */

export interface Recording {
  /** AudioContext time of the first sample, as processed (includes mic input latency) */
  t0: number;
  sr: number;
  data: Float32Array;
}

/** The test click: a 10 ms 2.5 kHz burst with a sharp start — easy to find even in a noisy room */
export function makeClick(sr: number): Float32Array<ArrayBuffer> {
  const len = Math.floor(sr * 0.01);
  const d = new Float32Array(len);
  for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * 2500 * i) / sr) * Math.exp((-i / len) * 4);
  return d;
}

/** Removes hum, rumble and DC offset, which otherwise hide quiet transients */
export function highpass(x: Float32Array, sr: number, fc = 200): Float32Array {
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + 1 / sr);
  // Two one-pole passes (12 dB/octave) to really get rid of mains hum
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(y.length);
    for (let i = 1; i < y.length; i++) out[i] = a * (out[i - 1] + y[i] - y[i - 1]);
    y = out;
  }
  return y;
}

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120);

/** Loudest peak and typical background level, in dBFS */
export function levels(hp: Float32Array, sr: number) {
  const env = envelope(hp, sr);
  const sorted = Float32Array.from(env).sort();
  return { peakDb: db(sorted[sorted.length - 1] ?? 0), noiseDb: db(sorted[Math.floor(sorted.length / 2)] ?? 0) };
}

/** Max |x| per 1 ms block */
export function envelope(hp: Float32Array, sr: number, blockSec = 0.001): Float32Array {
  const block = Math.max(1, Math.round(sr * blockSec));
  const env = new Float32Array(Math.ceil(hp.length / block));
  for (let k = 0; k < env.length; k++) {
    let m = 0;
    const end = Math.min(hp.length, (k + 1) * block);
    for (let i = k * block; i < end; i++) m = Math.max(m, Math.abs(hp[i]));
    env[k] = m;
  }
  return env;
}

/**
 * Finds the click in [from, to) by matching its waveform (cross-correlation).
 * Returns its arrival time on the recording timeline, or null if it isn't clearly there.
 */
export function findClick(rec: Recording, hp: Float32Array, click: Float32Array, from: number, to: number) {
  const i0 = Math.max(0, Math.floor((from - rec.t0) * rec.sr));
  const i1 = Math.min(hp.length - click.length, Math.floor((to - rec.t0) * rec.sr));
  if (i1 <= i0) return null;
  let best = 0;
  let bestAt = -1;
  let sumSq = 0;
  for (let i = i0; i < i1; i++) {
    let c = 0;
    for (let j = 0; j < click.length; j++) c += hp[i + j] * click[j];
    sumSq += c * c;
    const a = Math.abs(c);
    if (a > best) {
      best = a;
      bestAt = i;
    }
  }
  const rms = Math.sqrt(sumSq / (i1 - i0));
  const snr = rms > 0 ? best / rms : 0;
  // Pure noise peaks around 4–5× its rms; a real click stands far above that
  if (bestAt < 0 || snr < 8) return null;
  return { time: rec.t0 + bestAt / rec.sr, snr };
}

/**
 * The tap's thud: the first sudden sound (after ≥30 ms of quiet) in the 0.5 s before `arrival`.
 * The first one, because a single tap often makes several bumps (finger, then pad bottoming out).
 * Returns its time on the recording timeline, or null.
 */
export function findTapBefore(rec: Recording, hp: Float32Array, env: Float32Array, noise: number, arrival: number, maxGap = 0.5) {
  const blockSec = 0.001;
  // The 1 ms envelope of background noise varies little around its median,
  // so a modest factor already separates a tap from the room
  const thr = Math.max(noise * 2.5, 1e-4);
  const k0 = Math.max(31, Math.floor((arrival - maxGap - rec.t0) / blockSec));
  const k1 = Math.floor((arrival - 0.004 - rec.t0) / blockSec);
  let found = -1;
  for (let k = k0; k < k1; k++) {
    if (env[k] < thr) continue;
    let quiet = true;
    for (let q = k - 30; q < k; q++) if (env[q] >= thr) quiet = false;
    if (quiet) {
      found = k;
      break;
    }
  }
  if (found < 0) return null;
  // Refine to the exact sample
  const s0 = Math.max(0, Math.round((found - 1) * blockSec * rec.sr));
  const s1 = Math.min(hp.length, Math.round((found + 1) * blockSec * rec.sr));
  for (let i = s0; i < s1; i++) if (Math.abs(hp[i]) >= thr) return rec.t0 + i / rec.sr;
  return rec.t0 + found * blockSec;
}

export function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

/** 16-bit mono WAV with a 'meta' chunk holding the test's timing data as JSON */
export function encodeWav(rec: Recording, meta: unknown): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const metaLen = json.length + (json.length % 2);
  const dataLen = rec.data.length * 2;
  const buf = new ArrayBuffer(12 + 24 + 8 + metaLen + 8 + dataLen);
  const v = new DataView(buf);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
  };
  str('RIFF');
  v.setUint32(o, buf.byteLength - 8, true);
  o += 4;
  str('WAVE');
  str('fmt ');
  v.setUint32(o, 16, true);
  v.setUint16(o + 4, 1, true);
  v.setUint16(o + 6, 1, true);
  v.setUint32(o + 8, rec.sr, true);
  v.setUint32(o + 12, rec.sr * 2, true);
  v.setUint16(o + 16, 2, true);
  v.setUint16(o + 18, 16, true);
  o += 20;
  str('meta');
  v.setUint32(o, json.length, true);
  o += 4;
  new Uint8Array(buf, o, json.length).set(json);
  o += metaLen;
  str('data');
  v.setUint32(o, dataLen, true);
  o += 4;
  for (let i = 0; i < rec.data.length; i++, o += 2) {
    v.setInt16(o, Math.max(-1, Math.min(1, rec.data[i])) * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
