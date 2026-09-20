import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePlanJson } from '../shared/parse.js';
import { normalizePlan } from '../shared/normalize.js';
import { comparePlans } from '../shared/compare.js';
import { comparePerformance } from '../shared/stats.js';

function load(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

function normalizedPair(baselineName, candidateName, ruleVersion = '2026-09-21.v1') {
  const baselineRaw = parsePlanJson(load(baselineName)).plan;
  const candidateRaw = parsePlanJson(load(candidateName)).plan;
  return [normalizePlan(baselineRaw, ruleVersion), normalizePlan(candidateRaw, ruleVersion)];
}

describe('vendor parsing and normalization', () => {
  it('parses PostgreSQL and Spark fixtures without volatile IDs', () => {
    const postgres = parsePlanJson(load('postgres-orders-baseline.json'));
    const spark = normalizePlan(parsePlanJson(load('spark-events-baseline.json')).plan);
    expect(postgres.plan.format).toBe('postgres-explain-json');
    expect(spark.format).toBe('spark-physical-json');
    expect(JSON.stringify(spark)).not.toMatch(/application_1700000000000|expr_id=\d+|#\d+/);
  });

  it('keeps join order, index, partition, and cardinality', () => {
    const [plan] = normalizedPair('postgres-orders-baseline.json', 'postgres-orders-baseline.json');
    const join = plan.root;
    expect(join.operator).toBe('Hash Join');
    expect(join.children[0].index).toBe('orders_customer_id_idx');
    expect(join.children[0].estimates.rows).toBe(10000);
    const [spark] = normalizedPair('spark-events-baseline.json', 'spark-events-baseline.json');
    expect(spark.root.children[0].partition.columns).toEqual(['event_time']);
  });

  it('treats inner join child swap as logically equal but build/probe direction different', () => {
    const [baseline, candidate] = normalizedPair('postgres-orders-baseline.json', 'postgres-orders-candidate-swap.json');
    const comparison = comparePlans(baseline, candidate);
    expect(comparison.structure.logicalEquivalent).toBe(true);
    expect(comparison.structure.physicalEquivalent).toBe(false);
    expect(comparison.structure.containsPhysicalRoleReversal).toBe(true);
  });

  it('does not globally normalize ordered UNION ALL until v2 explicitly allows it', () => {
    const [v1Baseline, v1Candidate] = normalizedPair('postgres-union-baseline.json', 'postgres-union-candidate-swap.json', '2026-09-21.v1');
    const v1Comparison = comparePlans(v1Baseline, v1Candidate);
    expect(v1Comparison.structure.logicalEquivalent).toBe(false);
    const [v2Baseline, v2Candidate] = normalizedPair('postgres-union-baseline.json', 'postgres-union-candidate-swap.json', '2026-09-22.v2');
    const v2Comparison = comparePlans(v2Baseline, v2Candidate);
    expect(v2Comparison.structure.logicalEquivalent).toBe(true);
  });

  it('keeps structural, estimate, and runtime changes separate', () => {
    const [baseline, candidate] = normalizedPair('postgres-orders-baseline.json', 'postgres-orders-candidate-swap.json');
    const comparison = comparePlans(baseline, candidate);
    expect(comparison.categories.structural.some((item) => item.change === 'CHILD_ORDER_CHANGED')).toBe(true);
    expect(comparison.categories.estimates.some((item) => item.metric === 'rows')).toBe(true);
    expect(comparison.categories.runtime.length).toBeGreaterThan(0);
    expect(comparison.statuses).toContain('STATS_VERSION_CHANGED');
  });

  it('preserves Spark broadcast build direction and flags incompatible AQE parameters', () => {
    const [baseline, candidate] = normalizedPair('spark-events-baseline.json', 'spark-events-candidate-shuffle.json');
    expect(baseline.root.roles).toEqual({
      0: 'streamed/probe',
      1: 'broadcast/build',
      label: 'broadcast'
    });
    const comparison = comparePlans(baseline, candidate);
    expect(comparison.statuses).toContain('PARAMETER_ENVIRONMENT_NOT_COMPARABLE');
    expect(comparison.statuses).toContain('TIMEOUT_PRESENT');
    expect(comparison.categories.structural.some((item) => item.change === 'PARTITION_DECISION_CHANGED')).toBe(false);
    expect(comparison.categories.structural.some((item) => item.change === 'NODE_KIND_OR_OPERATOR_CHANGED')).toBe(true);
  });
});

describe('robust performance states', () => {
  it('does not declare regression from one observation', () => {
    const result = comparePerformance([{ durationMs: 100 }], [{ durationMs: 300 }]);
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.states).toContain('INSUFFICIENT_SAMPLES');
  });

  it('requires repeated robust median and effect evidence', () => {
    const baseline = [100, 101, 99, 102, 98];
    const candidate = [130, 132, 128, 134, 131];
    const result = comparePerformance(baseline, candidate);
    expect(result.verdict).toBe('REGRESSION');
    expect(result.medianRatio).toBeGreaterThan(1.15);
    expect(result.effect.delta).toBe(1);
  });

  it('reports missing, insufficient, and timeout states independently', () => {
    const missing = comparePerformance([], [{ durationMs: 1 }]);
    expect(missing.states).toContain('SAMPLES_MISSING');
    const timeout = comparePerformance(
      [{ durationMs: 10 }, { durationMs: 11 }, { durationMs: 10 }, { timeout: true }],
      [{ durationMs: 12 }, { durationMs: 11 }, { durationMs: 12 }, { timeout: true }]
    );
    expect(timeout.states).toContain('TIMEOUT_PRESENT');
  });

  it('flags missing plan node fields without inventing cardinality', () => {
    const raw = parsePlanJson(load('postgres-missing-estimate.json'));
    const normalized = normalizePlan(raw.plan, '2026-09-21.v1', raw.diagnostics);
    const comparison = comparePlans(normalized, normalized);
    expect(comparison.statuses).toContain('PLAN_NODE_FIELDS_MISSING');
    expect(normalized.root.estimates.rows).toBeNull();
  });
});
