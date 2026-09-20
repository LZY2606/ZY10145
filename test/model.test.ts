import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parseMysql } from '../server/adapters/mysql.ts';
import { parsePostgres } from '../server/adapters/postgresql.ts';
import { diffPlans } from '../server/lib/diff.ts';
import { DEFAULT_OPTIONS } from '../server/lib/statistics.ts';
import { CURRENT_RULE_VERSION, INITIAL_RULE_VERSION } from '../shared/rules.ts';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));

describe('vendor normalization', () => {
  it('removes volatile PostgreSQL execution fields but keeps plan decisions', () => {
    const { normalized } = parsePostgres(fixture('pg-baseline.json'));
    expect(normalized.vendor).toBe('postgresql');
    expect(normalized.root.children[0].node.relation).toBe('orders');
    expect(normalized.root.children[0].node.partitions?.selected).toEqual(['p2026_09']);
    expect(JSON.stringify(normalized)).not.toContain('12.4');
    expect(JSON.stringify(normalized)).not.toContain('2026-09-20T08:01:00Z');
    expect(normalized.warnings.some((warning) => warning.code === 'ignored_volatile_field' && warning.field === 'Actual Total Time')).toBe(true);
  });

  it('removes volatile MySQL executor identifiers but preserves nested-loop and indexes', () => {
    const { normalized } = parseMysql(fixture('mysql-baseline.json'));
    expect(normalized.root.operator).toBe('nested_loop_join');
    expect(normalized.root.joinDirection).toBe('outer_inner');
    expect(normalized.root.children[1].node.index).toBe('PRIMARY');
    expect(JSON.stringify(normalized)).not.toContain('volatile-1001');
  });

  it('normalizes only semantically commutative nested-loop child order under v2', () => {
    const baseline = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidate = parsePostgres(fixture('pg-equiv-reorder.json'), CURRENT_RULE_VERSION).normalized;
    const diffs = diffPlans(baseline, candidate, DEFAULT_OPTIONS);
    expect(baseline.semanticFingerprint).toBe(candidate.semanticFingerprint);
    expect(baseline.physicalFingerprint).not.toBe(candidate.physicalFingerprint);
    expect(diffs.some((diff) => diff.kind === 'equivalent_reorder')).toBe(true);
    expect(diffs.some((diff) => diff.kind === 'structure_changed')).toBe(false);
  });

  it('does not normalize nested-loop child order under v1', () => {
    const baseline = parsePostgres(fixture('pg-baseline.json'), INITIAL_RULE_VERSION).normalized;
    const candidate = parsePostgres(fixture('pg-equiv-reorder.json'), INITIAL_RULE_VERSION).normalized;
    const diffs = diffPlans(baseline, candidate, DEFAULT_OPTIONS);
    expect(baseline.semanticFingerprint).not.toBe(candidate.semanticFingerprint);
    expect(diffs.some((diff) => diff.kind === 'equivalent_reorder')).toBe(false);
  });

  it('does not treat hash build/probe direction as commutative', () => {
    const baseline = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidate = parsePostgres(fixture('pg-hash-swap.json'), CURRENT_RULE_VERSION).normalized;
    const diffs = diffPlans(baseline, candidate, DEFAULT_OPTIONS);
    expect(diffs.some((diff) => diff.kind === 'structure_changed')).toBe(true);
    expect(diffs.every((diff) => diff.kind !== 'equivalent_reorder')).toBe(true);
  });

  it('separates index decisions and estimate drift from structure', () => {
    const baseline = parsePostgres(fixture('pg-baseline.json'), CURRENT_RULE_VERSION).normalized;
    const candidate = parsePostgres(fixture('pg-index-drift.json'), CURRENT_RULE_VERSION).normalized;
    const diffs = diffPlans(baseline, candidate, DEFAULT_OPTIONS);
    expect(diffs.some((diff) => diff.kind === 'index_changed')).toBe(true);
    expect(diffs.some((diff) => diff.kind === 'estimate_drift')).toBe(true);
  });
});
