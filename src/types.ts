import type {
  ComparisonOptions,
  NodeDiff,
  PlanComparison,
  PlanNode,
  RuleDescriptor
} from '../shared/model.ts';

export interface PlanRow {
  id: string;
  vendor: string;
  query_fingerprint: string;
  schema_digest: string;
  stats_version: string;
  collected_at: string;
}

export interface NormalizedPlanView {
  planId: string;
  vendor: string;
  normalized: {
    root: PlanNode;
    ruleVersion: string;
    physicalFingerprint: string;
    semanticFingerprint: string;
    shapeFingerprint: string;
  };
}

export interface AppState {
  plans: PlanRow[];
  comparisons: PlanComparison[];
  baselines: Array<Record<string, unknown>>;
  rules: RuleDescriptor[];
}

export type { ComparisonOptions, NodeDiff, PlanComparison, PlanNode };
