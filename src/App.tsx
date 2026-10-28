import { useCallback, useEffect, useState, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { store, uid, useDoc } from './engine/doc';
import { engine, type EditPolicy } from './engine/engine';
import { CATEGORY_LABELS, MODULES, getDef } from './modules/registry';
import type { Category, PortType } from './engine/types';
import { ModuleNode } from './ui/ModuleNode';
import { SessionBar } from './ui/SessionBar';
import { defaultPatch, makeNode } from './defaultPatch';
import { setCursor, usePeers } from './sync/session';

const nodeTypes = { module: ModuleNode };
const DRAG_MIME = 'application/x-web-daw-module';

function portType(nodeId: string | null, handle: string | null | undefined, dir: 'in' | 'out'): PortType | undefined {
  if (!nodeId || !handle) return;
  const n = store.get().nodes[nodeId];
  const def = n && getDef(n.type);
  return (dir === 'out' ? def?.outputs : def?.inputs)?.find((p) => p.id === handle)?.type;
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

/** Other users' mouse pointers, drawn in canvas coordinates */
function RemoteCursors() {
  const peers = usePeers();
  return (
    <ViewportPortal>
      {peers
        .filter((p) => !p.isMe && p.cursor)
        .map((p) => (
          <div
            key={p.clientId}
            className="remote-cursor"
            style={{ transform: `translate(${p.cursor!.x}px, ${p.cursor!.y}px)`, color: p.user.color }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M1 1 L1 13 L5 9.5 L8 15 L10 14 L7 8.5 L12 8.5 Z" fill="currentColor" stroke="#000" strokeWidth="1" />
            </svg>
            <span style={{ background: p.user.color }}>{p.user.name}</span>
          </div>
        ))}
    </ViewportPortal>
  );
}

function Canvas() {
  const docNodes = useDoc((d) => d.nodes);
  const docEdges = useDoc((d) => d.edges);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const { screenToFlowPosition } = useReactFlow();

  // Document → React Flow nodes (keep RF's own measured/selected state)
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return Object.values(docNodes).map((dn) => {
        const p = byId.get(dn.id);
        if (p && p.position.x === dn.x && p.position.y === dn.y) return p;
        if (p) return { ...p, position: { x: dn.x, y: dn.y } };
        return { id: dn.id, type: 'module', position: { x: dn.x, y: dn.y }, data: {}, dragHandle: '.mod-header' };
      });
    });
  }, [docNodes]);

  useEffect(() => {
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return Object.values(docEdges).map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
        className: `e-${portType(e.source, e.sourceHandle, 'out') ?? 'audio'}`,
        selected: selected.has(e.id),
      }));
    });
  }, [docEdges, docNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    for (const c of changes) {
      if (c.type === 'position' && c.position) store.moveNode(c.id, c.position.x, c.position.y);
      if (c.type === 'remove') store.removeNode(c.id);
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    for (const c of changes) if (c.type === 'remove') store.removeEdge(c.id);
  }, []);

  const isValidConnection: IsValidConnection = useCallback((c) => {
    if (c.source === c.target) return false;
    const a = portType(c.source, c.sourceHandle, 'out');
    const b = portType(c.target, c.targetHandle, 'in');
    return !!a && a === b;
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.sourceHandle || !c.targetHandle) return;
    store.addEdge({ id: uid('e'), source: c.source, sourceHandle: c.sourceHandle, target: c.target, targetHandle: c.targetHandle });
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(DRAG_MIME);
      if (!type) return;
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      store.addNode(makeNode(type, pos.x - 100, pos.y - 20));
    },
    [screenToFlowPosition],
  );

  const addAtCenter = useCallback(
    (type: string) => {
      const pos = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      store.addNode(makeNode(type, pos.x - 110 + Math.random() * 40, pos.y - 80 + Math.random() * 40));
    },
    [screenToFlowPosition],
  );

  // Undo / redo only undoes your own edits, never other people's
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) store.undo();
      else if (k === 'y' || (k === 'z' && e.shiftKey)) store.redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <Palette onAdd={addAtCenter} />
        <div
          className="canvas"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onPointerMove={(e) => setCursor(screenToFlowPosition({ x: e.clientX, y: e.clientY }))}
          onPointerLeave={() => setCursor(null)}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onEdgeDoubleClick={(_, edge) => store.removeEdge(edge.id)}
            deleteKeyCode={['Backspace', 'Delete']}
            minZoom={0.2}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.1 }}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
            <Controls />
            <RemoteCursors />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

function TopBar() {
  const bpm = useDoc((d) => d.transport.bpm);
  const playing = useDoc((d) => d.transport.playing);
  const [audioState, setAudioState] = useState(engine.ctx.state);
  const [policy, setPolicy] = useState<EditPolicy>(engine.policy);
  const [bpmText, setBpmText] = useState(String(bpm));

  useEffect(() => setBpmText(String(bpm)), [bpm]);

  useEffect(() => {
    const update = () => setAudioState(engine.ctx.state);
    engine.ctx.addEventListener('statechange', update);
    // Browsers only allow audio after a user gesture
    const unlock = () => engine.resume();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      engine.ctx.removeEventListener('statechange', update);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const toggle = useCallback(async () => {
    await engine.resume();
    if (store.get().transport.playing) engine.stop();
    else engine.play();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.code !== 'Space' || isTyping(e) || t.tagName === 'BUTTON') return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <header className="topbar">
      <div className="brand">Web DAW</div>
      <button className={`play ${playing ? 'on' : ''}`} onClick={toggle} title="Play / stop for everyone (Space)">
        {playing ? '■ Stop' : '▶ Play'}
      </button>
      <label className="field">
        BPM
        <input
          type="number"
          min={40}
          max={240}
          value={bpmText}
          onChange={(e) => {
            setBpmText(e.target.value);
            const v = Number(e.target.value);
            if (v >= 40 && v <= 240) engine.setBpm(v);
          }}
          onBlur={() => setBpmText(String(store.get().transport.bpm))}
        />
      </label>
      <label
        className="field"
        title="Instantly = jam mode (same Wi-Fi). Next bar = studio mode (internet): edits land on the next bar, other people's notes on the next step."
      >
        Edits apply
        <select
          value={policy}
          onChange={(e) => {
            const v = e.target.value as EditPolicy;
            engine.policy = v;
            setPolicy(v);
          }}
        >
          <option value="instant">Instantly (jam)</option>
          <option value="bar">On next bar (studio)</option>
        </select>
      </label>
      <div className="spacer" />
      {audioState !== 'running' && <span className="badge warn">Audio paused, click anywhere to start</span>}
      <SessionBar />
      <button
        onClick={() => {
          if (confirm('Replace the patch with the starter patch, for everyone in this room?')) store.replace(defaultPatch());
        }}
      >
        Reset patch
      </button>
    </header>
  );
}

function Palette({ onAdd }: { onAdd(type: string): void }) {
  const groups = Object.keys(CATEGORY_LABELS) as Category[];
  return (
    <aside className="palette">
      {groups.map((cat) => (
        <section key={cat}>
          <h3>{CATEGORY_LABELS[cat]}</h3>
          {MODULES.filter((m) => m.category === cat).map((m) => (
            <button
              key={m.type}
              className={`palette-item cat-${m.category}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, m.type);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(m.type)}
              title="Click or drag onto the canvas"
            >
              {m.title}
            </button>
          ))}
        </section>
      ))}
      <div className="help">
        <p>
          Drag from an output to an input to patch. Colors: <b className="t-audio">audio</b>, <b className="t-midi">MIDI</b>,{' '}
          <b className="t-control">control</b>.
        </p>
        <p>Double-click a cable to remove it. Double-click a knob to reset it. Shift-drag for fine control.</p>
        <p>Play the Keyboard with your computer keys: A W S E D F T G…</p>
        <p>Ctrl+Z / Ctrl+Y undo and redo your own edits.</p>
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
