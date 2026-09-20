import { createNode, createPlan } from '../model.js';

export const POSTGRES_PARSER_VERSION = 'postgres-ir-parser-1.0';

function asNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOf(value) {
  return Array.isArray(value) ? value.join(' ') : String(value ?? '');
}

function inferKind(operator) {
  if (/join/i.test(operator)) return 'join';
  if (/scan/i.test(operator)) return 'scan';
  if (/sort/i.test(operator)) return 'sort';
  if (/aggregate/i.test(operator)) return 'aggregate';
  if (/limit/i.test(operator)) return 'limit';
  if (/union|append/i.test(operator)) return 'union';
  return 'operator';
}

function inferRoles(operator, children) {
  if (!/join/i.test(operator)) return null;
  if (/hash join/i.test(operator)) {
    return children.length === 2 ? { 0: 'outer/probe', 1: 'inner/build' } : null;
  }
  if (/nested loop|merge join/i.test(operator)) {
    return children.length === 2 ? { 0: 'outer', 1: 'inner' } : null;
  }
  return null;
}

function parseExpressions(source) {
  const keys = [
    'Filter',
    'Index Cond',
    'Hash Cond',
    'Join Filter',
    'Merge Cond',
    'Recheck Cond',
    'Sort Key',
    'Group Key',
    'Output'
  ];
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, Array.isArray(source[key]) ? source[key] : [source[key]]])
  );
}

function parseNode(source, path, diagnostics) {
  if (!source || typeof source !== 'object' || !source['Node Type']) {
    diagnostics.push({ path, code: 'MISSING_NODE_FIELD', field: 'Node Type' });
    return null;
  }
  const operator = source['Node Type'];
  const children = (source.Plans || []).map((child, index) =>
    parseNode(child, [...path, index], diagnostics)
  ).filter(Boolean);
  const kind = inferKind(operator);
  const indexName = source['Index Name'] || null;
  const joinType = source['Join Type'] ? textOf(source['Join Type']) : null;
  const node = createNode({
    kind,
    operator,
    relation: source['Relation Name'] || null,
    index: indexName,
    partition: source['Parent Relationship'] === 'InitPlan' ? 'init' : null,
    estimates: {
      rows: asNumber(source['Plan Rows']),
      width: asNumber(source['Plan Width']),
      cost: {
        startup: asNumber(source['Startup Cost']),
        total: asNumber(source['Total Cost'])
      }
    },
    details: {
       joinType,
      parentRole: source['Parent Relationship'] || null,
      scanDirection: source['Scan Direction'] || null,
      partialMode: source['Partial Mode'] || null,
      parallelAware: source['Parallel Aware'] ?? null
      ,
      timingKey: source.nodeTimingKey || source['Plan Node Key'] || null
    },
    expressions: parseExpressions(source),
    children,
    roles: inferRoles(operator, children),
    vendorPath: path
  });
  if (node.estimates.rows === null) {
    diagnostics.push({ path, code: 'MISSING_NODE_FIELD', field: 'estimates.rows' });
  }
  return node;
}

export function parsePostgresPlan(payload, sourceHash) {
  const diagnostics = [];
  const sourcePlan = Array.isArray(payload) ? payload[0]?.Plan : payload.Plan;
  if (!sourcePlan) {
    diagnostics.push({ path: [], code: 'MISSING_NODE_FIELD', field: 'Plan' });
  }
  const root = sourcePlan ? parseNode(sourcePlan, [0], diagnostics) : null;
  const samples = (payload.samples || payload.executionSamples || []).map((sample) => ({
    ordinal: sample.ordinal,
    durationMs: asNumber(sample.durationMs ?? sample['actual time']),
    timeout: Boolean(sample.timeout),
    nodeTimings: sample.nodeTimings || {}
  }));
  const parameters = Object.fromEntries(
    Object.entries(payload.parameters || {}).filter(([name]) => !/pid|timestamp|absolute/i.test(name))
  );
  return {
    plan: createPlan({
      format: 'postgres-explain-json',
      queryFingerprint: payload.queryFingerprint,
      schema: payload.schema || {},
      statsVersion: payload.statsVersion,
      parameters,
      environment: payload.environment || {},
      root,
      samples,
      sourceHash,
      capturedAt: null,
      parserVersion: POSTGRES_PARSER_VERSION
    }),
    diagnostics
  };
}

export function isPostgresPayload(payload) {
  const plan = Array.isArray(payload) ? payload[0]?.Plan : payload?.Plan;
  return Boolean(plan?.['Node Type']);
}
