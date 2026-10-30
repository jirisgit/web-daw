import { useEffect, useRef, useState } from 'react';
import type { ModuleDef, ParamDef, PanelProps } from '../engine/types';
import { Fader, Knob, Toggle } from '../ui/controls';
import { useLive } from '../engine/engine';
import { smooth } from './util';

// ---------------------------------------------------------------------------
// VCA: a gain stage whose level can be driven by an envelope or LFO
// ---------------------------------------------------------------------------

export const vca: ModuleDef = {
  type: 'vca',
  title: 'VCA',
  category: 'mixer',
  inputs: [
    { id: 'in', label: 'In', type: 'audio' },
    { id: 'cv', label: 'Gain mod', type: 'control' },
  ],
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [
    // Set this to 0 when an envelope drives the gain input, so silence is the resting state
    { id: 'gain', label: 'Gain', min: 0, max: 1.5, default: 1 },
    { id: 'mute', label: 'Mute', kind: 'toggle', default: 0 },
  ],
  create({ ctx }, p) {
    const amp = ctx.createGain();
    const mute = ctx.createGain();
    amp.gain.value = p.gain;
    mute.gain.value = p.mute ? 0 : 1;
    amp.connect(mute);
    return {
      inputs: { in: amp, cv: amp.gain },
      outputs: { out: mute },
      setParam(id, v, t) {
        if (id === 'gain') smooth(amp.gain, v, t);
        if (id === 'mute') smooth(mute.gain, v ? 0 : 1, t, 0.005);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Recorder: records what passes through it to a file on this computer
// ---------------------------------------------------------------------------

interface RecState {
  state: 'idle' | 'armed' | 'recording';
  /** performance.now() when recording started */
  since?: number;
  url?: string;
  name?: string;
}

const pickMime = () =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
    (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
  ) ?? '';

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

export const recorder: ModuleDef = {
  type: 'recorder',
  title: 'Recorder',
  category: 'output',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Thru', type: 'audio' }],
  params: [{ id: 'onBar', label: 'Start on bar', kind: 'toggle', default: 1 }],
  create({ ctx, engine, live }, p) {
    const input = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    input.connect(dest);
    let rec: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let url: string | undefined;
    let armed = false;
    let timer: number | undefined;
    const publish = (s: RecState) => live(s);
    publish({ state: 'idle' });

    const begin = () => {
      armed = false;
      chunks = [];
      const mimeType = pickMime();
      rec = new MediaRecorder(dest.stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        const type = rec?.mimeType || mimeType || 'audio/webm';
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob(chunks, { type }));
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        publish({ state: 'idle', url, name: `recording-${stamp()}.${ext}` });
        rec = null;
      };
      rec.start(1000);
      publish({ state: 'recording', since: performance.now() });
    };

    return {
      inputs: { in: input },
      outputs: { out: input },
      onStep(step, time) {
        if (!armed || step % 16 !== 0) return;
        armed = false;
        clearTimeout(timer);
        timer = window.setTimeout(begin, Math.max(0, (time - ctx.currentTime) * 1000));
      },
      onStop() {
        if (armed) begin();
      },
      setParam(id, v) {
        p[id] = v;
      },
      api: {
        start() {
          if (rec) return;
          if (p.onBar && engine.transport.playing) {
            armed = true;
            publish({ state: 'armed' });
          } else begin();
        },
        stop() {
          armed = false;
          clearTimeout(timer);
          if (rec) rec.stop();
          else publish({ state: 'idle', url });
        },
      },
      dispose() {
        clearTimeout(timer);
        if (rec && rec.state !== 'inactive') rec.stop();
        if (url) URL.revokeObjectURL(url);
      },
    };
  },
  Panel: RecorderPanel,
};

function RecorderPanel({ id, engine }: PanelProps) {
  const s = useLive<RecState>(id) ?? { state: 'idle' };
  const [, tick] = useState(0);
  useEffect(() => {
    if (s.state !== 'recording') return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [s.state]);
  const api = () => engine.instances.get(id)?.api;
  const secs = s.since ? Math.floor((performance.now() - s.since) / 1000) : 0;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="recorder nodrag">
      <div className="rec-row">
        {s.state === 'idle' ? (
          <button className="rec-btn" onClick={() => api()?.start()}>
            ● Record
          </button>
        ) : (
          <button className="rec-btn on" onClick={() => api()?.stop()}>
            ■ Stop
          </button>
        )}
        <span className="muted small">
          {s.state === 'armed' ? 'Waiting for next bar…' : s.state === 'recording' ? clock : ''}
        </span>
      </div>
      {s.state === 'idle' && s.url && (
        <a className="small" href={s.url} download={s.name}>
          Download {s.name}
        </a>
      )}
      <div className="muted small">Records on this computer only.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mixer: 4 channels with volume, pan and mute, plus master
// ---------------------------------------------------------------------------

const CH = [1, 2, 3, 4];
const chParams = (n: number): ParamDef[] => [
  { id: `v${n}`, label: `Vol ${n}`, min: 0, max: 1.25, default: 0.8 },
  { id: `p${n}`, label: 'Pan', min: -1, max: 1, default: 0 },
  { id: `m${n}`, label: 'M', kind: 'toggle', default: 0 },
];
const MASTER: ParamDef = { id: 'master', label: 'Master', min: 0, max: 1.25, default: 0.9 };

export const mixer: ModuleDef = {
  type: 'mixer',
  title: 'Mixer',
  category: 'mixer',
  width: 270,
  showParams: false,
  inputs: CH.map((n) => ({ id: `in${n}`, label: `Ch ${n}`, type: 'audio' as const })),
  outputs: [{ id: 'out', label: 'Out', type: 'audio' }],
  params: [...CH.flatMap(chParams), MASTER],
  create({ ctx }, p) {
    const master = ctx.createGain();
    master.gain.value = p.master;
    const strips = CH.map((n) => {
      const input = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const vol = ctx.createGain();
      input.gain.value = p[`m${n}`] ? 0 : 1;
      pan.pan.value = p[`p${n}`];
      vol.gain.value = p[`v${n}`];
      input.connect(pan).connect(vol).connect(master);
      return { input, pan, vol };
    });
    return {
      inputs: Object.fromEntries(CH.map((n, i) => [`in${n}`, strips[i].input])),
      outputs: { out: master },
      setParam(id, v, t) {
        if (id === 'master') return smooth(master.gain, v, t);
        const s = strips[Number(id.slice(1)) - 1];
        if (!s) return;
        if (id[0] === 'v') smooth(s.vol.gain, v, t);
        if (id[0] === 'p') smooth(s.pan.pan, v, t);
        if (id[0] === 'm') smooth(s.input.gain, v ? 0 : 1, t, 0.005);
      },
    };
  },
  Panel: MixerPanel,
};

function MixerPanel({ node, setParam }: PanelProps) {
  const val = (d: ParamDef) => node.params[d.id] ?? d.default;
  return (
    <div className="mixer">
      {CH.map((n) => {
        const [v, pan, m] = chParams(n);
        return (
          <div className="strip" key={n}>
            <Knob def={pan} value={val(pan)} onChange={(x) => setParam(pan.id, x)} size={26} label="Pan" />
            <Fader def={v} value={val(v)} onChange={(x) => setParam(v.id, x)} />
            <Toggle label="M" value={val(m)} onChange={(x) => setParam(m.id, x)} />
            <div className="strip-label">{n}</div>
          </div>
        );
      })}
      <div className="strip master">
        <div style={{ height: 52 }} />
        <Fader def={MASTER} value={val(MASTER)} onChange={(x) => setParam('master', x)} />
        <div className="strip-label">Master</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Output: speakers, with a level meter
// ---------------------------------------------------------------------------

export const output: ModuleDef = {
  type: 'output',
  title: 'Audio Out',
  category: 'output',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [],
  params: [{ id: 'volume', label: 'Volume', min: 0, max: 1, default: 0.8 }],
  create({ ctx }, p) {
    const input = ctx.createGain();
    const vol = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    vol.gain.value = p.volume;
    input.connect(vol).connect(analyser).connect(ctx.destination);
    const buf = new Float32Array(analyser.fftSize);
    return {
      inputs: { in: input },
      setParam(id, v, t) {
        if (id === 'volume') smooth(vol.gain, v, t);
      },
      api: {
        level() {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
          return peak;
        },
      },
      dispose: () => vol.disconnect(),
    };
  },
  Panel: OutputPanel,
};

function OutputPanel({ id, engine }: PanelProps) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const loop = () => {
      const peak: number = engine.instances.get(id)?.api?.level() ?? 0;
      shown = Math.max(peak, shown * 0.92);
      if (bar.current) {
        const db = 20 * Math.log10(shown + 1e-6);
        const pct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
        bar.current.style.width = `${pct}%`;
        bar.current.classList.toggle('clip', shown >= 0.99);
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [id, engine]);
  return (
    <>
      <div className="meter">
        <div ref={bar} className="meter-fill" />
      </div>
      <OutputPicker engine={engine} />
    </>
  );
}

/** Which speakers / interface this computer plays through. Saved per computer, not shared. */
function OutputPicker({ engine }: { engine: PanelProps['engine'] }) {
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [current, setCurrent] = useState(engine.outputDeviceId);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState(0);
  /** Bumped after mic permission is granted, to list the devices again with their names */
  const [scan, setScan] = useState(0);

  useEffect(() => {
    const load = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) =>
          setDevices(
            all
              // Without mic permission the browser hides device IDs (empty strings) — those can't be selected
              .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` })),
          ),
        )
        .catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    const offChange = engine.onOutputChange(() => setCurrent(engine.outputDeviceId));
    const t = setInterval(() => setLatency(((engine.ctx.outputLatency || 0) + (engine.ctx.baseLatency || 0)) * 1000), 500);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', load);
      offChange();
      clearInterval(t);
    };
  }, [engine, scan]);

  /**
   * Chrome only reveals output device names to pages that have microphone permission.
   * Ask once, then stop the mic straight away: nothing is recorded.
   */
  const revealNames = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setScan((n) => n + 1);
    } catch {
      setError('Microphone permission was not granted, so Chrome keeps the device names hidden.');
    }
  };
  const canAsk = !!navigator.mediaDevices?.getUserMedia;

  if (!engine.canChooseOutput) {
    return <p className="muted small">This browser can't choose an output device (needs Chrome or Edge).</p>;
  }
  const unnamed = devices.length === 0 || devices.every((d) => /^Output \d+$/.test(d.label));

  return (
    <div className="output-picker nodrag">
      <select
        value={current}
        title="Output device on this computer"
        onChange={async (e) => {
          setError(null);
          try {
            await engine.setOutputDevice(e.target.value);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <option value="">System default</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
      <div className="muted small">Output latency: {latency ? `${latency.toFixed(0)} ms` : '—'} (reported)</div>
      {unnamed && canAsk && (
        <>
          <button className="small" onClick={revealNames}>
            Show device names
          </button>
          <div className="muted small">
            Chrome only names output devices for pages with microphone permission. This asks once and turns the mic off right away.
          </div>
        </>
      )}
      {unnamed && !canAsk && (
        <div className="muted small">
          Device names need a secure page (localhost or https). Use System default and pick the device in Windows.
        </div>
      )}
      {error && <div className="lat-tip">{error}</div>}
    </div>
  );
}
