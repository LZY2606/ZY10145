export type VendorName = 'postgresql' | 'mysql';
export type RunStatus = 'completed' | 'timeout' | 'error';
export type ChildRole = 'left' | 'right' | 'outer' | 'inner' | 'build' | 'probe' | 'child' | 'first' | 'second';
export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'semi' | 'anti' | 'cross';

export interface VendorRun {
  id: string;
  status: RunStatus;
  startedAt: string;
  elapsedMs?: number | null;
  errorCode?: string | null;
}

export interface VendorPlanEnvelope {
  formatVersion: 1;
  vendor: VendorName;
  queryFingerprint: string;
  schemaDigest: string;
  schemaSummary: Record<string, unknown>;
  statsVersion: string;
  parameters: Record<string, unknown>;
  collectedAt: string;
  plan: unknown;
  runs: VendorRun[];
}

export interface PartitionDecision {
  selected: string[];
  pruned: string[];
  strategy: string | null;
}

export interface PlanWarning {
  code: 'missing_field' | 'unsupported_shape' | 'ignored_volatile_field';
  path: string;
  field: string;
  message: string;
}

export interface PlanChild {
  role: ChildRole;
  node: PlanNode;
}

export interface PlanNode {
  nodeId: string;
  path: string;
  operator: string;
  relation: string | null;
  alias: string | null;
  index: string | null;
  indexColumns: string[];
  scanDirection: string | null;
  joinKind: JoinKind | null;
  joinConditionDigest: string | null;
  equiJoin: boolean;
  joinDirection: 'build_probe' | 'outer_inner' | 'left_right' | 'none';
  filterDigest: string | null;
  projectionDigest: string | null;
  children: PlanChild[];
  estimatedRows: number | null;
  estimatedCost: number | null;
  partitions: PartitionDecision | null;
  parallelism: number | null;
  hints: string[];
  properties: Record<string, unknown>;
  warnings: PlanWarning[];
}

export interface NormalizedPlan {
  modelSchemaVersion: 'plan-v1';
  ruleVersion: string;
  vendor: VendorName;
  queryFingerprint: string;
  schemaDigest: string;
  schemaSummary: Record<string, unknown>;
  statsVersion: string;
  parameters: Record<string, unknown>;
  root: PlanNode;
  warnings: PlanWarning[];
  physicalFingerprint: string;
  semanticFingerprint: string;
  shapeFingerprint: string;
}

export interface RuleDescriptor {
  version: string;
  releasedAt: string;
  description: string;
  rules: Array<{ id: string; description: string }>;
}

export type PerformanceStatus =
  | 'comparable'
  | 'insufficient_samples'
  | 'timeout'
  | 'missing_fields'
  | 'incomparable_environment';

export type PerformanceVerdict = 'regression' | 'improvement' | 'unchanged' | 'indeterminate';

export interface RobustStats {
  count: number;
  medianMs: number | null;
  trimmedMeanMs: number | null;
  madMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface ComparisonOptions {
  minSamples: number;
  trimFraction: number;
  regressionThresholdRatio: number;
  improvementThresholdRatio: number;
  estimateDriftRatio: number;
  bootstrapReplicates: number;
  confidenceLevel: number;
}

export type DiffKind =
  | 'unchanged'
  | 'estimate_drift'
  | 'structure_changed'
  | 'equivalent_reorder'
  | 'index_changed'
  | 'partition_changed'
  | 'removed'
  | 'added';

export interface NodeDiff {
  baselineNodeId: string | null;
  candidateNodeId: string | null;
  path: string;
  operator: string;
  kind: DiffKind;
  estimateRowsRatio: number | null;
  estimateCostRatio: number | null;
  physicalChanged: boolean;
  semanticChanged: boolean;
  baseline: PlanNode | null;
  candidate: PlanNode | null;
}

export interface PlanComparison {
  id: string | null;
  baselinePlanId: string;
  candidatePlanId: string;
  ruleVersion: string;
  status: PerformanceStatus;
  verdict: PerformanceVerdict;
  baselineStats: RobustStats;
  candidateStats: RobustStats;
  medianRatio: number | null;
  confidenceInterval: [number, number] | null;
  nodeDiffs: NodeDiff[];
  reasons: string[];
  options: ComparisonOptions;
}

export interface RuleUpgradePreview {
  fromRuleVersion: string;
  toRuleVersion: string;
  affected: Array<{
    comparisonId: string;
    baselinePlanId: string;
    candidatePlanId: string;
    beforePhysical: boolean;
    beforeSemantic: boolean;
    afterPhysical: boolean;
    afterSemantic: boolean;
    changedReorderCount: number;
  }>;
}
