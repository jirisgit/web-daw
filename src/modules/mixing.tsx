import { useEffect, useRef, useState } from 'react';
import type { ModuleDef, ParamDef, PanelProps } from '../engine/types';
import { Fader, Knob, Toggle } from '../ui/controls';
import { smooth } from './util';

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
  }, [engine]);

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
      {unnamed && <div className="muted small">Chrome only lists output devices to pages with microphone permission, which this app doesn't ask for. Use System default and pick the device in Windows.</div>}
      {error && <div className="lat-tip">{error}</div>}
    </div>
  );
}
