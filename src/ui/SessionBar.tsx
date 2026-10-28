import { useEffect, useState } from 'react';
import { engine } from '../engine/engine';
import { clock, renameMe, room, useConnStatus, usePeers } from '../sync/session';

const STATUS_TEXT = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Offline, changes are saved in this browser and sync when you reconnect',
};

export function SessionBar() {
  const status = useConnStatus();
  const peers = usePeers();
  const [open, setOpen] = useState(false);

  return (
    <div className="session">
      <span className={`dot ${status}`} title={STATUS_TEXT[status]} />
      <div className="peers">
        {peers.map((p) => (
          <button
            key={p.clientId}
            className={`peer ${p.isMe ? 'me' : ''}`}
            style={{ background: p.user.color }}
            title={p.isMe ? `${p.user.name} (you, click to rename)` : p.user.name}
            onClick={() => {
              if (!p.isMe) return;
              const name = prompt('Your name', p.user.name)?.trim();
              if (name) renameMe(name.slice(0, 24));
            }}
          >
            {p.user.name.slice(0, 1).toUpperCase()}
          </button>
        ))}
      </div>
      <button onClick={() => setOpen((o) => !o)}>Share</button>
      {open && <SharePanel onClose={() => setOpen(false)} />}
    </div>
  );
}

function SharePanel({ onClose }: { onClose(): void }) {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [rtt, setRtt] = useState(clock.rtt);
  const [speaker, setSpeaker] = useState(engine.speakerDelayMs);
  const [roomName, setRoomName] = useState(room);

  useEffect(() => {
    fetch('/api/lan')
      .then((r) => r.json())
      .then((d) => setAddresses(d.addresses ?? []))
      .catch(() => {});
    const t = setInterval(() => setRtt(clock.rtt), 1000);
    return () => clearInterval(t);
  }, []);

  const port = location.port ? `:${location.port}` : '';
  const query = `?room=${encodeURIComponent(room)}`;
  const links = addresses.length
    ? addresses.map((a) => `${location.protocol}//${a}${port}/${query}`)
    : [`${location.origin}/${query}`];
  const outLatency = Math.round(((engine.ctx.outputLatency || engine.ctx.baseLatency || 0) as number) * 1000);

  return (
    <div className="share-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="share-head">
        <b>Room “{room}”</b>
        <button className="close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="muted">Open this on another device on the same Wi-Fi to make music together:</p>
      {links.map((l) => (
        <div className="share-link" key={l}>
          <code>{l}</code>
          <button onClick={() => navigator.clipboard?.writeText(l)}>Copy</button>
        </div>
      ))}

      <form
        className="share-row"
        onSubmit={(e) => {
          e.preventDefault();
          const name = roomName.trim();
          if (name && name !== room) location.search = `?room=${encodeURIComponent(name)}`;
        }}
      >
        <label>Switch room</label>
        <input value={roomName} onChange={(e) => setRoomName(e.target.value)} />
        <button type="submit">Go</button>
      </form>

      <h4>Timing on this device</h4>
      <div className="share-row">
        <label>Network round trip</label>
        <span>{Number.isFinite(rtt) ? `${rtt.toFixed(1)} ms` : '—'}</span>
      </div>
      <div className="share-row">
        <label>Audio output latency</label>
        <span>{outLatency} ms (auto-compensated)</span>
      </div>
      <div className="share-row">
        <label title="Extra delay the browser can't see, e.g. Bluetooth speakers. Raise it if this device sounds late.">
          Extra speaker delay
        </label>
        <input
          type="number"
          min={0}
          max={500}
          value={speaker}
          onChange={(e) => {
            const v = Math.max(0, Math.min(500, Number(e.target.value) || 0));
            setSpeaker(v);
            engine.setSpeakerDelay(v);
          }}
        />
        <span>ms</span>
      </div>
      <p className="muted small">
        The patch is saved in this browser and on the server, per room. Loaded samples stay on the device that loaded them.
      </p>
    </div>
  );
}
