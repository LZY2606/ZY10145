import type { ChildRole, JoinKind, PlanNode, PlanWarning, VendorPlanEnvelope } from '../../shared/model.ts';
import { asRecord, child, ignoredVolatile, makeNode, missingField, normalizeBase, numberOrNull, parseEnvelope, requireRecord, stringArray, stringOrNull } from './common.ts';

const VOLATILE_KEYS = new Set([
  'actualFirstRow',
  'actualLastRow',
  'actualRows',
  'actualLoops',
  'timerWait',
  'bufferUsage',
  'costInfoVersion',
  'execNodeId'
]);

function mysqlPartitionDecision(raw: Record<string, unknown>): ReturnType<typeof makeNode>['partitions'] {
  if (!asRecord(raw.partitionDecision)) return null;
  const partitions = raw.partitionDecision as Record<string, unknown>;
  return {
    selected: stringArray(partitions.selected),
    pruned: stringArray(partitions.pruned),
    strategy: stringOrNull(partitions.strategy)
  };
}

function joinKind(value: unknown): JoinKind {
  switch (value) {
    case 'LEFT':
    case 'left outer':
      return 'left';
    case 'RIGHT':
    case 'right outer':
      return 'right';
    case 'FULL':
      return 'full';
    case 'SEMI':
      return 'semi';
    case 'ANTI':
      return 'anti';
    default:
      return 'inner';
  }
}

function parseMysqlNode(rawNode: unknown, path: string, roleHint: ChildRole, warnings: PlanWarning[]): PlanNode | null {
  const raw = requireRecord(rawNode, path, warnings);
  if (!raw) return null;
  for (const key of Object.keys(raw)) {
    if (VOLATILE_KEYS.has(key)) warnings.push(ignoredVolatile(path, key, 'MySQL per-execution counter or transient executor ID is not part of the plan model'));
  }
  const type = stringOrNull(raw.nodeType) ?? stringOrNull(raw.operation);
  if (!type) {
    warnings.push(missingField(path, 'nodeType', 'MySQL node is missing nodeType'));
    return null;
  }
  const operator = type.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  const children: Array<{ role: ChildRole; node: PlanNode }> = [];
  if (Array.isArray(raw.children)) {
    raw.children.forEach((rawChild, index) => {
      const record = asRecord(rawChild);
      const rawRole = stringOrNull(record?.role);
      let role: ChildRole = stringOrNull(rawRole) as ChildRole | null ?? roleHint;
      if (rawRole === 'driving' || rawRole === 'outer') role = operator === 'hash_join' ? 'probe' : 'outer';
      if (rawRole === 'driven' || rawRole === 'inner') role = operator === 'hash_join' ? 'build' : 'inner';
      if (rawRole === 'first') role = 'first';
      if (rawRole === 'second') role = 'second';
      const parsed = parseMysqlNode(rawChild, `${path}/C${index}`, role, warnings);
      if (parsed) children.push(child(role, parsed));
    });
  }
  const isJoin = operator.includes('nested_loop') || operator.includes('join');
  const estimatedRows = numberOrNull(raw.estimatedRows ?? raw.rowsEstimate);
  const estimatedCost = numberOrNull(raw.estimatedCost ?? raw.costEstimate);
  if (estimatedRows === null) warnings.push(missingField(path, 'estimatedRows', 'Estimated row count is absent'));
  if (estimatedCost === null) warnings.push(missingField(path, 'estimatedCost', 'Estimated cost is absent'));
  const joinCondition = isJoin ? raw.accessCondition ?? raw.joinCondition ?? null : null;
  const condition = raw.filterCondition ?? raw.condition ?? (isJoin ? null : raw.accessCondition ?? null) ?? null;
  const equi = condition !== null && /=\s*/.test(String(condition)) && !String(condition).includes('!=') && !String(condition).includes('>') && !String(condition).includes('<');
  const properties: Record<string, unknown> = {};
  for (const key of ['usedColumns', 'attachedCondition', 'prefixCost', 'sortSpec', 'groupSpec']) {
    if (raw[key] !== undefined) properties[key] = raw[key];
  }

  return makeNode({
    operator,
    relation: stringOrNull(raw.tableName) ?? stringOrNull(raw.table),
    alias: stringOrNull(raw.tableAlias) ?? stringOrNull(raw.alias),
    index: stringOrNull(raw.indexName) ?? stringOrNull(raw.key),
    indexColumns: stringArray(raw.indexColumns ?? raw.keyColumns),
    scanDirection: stringOrNull(raw.scanDirection) === 'backward' ? 'backward' : stringOrNull(raw.scanDirection) === 'forward' ? 'forward' : null,
    joinKind: isJoin ? joinKind(raw.joinType ?? raw.joinKind) : null,
    joinCondition,
    equiJoin: isJoin ? equi : false,
    joinDirection: isJoin ? (operator === 'hash_join' ? 'build_probe' : 'outer_inner') : 'none',
    filter: raw.filterCondition ?? raw.condition ?? null,
    projection: raw.columns ?? raw.outputColumns ?? null,
    children,
    estimatedRows,
    estimatedCost,
    partitions: mysqlPartitionDecision(raw),
    parallelism: numberOrNull(raw.parallelWorkers),
    hints: stringArray(raw.hints),
    properties
  });
}

export function parseMysql(raw: unknown, ruleVersion?: string): { envelope: VendorPlanEnvelope; normalized: ReturnType<typeof normalizeBase> } {
  const envelope = parseEnvelope(raw, 'mysql');
  const warnings: PlanWarning[] = [];
  const plan = asRecord(envelope.plan);
  const rootRaw = asRecord(plan?.queryBlock) ?? plan;
  const root = parseMysqlNode(rootRaw, 'ROOT', 'child', warnings);
  if (!root) throw new Error('MySQL plan contains no parseable root node');
  return { envelope, normalized: normalizeBase(envelope, root, warnings, ruleVersion) };
}
