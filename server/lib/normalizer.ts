import { contentHash, shortHash } from '../../shared/hash.ts';
import type {
  NormalizedPlan,
  PlanChild,
  PlanNode,
  PlanWarning,
  VendorName
} from '../../shared/model.ts';
import { isCommutative } from '../../shared/rules.ts';

type FingerprintedNode = PlanNode & {
  physicalNodeFingerprint: string;
  semanticNodeFingerprint: string;
  shapeNodeFingerprint: string;
};

const VOLATILE_LOCAL_KEYS = new Set([
  'nodeId',
  'path',
  'estimatedRows',
  'estimatedCost',
  'warnings',
  'parallelism',
  'physicalNodeFingerprint',
  'semanticNodeFingerprint',
  'shapeNodeFingerprint'
]);

const PHYSICAL_DECISION_KEYS = new Set(['index', 'indexColumns', 'scanDirection', 'partitions', 'hints']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function stableDigest(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return shortHash(value);
}

export function missingField(path: string, field: string, message: string): PlanWarning {
  return { code: 'missing_field', path, field, message };
}

export function ignoredVolatile(path: string, field: string, message: string): PlanWarning {
  return { code: 'ignored_volatile_field', path, field, message };
}

export function unsupportedShape(path: string, message: string): PlanWarning {
  return { code: 'unsupported_shape', path, field: 'node', message };
}

export function expressionDigest(expression: unknown): string | null {
  return stableDigest(expression);
}

function localIdentity(node: PlanNode): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !VOLATILE_LOCAL_KEYS.has(key) && key !== 'children'));
}

function semanticLocalIdentity(node: PlanNode): Record<string, unknown> {
  return Object.fromEntries(Object.entries(localIdentity(node)).filter(([key]) => !PHYSICAL_DECISION_KEYS.has(key)));
}

function assignIdentity(node: PlanNode, parentPath: string, siblingIndex: number, localCounts: Map<string, number>): void {
  const local = shortHash(localIdentity(node));
  const occurrence = localCounts.get(local) ?? 0;
  localCounts.set(local, occurrence + 1);
  node.path = parentPath === '' ? 'ROOT' : `${parentPath}/C${siblingIndex}`;
  node.nodeId = `${node.path}:${local}:${occurrence}`;
  const childCounts = new Map<string, number>();
  node.children.forEach((child, index) => assignIdentity(child.node, node.path, index, childCounts));
}

function fingerprintNode(node: PlanNode, ruleVersion: string): FingerprintedNode {
  const children = node.children.map((child) => ({ role: child.role, node: fingerprintNode(child.node, ruleVersion) }));
  const copied = { ...node, children } as unknown as FingerprintedNode;
  const commutative = isCommutative(copied, ruleVersion);
  const childDigests = children.map((child) => ({
    role: child.role,
    physical: child.node.physicalNodeFingerprint,
    semantic: child.node.semanticNodeFingerprint,
    shape: child.node.shapeNodeFingerprint
  }));
  const semanticChildren = commutative
    ? [...childDigests]
        .map((child) => ({ ...child, role: 'commutative_input' as const }))
        .sort((a, b) => a.semantic.localeCompare(b.semantic))
    : childDigests;
  const shapeLocal = {
    operator: node.operator,
    relation: node.relation,
    alias: node.alias,
    joinKind: node.joinKind,
    joinDirection: node.joinDirection,
    commutative
  };
  const physicalNodeFingerprint = shortHash({ local: localIdentity(copied), children: childDigests });
  const semanticNodeFingerprint = shortHash({ local: semanticLocalIdentity(copied), children: semanticChildren, ruleVersion });
  const shapeNodeFingerprint = shortHash({ local: shapeLocal, children: semanticChildren.map((child) => child.shape) });
  Object.assign(copied, { physicalNodeFingerprint, semanticNodeFingerprint, shapeNodeFingerprint });
  return copied;
}

function stripHelperFingerprints(node: FingerprintedNode): PlanNode {
  const plain: PlanNode = {
    nodeId: node.nodeId,
    path: node.path,
    operator: node.operator,
    relation: node.relation,
    alias: node.alias,
    index: node.index,
    indexColumns: node.indexColumns,
    scanDirection: node.scanDirection,
    joinKind: node.joinKind,
    joinConditionDigest: node.joinConditionDigest,
    equiJoin: node.equiJoin,
    joinDirection: node.joinDirection,
    filterDigest: node.filterDigest,
    projectionDigest: node.projectionDigest,
    children: node.children.map((child: PlanChild) => ({ role: child.role, node: stripHelperFingerprints(child.node as FingerprintedNode) })),
    estimatedRows: node.estimatedRows,
    estimatedCost: node.estimatedCost,
    partitions: node.partitions,
    parallelism: node.parallelism,
    hints: node.hints,
    properties: node.properties,
    warnings: node.warnings
  };
  return plain;
}

export interface NormalizeInput {
  vendor: VendorName;
  ruleVersion: string;
  queryFingerprint: string;
  schemaDigest: string;
  schemaSummary: Record<string, unknown>;
  statsVersion: string;
  parameters: Record<string, unknown>;
  root: PlanNode;
  warnings: PlanWarning[];
}

export function normalizePlan(input: NormalizeInput): NormalizedPlan {
  const root = clone(input.root);
  assignIdentity(root, '', 0, new Map());
  const fingerprinted = fingerprintNode(root, input.ruleVersion);
  const normalized: NormalizedPlan = {
    modelSchemaVersion: 'plan-v1',
    ruleVersion: input.ruleVersion,
    vendor: input.vendor,
    queryFingerprint: input.queryFingerprint,
    schemaDigest: input.schemaDigest,
    schemaSummary: input.schemaSummary,
    statsVersion: input.statsVersion,
    parameters: input.parameters,
    root: stripHelperFingerprints(fingerprinted),
    warnings: clone(input.warnings),
    physicalFingerprint: '',
    semanticFingerprint: '',
    shapeFingerprint: ''
  };
  normalized.physicalFingerprint = contentHash({ fingerprint: fingerprinted.physicalNodeFingerprint, ruleVersion: input.ruleVersion }).slice(0, 16);
  normalized.semanticFingerprint = contentHash({ fingerprint: fingerprinted.semanticNodeFingerprint, ruleVersion: input.ruleVersion }).slice(0, 16);
  normalized.shapeFingerprint = contentHash({ fingerprint: fingerprinted.shapeNodeFingerprint, ruleVersion: input.ruleVersion }).slice(0, 16);
  return normalized;
}

export function walkPlan(node: PlanNode, visitor: (node: PlanNode, parent: PlanNode | null) => void, parent: PlanNode | null = null): void {
  visitor(node, parent);
  node.children.forEach((child) => walkPlan(child.node, visitor, node));
}
