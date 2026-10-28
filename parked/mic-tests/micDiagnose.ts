/**
 * "Deep check": listens to one microphone stream through several independent paths
 * at the same time, to find out where the sound gets lost when recordings come out silent.
 */

export interface DiagRow {
  path: string;
  /** Peak level in dBFS; -Infinity = exact silence; undefined = path unavailable/failed */
  peakDb?: number;
  note?: string;
}

export interface DeepCheckResult {
  rows: DiagRow[];
  track: {
    label: string;
    muted: boolean;
    enabled: boolean;
    readyState: string;
    settings: Record<string, unknown>;
  };
  appContext: { sampleRate: number; state: string; baseLatency: number };
}

const toDb = (peak: number) => (peak > 0 ? 20 * Math.log10(peak) : -Infinity);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Peak level of a stream seen through an AnalyserNode in the given context */
async function viaAnalyser(ctx: AudioContext, stream: MediaStream, ms: number): Promise<number> {
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(an).connect(mute).connect(ctx.destination);
  const buf = new Float32Array(an.fftSize);
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    an.getFloatTimeDomainData(buf);
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    await sleep(40);
  }
  src.disconnect();
  mute.disconnect();
  return peak;
}

/** Raw capture frames straight from the track (Chrome's MediaStreamTrackProcessor), no Web Audio involved */
async function viaTrackProcessor(track: MediaStreamTrack, ms: number): Promise<number | string> {
  const Processor = (window as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream } })
    .MediaStreamTrackProcessor;
  if (!Processor) return 'not available in this browser';
  const reader = new Processor({ track }).readable.getReader();
  let peak = 0;
  let frames = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    const n = value.numberOfFrames as number;
    const buf = new Float32Array(n);
    for (let ch = 0; ch < (value.numberOfChannels as number); ch++) {
      value.copyTo(buf, { planeIndex: ch, format: 'f32-planar' });
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
    }
    frames += n;
    value.close();
  }
  await reader.cancel();
  return frames ? peak : 'no frames arrived';
}

/** Chrome's built-in recorder, then decoded — completely independent of the live audio graph */
async function viaMediaRecorder(ctx: AudioContext, stream: MediaStream, ms: number): Promise<number | string> {
  if (typeof MediaRecorder === 'undefined') return 'not available';
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start();
  await sleep(ms);
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: rec.mimeType });
  if (!blob.size) return 'recorded nothing';
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  let peak = 0;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const d = audio.getChannelData(ch);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  return peak;
}

/** `testStream` replaces the microphone with a generated signal (for testing this check itself) */
export async function deepCheck(appCtx: AudioContext, deviceId?: string, ms = 2500, testStream?: MediaStream): Promise<DeepCheckResult> {
  // Plain request with browser defaults, the most "normal" way a site asks for the mic
  const stream = testStream ?? (await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true }));
  const track = stream.getAudioTracks()[0];
  const settings = { ...track.getSettings() } as Record<string, unknown>;
  const micRate = typeof settings.sampleRate === 'number' ? settings.sampleRate : undefined;
  const fresh = new AudioContext();
  const matched = micRate ? new AudioContext({ sampleRate: micRate }) : null;

  const wrap = async (path: string, fn: () => Promise<number | string>): Promise<DiagRow> => {
    try {
      const r = await fn();
      return typeof r === 'number' ? { path, peakDb: toDb(r) } : { path, note: r };
    } catch (e) {
      return { path, note: e instanceof Error ? e.message : String(e) };
    }
  };

  const rows = await Promise.all([
    wrap('1. Raw capture frames', () => viaTrackProcessor(track.clone(), ms)),
    wrap(`2. New audio graph (${fresh.sampleRate} Hz)`, () => viaAnalyser(fresh, stream, ms)),
    matched
      ? wrap(`3. New audio graph at mic rate (${micRate} Hz)`, () => viaAnalyser(matched, stream, ms))
      : Promise.resolve({ path: '3. New audio graph at mic rate', note: 'mic did not report its rate' }),
    wrap(`4. The app's audio graph (${appCtx.sampleRate} Hz)`, () => viaAnalyser(appCtx, stream, ms)),
    wrap('5. Chrome recorder (no audio graph)', () => viaMediaRecorder(fresh, stream, ms)),
  ]);

  const result: DeepCheckResult = {
    rows,
    track: { label: track.label, muted: track.muted, enabled: track.enabled, readyState: track.readyState, settings },
    appContext: { sampleRate: appCtx.sampleRate, state: appCtx.state, baseLatency: appCtx.baseLatency },
  };
  stream.getTracks().forEach((t) => t.stop());
  await fresh.close();
  await matched?.close();
  return result;
}
