import React, { useEffect, useMemo, useState } from 'react';
import { api, importFixtureSet } from './api.js';

const DEFAULT_CONFIG = { minSamples: 3, medianRatioThreshold: 1.15, effectThreshold: 0.474 };

function short(value = '') {
  return value.slice(0, 10);
}

function nodeLabel(node) {
  if (!node) return '—';
  const target = node.relation ? `${node.operator} · ${node.relation}` : node.operator;
  const index = node.index ? ` · ${node.index}` : '';
  return `${target}${index}`;
}

function NodeCard({ node, side, alignment }) {
  if (!node) return <div className="node missing">缺少节点</div>;
  const changed = Boolean(alignment?.change);
  const roleChange = side === 'candidate';
  return (
    <div className={`node ${changed ? 'changed' : ''}`}>
      <div className="node-title">
        <strong>{nodeLabel(node)}</strong>
        {node.roles && <span className="roles">{Object.entries(node.roles).map(([index, role]) => `${Number(index) + 1}:${role}`).join(' · ')}</span>}
      </div>
      <div className="metrics">
        <span>rows {node.estimates.rows ?? '缺失'}</span>
        <span>width {node.estimates.width ?? '—'}</span>
        <span>cost {node.estimates.cost?.total ?? '—'}</span>
      </div>
      {node.partition && <div className="decision">分区：{node.partition.columns?.join(', ')}</div>}
      <div className="digest">{short(node.stableId)} · {short(side === 'baseline' ? node.physicalFingerprint : node.physicalFingerprint)}</div>
    </div>
  );
}

function TreeRows({ alignment, depth = 0 }) {
  const key = alignment.id || `${alignment.baseline?.stableId || 'x'}-${alignment.candidate?.stableId || 'x'}-${depth}`;
  const rows = [
    <div className="tree-row" key={key}>
      <div style={{ marginLeft: depth * 18 }}><NodeCard node={alignment.baseline} side="baseline" alignment={alignment} /></div>
      <div style={{ marginLeft: depth * 18 }}><NodeCard node={alignment.candidate} side="candidate" alignment={alignment} /></div>
    </div>
  ];
  for (const child of alignment.children || []) rows.push(...TreeRows({ alignment: child, depth: depth + 1 }));
  return rows;
}

function ChangeList({ title, items, render }) {
  return (
    <section className="panel">
      <h3>{title} <span>{items.length}</span></h3>
      {items.length === 0 ? <p className="muted">无变化</p> : items.map((item, index) => <div className="change" key={`${item.nodeId || item.metric}-${index}`}>{render(item)}</div>)}
    </section>
  );
}

function AnnotationBox({ comparisonId, nodeId, annotations, onSaved }) {
  if (!nodeId) return null;
  const existing = annotations.find((item) => item.nodeId === nodeId);
  const [status, setStatus] = useState(existing?.status || 'explained');
  const [note, setNote] = useState(existing?.note || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.annotate(comparisonId, { nodeId, status, note, expectedVersion: existing?.version ?? null });
      await onSaved();
    } catch (error) {
      setError(error.conflict ? `版本冲突：当前 v${error.conflict.currentVersion}，内容为「${error.conflict.current.note}」` : error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="annotation">
      <select value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="explained">已解释</option>
        <option value="accepted">接受</option>
        <option value="rejected">拒绝</option>
        <option value="needs_review">需复核</option>
      </select>
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="节点级说明，不修改原计划" />
      <button onClick={save} disabled={busy}>{existing ? `更新 v${existing.version}` : '保存'}</button>
      {error && <em className="conflict">{error}</em>}
    </div>
  );
}

export default function App() {
  const [rules, setRules] = useState([]);
  const [plans, setPlans] = useState([]);
  const [ruleVersion, setRuleVersion] = useState('2026-09-21.v1');
  const [baselineHash, setBaselineHash] = useState('');
  const [candidateHash, setCandidateHash] = useState('');
  const [comparison, setComparison] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [message, setMessage] = useState('就绪：所有数据来自仓库 fixture 或本地 SQLite。');
  const [upgrade, setUpgrade] = useState(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  async function refreshPlans() {
    const data = await api.plans();
    setPlans(data.plans);
  }

  useEffect(() => {
    api.rules().then((data) => setRules(data.rules)).catch(() => {});
    refreshPlans().catch(() => {});
  }, []);

  const grouped = useMemo(() => Object.groupBy(plans, (item) => item.query_fingerprint), [plans]);
  const selectablePlans = plans.filter((item) => item.rule_version === ruleVersion);

  async function loadFixtures() {
    setMessage('正在导入 fixture；同内容重复导入不会新增。');
    const imported = await importFixtureSet();
    const hashes = imported.imported.map((item) => item.sourceHash);
    await api.normalize(hashes, ruleVersion);
    await refreshPlans();
    setMessage(`已检查 ${hashes.length} 份计划；新增 ${imported.imported.filter((item) => item.created).length} 份。`);
  }

  async function runCompare() {
    if (!baselineHash || !candidateHash) {
      setMessage('请先选择基线和候选。');
      return;
    }
    const data = await api.compare(baselineHash, candidateHash, config, ruleVersion);
    setComparison(data.comparison);
    setAnnotations([]);
    const detail = await api.comparison(data.comparison.comparison_id);
    setAnnotations(detail.annotations);
    setMessage('对比已生成；决议和批注不会改写原始计划。');
  }

  async function freezeBaseline() {
    await api.publishBaseline(baselineHash, true);
    setMessage('基线已冻结；再次发布会得到 409，需显式解冻。');
  }

  async function retainCandidate() {
    await api.retainCandidate(candidateHash);
    setMessage('候选已保留，可同时保留多个候选版本。');
  }

  async function previewUpgrade() {
    const data = await api.previewUpgrade();
    setUpgrade(data.preview);
    setMessage('规则升级预览完成，尚未重算任何旧对比。');
  }

  async function applyUpgrade() {
    if (!upgrade?.affected.length) return;
    await api.applyUpgrade(upgrade.affected.map((item) => item.sourceHash));
    setUpgrade(null);
    await refreshPlans();
    setMessage('仅重算用户确认的受影响计划；旧对比仍保留，需要重新生成。');
  }

  const result = comparison?.result;
  const rootAlignment = result?.structure.alignment;
  const structural = result?.categories.structural || [];
  const estimates = result?.estimateDrift || [];
  const runtime = result?.categories.runtime || [];

  return (
    <main>
      <header>
        <div>
          <h1>离线执行计划保真差异</h1>
          <p>{message}</p>
        </div>
        <div className="actions">
          <button onClick={safe(loadFixtures)}>导入并规范化 Fixtures</button>
          <button onClick={safe(previewUpgrade)} disabled={!plans.length}>预览规则升级</button>
        </div>
      </header>

      {upgrade && (
        <section className="upgrade">
          <h2>规则 {upgrade.ruleVersion} 将影响 {upgrade.affected.length} 份计划</h2>
          <p>先生成影响面，由用户决定是否重算。</p>
          <button onClick={safe(applyUpgrade)}>确认重算所选计划</button>
        </section>
      )}

      <section className="controls">
        <label>规则版本
          <select value={ruleVersion} onChange={(event) => { setRuleVersion(event.target.value); setComparison(null); }}>
            {rules.map((rule) => <option key={rule.version} value={rule.version}>{rule.version}</option>)}
          </select>
        </label>
        <label>基线
          <select value={baselineHash} onChange={(event) => setBaselineHash(event.target.value)}>
            <option value="">选择计划</option>
            {selectablePlans.map((plan) => <option key={plan.normalized_hash} value={plan.normalized_hash}>{plan.query_fingerprint} · {short(plan.normalized_hash)}</option>)}
          </select>
        </label>
        <label>候选
          <select value={candidateHash} onChange={(event) => setCandidateHash(event.target.value)}>
            <option value="">选择计划</option>
            {selectablePlans.map((plan) => <option key={plan.normalized_hash} value={plan.normalized_hash}>{plan.query_fingerprint} · {short(plan.normalized_hash)}</option>)}
          </select>
        </label>
        <button onClick={safe(runCompare)}>生成对比</button>
        <button onClick={safe(freezeBaseline)} disabled={!baselineHash}>冻结基线</button>
        <button onClick={safe(retainCandidate)} disabled={!candidateHash}>保留候选</button>
      </section>

      {result && (
        <>
          <section className="status-grid">
            <StatusCard title="结构" ok={result.structure.physicalEquivalent} text={result.structure.physicalEquivalent ? '物理等价' : result.structure.logicalEquivalent ? '逻辑等价，物理方向不同' : '结构不等价'} />
            <StatusCard title="估算" ok={!estimates.length} text={`${estimates.length} 项估算漂移`} />
            <StatusCard title="实测" ok={result.performance.verdict !== 'REGRESSION'} text={`${result.performance.verdict} · 中位数比 ${result.performance.medianRatio?.toFixed(2) ?? '—'}`} />
          </section>
          <section className="status-tags">
            {result.statuses.map((status) => <span key={status}>{status}</span>)}
          </section>
          <section className="rule-explanation">
            <h2>{result.ruleVersion} 可交换规则</h2>
            <p>INNER/CROSS join 只在逻辑层归一；带 build/probe、outer/inner 的物理方向参与物理指纹。UNION ALL 仅 v2 显式允许交换。</p>
          </section>
          <div className="tree-columns">
            <h2>基线树</h2><h2>候选树</h2>
            {rootAlignment && TreeRows({ alignment: rootAlignment })}
          </div>
          <div className="diff-grid">
            <ChangeList title="结构/索引/分区" items={structural} render={(item) => <>{item.change} {item.nodeId} {item.baselineRole !== item.candidateRole ? `${item.baselineRole} → ${item.candidateRole}` : null}</>} />
            <ChangeList title="估算漂移" items={estimates} render={(item) => <>{item.nodeId} · {item.metric}: {item.baseline} → {item.candidate} ({item.ratio?.toFixed(2)})</>} />
            <ChangeList title="实测耗时" items={runtime} render={(item) => <>{item.timingKey}: {item.baselineMedianMs}ms → {item.candidateMedianMs}ms ({item.ratio.toFixed(2)}x)</>} />
          </div>
          <section className="panel">
            <h2>节点级决议</h2>
            {structural.filter((item) => item.nodeId).slice(0, 8).map((item) => (
              <AnnotationBox key={`${item.change}-${item.nodeId}`} comparisonId={comparison.comparison_id} nodeId={item.nodeId} annotations={annotations} onSaved={async () => {
                const detail = await api.comparison(comparison.comparison_id);
                setAnnotations(detail.annotations);
              }} />
            ))}
          </section>
        </>
      )}
    </main>
  );
}

function StatusCard({ title, ok, text }) {
  return <div className={`status ${ok ? 'ok' : 'warn'}`}><strong>{title}</strong><span>{text}</span></div>;
}

function safe(fn) {
  return async () => {
    try { await fn(); } catch (error) { alert(error.message); }
  };
}
