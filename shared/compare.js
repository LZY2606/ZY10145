import { collectNodes } from './normalize.js';
import { INCOMPATIBLE_PARAMETERS, isVolatileParameter } from './rules.js';
import { comparePerformance, nodeTimingSummary } from './stats.js';

const ESTIMATE_THRESHOLD = 0.2;

function ratio(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  if (left === 0 && right === 0) return 1;
  if (left === 0) return null;
  return right / left;
}

function coarseKey(node) {
  return [node.kind, node.operator, node.relation || '', node.details?.joinType || ''].join('|');
}

function pairChildren(baselineChildren, candidateChildren) {
  const candidateByStable = new Map((candidateChildren || []).map((node) => [node.stableId, node]));
  const used = new Set();
  const pairs = [];
  for (const baselineNode of baselineChildren || []) {
    const exact = candidateByStable.get(baselineNode.stableId);
    if (exact && !used.has(exact.stableId)) {
      used.add(exact.stableId);
      pairs.push({ baseline: baselineNode, candidate: exact });
    } else {
      pairs.push({ baseline: baselineNode, candidate: null });
    }
  }
  const remaining = (candidateChildren || []).filter((node) => !used.has(node.stableId));
  for (const pair of pairs) {
    if (pair.candidate) continue;
    const matchIndex = remaining.findIndex((node) => coarseKey(node) === coarseKey(pair.baseline));
    if (matchIndex >= 0) pair.candidate = remaining.splice(matchIndex, 1)[0];
  }
  for (const node of remaining) pairs.push({ baseline: null, candidate: node });
  return pairs;
}

function alignTrees(baselineNode, candidateNode) {
  if (!baselineNode || !candidateNode) {
    return {
      id: (baselineNode || candidateNode)?.stableId,
      baseline: baselineNode || null,
      candidate: candidateNode || null,
      change: baselineNode ? 'NODE_ONLY_IN_BASELINE' : 'NODE_ONLY_IN_CANDIDATE',
      children: []
    };
  }
  const id = baselineNode.stableId === candidateNode.stableId
    ? baselineNode.stableId
    : `pair_${baselineNode.stableId}_${candidateNode.stableId}`;
  const change = baselineNode.stableId === candidateNode.stableId
    ? null
    : coarseKey(baselineNode) === coarseKey(candidateNode)
      ? 'SEMANTICALLY_PAIRED_WITH_DIFFERENT_STABLE_FINGERPRINT'
      : 'NODE_KIND_OR_OPERATOR_CHANGED';
  return {
    id,
    baseline: baselineNode,
    candidate: candidateNode,
    change,
    children: pairChildren(baselineNode.children, candidateNode.children)
      .map((pair) => alignTrees(pair.baseline, pair.candidate))
  };
}

function estimateDiffs(baselineNode, candidateNode) {
  const result = [];
  const fields = [
    ['rows', baselineNode.estimates.rows, candidateNode.estimates.rows],
    ['width', baselineNode.estimates.width, candidateNode.estimates.width],
    ['cost.startup', baselineNode.estimates.cost?.startup, candidateNode.estimates.cost?.startup],
    ['cost.total', baselineNode.estimates.cost?.total, candidateNode.estimates.cost?.total]
  ];
  for (const [metric, baseline, candidate] of fields) {
    const observedRatio = ratio(baseline, candidate);
    if (observedRatio === null && baseline === 0 && candidate !== 0) {
      result.push({ nodeId: baselineNode.stableId, metric, baseline, candidate, change: 'ZERO_BASELINE_NONZERO_CANDIDATE' });
    } else if (observedRatio !== null && Math.abs(observedRatio - 1) > ESTIMATE_THRESHOLD) {
      result.push({
        nodeId: baselineNode.stableId,
        metric,
        baseline,
        candidate,
        ratio: observedRatio,
        change: observedRatio > 1 ? 'INCREASED' : 'DECREASED'
      });
    }
  }
  return result;
}

function materialDiffs(baselineNode, candidateNode) {
  const result = [];
  if ((baselineNode.index || null) !== (candidateNode.index || null)) {
    result.push({
      nodeId: baselineNode.stableId,
      change: 'INDEX_DECISION_CHANGED',
      baseline: baselineNode.index || null,
      candidate: candidateNode.index || null
    });
  }
  if (JSON.stringify(baselineNode.partition || null) !== JSON.stringify(candidateNode.partition || null)) {
    result.push({
      nodeId: baselineNode.stableId,
      change: 'PARTITION_DECISION_CHANGED',
      baseline: baselineNode.partition || null,
      candidate: candidateNode.partition || null
    });
  }
  return result;
}

function childOrderChange(parent, childAlignment) {
  const baselineChild = childAlignment.baseline;
  const candidateChild = childAlignment.candidate;
  if (!parent?.baseline || !parent?.candidate || !baselineChild || !candidateChild) return null;
  const baselineIndex = parent.baseline.children.findIndex((node) => node.stableId === baselineChild.stableId);
  const candidateIndex = parent.candidate.children.findIndex((node) => node.stableId === candidateChild.stableId);
  if (baselineIndex === candidateIndex || baselineIndex < 0 || candidateIndex < 0) return null;
  const baselineRole = parent.baseline.roles?.[baselineIndex] || null;
  const candidateRole = parent.candidate.roles?.[candidateIndex] || null;
  return {
    nodeId: childAlignment.id,
    change: 'CHILD_ORDER_CHANGED',
    baselineRole,
    candidateRole,
    parentOperator: parent.baseline.operator,
    logicalCommutative: Boolean(parent.baseline.commutative || parent.candidate.commutative),
    physicalOrderMatters: Boolean(parent.baseline.physicalOrderMatters || parent.candidate.physicalOrderMatters),
    physicalEquivalent: !(parent.baseline.physicalOrderMatters || parent.candidate.physicalOrderMatters) || baselineRole === candidateRole
  };
}

function attachSamples(node, samples) {
  if (!node) return;
  node.__samples = samples;
  for (const child of node.children || []) attachSamples(child, samples);
}

function walkAlignment(alignment, parent, structural, estimates, observations) {
  const baselineNode = alignment.baseline;
  const candidateNode = alignment.candidate;
  if (baselineNode && candidateNode) {
    if (alignment.change) structural.push({ nodeId: alignment.id, change: alignment.change });
    structural.push(...materialDiffs(baselineNode, candidateNode));
    estimates.push(...estimateDiffs(baselineNode, candidateNode));
    const orderChange = childOrderChange(parent, alignment);
    if (orderChange) structural.push(orderChange);
    const timingKey = baselineNode.timingKey || candidateNode.timingKey;
    if (timingKey) {
      const baselineTiming = nodeTimingSummary(baselineNode.__samples || [], timingKey);
      const candidateTiming = nodeTimingSummary(candidateNode.__samples || [], timingKey);
      if (baselineTiming.median !== null && candidateTiming.median !== null) {
        observations.push({
          nodeId: alignment.id,
          timingKey,
          baselineMedianMs: baselineTiming.median,
          candidateMedianMs: candidateTiming.median,
          ratio: candidateTiming.median / baselineTiming.median
        });
      }
    }
  } else {
    structural.push({
      nodeId: alignment.id,
      change: alignment.change,
      operator: (baselineNode || candidateNode).operator
    });
  }
  for (const child of alignment.children) {
    walkAlignment(child, alignment, structural, estimates, observations);
  }
}

function parameterDiffs(baselineParameters = {}, candidateParameters = {}) {
  return [...new Set([...Object.keys(baselineParameters), ...Object.keys(candidateParameters)])]
    .filter((name) => INCOMPATIBLE_PARAMETERS.includes(name) || !isVolatileParameter(name))
    .filter((name) => JSON.stringify(baselineParameters[name]) !== JSON.stringify(candidateParameters[name]))
    .map((name) => ({
      parameter: name,
      baseline: baselineParameters[name] ?? null,
      candidate: candidateParameters[name] ?? null,
      incompatible: INCOMPATIBLE_PARAMETERS.includes(name)
    }));
}

export function comparePlans(baselinePlan, candidatePlan, statsConfig = {}) {
  const statuses = [];
  if (!baselinePlan?.root || !candidatePlan?.root) statuses.push('PLAN_ROOT_MISSING');
  if (baselinePlan?.queryFingerprint !== candidatePlan?.queryFingerprint) statuses.push('QUERY_FINGERPRINT_MISMATCH');
  if (baselinePlan?.environment?.vendor !== candidatePlan?.environment?.vendor) {
    statuses.push('PARAMETER_ENVIRONMENT_NOT_COMPARABLE');
  }
  const parameterChanges = parameterDiffs(baselinePlan?.parameters, candidatePlan?.parameters);
  if (parameterChanges.some((item) => item.incompatible)) statuses.push('PARAMETER_ENVIRONMENT_NOT_COMPARABLE');
  if (baselinePlan?.schema?.digest && candidatePlan?.schema?.digest && baselinePlan.schema.digest !== candidatePlan.schema.digest) {
    statuses.push('SCHEMA_DRIFT');
  }
  if (baselinePlan?.statsVersion !== candidatePlan?.statsVersion) statuses.push('STATS_VERSION_CHANGED');
  const missingFields = [...(baselinePlan?.diagnostics || []), ...(candidatePlan?.diagnostics || [])]
    .filter((item) => item.code === 'MISSING_NODE_FIELD');
  if (missingFields.length) statuses.push('PLAN_NODE_FIELDS_MISSING');

  attachSamples(baselinePlan?.root, baselinePlan?.samples || []);
  attachSamples(candidatePlan?.root, candidatePlan?.samples || []);
  const alignment = baselinePlan?.root && candidatePlan?.root
    ? alignTrees(baselinePlan.root, candidatePlan.root)
    : { id: null, baseline: baselinePlan?.root || null, candidate: candidatePlan?.root || null, children: [] };
  const structuralChanges = [];
  const estimateDrift = [];
  const observedTimingChanges = [];
  walkAlignment(alignment, null, structuralChanges, estimateDrift, observedTimingChanges);

  const performance = comparePerformance(baselinePlan?.samples || [], candidatePlan?.samples || [], statsConfig);
  statuses.push(...performance.states);
  const physicalReversal = structuralChanges.some((item) => item.change === 'CHILD_ORDER_CHANGED' && !item.physicalEquivalent);

  return {
    statuses: [...new Set(statuses)],
    ruleVersion: baselinePlan?.ruleVersion || candidatePlan?.ruleVersion,
    baseline: fingerprintSummary(baselinePlan),
    candidate: fingerprintSummary(candidatePlan),
    structure: {
      logicalEquivalent: baselinePlan?.logicalFingerprint === candidatePlan?.logicalFingerprint,
      physicalEquivalent: baselinePlan?.physicalFingerprint === candidatePlan?.physicalFingerprint,
      containsPhysicalRoleReversal: physicalReversal,
      alignment,
      changes: structuralChanges
    },
    estimateDrift,
    observedTimingChanges,
    performance,
    parameterChanges,
    missingFieldDiagnostics: missingFields,
    categories: {
      structural: structuralChanges,
      estimates: estimateDrift,
      runtime: observedTimingChanges
    }
  };
}

function fingerprintSummary(plan) {
  return {
    sourceHash: plan?.sourceHash,
    normalizedHash: plan?.normalizedHash,
    logicalFingerprint: plan?.logicalFingerprint,
    physicalFingerprint: plan?.physicalFingerprint,
    statsVersion: plan?.statsVersion
  };
}

export function planNodeCount(plan) {
  return collectNodes(plan?.root).length;
}
