import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.js';
import {
  createComparison,
  importPlans,
  listAnnotations,
  normalizeStoredPlans,
  previewRuleUpgrade,
  publishBaseline,
  setBaselineFrozen,
  upsertAnnotation
} from '../server/services.js';

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-diff-'));
  return openDatabase(join(dir, 'test.sqlite'));
}

function seedPair(db, baseline = 'postgres-orders-baseline.json', candidate = 'postgres-orders-candidate-swap.json') {
  const imported = importPlans(db, [fixture(baseline), fixture(candidate)]);
  const normalized = normalizeStoredPlans(db, imported.map((item) => item.sourceHash));
  return normalized;
}

describe('offline storage services', () => {
  let db;
  beforeEach(() => {
    db = freshDb();
  });

  it('is idempotent by content hash', () => {
    const first = importPlans(db, [fixture('postgres-orders-baseline.json')]);
    const second = importPlans(db, [fixture('postgres-orders-baseline.json')]);
    expect(first[0].sourceHash).toBe(second[0].sourceHash);
    expect(first[0].created).toBe(true);
    expect(second[0].created).toBe(false);
  });

  it('rolls the whole normalization batch back when one source is missing', () => {
    const imported = importPlans(db, [fixture('postgres-orders-baseline.json')]);
    expect(() => normalizeStoredPlans(db, [imported[0].sourceHash, 'missing'])).toThrow(/rolled back/);
    const count = db.prepare('SELECT COUNT(*) AS count FROM normalized_plans').get().count;
    expect(count).toBe(0);
  });

  it('publishes and freezes baselines without rewriting plans', () => {
    const [baselinePlan] = seedPair(db);
    const before = db.prepare('SELECT payload_json FROM raw_plans WHERE source_hash = ?').get(baselinePlan.sourceHash).payload_json;
    const baseline = publishBaseline(db, baselinePlan.normalizedHash, { label: 'release-1', freeze: true });
    expect(baseline.frozen).toBe(1);
    expect(() => publishBaseline(db, baselinePlan.normalizedHash)).toThrow(/frozen baseline/);
    setBaselineFrozen(db, baseline.baseline_id, false);
    const next = publishBaseline(db, baselinePlan.normalizedHash, { label: 'release-2' });
    expect(next.revision).toBe(2);
    const after = db.prepare('SELECT payload_json FROM raw_plans WHERE source_hash = ?').get(baselinePlan.sourceHash).payload_json;
    expect(after).toBe(before);
  });

  it('returns node-level optimistic annotation conflicts', async () => {
    const [baselinePlan, candidatePlan] = seedPair(db);
    const comparison = createComparison(db, baselinePlan.normalizedHash, candidatePlan.normalizedHash);
    const nodeId = comparison.result.structure.alignment.id;
    const first = upsertAnnotation(db, comparison.comparison_id, nodeId, 'explained', 'first');
    const second = upsertAnnotation(db, comparison.comparison_id, nodeId, 'accepted', 'second', first.version);
    expect(second.version).toBe(2);
    await expect(async () => upsertAnnotation(db, comparison.comparison_id, nodeId, 'rejected', 'stale', first.version))
      .rejects.toMatchObject({
        status: 409,
        conflict: expect.objectContaining({ nodeId, currentVersion: 2 })
      });
    const retained = upsertAnnotation(db, comparison.comparison_id, nodeId, 'accepted', 'second', second.version);
    expect(retained.version).toBe(3);
    expect(listAnnotations(db, comparison.comparison_id)[0].note).toBe('second');
  });

  it('previews old fingerprints affected by a rule upgrade without auto-recomputing', () => {
    const imported = importPlans(db, [fixture('postgres-union-baseline.json'), fixture('postgres-union-candidate-swap.json')]);
    normalizeStoredPlans(db, imported.map((item) => item.sourceHash), '2026-09-21.v1');
    const preview = previewRuleUpgrade(db);
    expect(preview.awaitingUserDecision).toBe(true);
    expect(preview.recomputed).toBe(false);
    expect(preview.affected).toHaveLength(1);
    expect(preview.affected[0].sourceHash).toBe(imported[1].sourceHash);
    const stillV1 = db.prepare('SELECT rule_version FROM normalized_plans').get();
    expect(stillV1.rule_version).toBe('2026-09-21.v1');
  });
});
