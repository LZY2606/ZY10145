import type { PlanNode, RuleDescriptor } from './model.ts';

export const CURRENT_RULE_VERSION = '2026.09.22-v2';
export const INITIAL_RULE_VERSION = '2026.09.21-v1';

export const RULES: RuleDescriptor[] = [
  {
    version: INITIAL_RULE_VERSION,
    releasedAt: '2026-09-21',
    description: 'First versioned plan normalization contract.',
    rules: [
      { id: 'VOLATILE-1', description: 'Remove source node IDs, absolute timestamps, transient counters, and execution-only IDs.' },
      { id: 'LEAF-1', description: 'Stabilize relation, alias, index, scan direction, filter, and partition decisions.' },
      { id: 'JOIN-DIR-1', description: 'Retain explicit outer/inner and build/probe roles instead of globally sorting join children.' },
      { id: 'COMM-HASH-1', description: 'Hash joins are not treated as commutative because a build/probe swap changes physical execution.' },
      { id: 'COMM-MERGE-1', description: 'Inner merge joins require ordered inputs, so child order is retained.' },
      { id: 'COMM-NL-1', description: 'Nested-loop child order is retained, including for equality inner joins.' },
      { id: 'COMM-UNION-1', description: 'UNION ALL branches are commutative when each branch has a distinct stable branch digest.' },
      { id: 'PART-1', description: 'Keep selected and pruned partition identifiers as a decision, not as runtime partition scans.' },
      { id: 'EST-1', description: 'Keep estimated rows and cost separate from measured execution samples.' }
    ]
  },
  {
    version: CURRENT_RULE_VERSION,
    releasedAt: '2026-09-22',
    description: 'Adds a narrowly scoped commutative rule for order-insensitive equality nested-loop joins.',
    rules: [
      { id: 'COMM-NL-2', description: 'An inner nested-loop join with an equality predicate is commutative only when it has no ordered/scan-direction dependency; outer, semi, anti, hash, and merge joins remain non-commutative.' }
    ]
  }
];

export function ruleDescriptor(version: string): RuleDescriptor {
  const found = RULES.find((rule) => rule.version === version);
  if (!found) throw new Error(`Unknown normalization rule version: ${version}`);
  return found;
}

export function isCommutative(node: Pick<PlanNode, 'operator' | 'joinKind' | 'equiJoin' | 'joinDirection' | 'scanDirection' | 'children'>, ruleVersion: string): boolean {
  if (node.operator === 'union_all') {
    return node.children.every((child) => child.node.projectionDigest !== null);
  }
  if (node.operator !== 'nested_loop' && node.operator !== 'nested_loop_join') return false;
  if (node.joinKind !== 'inner' || !node.equiJoin) return false;
  if (node.joinDirection !== 'outer_inner') return false;
  if (node.scanDirection !== null) return false;
  if (node.children.some((child) => child.node.scanDirection !== null || child.node.operator === 'sort')) return false;
  return ruleVersion === CURRENT_RULE_VERSION;
}

export function laterRuleVersion(a: string, b: string): boolean {
  return RULES.findIndex((rule) => rule.version === a) < RULES.findIndex((rule) => rule.version === b);
}
