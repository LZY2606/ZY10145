import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ComparisonOptions, NormalizedPlan, PlanComparison, RuleUpgradePreview, RunStatus } from '../../shared/model.ts';

export interface PlanRecord {
  id: string;
  vendor: string;
  raw_json: string;
  query_fingerprint: string;
  schema_digest: string;
  stats_version: string;
  parameters_json: string;
  collected_at: string;
  imported_at: string;
}

export interface NormalizationRecord {
  id: string;
  plan_id: string;
  rule_version: string;
  normalized_json: string;
  physical_fingerprint: string;
  semantic_fingerprint: string;
  shape_fingerprint: string;
  created_at: string;
}

export interface SampleRecord {
  plan_id: string;
  run_id: string;
  status: RunStatus;
  started_at: string;
  elapsed_ms: number | null;
  error_code: string | null;
}

export interface AnnotationRecord {
  id: string;
  comparison_id: string;
  node_id: string;
  decision: 'explained' | 'accepted' | 'rejected' | 'investigating';
  note: string;
  author: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type DatabaseLike = DatabaseSync;

export class ConflictError extends Error {
  readonly stored: AnnotationRecord;
  readonly nodeDiff: unknown;
  constructor(stored: AnnotationRecord, nodeDiff: unknown) {
    super(`Annotation for ${stored.node_id} changed concurrently; stored version is ${stored.version}`);
    this.name = 'ConflictError';
    this.stored = stored;
    this.nodeDiff = nodeDiff;
  }
}

const MIGRATION = `
pragma journal_mode = wal;
create table if not exists meta (key text primary key, value text not null);
create table if not exists plans (
  id text primary key,
  vendor text not null,
  raw_json text not null,
  query_fingerprint text not null,
  schema_digest text not null,
  stats_version text not null,
  parameters_json text not null,
  collected_at text not null,
  imported_at text not null
);
create table if not exists normalizations (
  id text primary key,
  plan_id text not null references plans(id) on delete cascade,
  rule_version text not null,
  normalized_json text not null,
  physical_fingerprint text not null,
  semantic_fingerprint text not null,
  shape_fingerprint text not null,
  created_at text not null,
  unique(plan_id, rule_version)
);
create table if not exists samples (
  plan_id text not null references plans(id) on delete cascade,
  run_id text not null,
  status text not null,
  started_at text not null,
  elapsed_ms real,
  error_code text,
  primary key(plan_id, run_id)
);
create table if not exists baselines (
  id text primary key,
  query_fingerprint text not null,
  schema_digest text not null,
  rule_version text not null,
  plan_id text not null references plans(id),
  normalization_id text not null references normalizations(id),
  frozen integer not null default 0,
  published_at text not null,
  unique(query_fingerprint, schema_digest, rule_version)
);
create table if not exists comparisons (
  id text primary key,
  baseline_plan_id text not null references plans(id),
  candidate_plan_id text not null references plans(id),
  baseline_normalization_id text not null references normalizations(id),
  candidate_normalization_id text not null references normalizations(id),
  rule_version text not null,
  status text not null,
  verdict text not null,
  result_json text not null,
  active integer not null,
  superseded_by text,
  created_at text not null
);
create unique index if not exists active_comparison_unique
  on comparisons(baseline_plan_id, candidate_plan_id, rule_version) where active = 1;
create table if not exists annotations (
  id text primary key,
  comparison_id text not null references comparisons(id) on delete cascade,
  node_id text not null,
  decision text not null,
  note text not null,
  author text not null,
  version integer not null,
  created_at text not null,
  updated_at text not null,
  unique(comparison_id, node_id)
);
create table if not exists audit_events (
  id integer primary key autoincrement,
  event_type text not null,
  entity_id text not null,
  detail_json text not null,
  created_at text not null
);
`;

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('pragma foreign_keys = on');
  database.exec(MIGRATION);
  return database;
}

export function transaction<T>(database: DatabaseSync, work: () => T): T {
  const state = database as DatabaseSync & { __planDiffInTransaction?: boolean };
  if (state.__planDiffInTransaction) return work();
  state.__planDiffInTransaction = true;
  database.exec('begin immediate');
  try {
    const result = work();
    database.exec('commit');
    state.__planDiffInTransaction = false;
    return result;
  } catch (error) {
    database.exec('rollback');
    state.__planDiffInTransaction = false;
    throw error;
  }
}

export function insertPlan(database: DatabaseSync, plan: PlanRecord): void {
  database.prepare(`
    insert or ignore into plans
    (id, vendor, raw_json, query_fingerprint, schema_digest, stats_version, parameters_json, collected_at, imported_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(plan.id, plan.vendor, plan.raw_json, plan.query_fingerprint, plan.schema_digest, plan.stats_version, plan.parameters_json, plan.collected_at, plan.imported_at);
}

export function getPlan(database: DatabaseSync, id: string): PlanRecord | undefined {
  return database.prepare('select * from plans where id = ?').get(id) as PlanRecord | undefined;
}

export function listPlans(database: DatabaseSync): PlanRecord[] {
  return database.prepare('select * from plans order by imported_at, id').all() as unknown as PlanRecord[];
}

export function insertSamples(database: DatabaseSync, samples: SampleRecord[]): void {
  const statement = database.prepare(`
    insert or ignore into samples(plan_id, run_id, status, started_at, elapsed_ms, error_code)
    values (?, ?, ?, ?, ?, ?)
  `);
  for (const sample of samples) statement.run(sample.plan_id, sample.run_id, sample.status, sample.started_at, sample.elapsed_ms, sample.error_code);
}

export function listSamples(database: DatabaseSync, planId: string): Array<{ status: RunStatus; elapsedMs: number | null }> {
  const rows = database.prepare('select status, elapsed_ms as elapsedMs from samples where plan_id = ? order by started_at, run_id').all(planId) as Array<{ status: RunStatus; elapsedMs: number | null }>;
  return rows.map((row) => ({ status: row.status, elapsedMs: row.elapsedMs ?? null }));
}

export function upsertNormalization(database: DatabaseSync, planId: string, normalized: NormalizedPlan): NormalizationRecord {
  const id = `${planId.slice(0, 24)}:${normalized.ruleVersion}`;
  const createdAt = new Date().toISOString();
  database.prepare(`
    insert into normalizations
    (id, plan_id, rule_version, normalized_json, physical_fingerprint, semantic_fingerprint, shape_fingerprint, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(plan_id, rule_version) do update set
      normalized_json = excluded.normalized_json,
      physical_fingerprint = excluded.physical_fingerprint,
      semantic_fingerprint = excluded.semantic_fingerprint,
      shape_fingerprint = excluded.shape_fingerprint
  `).run(
    id,
    planId,
    normalized.ruleVersion,
    JSON.stringify(normalized),
    normalized.physicalFingerprint,
    normalized.semanticFingerprint,
    normalized.shapeFingerprint,
    createdAt
  );
  return getNormalization(database, planId, normalized.ruleVersion)!;
}

export function getNormalization(database: DatabaseSync, planId: string, ruleVersion: string): NormalizationRecord | undefined {
  return database.prepare('select * from normalizations where plan_id = ? and rule_version = ?').get(planId, ruleVersion) as NormalizationRecord | undefined;
}

export function insertComparison(database: DatabaseSync, comparison: PlanComparison, ids: { baselineNormalizationId: string; candidateNormalizationId: string }): string {
  const id = comparison.id!;
  database.prepare(`
    insert into comparisons
    (id, baseline_plan_id, candidate_plan_id, baseline_normalization_id, candidate_normalization_id,
     rule_version, status, verdict, result_json, active, superseded_by, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, null, ?)
  `).run(
    id,
    comparison.baselinePlanId,
    comparison.candidatePlanId,
    ids.baselineNormalizationId,
    ids.candidateNormalizationId,
    comparison.ruleVersion,
    comparison.status,
    comparison.verdict,
    JSON.stringify(comparison),
    new Date().toISOString()
  );
  return id;
}

export function deactivateComparison(database: DatabaseSync, id: string, supersededBy: string): void {
  database.prepare('update comparisons set active = 0, superseded_by = ? where id = ?').run(supersededBy, id);
}

export function findActiveComparison(database: DatabaseSync, baselinePlanId: string, candidatePlanId: string, ruleVersion: string, optionsKey: string) {
  const rows = database.prepare('select * from comparisons where baseline_plan_id = ? and candidate_plan_id = ? and rule_version = ? and active = 1 order by created_at desc').all(baselinePlanId, candidatePlanId, ruleVersion) as Array<{ result_json: string }>;
  return rows.map((row) => JSON.parse(row.result_json) as PlanComparison).find((comparison) => stableOptionsKey(comparison.options) === optionsKey);
}

export function getComparison(database: DatabaseSync, id: string): PlanComparison | undefined {
  const row = database.prepare('select result_json from comparisons where id = ?').get(id) as { result_json: string } | undefined;
  return row ? (JSON.parse(row.result_json) as PlanComparison) : undefined;
}

export function listActiveComparisons(database: DatabaseSync): PlanComparison[] {
  const rows = database.prepare('select result_json from comparisons where active = 1 order by created_at desc, id').all() as Array<{ result_json: string }>;
  return rows.map((row) => JSON.parse(row.result_json) as PlanComparison);
}

export function listComparisonsForRule(database: DatabaseSync, ruleVersion: string): PlanComparison[] {
  const rows = database.prepare('select result_json from comparisons where rule_version = ? and active = 1 order by id').all(ruleVersion) as Array<{ result_json: string }>;
  return rows.map((row) => JSON.parse(row.result_json) as PlanComparison);
}

export function stableOptionsKey(options: ComparisonOptions): string {
  return JSON.stringify(options, Object.keys(options).sort());
}

export function publishBaseline(database: DatabaseSync, baseline: {
  id: string;
  queryFingerprint: string;
  schemaDigest: string;
  ruleVersion: string;
  planId: string;
  normalizationId: string;
}): { replaced: boolean; frozen: boolean } {
  const existing = database.prepare('select * from baselines where query_fingerprint = ? and schema_digest = ? and rule_version = ?')
    .get(baseline.queryFingerprint, baseline.schemaDigest, baseline.ruleVersion) as { id: string; frozen: number } | undefined;
  if (existing?.frozen) return { replaced: false, frozen: true };
  database.prepare(`
    insert into baselines(id, query_fingerprint, schema_digest, rule_version, plan_id, normalization_id, frozen, published_at)
    values (?, ?, ?, ?, ?, ?, 0, ?)
    on conflict(query_fingerprint, schema_digest, rule_version) do update set
      plan_id = excluded.plan_id,
      normalization_id = excluded.normalization_id,
      frozen = 0,
      published_at = excluded.published_at
  `).run(baseline.id, baseline.queryFingerprint, baseline.schemaDigest, baseline.ruleVersion, baseline.planId, baseline.normalizationId, new Date().toISOString());
  return { replaced: Boolean(existing), frozen: false };
}

export function listBaselines(database: DatabaseSync) {
  return database.prepare(`
    select b.*, p.vendor, n.semantic_fingerprint as semantic_fingerprint
    from baselines b join plans p on p.id = b.plan_id join normalizations n on n.id = b.normalization_id
    order by b.published_at desc
  `).all() as Array<Record<string, unknown>>;
}

export function setBaselineFrozen(database: DatabaseSync, planId: string, ruleVersion: string, frozen: boolean): boolean {
  const result = database.prepare('update baselines set frozen = ? where plan_id = ? and rule_version = ?').run(frozen ? 1 : 0, planId, ruleVersion);
  return result.changes > 0;
}

export function putAnnotation(database: DatabaseSync, annotation: AnnotationRecord, expectedVersion: number | null, nodeDiff: unknown): AnnotationRecord {
  const existing = getAnnotation(database, annotation.comparison_id, annotation.node_id);
  if (existing && existing.version !== expectedVersion) throw new ConflictError(existing, nodeDiff);
  const nextVersion = existing ? existing.version + 1 : 1;
  database.prepare(`
    insert into annotations(id, comparison_id, node_id, decision, note, author, version, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(comparison_id, node_id) do update set
      decision = excluded.decision,
      note = excluded.note,
      author = excluded.author,
      version = annotations.version + 1,
      updated_at = excluded.updated_at
  `).run(annotation.id, annotation.comparison_id, annotation.node_id, annotation.decision, annotation.note, annotation.author, nextVersion, annotation.created_at, annotation.updated_at);
  return getAnnotation(database, annotation.comparison_id, annotation.node_id)!;
}

export function getAnnotation(database: DatabaseSync, comparisonId: string, nodeId: string): AnnotationRecord | undefined {
  return database.prepare('select * from annotations where comparison_id = ? and node_id = ?').get(comparisonId, nodeId) as AnnotationRecord | undefined;
}

export function listAnnotations(database: DatabaseSync, comparisonId: string): AnnotationRecord[] {
  return database.prepare('select * from annotations where comparison_id = ? order by updated_at desc').all(comparisonId) as unknown as AnnotationRecord[];
}

export function audit(database: DatabaseSync, eventType: string, entityId: string, detail: unknown): void {
  database.prepare('insert into audit_events(event_type, entity_id, detail_json, created_at) values (?, ?, ?, ?)')
    .run(eventType, entityId, JSON.stringify(detail), new Date().toISOString());
}
