import { createNode, createPlan } from '../model.js';

export const SPARK_PARSER_VERSION = 'spark-physical-json-parser-1.0';

function asNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function inferKind(operator) {
  if (/join/i.test(operator)) return 'join';
  if (/scan/i.test(operator)) return 'scan';
  if (/sort/i.test(operator)) return 'sort';
  if (/aggregate/i.test(operator)) return 'aggregate';
  if (/limit/i.test(operator)) return 'limit';
  if (/union/i.test(operator)) return 'union';
  return 'operator';
}

function sparkJoinType(value) {
  const type = String(value || 'inner').toLowerCase();
  if (type.includes('left semi')) return 'left_semi';
  if (type.includes('left anti')) return 'left_anti';
  if (type.startsWith('left')) return 'left_outer';
  if (type.startsWith('right')) return 'right_outer';
  if (type.startsWith('full')) return 'full_outer';
  if (type.includes('cross')) return 'cross';
  return 'inner';
}

function inferRoles(operator, children, joinType) {
  if (!/join/i.test(operator) || children.length !== 2) return null;
  if (/broadcast\s*hash\s*join/i.test(operator)) {
    return { 0: 'streamed/probe', 1: 'broadcast/build', label: 'broadcast' };
  }
  if (/shuffled\s*hash\s*join/i.test(operator)) {
    return { 0: 'streamed/probe', 1: 'build', label: 'shuffled' };
  }
  if (['left_outer', 'right_outer', 'full_outer', 'left_semi', 'left_anti'].includes(joinType)) {
    return { 0: joinType.startsWith('right') ? 'right/optional' : 'left/required', 1: joinType.startsWith('right') ? 'left/required' : 'right/optional' };
  }
  return { 0: 'left', 1: 'right' };
}

function parseExpressions(source) {
  return Object.fromEntries(
    ['condition', 'outputColumns', 'order', 'groupingExpressions', 'aggregateExpressions', 'partitionFilters', 'dataFilters', 'pushedFilters']
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, asArray(source[key]).map(String)])
  );
}

function parseNode(source, path, diagnostics) {
  if (!source || typeof source !== 'object' || !source.nodeName) {
    diagnostics.push({ path, code: 'MISSING_NODE_FIELD', field: 'nodeName' });
    return null;
  }
  const operator = source.nodeName;
  const children = (source.children || []).map((child, index) =>
    parseNode(child, [...path, index], diagnostics)
  ).filter(Boolean);
  const joinType = /join/i.test(operator) ? sparkJoinType(source.joinType) : null;
  const node = createNode({
    kind: inferKind(operator),
    operator,
    relation: source.table || source.relation || null,
    index: source.indexName || source.accessPath || null,
    partition: Array.isArray(source.partitionColumns) && source.partitionColumns.length
      ? { columns: source.partitionColumns, pruningFilters: asArray(source.partitionFilters) }
      : null,
    estimates: {
      rows: asNumber(source.estimatedRows ?? source.rowCount),
      width: asNumber(source.estimatedSizeBytes ?? source.sizeInBytes),
      cost: {
        startup: null,
        total: asNumber(source.cost)
      }
    },
    details: {
      joinType,
      joinSide: source.joinSide || null,
      buildSide: source.buildSide || null,
      exchangeMode: source.exchangeMode || null,
      tableFormat: source.tableFormat || null,
      timingKey: source.pathKey || source.nodeTimingKey || null
    },
    expressions: parseExpressions(source),
    children,
    roles: inferRoles(operator, children, joinType),
    vendorPath: path
  });
  if (node.estimates.rows === null) {
    diagnostics.push({ path, pathKey: source.pathKey || null, code: 'MISSING_NODE_FIELD', field: 'estimates.rows' });
  }
  return node;
}

export function parseSparkPlan(payload, sourceHash) {
  const diagnostics = [];
  const root = parseNode(payload.rootPlan || payload.plan, [0], diagnostics);
  const samples = (payload.samples || []).map((sample) => ({
    ordinal: sample.ordinal,
    durationMs: asNumber(sample.durationMs),
    timeout: Boolean(sample.timeout),
    nodeTimings: sample.nodeTimings || {}
  }));
  const parameters = Object.fromEntries(
    Object.entries(payload.conf || payload.parameters || {}).filter(([name]) => !/(^|\.)(app\.id|appId|appName|queryId|executionId)(\.|$)|timestamp|pid/i.test(name))
  );
  return {
    plan: createPlan({
      format: 'spark-physical-json',
      queryFingerprint: payload.queryFingerprint,
      schema: payload.schema || {},
      statsVersion: payload.statsVersion,
      parameters,
      environment: payload.environment || {},
      root,
      samples,
      sourceHash,
      capturedAt: null,
      parserVersion: SPARK_PARSER_VERSION
    }),
    diagnostics
  };
}

export function isSparkPayload(payload) {
  return Boolean(payload?.rootPlan?.nodeName || payload?.plan?.nodeName || payload?.sparkVersion);
}
