import { contentHash } from '../../shared/hash.ts';
import type {
  ChildRole,
  JoinKind,
  NormalizedPlan,
  PartitionDecision,
  PlanChild,
  PlanNode,
  PlanWarning,
  VendorName,
  VendorPlanEnvelope,
  VendorRun
} from '../../shared/model.ts';
import { CURRENT_RULE_VERSION } from '../../shared/rules.ts';
import { expressionDigest, missingField, normalizePlan } from '../lib/normalizer.ts';

export { expressionDigest, ignoredVolatile, missingField, unsupportedShape } from '../lib/normalizer.ts';

export interface AdapterContext {
  ruleVersion: string;
}

export interface NodeSeed {
  operator: string;
  relation?: string | null;
  alias?: string | null;
  index?: string | null;
  indexColumns?: string[];
  scanDirection?: string | null;
  joinKind?: JoinKind | null;
  joinCondition?: unknown;
  equiJoin?: boolean;
  joinDirection?: PlanNode['joinDirection'];
  filter?: unknown;
  projection?: unknown;
  children?: Array<{ role: ChildRole; node: PlanNode }>;
  estimatedRows?: number | null;
  estimatedCost?: number | null;
  partitions?: PartitionDecision | null;
  parallelism?: number | null;
  hints?: string[];
  properties?: Record<string, unknown>;
  warnings?: PlanWarning[];
}

export function makeNode(seed: NodeSeed): PlanNode {
  return {
    nodeId: '',
    path: '',
    operator: seed.operator,
    relation: seed.relation ?? null,
    alias: seed.alias ?? null,
    index: seed.index ?? null,
    indexColumns: seed.indexColumns ?? [],
    scanDirection: seed.scanDirection ?? null,
    joinKind: seed.joinKind ?? null,
    joinConditionDigest: expressionDigest(seed.joinCondition ?? null),
    equiJoin: seed.equiJoin ?? false,
    joinDirection: seed.joinDirection ?? 'none',
    filterDigest: expressionDigest(seed.filter ?? null),
    projectionDigest: expressionDigest(seed.projection ?? null),
    children: seed.children ?? [],
    estimatedRows: seed.estimatedRows ?? null,
    estimatedCost: seed.estimatedCost ?? null,
    partitions: seed.partitions ?? null,
    parallelism: seed.parallelism ?? null,
    hints: seed.hints ?? [],
    properties: seed.properties ?? {},
    warnings: seed.warnings ?? []
  };
}

export function child(role: ChildRole, node: PlanNode): PlanChild {
  return { role, node };
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseEnvelope(raw: unknown, vendor: VendorName): VendorPlanEnvelope {
  const envelope = asRecord(raw);
  if (!envelope) throw new Error('Plan payload must be a JSON object');
  if (envelope.vendor !== vendor) throw new Error(`Expected ${vendor} payload, received ${String(envelope.vendor)}`);
  if (envelope.formatVersion !== 1) throw new Error('Only formatVersion 1 is supported');
  if (typeof envelope.queryFingerprint !== 'string' || !envelope.queryFingerprint) throw new Error('queryFingerprint is required');
  if (typeof envelope.schemaDigest !== 'string' || !envelope.schemaDigest) throw new Error('schemaDigest is required');
  if (typeof envelope.statsVersion !== 'string' || !envelope.statsVersion) throw new Error('statsVersion is required');
  if (typeof envelope.collectedAt !== 'string' || Number.isNaN(Date.parse(envelope.collectedAt))) throw new Error('A valid collectedAt timestamp is required');
  if (!asRecord(envelope.parameters)) throw new Error('parameters must be an object');
  if (!asRecord(envelope.schemaSummary)) throw new Error('schemaSummary must be an object');
  if (!Array.isArray(envelope.runs)) throw new Error('runs must be an array');
  const runs: VendorRun[] = envelope.runs.map((item, index) => {
    const run = asRecord(item);
    if (!run) throw new Error(`runs[${index}] must be an object`);
    if (typeof run.id !== 'string' || !run.id) throw new Error(`runs[${index}].id is required`);
    if (!['completed', 'timeout', 'error'].includes(String(run.status))) throw new Error(`runs[${index}].status is invalid`);
    if (typeof run.startedAt !== 'string' || Number.isNaN(Date.parse(run.startedAt))) throw new Error(`runs[${index}].startedAt is invalid`);
    return {
      id: run.id,
      status: run.status as VendorRun['status'],
      startedAt: run.startedAt,
      elapsedMs: numberOrNull(run.elapsedMs),
      errorCode: stringOrNull(run.errorCode)
    };
  });
  return {
    formatVersion: 1,
    vendor,
    queryFingerprint: envelope.queryFingerprint,
    schemaDigest: envelope.schemaDigest,
    schemaSummary: envelope.schemaSummary as Record<string, unknown>,
    statsVersion: envelope.statsVersion,
    parameters: envelope.parameters as Record<string, unknown>,
    collectedAt: envelope.collectedAt,
    plan: envelope.plan,
    runs
  };
}

export function normalizeBase(
  envelope: VendorPlanEnvelope,
  root: PlanNode,
  warnings: PlanWarning[],
  ruleVersion = CURRENT_RULE_VERSION
): NormalizedPlan {
  return normalizePlan({
    vendor: envelope.vendor,
    ruleVersion,
    queryFingerprint: envelope.queryFingerprint,
    schemaDigest: envelope.schemaDigest,
    schemaSummary: envelope.schemaSummary,
    statsVersion: envelope.statsVersion,
    parameters: envelope.parameters,
    root,
    warnings
  });
}

export function stablePayloadHash(raw: unknown): string {
  return contentHash(raw);
}

export function requireRecord(value: unknown, path: string, warnings: PlanWarning[]): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) warnings.push(missingField(path, 'node', 'Expected a JSON object node'));
  return record;
}
