import { canonicalHash, shortHash } from './hash.js';
import { IR_MODEL_VERSION } from './model.js';
import { CURRENT_RULE_VERSION, getRulePack, isLogicallyCommutative, physicalOrderMatters } from './rules.js';

const VOLATILE_TEXT_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
  /#\d+L?/g,
  /\bexpr[_-]?id\s*=\s*\d+\b/gi
];

function scrubVolatileText(value) {
  if (typeof value !== 'string') return value;
  return VOLATILE_TEXT_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, (match) => pattern === VOLATILE_TEXT_PATTERNS[2] ? '#id' : match.startsWith('expr') ? 'expr_id=#id' : '<time>'),
    value
  );
}

function scrubExpressions(expressions) {
  return Object.fromEntries(
    Object.entries(expressions || {}).map(([key, values]) => [
      key,
      (Array.isArray(values) ? values : [values]).map(scrubVolatileText)
    ])
  );
}

function normalizedDetails(node, pack) {
  const allowed = {
    joinType: node.details?.joinType ?? null,
    parentRole: node.details?.parentRole ?? null,
    scanDirection: node.details?.scanDirection ?? null,
    partialMode: node.details?.partialMode ?? null,
    parallelAware: node.details?.parallelAware ?? null,
    buildSide: node.details?.buildSide ?? null,
    joinSide: node.details?.joinSide ?? null,
    exchangeMode: node.details?.exchangeMode ?? null,
    tableFormat: node.details?.tableFormat ?? null
    ,
    timingKey: node.details?.timingKey ?? node.timingKey ?? null
  };
  return { ...allowed, ruleVersion: pack.version };
}

function partitionIdentity(partition) {
  if (!partition) return null;
  return {
    columns: partition.columns || null,
    pruningFilters: (partition.pruningFilters || []).map(scrubVolatileText)
  };
}

function normalizedPartition(node) {
  return partitionIdentity(node.partition);
}

export function nodeSemanticKey(node) {
  return {
    kind: node.kind,
    operator: node.operator,
    relation: node.relation || null,
    index: node.index || null,
    joinType: node.details?.joinType || null,
    partition: normalizedPartition(node),
    expressions: scrubExpressions(node.expressions)
  };
}

function ensureChildren(node) {
  const children = (node.children || []).map(normalizeNodeShape);
  return { ...normalizeNodeShape(node), children };
}

function normalizeNodeShape(node) {
  return {
    kind: node.kind,
    operator: node.operator,
    relation: node.relation || null,
    index: node.index || null,
    partition: partitionIdentity(node.partition),
    estimates: {
      rows: node.estimates?.rows ?? null,
      width: node.estimates?.width ?? null,
      cost: {
        startup: node.estimates?.cost?.startup ?? null,
        total: node.estimates?.cost?.total ?? null
      }
    },
    details: Object.fromEntries(Object.entries(node.details || {}).filter(([, value]) => value !== undefined && value !== null)),
    expressions: scrubExpressions(node.expressions),
    roles: node.roles || null,
    children: node.children || [],
    timingKey: node.timingKey || node.details?.timingKey || null
  };
}

function cloneTree(node) {
  return { ...ensureChildren(node), children: node.children.map(cloneTree) };
}

function assignNodeIds(node, pack, path = 'root') {
  const children = (node.children || []).map((child, index) => assignNodeIds(child, pack, `${path}.${index}`));
  const commutative = isLogicallyCommutative(node, pack);
  const orderedChildren = commutative ? children.map((child) => child.stableId).sort() : children.map((child) => child.stableId);
  const base = nodeSemanticKey({ ...node, children });
  const stableId = `n_${shortHash(canonicalHash({ path: 'stable', base, children: orderedChildren }))}`;
  const logicalChildFingerprints = commutative
    ? children.map((child) => child.logicalFingerprint).sort()
    : children.map((child) => child.logicalFingerprint);
  const physicalOrder = physicalOrderMatters(node);
  const physicalChildFingerprints = physicalOrder
    ? children.map((child, index) => ({ role: node.roles?.[index] || `${index}`, fingerprint: child.physicalFingerprint }))
    : logicalChildFingerprints;
  const logicalMaterial = {
    ...base,
    children: logicalChildFingerprints
  };
  const physicalMaterial = {
    ...base,
    roles: node.roles || null,
    children: physicalChildFingerprints,
    physical: true
  };
  return {
    ...node,
    path,
    children,
    stableId,
    commutative,
    physicalOrderMatters: physicalOrder,
    logicalFingerprint: `fp_${shortHash(canonicalHash(logicalMaterial))}`,
    physicalFingerprint: `fp_${shortHash(canonicalHash(physicalMaterial))}`
  };
}

export function normalizePlan(plan, ruleVersion = CURRENT_RULE_VERSION, diagnostics = []) {
  const pack = getRulePack(ruleVersion);
  const root = plan.root ? assignNodeIds(cloneTree(plan.root), pack) : null;
  const normalized = {
    modelVersion: IR_MODEL_VERSION,
    ruleVersion: pack.version,
    parserVersion: plan.parserVersion,
    sourceHash: plan.sourceHash,
    format: plan.format,
    queryFingerprint: plan.queryFingerprint,
    schema: plan.schema,
    statsVersion: plan.statsVersion,
    parameters: plan.parameters,
    environment: plan.environment,
    root,
    samples: plan.samples || [],
    diagnostics
  };
  normalized.normalizedHash = canonicalHash({
    modelVersion: normalized.modelVersion,
    ruleVersion: normalized.ruleVersion,
    parserVersion: normalized.parserVersion,
    sourceHash: normalized.sourceHash,
    queryFingerprint: normalized.queryFingerprint,
    schema: normalized.schema,
    statsVersion: normalized.statsVersion,
    parameters: normalized.parameters,
    environment: normalized.environment,
    root: normalized.root
  });
  normalized.logicalFingerprint = root?.logicalFingerprint || 'fp_missing_root';
  normalized.physicalFingerprint = root?.physicalFingerprint || 'fp_missing_root';
  return normalized;
}

export function collectNodes(node, result = []) {
  if (!node) return result;
  result.push(node);
  for (const child of node.children || []) collectNodes(child, result);
  return result;
}

export function findNode(node, stableId) {
  if (!node) return null;
  if (node.stableId === stableId) return node;
  for (const child of node.children || []) {
    const found = findNode(child, stableId);
    if (found) return found;
  }
  return null;
}
