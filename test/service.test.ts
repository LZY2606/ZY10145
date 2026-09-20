import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, openDatabase } from '../server/db/repository.ts';
import {
  annotateNode,
  comparePlans,
  importPlans,
  normalizePlans,
  previewRuleUpgrade,
  publishCurrentBaseline,
  publishCurrentBaselines,
  freezeBaseline,
  upgradeRules
} from '../server/lib/service.ts';
import { CURRENT_RULE_VERSION, INITIAL_RULE_VERSION } from '../shared/rules.ts';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
let database: DatabaseSync;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plan-db-'));
  database = openDatabase(join(dir, 'test.sqlite'));
});

function importAll(): Record<string, string> {
  const result = importPlans(database, [
    fixture('pg-baseline.json'),
    fixture('pg-equiv-reorder.json'),
    fixture('pg-hash-swap.json'),
    fixture('pg-index-drift.json'),
    fixture('mysql-baseline.json'),
    fixture('mysql-candidate.json')
  ]);
  expect(result.created).toHaveLength(6);
  return {
    pgBaseline: result.created[0],
    pgReorder: result.created[1],
    pgHash: result.created[2],
    pgIndex: result.created[3],
    mysqlBaseline: result.created[4],
    mysqlCandidate: result.created[5]
  };
}

describe('sqlite transactions and decisions', () => {
  it('imports by content hash idempotently and ignores absolute timestamps', () => {
    const first = importPlans(database, [fixture('pg-baseline.json'), fixture('mysql-baseline.json')]);
    const second = importPlans(database, [fixture('pg-baseline.json'), fixture('mysql-baseline.json')]);
    expect(first.created).toHaveLength(2);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual(first.created);
  });

  it('rolls back the whole import batch when one payload is invalid', () => {
    expect(() => importPlans(database, [fixture('pg-baseline.json'), { vendor: 'postgresql' }])).toThrow();
    const count = database.prepare('select count(*) as count from plans').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('rolls back partial normalization batch', () => {
    const ids = importAll();
    expect(() => normalizePlans(database, [ids.pgBaseline, 'plan_missing'], INITIAL_RULE_VERSION)).toThrow();
    const count = database.prepare('select count(*) as count from normalizations where rule_version = ?').get(INITIAL_RULE_VERSION) as { count: number };
    expect(count.count).toBe(0);
  });

  it('rolls back batch baseline publishing when any request is blocked by a frozen baseline', () => {
    const ids = importAll();
    publishCurrentBaseline(database, ids.pgBaseline, CURRENT_RULE_VERSION);
    freezeBaseline(database, ids.pgBaseline, CURRENT_RULE_VERSION, true);
    expect(() => publishCurrentBaselines(database, [
      { planId: ids.mysqlBaseline, ruleVersion: CURRENT_RULE_VERSION },
      { planId: ids.pgHash, ruleVersion: CURRENT_RULE_VERSION }
    ])).toThrow(/frozen/i);
    const count = database.prepare("select count(*) as count from baselines where plan_id = ?").get(ids.mysqlBaseline) as { count: number };
    expect(count.count).toBe(0);
  });

  it('creates robust comparison and freezes baseline without rewriting raw plan', () => {
    const ids = importAll();
    publishCurrentBaseline(database, ids.pgBaseline, CURRENT_RULE_VERSION);
    freezeBaseline(database, ids.pgBaseline, CURRENT_RULE_VERSION, true);
    expect(() => publishCurrentBaseline(database, ids.pgHash, CURRENT_RULE_VERSION)).toThrow(/frozen/i);
    const comparison = comparePlans(database, { baselinePlanId: ids.pgBaseline, candidatePlanId: ids.pgHash, ruleVersion: CURRENT_RULE_VERSION });
    expect(comparison.status).toBe('comparable');
    expect(comparison.verdict).toBe('regression');
    const raw = database.prepare('select raw_json as raw_json from plans where id=?').get(ids.pgBaseline) as { raw_json: string };
    expect(JSON.parse(raw.raw_json).vendor).toBe('postgresql');
  });

  it('reports missing plan fields as an independent performance state', () => {
    const complete = fixture('pg-baseline.json');
    const missing = fixture('pg-baseline.json');
    delete missing.plan.Plan['Plan Rows'];
    missing.collectedAt = '2026-09-20T14:00:00.000Z';
    const imported = importPlans(database, [complete, missing]);
    const comparison = comparePlans(database, { baselinePlanId: imported.created[0], candidatePlanId: imported.created[1], ruleVersion: CURRENT_RULE_VERSION });
    expect(comparison.status).toBe('missing_fields');
  });

  it('previews old comparisons affected by a rule upgrade and recomputes only after confirmation', () => {
    const ids = importAll();
    normalizePlans(database, [ids.pgBaseline, ids.pgReorder], INITIAL_RULE_VERSION);
    const old = comparePlans(database, { baselinePlanId: ids.pgBaseline, candidatePlanId: ids.pgReorder, ruleVersion: INITIAL_RULE_VERSION });
    const preview = previewRuleUpgrade(database, INITIAL_RULE_VERSION, CURRENT_RULE_VERSION);
    expect(preview.affected[0].comparisonId).toBe(old.id);
    expect(preview.affected[0].beforeSemantic).toBe(true);
    expect(preview.affected[0].afterSemantic).toBe(false);
    expect(preview.affected[0].changedReorderCount).toBeGreaterThan(0);
    const result = upgradeRules(database, INITIAL_RULE_VERSION, CURRENT_RULE_VERSION);
    expect(result.recomputed).toHaveLength(1);
    const active = database.prepare('select count(*) as count from comparisons where active=1').get() as { count: number };
    expect(active.count).toBe(1);
  });

  it('exposes plan-node level diff on concurrent annotation conflict', () => {
    const ids = importAll();
    const comparison = comparePlans(database, { baselinePlanId: ids.pgBaseline, candidatePlanId: ids.pgHash, ruleVersion: CURRENT_RULE_VERSION });
    const target = comparison.nodeDiffs.find((diff) => diff.kind === 'structure_changed')!;
    const nodeId = target.baselineNodeId ?? target.candidateNodeId!;
    const first = annotateNode(database, { comparisonId: comparison.id!, nodeId, decision: 'investigating', note: 'first', author: 'a', expectedVersion: null });
    expect(first.version).toBe(1);
    expect(() => annotateNode(database, { comparisonId: comparison.id!, nodeId, decision: 'explained', note: 'stale', author: 'b', expectedVersion: null })).toThrow(ConflictError);
    try {
      annotateNode(database, { comparisonId: comparison.id!, nodeId, decision: 'explained', note: 'stale', author: 'b', expectedVersion: null });
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).nodeDiff).toMatchObject({ kind: target.kind, path: target.path });
    }
  });
});
