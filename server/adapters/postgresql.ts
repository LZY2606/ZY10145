import type { ChildRole, JoinKind, PlanNode, PlanWarning, VendorPlanEnvelope } from '../../shared/model.ts';
import { asRecord, child, expressionDigest, ignoredVolatile, makeNode, missingField, normalizeBase, numberOrNull, parseEnvelope, requireRecord, stringArray, stringOrNull } from './common.ts';

const VOLATILE_KEYS = new Set([
  'Actual Startup Time',
  'Actual Total Time',
  'Actual Rows',
  'Actual Loops',
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Shared Dirtied Blocks',
  'Shared Written Blocks',
  'Local Hit Blocks',
  'Local Read Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
  'I/O Read Time',
  'I/O Write Time'
]);

function partitionDecision(raw: Record<string, unknown>): ReturnType<typeof makeNode>['partitions'] {
  if (!asRecord(raw['x-partitions'])) return null;
  const partitions = raw['x-partitions'] as Record<string, unknown>;
  return {
    selected: stringArray(partitions.selected),
    pruned: stringArray(partitions.pruned),
    strategy: stringOrNull(partitions.strategy)
  };
}

function joinKind(value: unknown): JoinKind {
  switch (value) {
    case 'Left':
      return 'left';
    case 'Right':
      return 'right';
    case 'Full':
      return 'full';
    case 'Semi':
      return 'semi';
    case 'Anti':
      return 'anti';
    default:
      return 'inner';
  }
}

function operatorName(type: string): string {
  return type
    .toLowerCase()
    .replace(/[^a-z]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parsePostgresNode(rawNode: unknown, path: string, roleHint: ChildRole, warnings: PlanWarning[]): PlanNode | null {
  const raw = requireRecord(rawNode, path, warnings);
  if (!raw) return null;
  for (const key of Object.keys(raw)) {
    if (VOLATILE_KEYS.has(key)) warnings.push(ignoredVolatile(path, key, 'PostgreSQL per-execution counter or absolute timing field is not part of the plan model'));
  }
  const nodeType = stringOrNull(raw['Node Type']);
  if (!nodeType) {
    warnings.push(missingField(path, 'Node Type', 'PostgreSQL node is missing Node Type'));
    return null;
  }
  const operator = operatorName(nodeType);
  const children: Array<{ role: ChildRole; node: PlanNode }> = [];
  const rawChildren = Array.isArray(raw.Plans) ? raw.Plans : [];
  rawChildren.forEach((rawChild, index) => {
    const record = asRecord(rawChild);
    const rawRole = stringOrNull(record?.['Parent Relationship']);
    const role: ChildRole = rawRole === 'InitPlan' || rawRole === 'SubPlan' ? (rawRole as ChildRole) : 'child';
    const mappedRole: ChildRole = rawRole === 'Inner'
      ? (operator === 'hash_join' ? 'build' : 'inner')
      : rawRole === 'Outer'
        ? (operator === 'hash_join' ? 'probe' : 'outer')
        : role;
    const parsed = parsePostgresNode(rawChild, `${path}/C${index}`, mappedRole, warnings);
    if (parsed) children.push(child(mappedRole, parsed));
  });

  const estimatedRows = numberOrNull(raw['Plan Rows']);
  const estimatedCost = numberOrNull(raw['Total Cost']);
  if (estimatedRows === null) warnings.push(missingField(path, 'Plan Rows', 'Estimated row count is absent'));
  if (estimatedCost === null) warnings.push(missingField(path, 'Total Cost', 'Estimated cost is absent'));

  const isJoin = operator.endsWith('_join') || operator === 'nested_loop';
  const joinCondition = isJoin
    ? raw['Join Cond'] ?? raw['Hash Cond'] ?? raw['Merge Cond'] ?? raw['Join Filter'] ?? null
    : null;
  const conditionText = String(joinCondition ?? '');
  const equiJoin = joinCondition !== null && /\s=\s|=\s*\w/.test(conditionText) && !conditionText.includes('!=') && !conditionText.includes('<>') && !conditionText.includes('>') && !conditionText.includes('<');
  const hints = stringArray(raw['x-hints']);
  const properties: Record<string, unknown> = {};
  if (raw['Sort Key']) properties.sortKey = raw['Sort Key'];
  if (raw['Group Key']) properties.groupKey = raw['Group Key'];
  if (raw['Hash Buckets']) properties.hashBuckets = raw['Hash Buckets'];
  if (raw['Strategy']) properties.aggregateStrategy = raw['Strategy'];

  return makeNode({
    operator,
    relation: stringOrNull(raw['Relation Name']),
    alias: stringOrNull(raw.Alias),
    index: stringOrNull(raw['Index Name']),
    indexColumns: stringArray(raw['Index Key']),
    scanDirection: stringOrNull(raw['Scan Direction']) === 'Backward' ? 'backward' : stringOrNull(raw['Scan Direction']) === 'Forward' ? 'forward' : null,
    joinKind: isJoin ? joinKind(raw['Join Type']) : null,
    joinCondition,
    equiJoin: isJoin ? equiJoin : false,
    joinDirection: isJoin ? (operator === 'hash_join' ? 'build_probe' : 'outer_inner') : 'none',
    filter: raw['Filter'] ?? raw['Recheck Cond'] ?? null,
    projection: raw['Output'] ?? null,
    children,
    estimatedRows,
    estimatedCost,
    partitions: partitionDecision(raw),
    parallelism: numberOrNull(raw['Workers Planned']),
    hints,
    properties,
    warnings: []
  });
}

export function parsePostgres(raw: unknown, ruleVersion?: string): { envelope: VendorPlanEnvelope; normalized: ReturnType<typeof normalizeBase> } {
  const envelope = parseEnvelope(raw, 'postgresql');
  const warnings: PlanWarning[] = [];
  const rawPlan = Array.isArray(envelope.plan) ? asRecord(envelope.plan[0]) : asRecord(envelope.plan);
  const rootRaw = asRecord(rawPlan?.Plan) ?? rawPlan;
  const root = parsePostgresNode(rootRaw, 'ROOT', 'child', warnings);
  if (!root) throw new Error('PostgreSQL plan contains no parseable root node');
  return { envelope, normalized: normalizeBase(envelope, root, warnings, ruleVersion) };
}
