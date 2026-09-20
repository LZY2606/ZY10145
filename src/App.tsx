import { useEffect, useMemo, useState } from 'react';
import { AnnotationPanel } from './AnnotationPanel.tsx';
import { apiRequest } from './api.ts';
import { DiffList } from './DiffList.tsx';
import { PlanTree } from './PlanTree.tsx';
import type { AppState, NodeDiff, PlanRow } from './types.ts';
import type { NormalizedPlan, PlanComparison, RuleUpgradePreview } from '../shared/model.ts';
import { CURRENT_RULE_VERSION, INITIAL_RULE_VERSION } from '../shared/rules.ts';
import { DEFAULT_OPTIONS } from '../server/lib/statistics.ts';

interface PlanBundle {
  planId: string;
  vendor: string;
  normalized: NormalizedPlan;
}

function diffMaps(comparison: PlanComparison) {
  const baseline = new Map<string, NodeDiff>();
  const candidate = new Map<string, NodeDiff>();
  for (const diff of comparison.nodeDiffs) {
    if (diff.baselineNodeId) baseline.set(diff.baselineNodeId, diff);
    if (diff.candidateNodeId) candidate.set(diff.candidateNodeId, diff);
  }
  return { baseline, candidate };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [comparisonId, setComparisonId] = useState<string>('');
  const [baselineBundle, setBaselineBundle] = useState<PlanBundle | null>(null);
  const [candidateBundle, setCandidateBundle] = useState<PlanBundle | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<NodeDiff | null>(null);
  const [preview, setPreview] = useState<RuleUpgradePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [minSamples, setMinSamples] = useState(DEFAULT_OPTIONS.minSamples);
  const [regressionThreshold, setRegressionThreshold] = useState(DEFAULT_OPTIONS.regressionThresholdRatio);
  const [estimateDriftRatio, setEstimateDriftRatio] = useState(DEFAULT_OPTIONS.estimateDriftRatio);

  async function refresh() {
    const next = await apiRequest<AppState>('/api/state');
    setState(next);
    if (!comparisonId && next.comparisons[0]) setComparisonId(next.comparisons[0].id!);
    return next;
  }

  useEffect(() => {
    refresh().catch((reason) => setError(reason.message));
  }, []);

  const comparison = state?.comparisons.find((item) => item.id === comparisonId) ?? state?.comparisons[0] ?? null;

  useEffect(() => {
    if (!comparison) return;
    setSelectedDiff(null);
    Promise.all([
      apiRequest<PlanBundle>(`/api/plans/${comparison.baselinePlanId}?ruleVersion=${encodeURIComponent(comparison.ruleVersion)}`),
      apiRequest<PlanBundle>(`/api/plans/${comparison.candidatePlanId}?ruleVersion=${encodeURIComponent(comparison.ruleVersion)}`)
    ]).then(([baseline, candidate]) => {
      setBaselineBundle(baseline);
      setCandidateBundle(candidate);
    }).catch((reason) => setError(reason.message));
  }, [comparison?.id, comparison?.ruleVersion]);

  const maps = useMemo(() => comparison ? diffMaps(comparison) : null, [comparison]);
  const selectedId = selectedDiff?.baselineNodeId ?? selectedDiff?.candidateNodeId ?? null;

  function selectDiff(diff: NodeDiff) {
    setSelectedDiff(diff);
  }

  function selectBaselineNode(nodeId: string) {
    const diff = maps?.baseline.get(nodeId) ?? null;
    if (diff) setSelectedDiff(diff);
  }

  function selectCandidateNode(nodeId: string) {
    const diff = maps?.candidate.get(nodeId) ?? null;
    if (diff) setSelectedDiff(diff);
  }

  async function runAction(path: string, body: unknown, reload = true) {
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest(path, { method: 'POST', body: JSON.stringify(body) });
      if (path.includes('upgrade-preview')) setPreview(result as RuleUpgradePreview);
      if (reload) await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function recalculateWithOptions() {
    if (!comparison) return;
    setBusy(true);
    setError('');
    try {
      const next = await apiRequest<PlanComparison>('/api/compare', {
        method: 'POST',
        body: JSON.stringify({
          baselinePlanId: comparison.baselinePlanId,
          candidatePlanId: comparison.candidatePlanId,
          ruleVersion: comparison.ruleVersion,
          options: {
            minSamples: Number(minSamples),
            regressionThresholdRatio: Number(regressionThreshold),
            estimateDriftRatio: Number(estimateDriftRatio)
          }
        })
      });
      setComparisonId(next.id!);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const baselinePlan = state?.plans.find((plan) => plan.id === comparison?.baselinePlanId) as PlanRow | undefined;
  const candidatePlan = state?.plans.find((plan) => plan.id === comparison?.candidatePlanId) as PlanRow | undefined;
  const changedCounts = comparison ? {
    structure: comparison.nodeDiffs.filter((diff) => ['structure_changed', 'equivalent_reorder', 'removed', 'added'].includes(diff.kind)).length,
    estimate: comparison.nodeDiffs.filter((diff) => diff.kind === 'estimate_drift').length,
    decision: comparison.nodeDiffs.filter((diff) => ['index_changed', 'partition_changed'].includes(diff.kind)).length
  } : null;

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>Pair-wise SQL Plan Diff</h1>
          <p>保真中间模型 · 版本化交换规则 · 多次样本稳健判定 · 离线 SQLite</p>
        </div>
        <div className="header-actions">
          <button type="button" disabled={busy || !comparison} onClick={() => comparison && runAction('/api/baselines/freeze', { planId: comparison.baselinePlanId, ruleVersion: comparison.ruleVersion, frozen: true })}>冻结基线</button>
          <button type="button" disabled={busy || !comparison} onClick={() => comparison && runAction('/api/baselines/publish', { planId: comparison.candidatePlanId, ruleVersion: comparison.ruleVersion })}>发布候选为基线</button>
        </div>
      </header>

      <section className="toolbar">
        <label>
          对比
          <select value={comparison?.id ?? ''} onChange={(event) => setComparisonId(event.target.value)}>
            {state?.comparisons.map((item) => (
              <option key={item.id} value={item.id!}>{item.id} · {item.ruleVersion} · {item.status} · {item.verdict}</option>
            ))}
          </select>
        </label>
        <div className="rule-box">
          <strong>规则升级</strong>
          <button type="button" disabled={busy} onClick={() => runAction('/api/rules/upgrade-preview', { fromRuleVersion: INITIAL_RULE_VERSION, toRuleVersion: CURRENT_RULE_VERSION }, false)}>先生成影响预览</button>
          <button type="button" disabled={busy} onClick={() => runAction('/api/rules/upgrade', { fromRuleVersion: INITIAL_RULE_VERSION, toRuleVersion: CURRENT_RULE_VERSION })}>用户确认后重算</button>
        </div>
      </section>

      <section className="stats-config">
        <label>最少样本 <input type="number" min="1" value={minSamples} onChange={(event) => setMinSamples(Number(event.target.value))} /></label>
        <label>回归阈值 <input type="number" step="0.05" min="1" value={regressionThreshold} onChange={(event) => setRegressionThreshold(Number(event.target.value))} /></label>
        <label>估算漂移阈值 <input type="number" step="0.05" min="0" value={estimateDriftRatio} onChange={(event) => setEstimateDriftRatio(Number(event.target.value))} /></label>
        <button type="button" disabled={busy || !comparison} onClick={recalculateWithOptions}>用新口径重算</button>
      </section>

      {error && <p className="error">{error}</p>}
      {preview && (
        <section className="preview">
          <h2>旧对比影响预览（不自动重算）</h2>
          <p>{preview.fromRuleVersion} → {preview.toRuleVersion}，受影响 {preview.affected.length} 项</p>
          {preview.affected.map((item) => (
            <code key={item.comparisonId}>{item.comparisonId}: semantic {String(item.beforeSemantic)} → {String(item.afterSemantic)}, reorder nodes {item.changedReorderCount}</code>
          ))}
        </section>
      )}

      {comparison && baselineBundle && candidateBundle && (
        <>
          <section className="performance-card">
            <div>
              <span>性能状态</span>
              <strong>{comparison.status}</strong>
            </div>
            <div>
              <span>判定</span>
              <strong>{comparison.verdict}</strong>
            </div>
            <div>
              <span>中位时间比值</span>
              <strong>{comparison.medianRatio?.toFixed(3) ?? '—'}</strong>
            </div>
            <div>
              <span>自助法区间</span>
              <strong>{comparison.confidenceInterval ? `${comparison.confidenceInterval[0].toFixed(3)}–${comparison.confidenceInterval[1].toFixed(3)}` : '—'}</strong>
            </div>
            <div>
              <span>变化计数</span>
              <strong>结构 {changedCounts?.structure} · 估算 {changedCounts?.estimate} · 决策 {changedCounts?.decision}</strong>
            </div>
            <div>
              <span>不可比/异常原因</span>
              <strong>{comparison.reasons.join('；') || '无'}</strong>
            </div>
          </section>
          <section className="meta-grid">
            <p><b>基线</b> {baselinePlan?.vendor} {comparison.baselinePlanId} · stats {baselineBundle.normalized.statsVersion} · samples {comparison.baselineStats.count}</p>
            <p><b>候选</b> {candidatePlan?.vendor} {comparison.candidatePlanId} · stats {candidateBundle.normalized.statsVersion} · samples {comparison.candidateStats.count}</p>
            <p><b>物理指纹</b> {baselineBundle.normalized.physicalFingerprint} → {candidateBundle.normalized.physicalFingerprint}</p>
            <p><b>语义指纹</b> {baselineBundle.normalized.semanticFingerprint} → {candidateBundle.normalized.semanticFingerprint}</p>
          </section>
          <div className="workspace">
            <PlanTree
              title="基线计划树"
              root={baselineBundle.normalized.root}
              selectedId={selectedId}
              diffsByNode={maps!.baseline}
              onSelect={(node) => selectBaselineNode(node.nodeId)}
            />
            <DiffList comparison={comparison} selectedId={selectedId} onSelect={selectDiff} />
            <PlanTree
              title="候选计划树"
              root={candidateBundle.normalized.root}
              selectedId={selectedId}
              diffsByNode={maps!.candidate}
              onSelect={(node) => selectCandidateNode(node.nodeId)}
            />
            <AnnotationPanel comparison={comparison} diff={selectedDiff} />
          </div>
        </>
      )}
    </main>
  );
}
