import { createHash } from 'node:crypto';
import type {
  ComparisonOptions,
  NormalizedPlan,
  PlanComparison,
  RuleUpgradePreview,
  VendorName
} from '../../shared/model.ts';
import { CURRENT_RULE_VERSION, laterRuleVersion } from '../../shared/rules.ts';
import { parseMysql } from '../adapters/mysql.ts';
import { parsePostgres } from '../adapters/postgresql.ts';
import {
  ConflictError,
  audit,
  deactivateComparison,
  getComparison,
  getNormalization,
  getPlan,
  insertComparison,
  insertPlan,
  insertSamples,
  listActiveComparisons,
  listAnnotations,
  listComparisonsForRule,
  listPlans,
  publishBaseline,
  putAnnotation,
  setBaselineFrozen,
  stableOptionsKey,
  transaction,
  upsertNormalization,
  type AnnotationRecord,
  type DatabaseLike,
  type PlanRecord,
  type SampleRecord
} from '../db/repository.ts';
import { diffPlans } from './diff.ts';
import { DEFAULT_OPTIONS, evaluatePerformance } from './statistics.ts';

type Database = DatabaseLike;

class FrozenBaselineError extends Error {
  constructor(planId: string) {
    super(`Cannot replace frozen baseline for plan ${planId}`);
    this.name = 'FrozenBaselineError';
  }
}

interface ParsedImport {
  raw: unknown;
  rawText: string;
  hash: string;
  planId: string;
  normalized: NormalizedPlan;
}

function hashContent(raw: unknown): { rawText: string; hash: string } {
  const rawText = JSON.stringify(raw);
  return { rawText, hash: createHash('sha256').update(rawText).digest('hex') };
}

function parseVendor(raw: unknown, ruleVersion?: string) {
  const vendor = (raw as { vendor?: VendorName } | null)?.vendor;
  if (vendor === 'postgresql') return parsePostgres(raw, ruleVersion);
  if (vendor === 'mysql') return parseMysql(raw, ruleVersion);
  throw new Error('Unsupported plan vendor; expected postgresql or mysql');
}

function planRecordFromParsed(parsed: ParsedImport, importedAt: string): PlanRecord {
  const envelope = parsed.normalized;
  const rawEnvelope = parsed.raw as { collectedAt: string; vendor: VendorName };
  return {
    id: parsed.planId,
    vendor: rawEnvelope.vendor,
    raw_json: parsed.rawText,
    query_fingerprint: envelope.queryFingerprint,
    schema_digest: envelope.schemaDigest,
    stats_version: envelope.statsVersion,
    parameters_json: JSON.stringify(envelope.parameters),
    collected_at: rawEnvelope.collectedAt,
    imported_at: importedAt
  };
}

export function importPlans(database: Database, payloads: unknown[]): { created: string[]; existing: string[] } {
  return transaction(database, () => {
    const created: string[] = [];
    const existing: string[] = [];
    const now = new Date().toISOString();
    const hashesInBatch = new Set<string>();
    for (const payload of payloads) {
      const parsed = parsePayload(payload, CURRENT_RULE_VERSION);
      if (hashesInBatch.has(parsed.hash)) throw new Error(`Duplicate content hash in one import batch: ${parsed.hash}`);
      hashesInBatch.add(parsed.hash);
      if (getPlan(database, parsed.planId)) {
        existing.push(parsed.planId);
        continue;
      }
      insertPlan(database, planRecordFromParsed(parsed, now));
      insertSamples(database, sampleRecords(parsed));
      upsertNormalization(database, parsed.planId, parsed.normalized);
      audit(database, 'plan.import', parsed.planId, { hash: parsed.hash, vendor: parsed.normalized.vendor });
      created.push(parsed.planId);
    }
    return { created, existing };
  });
}

function parsePayload(raw: unknown, ruleVersion: string): ParsedImport {
  const { normalized } = parseVendor(raw, ruleVersion);
  const content = hashContent(raw);
  return {
    raw,
    rawText: content.rawText,
    hash: content.hash,
    planId: `plan_${content.hash.slice(0, 24)}`,
    normalized
  };
}

function sampleRecords(parsed: ParsedImport): SampleRecord[] {
  const envelope = parsed.raw as { runs: Array<{ id: string; status: SampleRecord['status']; startedAt: string; elapsedMs?: number | null; errorCode?: string | null }> };
  return envelope.runs.map((run) => ({
    plan_id: parsed.planId,
    run_id: run.id,
    status: run.status,
    started_at: run.startedAt,
    elapsed_ms: run.elapsedMs ?? null,
    error_code: run.errorCode ?? null
  }));
}

export function normalizePlans(database: Database, planIds: string[], ruleVersion: string): { normalized: string[] } {
  return transaction(database, () => {
    const normalized: string[] = [];
    for (const planId of planIds) {
      const record = getPlan(database, planId);
      if (!record) throw new Error(`Unknown plan: ${planId}`);
      const parsed = parsePayload(JSON.parse(record.raw_json), ruleVersion);
      upsertNormalization(database, planId, parsed.normalized);
      audit(database, 'plan.normalize', planId, { ruleVersion });
      normalized.push(planId);
    }
    return { normalized };
  });
}

function requireNormalizedPlan(database: Database, planId: string, ruleVersion: string): NormalizedPlan {
  const record = getNormalization(database, planId, ruleVersion);
  if (!record) throw new Error(`Plan ${planId} has not been normalized with ${ruleVersion}`);
  return JSON.parse(record.normalized_json) as NormalizedPlan;
}

function normalizationId(planId: string, ruleVersion: string): string {
  return `${planId.slice(0, 24)}:${ruleVersion}`;
}

export function comparePlans(
  database: Database,
  request: { baselinePlanId: string; candidatePlanId: string; ruleVersion: string; options?: Partial<ComparisonOptions> }
): PlanComparison {
  return transaction(database, () => {
    const options = { ...DEFAULT_OPTIONS, ...request.options };
    const baselinePlan = requireNormalizedPlan(database, request.baselinePlanId, request.ruleVersion);
    const candidatePlan = requireNormalizedPlan(database, request.candidatePlanId, request.ruleVersion);
    const performance = evaluatePerformance(
      baselinePlan,
      candidatePlan,
      listSamplesForStats(database, request.baselinePlanId),
      listSamplesForStats(database, request.candidatePlanId),
      options
    );
    const nodeDiffs = diffPlans(baselinePlan, candidatePlan, options);
    const id = comparisonId(request.baselinePlanId, request.candidatePlanId, request.ruleVersion, options);
    const comparison: PlanComparison = {
      id,
      baselinePlanId: request.baselinePlanId,
      candidatePlanId: request.candidatePlanId,
      ruleVersion: request.ruleVersion,
      ...performance,
      nodeDiffs
    };
    const existing = getComparison(database, id);
    if (!existing) {
      insertComparison(database, comparison, {
        baselineNormalizationId: normalizationId(request.baselinePlanId, request.ruleVersion),
        candidateNormalizationId: normalizationId(request.candidatePlanId, request.ruleVersion)
      });
      audit(database, 'comparison.create', id, { status: comparison.status, verdict: comparison.verdict });
    }
    return comparison;
  });
}

function listSamplesForStats(database: Database, planId: string) {
  const rows = database.prepare('select status, elapsed_ms as elapsedMs from samples where plan_id = ?').all(planId) as Array<{ status: 'completed' | 'timeout' | 'error'; elapsedMs: number | null }>;
  return rows;
}

function comparisonId(baseline: string, candidate: string, ruleVersion: string, options: ComparisonOptions): string {
  const digest = createHash('sha256').update(JSON.stringify({ baseline, candidate, ruleVersion, options: stableOptionsKey(options) })).digest('hex').slice(0, 20);
  return `cmp_${digest}`;
}

export function publishCurrentBaseline(database: Database, planId: string, ruleVersion: string) {
  return transaction(database, () => {
    const plan = getPlan(database, planId);
    const normalized = getNormalization(database, planId, ruleVersion);
    if (!plan || !normalized) throw new Error('Plan normalization is required before publishing a baseline');
    const result = publishBaseline(database, {
      id: `base_${createHash('sha256').update(`${plan.query_fingerprint}:${plan.schema_digest}:${ruleVersion}`).digest('hex').slice(0, 18)}`,
      queryFingerprint: plan.query_fingerprint,
      schemaDigest: plan.schema_digest,
      ruleVersion,
      planId,
      normalizationId: normalized.id
    });
    audit(database, 'baseline.publish', planId, { ruleVersion, result });
    if (result.frozen) throw new FrozenBaselineError(planId);
    return result;
  });
}

export function publishCurrentBaselines(database: Database, requests: Array<{ planId: string; ruleVersion: string }>) {
  return transaction(database, () => requests.map((request) => publishCurrentBaseline(database, request.planId, request.ruleVersion)));
}

export function freezeBaseline(database: Database, planId: string, ruleVersion: string, frozen: boolean) {
  return transaction(database, () => {
    const changed = setBaselineFrozen(database, planId, ruleVersion, frozen);
    if (!changed) throw new Error('No published baseline matches that plan and rule version');
    audit(database, 'baseline.freeze', planId, { ruleVersion, frozen });
    return { frozen };
  });
}

export function annotateNode(
  database: Database,
  request: {
    comparisonId: string;
    nodeId: string;
    decision: AnnotationRecord['decision'];
    note: string;
    author: string;
    expectedVersion: number | null;
  }
): AnnotationRecord {
  return transaction(database, () => {
    const comparison = getComparison(database, request.comparisonId);
    if (!comparison) throw new Error('Unknown comparison');
    const nodeDiff = comparison.nodeDiffs.find((diff) => diff.baselineNodeId === request.nodeId || diff.candidateNodeId === request.nodeId);
    if (!nodeDiff) throw new Error('Unknown plan node in comparison');
    const now = new Date().toISOString();
    const annotationId = `ann_${createHash('sha256').update(`${request.comparisonId}:${request.nodeId}`).digest('hex').slice(0, 16)}`;
    const record = putAnnotation(
      database,
      {
        id: annotationId,
        comparison_id: request.comparisonId,
        node_id: request.nodeId,
        decision: request.decision,
        note: request.note,
        author: request.author,
        version: request.expectedVersion ?? 1,
        created_at: now,
        updated_at: now
      },
      request.expectedVersion,
      nodeDiff
    );
    audit(database, 'annotation.put', annotationId, { nodeId: request.nodeId, decision: request.decision, version: record.version });
    return record;
  });
}

export function upgradeRules(database: Database, fromRuleVersion: string, toRuleVersion: string): { recomputed: string[] } {
  if (!laterRuleVersion(fromRuleVersion, toRuleVersion)) throw new Error('Rule upgrades must move forward through registered versions');
  return transaction(database, () => {
    const oldComparisons = listComparisonsForRule(database, fromRuleVersion);
    const recomputed: string[] = [];
    const planIds = new Set<string>();
    oldComparisons.forEach((comparison) => {
      planIds.add(comparison.baselinePlanId);
      planIds.add(comparison.candidatePlanId);
    });
    normalizePlans(database, [...planIds], toRuleVersion);
    oldComparisons.forEach((oldComparison) => {
      const next = comparePlans(database, {
        baselinePlanId: oldComparison.baselinePlanId,
        candidatePlanId: oldComparison.candidatePlanId,
        ruleVersion: toRuleVersion,
        options: oldComparison.options
      });
      const oldId = oldComparison.id!;
      const nextId = next.id!;
      deactivateComparison(database, oldId, nextId);
      audit(database, 'comparison.recompute', nextId, { oldId, fromRuleVersion, toRuleVersion });
      recomputed.push(nextId);
    });
    return { recomputed };
  });
}

export function previewRuleUpgrade(database: Database, fromRuleVersion: string, toRuleVersion: string): RuleUpgradePreview {
  if (!laterRuleVersion(fromRuleVersion, toRuleVersion)) throw new Error('Rule upgrades must move forward through registered versions');
  const affected: RuleUpgradePreview['affected'] = [];
  for (const oldComparison of listComparisonsForRule(database, fromRuleVersion)) {
    const baselinePlan = requireNormalizedPlan(database, oldComparison.baselinePlanId, fromRuleVersion);
    const candidatePlan = requireNormalizedPlan(database, oldComparison.candidatePlanId, fromRuleVersion);
    const temporaryBaseline = parsePayloadFromRecord(database, oldComparison.baselinePlanId, toRuleVersion).normalized;
    const temporaryCandidate = parsePayloadFromRecord(database, oldComparison.candidatePlanId, toRuleVersion).normalized;
    const beforePhysical = baselinePlan.physicalFingerprint !== candidatePlan.physicalFingerprint;
    const beforeSemantic = baselinePlan.semanticFingerprint !== candidatePlan.semanticFingerprint;
    const afterPhysical = temporaryBaseline.physicalFingerprint !== temporaryCandidate.physicalFingerprint;
    const afterSemantic = temporaryBaseline.semanticFingerprint !== temporaryCandidate.semanticFingerprint;
    const nextDiffs = diffPlans(temporaryBaseline, temporaryCandidate, oldComparison.options);
    const changedReorderCount = nextDiffs.filter((diff) => diff.kind === 'equivalent_reorder').length;
    if (beforePhysical !== afterPhysical || beforeSemantic !== afterSemantic || changedReorderCount > 0) {
      affected.push({
        comparisonId: oldComparison.id!,
        baselinePlanId: oldComparison.baselinePlanId,
        candidatePlanId: oldComparison.candidatePlanId,
        beforePhysical,
        beforeSemantic,
        afterPhysical,
        afterSemantic,
        changedReorderCount
      });
    }
  }
  return { fromRuleVersion, toRuleVersion, affected };
}

function parsePayloadFromRecord(database: Database, planId: string, ruleVersion: string) {
  const record = getPlan(database, planId);
  if (!record) throw new Error(`Unknown plan: ${planId}`);
  return parsePayload(JSON.parse(record.raw_json), ruleVersion);
}

export function storeState(database: Database) {
  return {
    plans: listPlans(database),
    comparisons: listActiveComparisons(database),
    annotations(comparisonId: string) {
      return listAnnotations(database, comparisonId);
    }
  };
}

export function getPlanBundle(database: Database, planId: string, ruleVersion: string) {
  const plan = getPlan(database, planId);
  const normalization = getNormalization(database, planId, ruleVersion);
  if (!plan || !normalization) throw new Error('Plan normalization not found');
  return {
    planId,
    vendor: plan.vendor,
    raw: JSON.parse(plan.raw_json),
    normalized: JSON.parse(normalization.normalized_json) as NormalizedPlan,
    samples: listSamplesForStats(database, planId)
  };
}
