import { useEffect, useRef } from 'react';
import type { ModuleDef, PanelProps } from '../engine/types';

// Analysis modules pass audio straight through and draw what they hear.
// They only read audio on this device, so nothing here touches the shared document.

function makeTap(ctx: AudioContext, fftSize: number, smoothing = 0) {
  const input = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = smoothing;
  input.connect(analyser);
  return { input, analyser };
}

/** Redraw a canvas every animation frame, sized for the screen's pixel density. */
function useCanvasLoop(draw: (g: CanvasRenderingContext2D, w: number, h: number, color: string) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext('2d')!;
    const color = getComputedStyle(canvas).getPropertyValue('--c').trim() || '#e6e8ee';
    let raf = 0;
    const loop = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      g.clearRect(0, 0, w, h);
      drawRef.current(g, w, h, color);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return ref;
}

// ---------------------------------------------------------------------------
// Scope: the waveform, triggered on a rising zero crossing so it stands still
// ---------------------------------------------------------------------------

const SCOPE_SPANS = [256, 512, 1024, 2048];

export const scope: ModuleDef = {
  type: 'scope',
  title: 'Scope',
  category: 'utility',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Thru', type: 'audio' }],
  params: [
    { id: 'span', label: 'Span', kind: 'enum', options: ['5ms', '10ms', '20ms', '40ms'], default: 2 },
    { id: 'gain', label: 'Zoom', min: 0.5, max: 8, default: 1, curve: 'log' },
  ],
  create({ ctx }) {
    const { input, analyser } = makeTap(ctx, 4096);
    const buf = new Float32Array(analyser.fftSize);
    return {
      inputs: { in: input },
      outputs: { out: input },
      api: {
        read() {
          analyser.getFloatTimeDomainData(buf);
          return buf;
        },
      },
    };
  },
  Panel: ScopePanel,
};

function ScopePanel({ id, node, engine }: PanelProps) {
  const span = SCOPE_SPANS[node.params.span ?? 2];
  const gain = node.params.gain ?? 1;
  const ref = useCanvasLoop((g, w, h, color) => {
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
    const buf: Float32Array | undefined = engine.instances.get(id)?.api?.read();
    if (!buf) return;
    let start = 0;
    for (let i = 1; i < buf.length - span; i++) {
      if (buf[i - 1] <= 0 && buf[i] > 0) {
        start = i;
        break;
      }
    }
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.25);
    g.beginPath();
    for (let i = 0; i < span; i++) {
      const x = (i / (span - 1)) * w;
      const y = h / 2 - Math.max(-1, Math.min(1, buf[start + i] * gain)) * (h / 2 - 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  });
  return <canvas ref={ref} className="viz" />;
}

// ---------------------------------------------------------------------------
// Spectrum: level per frequency, on a log scale from 20 Hz to 20 kHz
// ---------------------------------------------------------------------------

export const spectrum: ModuleDef = {
  type: 'spectrum',
  title: 'Spectrum',
  category: 'utility',
  inputs: [{ id: 'in', label: 'In', type: 'audio' }],
  outputs: [{ id: 'out', label: 'Thru', type: 'audio' }],
  params: [
    { id: 'smoothing', label: 'Smooth', min: 0, max: 0.95, default: 0.8 },
    { id: 'floor', label: 'Floor', min: -120, max: -40, default: -90, unit: 'dB' },
  ],
  create({ ctx }, p) {
    const { input, analyser } = makeTap(ctx, 8192, p.smoothing);
    const bins = new Float32Array(analyser.frequencyBinCount);
    return {
      inputs: { in: input },
      outputs: { out: input },
      setParam(id, v) {
        if (id === 'smoothing') analyser.smoothingTimeConstant = v;
      },
      api: {
        read() {
          analyser.getFloatFrequencyData(bins);
          return { bins, nyquist: ctx.sampleRate / 2 };
        },
      },
    };
  },
  Panel: SpectrumPanel,
};

const F_LO = 20;
const F_HI = 20000;
const GRID_FREQS = [100, 1000, 10000];

function SpectrumPanel({ id, node, engine }: PanelProps) {
  const floor = node.params.floor ?? -90;
  const ref = useCanvasLoop((g, w, h, color) => {
    const xOf = (f: number) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    for (const f of GRID_FREQS) {
      g.beginPath();
      g.moveTo(xOf(f), 0);
      g.lineTo(xOf(f), h);
      g.stroke();
    }
    const data: { bins: Float32Array; nyquist: number } | undefined = engine.instances.get(id)?.api?.read();
    if (!data) return;
    const { bins, nyquist } = data;
    const ceil = 0;
    g.fillStyle = color;
    g.globalAlpha = 0.8;
    const cols = Math.floor(w / 2);
    for (let c = 0; c < cols; c++) {
      // Take the loudest bin in each pixel column, so narrow peaks stay visible
      const f0 = F_LO * Math.pow(F_HI / F_LO, c / cols);
      const f1 = F_LO * Math.pow(F_HI / F_LO, (c + 1) / cols);
      const b0 = Math.floor((f0 / nyquist) * bins.length);
      const b1 = Math.max(b0 + 1, Math.floor((f1 / nyquist) * bins.length));
      let db = -Infinity;
      for (let b = b0; b < b1 && b < bins.length; b++) db = Math.max(db, bins[b]);
      const v = Math.max(0, Math.min(1, (db - floor) / (ceil - floor)));
      const bh = v * h;
      g.fillRect((c / cols) * w, h - bh, w / cols, bh);
    }
    g.globalAlpha = 1;
  });
  return <canvas ref={ref} className="viz" />;
}
