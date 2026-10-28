import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { store, useDoc } from '../engine/doc';
import { engine } from '../engine/engine';
import { getDef } from '../modules/registry';
import { ParamControl } from './controls';

export const ModuleNode = memo(function ModuleNode({ id, selected }: NodeProps) {
  const node = useDoc((d) => d.nodes[id]);
  const setParam = useCallback((p: string, v: number) => store.setParam(id, p, v), [id]);
  const setData = useCallback((patch: Record<string, unknown>) => store.setData(id, patch), [id]);
  const def = node && getDef(node.type);
  if (!node || !def) return null;

  return (
    <div className={`module cat-${def.category} ${selected ? 'selected' : ''}`} style={{ width: def.width ?? 220 }}>
      <div className="mod-header">
        <span>{def.title}</span>
        <button className="nodrag close" title="Remove module" onClick={() => store.removeNode(id)}>
          ×
        </button>
      </div>

      {(def.inputs.length > 0 || def.outputs.length > 0) && (
        <div className="mod-ports">
          <div className="ports-col">
            {def.inputs.map((p) => (
              <div className="port in" key={p.id}>
                <Handle type="target" position={Position.Left} id={p.id} className={`h-${p.type}`} />
                {p.label}
              </div>
            ))}
          </div>
          <div className="ports-col right">
            {def.outputs.map((p) => (
              <div className="port out" key={p.id}>
                {p.label}
                <Handle type="source" position={Position.Right} id={p.id} className={`h-${p.type}`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {def.showParams !== false && def.params.length > 0 && (
        <div className="mod-params">
          {def.params.map((p) => (
            <ParamControl key={p.id} def={p} value={node.params[p.id] ?? p.default} onChange={(v) => setParam(p.id, v)} />
          ))}
        </div>
      )}

      {def.Panel && (
        <div className="mod-panel">
          <def.Panel id={id} node={node} engine={engine} setData={setData} setParam={setParam} />
        </div>
      )}
    </div>
  );
});
