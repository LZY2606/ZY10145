import type { NodeDiff, PlanComparison } from '../shared/model.ts';

const groups: Array<{ title: string; kinds: NodeDiff['kind'][] }> = [
  { title: '结构 / 等价交换', kinds: ['structure_changed', 'equivalent_reorder', 'removed', 'added'] },
  { title: '估算漂移', kinds: ['estimate_drift'] },
  { title: '索引与分区决策', kinds: ['index_changed', 'partition_changed'] }
];

export function DiffList({ comparison, selectedId, onSelect }: { comparison: PlanComparison; selectedId: string | null; onSelect: (diff: NodeDiff) => void }) {
  return (
    <section className="diff-list">
      <h2>对齐差异</h2>
      {groups.map((group) => {
        const items = comparison.nodeDiffs.filter((diff) => group.kinds.includes(diff.kind));
        return (
          <div key={group.title} className="diff-group">
            <h3>{group.title} <span>{items.length}</span></h3>
            {items.length === 0 && <p className="muted">无</p>}
            {items.map((diff) => {
              const id = diff.baselineNodeId ?? diff.candidateNodeId ?? diff.path;
              return (
                <button
                  type="button"
                  key={`${diff.path}:${id}`}
                  className={`diff-item ${selectedId === id ? 'selected' : ''}`}
                  onClick={() => onSelect(diff)}
                >
                  <strong>{diff.operator}</strong>
                  <span>{diff.kind}</span>
                  <small>{diff.path}</small>
                  <small>rows × {diff.estimateRowsRatio?.toFixed(2) ?? '—'} · cost × {diff.estimateCostRatio?.toFixed(2) ?? '—'}</small>
                </button>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
