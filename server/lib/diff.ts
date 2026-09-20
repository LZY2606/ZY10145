import { shortHash } from '../../shared/hash.ts';
import type { DiffKind, NodeDiff, NormalizedPlan, PlanChild, PlanNode, ComparisonOptions } from '../../shared/model.ts';
import { isCommutative } from '../../shared/rules.ts';
import { walkPlan } from './normalizer.ts';

const LOCAL_FINGERPRINT_KEYS = new Set([
  'operator',
  'relation',
  'alias',
  'index',
  'indexColumns',
  'scanDirection',
  'joinKind',
  'joinConditionDigest',
  'equiJoin',
  'joinDirection',
  'filterDigest',
  'projectionDigest',
  'partitions',
  'parallelism',
  'hints',
  'properties'
]);

function localKey(node: PlanNode): string {
  return shortHash(Object.fromEntries(Object.entries(node).filter(([key]) => LOCAL_FINGERPRINT_KEYS.has(key))));
}

function semanticLocalKey(node: PlanNode): string {
  return shortHash(Object.fromEntries(Object.entries(node).filter(([key]) => SEMANTIC_LOCAL_KEYS.has(key))));
}

const SEMANTIC_LOCAL_KEYS = new Set([
  'operator',
  'relation',
  'alias',
  'joinKind',
  'joinConditionDigest',
  'equiJoin',
  'joinDirection',
  'filterDigest',
  'projectionDigest',
  'parallelism',
  'properties'
]);

function semanticSubtreeKey(node: PlanNode, ruleVersion: string): string {
  const commutative = isCommutative(node, ruleVersion);
  const children = node.children
    .map((child) => ({
      role: commutative ? 'commutative_input' : child.role,
      key: semanticSubtreeKey(child.node, ruleVersion)
    }))
    .sort((a, b) => (commutative ? a.key.localeCompare(b.key) : 0));
  return shortHash({
    local: Object.fromEntries(Object.entries(node).filter(([key]) => SEMANTIC_LOCAL_KEYS.has(key))),
    children,
    ruleVersion
  });
}

function ratio(candidate: number | null, baseline: number | null): number | null {
  if (candidate === null || baseline === null || baseline === 0) return null;
  return candidate / baseline;
}

function decisionChanged(a: PlanNode, b: PlanNode): DiffKind | null {
  const indexChanged = a.index !== b.index || JSON.stringify(a.indexColumns) !== JSON.stringify(b.indexColumns) || a.scanDirection !== b.scanDirection;
  if (indexChanged) return 'index_changed';
  if (JSON.stringify(a.partitions) !== JSON.stringify(b.partitions)) return 'partition_changed';
  return null;
}

function estimateDrift(a: PlanNode, b: PlanNode, options: ComparisonOptions): boolean {
  const rowsRatio = ratio(a.estimatedRows, b.estimatedRows);
  const costRatio = ratio(a.estimatedCost, b.estimatedCost);
  return (
    (rowsRatio !== null && Math.abs(rowsRatio - 1) >= options.estimateDriftRatio) ||
    (costRatio !== null && Math.abs(costRatio - 1) >= options.estimateDriftRatio)
  );
}

function childChange(a: PlanNode, b: PlanNode, ruleVersion: string) {
  const samePhysicalOrder = a.children.length === b.children.length && a.children.every((child, index) => {
    const other = b.children[index];
    return child.role === other.role && semanticSubtreeKey(child.node, ruleVersion) === semanticSubtreeKey(other.node, ruleVersion);
  });
  const keyed = (parent: PlanNode, children: PlanChild[]) => children
    .map((current) => `${isCommutative(parent, ruleVersion) ? 'commutative_input' : current.role}:${semanticSubtreeKey(current.node, ruleVersion)}`)
    .sort();
  const sameSemanticSet = JSON.stringify(keyed(a, a.children)) === JSON.stringify(keyed(b, b.children));
  return { physical: !samePhysicalOrder, semantic: !sameSemanticSet, reorder: !samePhysicalOrder && sameSemanticSet };
}

function nodeDiff(baseline: PlanNode | null, candidate: PlanNode | null, path: string, options: ComparisonOptions, ruleVersion: string): NodeDiff {
  const operator = baseline?.operator ?? candidate?.operator ?? 'unknown';
  if (!baseline || !candidate) {
    return {
      baselineNodeId: baseline?.nodeId ?? null,
      candidateNodeId: candidate?.nodeId ?? null,
      path: baseline?.path ?? candidate?.path ?? path,
      operator,
      kind: baseline ? 'removed' : 'added',
      estimateRowsRatio: null,
      estimateCostRatio: null,
      physicalChanged: true,
      semanticChanged: true,
      baseline,
      candidate
    };
  }
  const localChanged = localKey(baseline) !== localKey(candidate);
  const semanticLocalChanged = semanticLocalKey(baseline) !== semanticLocalKey(candidate);
  const children = childChange(baseline, candidate, ruleVersion);
  const physicalChanged = localChanged || children.physical;
  const semanticChanged = semanticLocalChanged || children.semantic;
  let kind: DiffKind = 'unchanged';
  if (children.reorder) kind = 'equivalent_reorder';
  else if (semanticChanged) kind = 'structure_changed';
  else kind = decisionChanged(baseline, candidate) ?? (estimateDrift(candidate, baseline, options) ? 'estimate_drift' : 'unchanged');
  return {
    baselineNodeId: baseline.nodeId,
    candidateNodeId: candidate.nodeId,
    path: baseline.path,
    operator,
    kind,
    estimateRowsRatio: ratio(candidate.estimatedRows, baseline.estimatedRows),
    estimateCostRatio: ratio(candidate.estimatedCost, baseline.estimatedCost),
    physicalChanged,
    semanticChanged,
    baseline,
    candidate
  };
}

function matchChildren(baselineParent: PlanNode, candidateParent: PlanNode, baselineChildren: PlanChild[], candidateChildren: PlanChild[], ruleVersion: string): Array<[PlanChild | null, PlanChild | null]> {
  const usedCandidates = new Set<number>();
  const pairs: Array<[PlanChild | null, PlanChild | null]> = [];
  baselineChildren.forEach((baselineChild, index) => {
    let matchIndex = candidateChildren.findIndex(
      (candidateChild, candidateIndex) =>
        !usedCandidates.has(candidateIndex) &&
        (isCommutative(baselineParent, ruleVersion) || candidateChild.role === baselineChild.role) &&
        semanticSubtreeKey(baselineChild.node, ruleVersion) === semanticSubtreeKey(candidateChild.node, ruleVersion)
    );
    if (matchIndex === -1) {
      matchIndex = candidateChildren.findIndex(
        (candidateChild, candidateIndex) => !usedCandidates.has(candidateIndex) && localKey(baselineChild.node) === localKey(candidateChild.node)
      );
    }
    if (matchIndex === -1 && index < candidateChildren.length && !usedCandidates.has(index)) matchIndex = index;
    if (matchIndex >= 0) {
      usedCandidates.add(matchIndex);
      pairs.push([baselineChild, candidateChildren[matchIndex]]);
    } else {
      pairs.push([baselineChild, null]);
    }
  });
  candidateChildren.forEach((candidateChild, index) => {
    if (!usedCandidates.has(index)) pairs.push([null, candidateChild]);
  });
  return pairs;
}

function compareNodes(
  baseline: PlanNode | null,
  candidate: PlanNode | null,
  path: string,
  options: ComparisonOptions,
  ruleVersion: string,
  output: NodeDiff[]
): void {
  output.push(nodeDiff(baseline, candidate, path, options, ruleVersion));
  if (!baseline || !candidate) {
    if (baseline) walkPlan(baseline, (node) => output.push(nodeDiff(node, null, node.path, options, ruleVersion)));
    if (candidate) walkPlan(candidate, (node) => output.push(nodeDiff(null, node, node.path, options, ruleVersion)));
    return;
  }
  matchChildren(baseline, candidate, baseline.children, candidate.children, ruleVersion).forEach(([baseChild, candidateChild], index) => {
    compareNodes(baseChild?.node ?? null, candidateChild?.node ?? null, `${baseline.path}/C${index}`, options, ruleVersion, output);
  });
}

export function diffPlans(baseline: NormalizedPlan, candidate: NormalizedPlan, options: ComparisonOptions): NodeDiff[] {
  const output: NodeDiff[] = [];
  compareNodes(baseline.root, candidate.root, 'ROOT', options, baseline.ruleVersion, output);
  return output;
}
