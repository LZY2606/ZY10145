import { useEffect, useMemo, useState } from 'react';
import type { NodeDiff, PlanComparison } from '../shared/model.ts';
import { apiRequest } from './api.ts';

type StoredAnnotation = {
  id: string;
  comparison_id: string;
  node_id: string;
  decision: 'explained' | 'accepted' | 'rejected' | 'investigating';
  note: string;
  author: string;
  version: number;
};

interface Props {
  comparison: PlanComparison;
  diff: NodeDiff | null;
}

export function AnnotationPanel({ comparison, diff }: Props) {
  const nodeId = diff?.baselineNodeId ?? diff?.candidateNodeId ?? '';
  const [annotations, setAnnotations] = useState<StoredAnnotation[]>([]);
  const [decision, setDecision] = useState<StoredAnnotation['decision']>('explained');
  const [note, setNote] = useState('');
  const [author, setAuthor] = useState('dba');
  const [message, setMessage] = useState<string>('');
  const [conflict, setConflict] = useState<NodeDiff | null>(null);

  useEffect(() => {
    setMessage('');
    setConflict(null);
    apiRequest<{ annotations: StoredAnnotation[] }>(`/api/comparisons/${comparison.id}/annotations`)
      .then((body) => {
        setAnnotations(body.annotations);
        const current = body.annotations.find((annotation) => annotation.node_id === nodeId);
        if (current) {
          setDecision(current.decision);
          setNote(current.note);
        }
      })
      .catch(() => undefined);
  }, [comparison.id, nodeId]);

  const current = useMemo(() => annotations.find((annotation) => annotation.node_id === nodeId), [annotations, nodeId]);

  async function save() {
    try {
      const body = await apiRequest<{ annotation: StoredAnnotation }>('/api/annotations', {
        method: 'POST',
        body: JSON.stringify({ comparisonId: comparison.id, nodeId, decision, note, author, expectedVersion: current?.version ?? null })
      });
      setAnnotations((existing) => [body.annotation, ...existing.filter((item) => item.id !== body.annotation.id)]);
      setMessage(`已保存，节点决议版本 ${body.annotation.version}`);
      setConflict(null);
    } catch (error) {
      const payload = (error as { body?: { nodeDiff?: NodeDiff; error?: string } }).body;
      setConflict(payload?.nodeDiff ?? null);
      setMessage(payload?.error ?? '保存失败');
    }
  }

  if (!diff) return <aside className="side-panel">选择一个节点以查看或添加批注。</aside>;

  return (
    <aside className="side-panel">
      <h2>节点决议</h2>
      <p className="mono small">{nodeId}</p>
      <label>
        决议
        <select value={decision} onChange={(event) => setDecision(event.target.value as StoredAnnotation['decision'])}>
          <option value="explained">已解释变化</option>
          <option value="accepted">接受候选</option>
          <option value="rejected">拒绝候选</option>
          <option value="investigating">继续调查</option>
        </select>
      </label>
      <label>
        说明
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5} />
      </label>
      <label>
        作者
        <input value={author} onChange={(event) => setAuthor(event.target.value)} />
      </label>
      <button type="button" onClick={save}>保存批注</button>
      {message && <p className="message">{message}</p>}
      {conflict && (
        <div className="conflict">
          <h3>并发批注冲突：节点级差异</h3>
          <p>类型：{conflict.kind}；估算行比值：{conflict.estimateRowsRatio?.toFixed(2) ?? '—'}；物理变化：{String(conflict.physicalChanged)}</p>
          <p>基线算子：{conflict.baseline?.operator ?? '—'}；候选算子：{conflict.candidate?.operator ?? '—'}</p>
        </div>
      )}
    </aside>
  );
}
