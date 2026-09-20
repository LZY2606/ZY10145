import { describe, expect, it } from 'vitest';
import { parsePostgres } from '../server/adapters/postgresql.ts';
import { evaluatePerformance, robustStats } from '../server/lib/statistics.ts';
import { CURRENT_RULE_VERSION } from '../shared/rules.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
const completed = (values: number[]) => values.map((value) => ({ status: 'completed' as const, elapsedMs: value }));

describe('robust performance statistics', () => {
  it('computes median, trimmed mean, and MAD from repeated samples', () => {
    const stats = robustStats(completed([100, 102, 104, 106, 500]));
    expect(stats.count).toBe(5);
    expect(stats.medianMs).toBe(104);
    expect(stats.madMs).toBe(2);
    expect(stats.trimmedMeanMs).toBe(182.4);
  });

  it('does not announce regression from a single large sample', () => {
    const baselinePlan = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidatePlan = parsePostgres(fixture('pg-hash-swap.json'), CURRENT_RULE_VERSION).normalized;
    const result = evaluatePerformance(baselinePlan, candidatePlan, completed([100, 101, 99, 100, 100]), completed([101, 103, 102, 500, 100]));
    expect(result.status).toBe('comparable');
    expect(['indeterminate', 'improvement', 'unchanged']).toContain(result.verdict);
  });

  it('reports insufficient samples independently', () => {
    const baselinePlan = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidatePlan = parsePostgres(fixture('pg-hash-swap.json'), CURRENT_RULE_VERSION).normalized;
    const result = evaluatePerformance(baselinePlan, candidatePlan, completed([100]), completed([200]));
    expect(result.status).toBe('insufficient_samples');
    expect(result.verdict).toBe('indeterminate');
  });

  it('reports timeout independently', () => {
    const baselinePlan = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidatePlan = parsePostgres(fixture('pg-hash-swap.json'), CURRENT_RULE_VERSION).normalized;
    const candidateSamples = completed([200, 201, 202, 203, 204]);
    candidateSamples.push({ status: 'timeout', elapsedMs: null });
    const result = evaluatePerformance(baselinePlan, candidatePlan, completed([100, 101, 102, 103, 104]), candidateSamples);
    expect(result.status).toBe('timeout');
  });

  it('reports incomparable parameter environments independently', () => {
    const baselinePlan = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidatePlan = parsePostgres(fixture('pg-hash-swap.json'), CURRENT_RULE_VERSION).normalized;
    candidatePlan.parameters.work_mem = '64MB';
    const result = evaluatePerformance(baselinePlan, candidatePlan, completed([100, 101, 102, 103, 104]), completed([200, 201, 202, 203, 204]));
    expect(result.status).toBe('incomparable_environment');
    expect(result.reasons.some((reason) => reason.includes('parameter'))).toBe(true);
  });
});
