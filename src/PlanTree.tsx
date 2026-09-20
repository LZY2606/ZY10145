import type { NodeDiff, PlanNode } from '../shared/model.ts';

interface PlanTreeProps {
  title: string;
  root: PlanNode;
  selectedId: string | null;
  diffsByNode: Map<string, NodeDiff>;
  onSelect: (node: PlanNode) => void;
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...node.children.flatMap((child) => flatten(child.node))];
}

export function nodesInTree(root: PlanNode): PlanNode[] {
  return flatten(root);
}

function findNode(root: PlanNode, id: string): PlanNode | null {
  return flatten(root).find((node) => node.nodeId === id) ?? null;
}

function nodeLabel(node: PlanNode): string {
  const relation = node.relation ? ` · ${node.relation}${node.alias ? ` ${node.alias}` : ''}` : '';
  const index = node.index ? ` · ${node.index}` : '';
  return `${node.operator}${relation}${index}`;
}

function kindClass(kind: NodeDiff['kind'] | undefined): string {
  switch (kind) {
    case 'structure_changed':
    case 'removed':
    case 'added':
      return 'node-structure';
    case 'equivalent_reorder':
      return 'node-reorder';
    case 'index_changed':
    case 'partition_changed':
      return 'node-decision';
    case 'estimate_drift':
      return 'node-estimate';
    default:
      return '';
  }
}

function TreeRow({ node, depth, selectedId, diffsByNode, onSelect }: { node: PlanNode; depth: number } & Omit<PlanTreeProps, 'title' | 'root'>) {
  const diff = diffsByNode.get(node.nodeId);
  return (
    <div>
      <button
        type="button"
        className={`tree-row ${kindClass(diff?.kind)} ${selectedId === node.nodeId ? 'selected' : ''}`}
        style={{ '--depth': depth } as React.CSSProperties}
        onClick={() => onSelect(node)}
      >
        <span>{nodeLabel(node)}</span>
        <small>{node.estimatedRows ?? '—'} rows · {node.estimatedCost ?? '—'} cost</small>
      </button>
      {node.children.map((child) => (
        <TreeRow
          key={`${child.role}:${child.node.nodeId}`}
          node={child.node}
          depth={depth + 1}
          selectedId={selectedId}
          diffsByNode={diffsByNode}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function PlanTree({ title, root, selectedId, diffsByNode, onSelect }: PlanTreeProps) {
  const selected = selectedId ? findNode(root, selectedId) : null;
  return (
    <section className="tree-panel">
      <h2>{title}</h2>
      <div className="tree-scroll">
        <TreeRow node={root} depth={0} selectedId={selectedId} diffsByNode={diffsByNode} onSelect={onSelect} />
      </div>
      {selected && (
        <div className="node-details">
          <h3>{nodeLabel(selected)}</h3>
          <dl>
            <dt>Stable node ID</dt>
            <dd><code>{selected.nodeId}</code></dd>
            <dt>Join</dt>
            <dd>{selected.joinKind ?? '—'} / {selected.joinDirection}</dd>
            <dt>Index / partition</dt>
            <dd>{selected.index ?? 'no index'} / {selected.partitions?.selected.join(', ') ?? 'no partition decision'}</dd>
            <dt>Filter / projection</dt>
            <dd>{selected.filterDigest ?? '—'} / {selected.projectionDigest ?? '—'}</dd>
            <dt>Warnings</dt>
            <dd>{selected.warnings.length === 0 ? 'none' : selected.warnings.map((warning) => warning.message).join('; ')}</dd>
          </dl>
        </div>
      )}
    </section>
  );
}
