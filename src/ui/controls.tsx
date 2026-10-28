import { memo, useRef, type PointerEvent } from 'react';
import type { ParamDef } from '../engine/types';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function toNorm(def: ParamDef, v: number) {
  const min = def.min ?? 0;
  const max = def.max ?? 1;
  if (def.curve === 'log') return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}

export function fromNorm(def: ParamDef, n: number) {
  const min = def.min ?? 0;
  const max = def.max ?? 1;
  let v = def.curve === 'log' ? min * Math.pow(max / min, n) : min + n * (max - min);
  if (def.step) v = Math.round(v / def.step) * def.step;
  return clamp(v, min, max);
}

export function formatValue(v: number) {
  const a = Math.abs(v);
  return a >= 1000 ? `${(v / 1000).toFixed(1)}k` : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** Vertical drag on any element: calls back with a normalized 0..1 value. Shift = fine. */
function useDrag(norm: number, onNorm: (n: number) => void, range = 150) {
  const start = useRef<{ y: number; n: number } | null>(null);
  return {
    onPointerDown(e: PointerEvent) {
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { y: e.clientY, n: norm };
    },
    onPointerMove(e: PointerEvent) {
      if (!start.current) return;
      const r = e.shiftKey ? range * 4 : range;
      onNorm(clamp(start.current.n + (start.current.y - e.clientY) / r, 0, 1));
    },
    onPointerUp() {
      start.current = null;
    },
    onPointerCancel() {
      start.current = null;
    },
  };
}

interface KnobProps {
  def: ParamDef;
  value: number;
  onChange(v: number): void;
  size?: number;
  label?: string;
}

export const Knob = memo(function Knob({ def, value, onChange, size = 34, label }: KnobProps) {
  const n = clamp(toNorm(def, value), 0, 1);
  const drag = useDrag(n, (nn) => onChange(fromNorm(def, nn)));
  const r = size / 2 - 3;
  const c = size / 2;
  const a0 = Math.PI * 0.75;
  const a1 = a0 + n * Math.PI * 1.5;
  const arc = (from: number, to: number) => {
    const large = to - from > Math.PI ? 1 : 0;
    return `M ${c + r * Math.cos(from)} ${c + r * Math.sin(from)} A ${r} ${r} 0 ${large} 1 ${c + r * Math.cos(to)} ${c + r * Math.sin(to)}`;
  };
  return (
    <div className="knob nodrag" title={`${def.label}: ${formatValue(value)}${def.unit ?? ''} (double-click to reset, Shift = fine)`}>
      <svg
        width={size}
        height={size}
        {...drag}
        onDoubleClick={() => onChange(def.default)}
        style={{ touchAction: 'none', cursor: 'ns-resize' }}
      >
        <path d={arc(a0, a0 + Math.PI * 1.5)} className="knob-track" />
        {n > 0.001 && <path d={arc(a0, a1)} className="knob-value" />}
        <line x1={c} y1={c} x2={c + r * 0.6 * Math.cos(a1)} y2={c + r * 0.6 * Math.sin(a1)} className="knob-pointer" />
      </svg>
      <div className="knob-label">{label ?? def.label}</div>
      <div className="knob-readout">
        {formatValue(value)}
        {def.unit && <span className="unit">{def.unit}</span>}
      </div>
    </div>
  );
});

export const Fader = memo(function Fader({
  def,
  value,
  onChange,
  height = 90,
}: {
  def: ParamDef;
  value: number;
  onChange(v: number): void;
  height?: number;
}) {
  const n = clamp(toNorm(def, value), 0, 1);
  const drag = useDrag(n, (nn) => onChange(fromNorm(def, nn)), height);
  return (
    <div
      className="fader nodrag"
      style={{ height, touchAction: 'none' }}
      {...drag}
      onDoubleClick={() => onChange(def.default)}
      title={`${def.label}: ${formatValue(value)}`}
    >
      <div className="fader-fill" style={{ height: `${n * 100}%` }} />
      <div className="fader-cap" style={{ bottom: `calc(${n * 100}% - 4px)` }} />
    </div>
  );
});

export function EnumControl({ def, value, onChange }: { def: ParamDef; value: number; onChange(v: number): void }) {
  return (
    <div className="enum nodrag">
      <div className="knob-label">{def.label}</div>
      <div className="enum-options">
        {def.options!.map((o, i) => (
          <button key={o} className={i === value ? 'on' : ''} onClick={() => onChange(i)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  return (
    <button className={`toggle nodrag ${value ? 'on' : ''}`} onClick={() => onChange(value ? 0 : 1)}>
      {label}
    </button>
  );
}

export function ParamControl({ def, value, onChange }: { def: ParamDef; value: number; onChange(v: number): void }) {
  if (def.kind === 'enum') return <EnumControl def={def} value={value} onChange={onChange} />;
  if (def.kind === 'toggle') return <Toggle label={def.label} value={value} onChange={onChange} />;
  return <Knob def={def} value={value} onChange={onChange} />;
}
