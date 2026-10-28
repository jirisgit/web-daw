import { useEffect, useState } from 'react';
import type { ModuleDef, PanelProps } from '../engine/types';
import { latencyStats, summarize } from '../engine/latency';
import { bufferMode, setBufferMode, type BufferMode } from '../engine/engine';

// ---------------------------------------------------------------------------
// Latency Meter: timing of notes played on this device, as the browser sees it.
// No microphone: the old mic tests live in /parked/mic-tests.
// ---------------------------------------------------------------------------

export const latencyMeter: ModuleDef = {
  type: 'latencyMeter',
  title: 'Latency Meter',
  category: 'utility',
  width: 340,
  inputs: [],
  outputs: [],
  showParams: false,
  params: [],
  create() {
    return {};
  },
  Panel: MeterPanel,
};

const ms = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(v < 10 ? 1 : 0)} ms`);

function useTick(intervalMs: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

const isAndroid = /Android/i.test(navigator.userAgent);

function MeterPanel({ engine }: PanelProps) {
  useTick(300);
  const samples = latencyStats.samples;
  const last = samples.at(-1);
  const stat = (k: 'inputToApp' | 'appToSpeaker' | 'total') => summarize(samples.map((s) => s[k]));
  const rows: [string, 'inputToApp' | 'appToSpeaker' | 'total', string][] = [
    ['Input → app', 'inputToApp', 'Browser received the touch / MIDI message → our code handled it'],
    ['App → speaker', 'appToSpeaker', 'Audio buffer + output device'],
    ['Total (software)', 'total', 'Everything the browser can see'],
  ];
  const stalls = latencyStats.recentStalls();
  const base = (engine.ctx.baseLatency || 0) * 1000;
  const output = (engine.ctx.outputLatency || 0) * 1000;

  const tips: string[] = [];
  const inApp = stat('inputToApp');
  if (inApp && inApp.max > 20) tips.push('Some notes waited for a busy main thread. Close other tabs and avoid editing while playing.');
  if (output > 30) {
    tips.push(
      isAndroid
        ? 'The output is slow. Bluetooth adds 100–250 ms: use the phone speaker or wired headphones. Turn off battery saver.'
        : 'The output device is slow. Try wired headphones or a USB audio interface, and turn off "Audio enhancements" in Windows sound settings.',
    );
  }

  return (
    <div className="meter-panel nodrag nopan">
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
          <span title="Saved on this device. Reloads the page.">Buffer size</span>
          <select value={bufferMode} onChange={(e) => setBufferMode(e.target.value as BufferMode)}>
            <option value="default">Default</option>
            <option value="smallest">Smallest</option>
          </select>
        </div>
        <div>
          <span>Output device (reported)</span>
          <b className={output > 30 ? 'bad' : ''}>{ms(output)}</b>
        </div>
        <div>
          <span>Sample rate</span>
          <b>{engine.ctx.sampleRate} Hz</b>
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
      <p className="muted small">
        Not shown: the touchscreen or MIDI cable before the browser, and the speaker after the sound card.
      </p>
    </div>
  );
}
