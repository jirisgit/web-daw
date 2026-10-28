import { uid, type Doc, type DocEdge, type DocNode } from './engine/doc';
import { getDef } from './modules/registry';

export function makeNode(type: string, x: number, y: number, params: Record<string, number> = {}): DocNode {
  const def = getDef(type)!;
  const p: Record<string, number> = {};
  def.params.forEach((d) => (p[d.id] = d.default));
  return { id: uid(type), type, x, y, params: { ...p, ...params }, data: def.defaultData?.() ?? {} };
}

/** A small starter patch: drums + synth through effects into the mixer. */
export function defaultPatch(): Doc {
  const seq = makeNode('sequencer', 40, 40);
  const drums = makeNode('drums', 460, 40);
  const kb = makeNode('keyboard', 40, 330);
  const midi = makeNode('midiIn', 40, 620);
  const synth = makeNode('synth', 420, 330);
  const auto = makeNode('automation', 380, 730);
  const filter = makeNode('filter', 720, 360, { cutoff: 400, q: 5 });
  const delay = makeNode('delay', 720, 640);
  const mixer = makeNode('mixer', 1000, 120, { v2: 0.6 });
  const reverb = makeNode('reverb', 1320, 140);
  const out = makeNode('output', 1580, 160);

  const wire = (a: DocNode, ap: string, b: DocNode, bp: string): DocEdge => ({
    id: uid('e'),
    source: a.id,
    sourceHandle: ap,
    target: b.id,
    targetHandle: bp,
  });

  const nodes = [seq, drums, kb, midi, synth, auto, filter, delay, mixer, reverb, out];
  const edges = [
    wire(seq, 'midi', drums, 'midi'),
    wire(drums, 'out', mixer, 'in1'),
    wire(kb, 'midi', synth, 'midi'),
    wire(midi, 'midi', synth, 'midi'),
    wire(synth, 'out', filter, 'in'),
    wire(auto, 'out', filter, 'cutoff'),
    wire(filter, 'out', delay, 'in'),
    wire(delay, 'out', mixer, 'in2'),
    wire(mixer, 'out', reverb, 'in'),
    wire(reverb, 'out', out, 'in'),
  ];

  return {
    transport: { playing: false, bpm: 120, anchorMs: 0, anchorStep: 0 },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
  };
}
