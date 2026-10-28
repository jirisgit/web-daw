import { useEffect, useState } from 'react';
import type { ModuleDef, PanelProps } from '../engine/types';
import { latencyStats, summarize, type LatencySample } from '../engine/latency';
import { smooth } from './util';
import {
  encodeWav,
  envelope,
  findClick,
  findTapBefore,
  highpass,
  levels,
  makeClick,
  median,
  type Recording,
} from './meterAnalysis';
import { deepCheck, type DeepCheckResult } from './micDiagnose';

// ---------------------------------------------------------------------------
// Microphone recording (AudioWorklet), timestamped in AudioContext time
// ---------------------------------------------------------------------------

// Records every channel the mic delivers: laptop "microphone arrays" often send
// several channels, and some of them can be silent.
const RECORDER_SRC = `
class LatencyRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.size = 2048; this.bufs = []; this.n = 0; this.t0 = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      if (this.bufs.length !== chans.length) { this.bufs = chans.map(() => new Float32Array(this.size)); this.n = 0; }
      if (this.n === 0) this.t0 = currentTime;
      for (let c = 0; c < chans.length; c++) this.bufs[c].set(chans[c], this.n);
      this.n += chans[0].length;
      if (this.n >= this.size) {
        this.port.postMessage({ t0: this.t0, d: this.bufs.map((b) => b.slice(0, this.n)) });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('latency-recorder-v2', LatencyRecorder);
`;

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();
function loadWorklet(ctx: AudioContext) {
  if (!workletLoaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'application/javascript' }));
    workletLoaded.set(ctx, ctx.audioWorklet.addModule(url));
  }
  return workletLoaded.get(ctx)!;
}

interface MicInfo {
  label: string;
  /** Input latency the browser reports for the mic, if it does */
  latencyMs?: number;
  mode: MicMode;
  sampleRate?: number;
  /** Peak level of every channel the mic delivered, in dBFS */
  channelPeaksDb: number[];
  /** Which channel was analyzed (the loudest) */
  channel: number;
}

/**
 * Ways to open the mic. Timing tests want "raw" (no echo cancellation, which would
 * remove the very speaker sound we listen for), but some drivers only deliver sound
 * in another mode.
 */
export type MicMode = 'raw' | 'raw-mono' | 'no-echo-cancel' | 'browser-default';
const MIC_MODES: Record<MicMode, { label: string; constraints: MediaTrackConstraints }> = {
  raw: { label: 'Raw', constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
  'raw-mono': {
    label: 'Raw, mono',
    constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  },
  'no-echo-cancel': { label: 'Processed, no echo cancel', constraints: { echoCancellation: false } },
  'browser-default': { label: 'Browser default', constraints: {} },
};
const MIC_ORDER: MicMode[] = ['raw', 'raw-mono', 'no-echo-cancel', 'browser-default'];

const MIC_PREFS_KEY = 'web-daw-mic';
interface MicPrefs {
  deviceId?: string;
  mode?: MicMode;
}
export const micPrefs = {
  get(): MicPrefs {
    try {
      return JSON.parse(localStorage.getItem(MIC_PREFS_KEY) ?? '{}');
    } catch {
      return {};
    }
  },
  set(p: MicPrefs) {
    try {
      localStorage.setItem(MIC_PREFS_KEY, JSON.stringify({ ...micPrefs.get(), ...p }));
    } catch {
      /* ignore */
    }
  },
};

const peakDb = (d: Float32Array) => {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
};

/** `stream` lets tests feed in a generated signal instead of the microphone */
export async function startRecording(ctx: AudioContext, mode: MicMode = micPrefs.get().mode ?? 'raw', stream?: MediaStream) {
  const deviceId = micPrefs.get().deviceId;
  stream ??= await navigator.mediaDevices.getUserMedia({
    audio: { ...MIC_MODES[mode].constraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
  });
  await loadWorklet(ctx);
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings() as MediaTrackSettings & { latency?: number };
  const src = ctx.createMediaStreamSource(stream);
  const rec = new AudioWorkletNode(ctx, 'latency-recorder-v2', {
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 8,
    channelCountMode: 'max',
    channelInterpretation: 'discrete',
  });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(rec).connect(sink).connect(ctx.destination);
  const chunks: { t0: number; d: Float32Array[] }[] = [];
  rec.port.onmessage = (e) => chunks.push(e.data);
  return {
    /** True if the browser marked the mic as muted (e.g. blocked by the OS) */
    trackMuted: () => !!track?.muted,
    stop(): { rec: Recording; mic: MicInfo } {
      src.disconnect();
      rec.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const nch = Math.max(1, ...chunks.map((c) => c.d.length));
      const len = chunks.reduce((a, c) => a + c.d[0].length, 0);
      const chans = Array.from({ length: nch }, () => new Float32Array(len));
      let o = 0;
      for (const c of chunks) {
        c.d.forEach((d, ch) => chans[ch].set(d, o));
        o += c.d[0].length;
      }
      const peaks = chans.map(peakDb);
      const channel = peaks.indexOf(Math.max(...peaks));
      return {
        rec: { t0: chunks[0]?.t0 ?? 0, sr: ctx.sampleRate, data: chans[Math.max(0, channel)] },
        mic: {
          label: track?.label || 'Default microphone',
          latencyMs: settings?.latency ? settings.latency * 1000 : undefined,
          mode,
          sampleRate: settings?.sampleRate,
          channelPeaksDb: peaks,
          channel: Math.max(0, channel),
        },
      };
    },
  };
}

export interface MicCheckRow {
  mode: MicMode;
  label: string;
  ok: boolean;
  peaks: number[];
  error?: string;
}

/** Try every way of opening the mic for a moment and report which ones actually deliver sound. */
async function micCheck(ctx: AudioContext, onStep: (label: string) => void): Promise<MicCheckRow[]> {
  const rows: MicCheckRow[] = [];
  for (const mode of MIC_ORDER) {
    onStep(MIC_MODES[mode].label);
    try {
      const r = await startRecording(ctx, mode);
      await sleep(1500);
      const { mic } = r.stop();
      rows.push({ mode, label: MIC_MODES[mode].label, ok: Math.max(...mic.channelPeaksDb) > -70, peaks: mic.channelPeaksDb });
    } catch (e) {
      rows.push({ mode, label: MIC_MODES[mode].label, ok: false, peaks: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  const best = rows.find((r) => r.ok);
  if (best) micPrefs.set({ mode: best.mode });
  return rows;
}

export async function listMics(): Promise<{ id: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export interface Diagnostics {
  mic: MicInfo;
  seconds: number;
  peakDb: number;
  noiseDb: number;
  /** Every sample exactly zero: the OS or hardware is muting the mic */
  silent: boolean;
  trackMuted: boolean;
}
export interface LoopbackResult {
  roundTrip: number[];
  clicks: number;
  diag: Diagnostics;
}
export interface TapResult {
  gaps: number[];
  software: number[];
  taps: number;
  /** taps whose speaker sound was found (but maybe not the tap itself) */
  clicksHeard: number;
  diag: Diagnostics;
}

export const latencyMeter: ModuleDef = {
  type: 'latencyMeter',
  title: 'Latency Meter',
  category: 'utility',
  width: 340,
  inputs: [],
  outputs: [],
  showParams: false,
  params: [{ id: 'click', label: 'Click vol', min: 0, max: 1, default: 0.8 }],
  create({ ctx }, p) {
    // Test clicks go straight to the speakers, independent of the patch
    const out = ctx.createGain();
    out.gain.value = p.click;
    out.connect(ctx.destination);
    const clickWave = makeClick(ctx.sampleRate);
    const clickBuf = ctx.createBuffer(1, clickWave.length, ctx.sampleRate);
    clickBuf.copyToChannel(clickWave, 0);

    const click = (t: number) => {
      const s = ctx.createBufferSource();
      s.buffer = clickBuf;
      s.connect(out);
      s.start(Math.max(t, ctx.currentTime));
    };

    let lastRecording: { rec: Recording; meta: Record<string, unknown> } | null = null;
    const diagnose = (rec: Recording, hp: Float32Array, mic: MicInfo, trackMuted: boolean): Diagnostics => ({
      mic,
      seconds: rec.data.length / rec.sr,
      ...levels(hp, rec.sr),
      silent: rec.data.every((v) => v === 0),
      trackMuted,
    });
    /** The analysis is heavy; don't let it show up as a "main-thread stall" in the stats */
    const analyze = <T,>(fn: () => T): T => {
      const t = performance.now();
      const result = fn();
      latencyStats.dropStallsSince(t);
      return result;
    };
    const deviceMeta = () => ({
      outputLatencyMs: (ctx.outputLatency || 0) * 1000,
      baseLatencyMs: (ctx.baseLatency || 0) * 1000,
      userAgent: navigator.userAgent,
    });

    return {
      setParam(id, v, t) {
        if (id === 'click') smooth(out.gain, v, t);
      },
      dispose: () => out.disconnect(),
      api: {
        /** Clicks through the speakers, listens with the mic: output + mic latency */
        async loopback(): Promise<LoopbackResult> {
          const r = await startRecording(ctx);
          await sleep(400);
          const start = ctx.currentTime + 0.3;
          const times = Array.from({ length: 5 }, (_, i) => start + i);
          times.forEach(click);
          await sleep((times[times.length - 1] - ctx.currentTime + 1) * 1000);
          const muted = r.trackMuted();
          const { rec, mic } = r.stop();
          lastRecording = { rec, meta: { test: 'loopback', t0: rec.t0, sr: rec.sr, clickTimes: times, mic, ...deviceMeta() } };
          return analyze(() => {
            const hp = highpass(rec.data, rec.sr);
            const roundTrip = times
              .map((t) => {
                const o = findClick(rec, hp, clickWave, t, t + 0.8);
                return o ? (o.time - t) * 1000 : NaN;
              })
              .filter((v) => v > 0);
            return { roundTrip, clicks: times.length, diag: diagnose(rec, hp, mic, muted) };
          });
        },

        /** Record taps on a pad and the resulting sound; the gap is the real pad-to-sound time */
        async tapTest(seconds: number, onTap: (n: number) => void): Promise<TapResult> {
          const r = await startRecording(ctx);
          const notes: LatencySample[] = [];
          const off = latencyStats.onInput((s) => {
            notes.push(s);
            click(s.ctxTime);
            onTap(notes.length);
          });
          await sleep(seconds * 1000);
          off();
          await sleep(800);
          const muted = r.trackMuted();
          const { rec, mic } = r.stop();
          const analysisStart = performance.now();
          const hp = highpass(rec.data, rec.sr);
          const env = envelope(hp, rec.sr);
          const noise = median(Array.from(env));
          const gaps: number[] = [];
          const software: number[] = [];
          let clicksHeard = 0;
          notes.forEach((n, i) => {
            // Taps closer than 0.6 s together can't be told apart
            const next = notes[i + 1];
            if (next && next.ctxTime - n.ctxTime < 0.6) return;
            const prev = notes[i - 1];
            if (prev && n.ctxTime - prev.ctxTime < 0.6) return;
            const arrival = findClick(rec, hp, clickWave, n.ctxTime, n.ctxTime + 0.8);
            if (!arrival) return;
            clicksHeard++;
            // The tap's thud comes before the speaker sound
            const tap = findTapBefore(rec, hp, env, noise, arrival.time);
            if (tap === null) return;
            gaps.push((arrival.time - tap) * 1000);
            software.push(n.total);
          });
          lastRecording = {
            rec,
            meta: {
              test: 'tap',
              t0: rec.t0,
              sr: rec.sr,
              notes: notes.map((n) => ({ ctxTime: n.ctxTime, total: n.total, inputToApp: n.inputToApp, source: n.source })),
              mic,
              ...deviceMeta(),
            },
          };
          const diag = diagnose(rec, hp, mic, muted);
          latencyStats.dropStallsSince(analysisStart);
          return { gaps, software, taps: notes.length, clicksHeard, diag };
        },

        micCheck: (onStep: (label: string) => void) => micCheck(ctx, onStep),
        deepCheck: () => deepCheck(ctx, micPrefs.get().deviceId),
        listMics,

        /** Download the last test's recording (with timing data inside) for closer analysis */
        saveRecording() {
          if (!lastRecording) return;
          const bytes = encodeWav(lastRecording.rec, lastRecording.meta);
          const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `latency-${lastRecording.meta.test}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        },
      },
    };
  },
  Panel: MeterPanel,
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const ms = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(v < 10 ? 1 : 0)} ms`);

function useTick(intervalMs: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

function DiagLine({ d }: { d: Diagnostics }) {
  const quiet = d.peakDb < -45;
  return (
    <>
      <p className="muted small">
        Mic: {d.mic.label} ({MIC_MODES[d.mic.mode].label.toLowerCase()}
        {d.mic.channelPeaksDb.length > 1 && `, channel ${d.mic.channel + 1} of ${d.mic.channelPeaksDb.length}`})
        {d.mic.latencyMs !== undefined && `, reports ${ms(d.mic.latencyMs)} input latency`} · loudest {d.peakDb.toFixed(0)} dBFS · background{' '}
        {d.noiseDb.toFixed(0)} dBFS · {d.seconds.toFixed(1)} s recorded
      </p>
      {d.seconds < 1 && <p className="lat-tip">The mic delivered no audio. Check that it isn't muted or used by another app.</p>}
      {d.seconds >= 1 && (d.silent || d.trackMuted) && (
        <p className="lat-tip">
          The microphone sent pure silence. Run <b>Mic check</b> to find a setting or microphone that works. Also check that no mic-mute
          key is active and that Windows Settings → Sound → Input shows the level moving when you speak.
        </p>
      )}
      {d.seconds >= 1 && !d.silent && !d.trackMuted && quiet && (
        <p className="lat-tip">The mic heard almost nothing. Check the Windows input device and its level, or pick another mic.</p>
      )}
    </>
  );
}

const dbText = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)} dB` : 'silent');

/** Microphone picker + "Mic check", which finds a way of opening the mic that delivers sound */
function MicSetup({ api, busy, run }: { api: () => any; busy: string | null; run: (name: string, fn: () => Promise<void>) => void }) {
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState(micPrefs.get().deviceId ?? '');
  const [rows, setRows] = useState<MicCheckRow[] | null>(null);
  const [step, setStep] = useState('');
  const [deep, setDeep] = useState<DeepCheckResult | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = () => listMics().then(setMics).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="mic-setup">
      <div className="share-row">
        <label>Microphone</label>
        <select
          value={deviceId}
          onChange={(e) => {
            setDeviceId(e.target.value);
            micPrefs.set({ deviceId: e.target.value || undefined });
            setRows(null);
          }}
        >
          <option value="">System default</option>
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          disabled={!!busy}
          onClick={() =>
            run('mic', async () => {
              setRows(await api()?.micCheck(setStep));
              refresh(); // device names become visible once mic access is granted
            })
          }
        >
          {busy === 'mic' ? `Checking ${step}…` : 'Mic check'}
        </button>
      </div>
      {busy === 'mic' && <p className="muted small">Talk or tap near the mic for the next few seconds.</p>}
      {rows && (
        <table className="lat-table mic-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.mode} className={micPrefs.get().mode === r.mode && r.ok ? 'total' : ''}>
                <td>
                  {r.ok ? '✓' : '✗'} {r.label}
                </td>
                <td>{r.error ? r.error : r.peaks.map(dbText).join(' · ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && !rows.some((r) => r.ok) && (
        <p className="lat-tip">
          No setting delivered sound from this microphone. Pick another microphone above, check for a mic-mute key, and check that
          Windows Settings → Sound → Input shows the level moving when you speak.
        </p>
      )}
      {rows && rows.some((r) => r.ok) && (
        <p className="muted small">The tests will now use the highlighted setting, and always the loudest channel.</p>
      )}

      <div className="share-row">
        <label className="muted small">Still silent? Find where the sound gets lost:</label>
        <button
          disabled={!!busy}
          onClick={() =>
            run('deep', async () => {
              setDeep(null);
              setCopied(false);
              setDeep(await api()?.deepCheck());
            })
          }
        >
          {busy === 'deep' ? 'Listening… keep talking' : 'Deep check'}
        </button>
      </div>
      {deep && (
        <>
          <table className="lat-table mic-table">
            <tbody>
              {deep.rows.map((r) => {
                const ok = r.peakDb !== undefined && r.peakDb > -70;
                return (
                  <tr key={r.path}>
                    <td>
                      {r.peakDb === undefined ? '–' : ok ? '✓' : '✗'} {r.path}
                    </td>
                    <td title={r.note}>{r.peakDb !== undefined ? dbText(r.peakDb) : r.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">
            Track: {deep.track.label} · {deep.track.readyState}
            {deep.track.muted ? ' · MUTED by browser/OS' : ''}
            {!deep.track.enabled ? ' · disabled' : ''} · {String(deep.track.settings.sampleRate ?? '?')} Hz,{' '}
            {String(deep.track.settings.channelCount ?? '?')} ch
          </p>
          {deep.track.muted && (
            <p className="lat-tip">
              The browser reports this microphone as muted at the system level, so it receives silence before the app sees anything.
              Check: the microphone mute in Windows Quick Settings (Win+A) or Win+Alt+K; Settings → Privacy &amp; security → Microphone
              → “Let desktop apps access your microphone”; the input volume in Settings → Sound; and any antivirus “microphone
              protection”.
            </p>
          )}
          <button
            onClick={() => {
              navigator.clipboard?.writeText(JSON.stringify({ ...deep, userAgent: navigator.userAgent }, null, 1));
              setCopied(true);
            }}
          >
            {copied ? 'Copied ✓' : 'Copy details'}
          </button>
        </>
      )}
    </div>
  );
}

function MeterPanel({ id, engine }: PanelProps) {
  useTick(300);
  const [busy, setBusy] = useState<string | null>(null);
  const [loop, setLoop] = useState<LoopbackResult | null>(null);
  const [tap, setTap] = useState<TapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = () => engine.instances.get(id)?.api;

  const samples = latencyStats.samples;
  const last = samples.at(-1);
  const stat = (k: 'inputToApp' | 'appToSpeaker' | 'total') => summarize(samples.map((s) => s[k]));
  const rows: [string, 'inputToApp' | 'appToSpeaker' | 'total', string][] = [
    ['Input → app', 'inputToApp', 'Browser received the note → our code handled it'],
    ['App → speaker', 'appToSpeaker', 'Audio buffer + output device'],
    ['Total (software)', 'total', 'Everything the browser can see'],
  ];
  const stalls = latencyStats.recentStalls();
  const base = (engine.ctx.baseLatency || 0) * 1000;
  const output = (engine.ctx.outputLatency || 0) * 1000;

  const tips: string[] = [];
  const inApp = stat('inputToApp');
  if (inApp && inApp.max > 20) tips.push('Some notes waited for a busy main thread. Close other tabs and avoid editing while playing.');
  if (output > 30) tips.push('The output device is slow. Try wired headphones or a USB audio interface, and turn off "Audio enhancements" in Windows sound settings.');

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await engine.resume();
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const loopMed = loop && summarize(loop.roundTrip);
  const tapMed = tap && summarize(tap.gaps);
  const tapSoft = tap && summarize(tap.software);

  return (
    <div className="meter-panel nodrag">
      <div className="meter-head">
        <span className="muted">
          {last ? `${samples.length} notes · last from ${last.source}` : 'Play something: MIDI, keys or pads'}
        </span>
        <button onClick={() => latencyStats.clear()}>Clear</button>
      </div>

      <table className="lat-table">
        <thead>
          <tr>
            <th />
            <th>Last</th>
            <th>Median</th>
            <th>Worst</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, k, hint]) => {
            const s = stat(k);
            return (
              <tr key={k} title={hint} className={k === 'total' ? 'total' : ''}>
                <td>{label}</td>
                <td>{ms(last?.[k])}</td>
                <td>{ms(s?.median)}</td>
                <td>{ms(s?.max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="lat-device">
        <div>
          <span>Audio buffer</span>
          <b>{ms(base)}</b>
        </div>
        <div>
          <span>Output device (reported)</span>
          <b className={output > 30 ? 'bad' : ''}>{ms(output)}</b>
        </div>
        <div>
          <span>Main-thread stalls, last 30 s</span>
          <b className={stalls.length ? 'bad' : ''}>
            {stalls.length ? `${stalls.length} (worst ${ms(Math.max(...stalls.map((s) => s.duration)))})` : 'none'}
          </b>
        </div>
      </div>

      {tips.map((t) => (
        <p key={t} className="lat-tip">
          {t}
        </p>
      ))}

      <h4>Microphone tests</h4>
      <p className="muted small">
        Use speakers, not headphones, so the mic can hear the sound. Stop playback first. For the tap test, tap one pad firmly about once a
        second, close to the mic.
      </p>
      <MicSetup api={api} busy={busy} run={run} />
      <div className="lat-buttons">
        <button disabled={!!busy} onClick={() => run('loop', async () => setLoop(await api()?.loopback()))}>
          {busy === 'loop' ? 'Listening…' : 'Loopback test'}
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            run('tap', async () => {
              setTap(null);
              setTap(await api()?.tapTest(10, (n: number) => setBusy(`tap:${n}`)));
            })
          }
        >
          {busy?.startsWith('tap') ? `Tap… (${busy.split(':')[1] ?? 0} taps)` : 'Tap test (10 s)'}
        </button>
        <button disabled={!!busy || (!loop && !tap)} onClick={() => api()?.saveRecording()} title="Download the last test's recording">
          Save recording
        </button>
      </div>
      {error && <p className="lat-tip">Test failed: {error}</p>}

      {loop && (
        <div className="lat-result">
          <div>
            <span>Speaker → mic round trip</span>
            <b>{loopMed ? ms(loopMed.median) : 'not detected'}</b>
          </div>
          <p className="muted small">
            {loopMed
              ? `${loop.roundTrip.length}/${loop.clicks} clicks heard (range ${ms(loopMed.min)} – ${ms(loopMed.max)}). This is output + microphone latency; the browser reports ${ms(output + base)} for output.`
              : 'The mic did not hear the clicks. Turn up the volume or move the mic closer to the speaker.'}
          </p>
          <DiagLine d={loop.diag} />
        </div>
      )}

      {tap && (
        <div className="lat-result">
          <div>
            <span>Pad → sound (heard by mic)</span>
            <b>{tapMed ? ms(tapMed.median) : 'not detected'}</b>
          </div>
          {tapMed && tapSoft ? (
            <>
              <div>
                <span>…of which the browser can see</span>
                <b>{ms(tapSoft.median)}</b>
              </div>
              <div>
                <span>…hidden: pad, USB, driver, speaker</span>
                <b>{ms(Math.max(0, tapMed.median - tapSoft.median))}</b>
              </div>
              <p className="muted small">
                {tap.gaps.length} of {tap.taps} taps measured (range {ms(tapMed.min)} – {ms(tapMed.max)}).
              </p>
            </>
          ) : (
            <p className="muted small">
              {tap.taps === 0
                ? 'No notes were played during the test.'
                : tap.clicksHeard === 0
                  ? 'The mic did not hear the test clicks. Turn up the volume or move the mic closer to the speaker.'
                  : `The clicks were heard (${tap.clicksHeard}×) but not the taps. Tap harder, or hold the mic right next to the pad.`}
            </p>
          )}
          <DiagLine d={tap.diag} />
        </div>
      )}
    </div>
  );
}
