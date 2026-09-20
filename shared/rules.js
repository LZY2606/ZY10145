export const CURRENT_RULE_VERSION = '2026-09-21.v1';

export const RULE_PACKS = {
  '2026-09-21.v1': {
    version: '2026-09-21.v1',
    publishedAt: '2026-09-21',
    summary: '首版保真规范化规则。',
    commutativeRules: [
      {
        id: 'C-JOIN-001',
        applies: 'INNER 与 CROSS join',
        semantic: '逻辑结果不依赖输入顺序。',
        physical: 'Hash/Broadcast/Shuffled Hash 的 build/probe 方向仍保留并参与物理指纹。'
      }
    ],
    nonCommutativeRules: [
      {
        id: 'P-ROLE-001',
        applies: '带 outer/inner、build/probe 标签的物理 join',
        semantic: '交换子节点但 build/probe 或 outer/inner 方向改变时，不视为物理计划等价。'
      }
    ],
    unionChildrenCommutative: false
  },
  '2026-09-22.v2': {
    version: '2026-09-22.v2',
    publishedAt: '2026-09-22',
    summary: '在 v1 基础上增加无全局排序 UNION ALL 的语义交换规则。',
    commutativeRules: [
      {
        id: 'C-JOIN-001',
        applies: 'INNER 与 CROSS join',
        semantic: '逻辑结果不依赖输入顺序。',
        physical: 'Hash/Broadcast/Shuffled Hash 的 build/probe 方向仍保留并参与物理指纹。'
      },
      {
        id: 'C-UNION-002',
        applies: '无全局 ORDER BY/LIMIT 的 UNION ALL',
        semantic: 'bag union 的输入顺序不改变多行集合结果。'
      }
    ],
    nonCommutativeRules: [
      {
        id: 'P-ROLE-001',
        applies: '带 outer/inner、build/probe 标签的物理 join',
        semantic: '交换子节点但 build/probe 或 outer/inner 方向改变时，不视为物理计划等价。'
      }
    ],
    unionChildrenCommutative: true
  }
};

const PHYSICAL_ORDER_OPERATORS = new Set([
  'Hash Join',
  'Nested Loop',
  'Merge Join',
  'BroadcastHashJoin',
  'ShuffledHashJoin',
  'SortMergeJoin'
]);

const LOGICALLY_COMMUTATIVE_JOINS = new Set(['inner', 'cross']);

export function getRulePack(version = CURRENT_RULE_VERSION) {
  const pack = RULE_PACKS[version];
  if (!pack) {
    throw new Error(`Unknown normalization rule version: ${version}`);
  }
  return pack;
}

export function isLogicallyCommutative(node, pack = getRulePack()) {
  if (node.kind === 'join') {
    return LOGICALLY_COMMUTATIVE_JOINS.has(String(node.details?.joinType || '').toLowerCase());
  }
  if (node.kind === 'union') {
    return Boolean(pack.unionChildrenCommutative) && !node.details?.orderedOutput;
  }
  return false;
}

export function physicalOrderMatters(node) {
  return PHYSICAL_ORDER_OPERATORS.has(node.operator);
}

export const INCOMPATIBLE_PARAMETERS = [
  'work_mem',
  'shared_buffers',
  'effective_cache_size',
  'enable_indexscan',
  'enable_seqscan',
  'enable_hashjoin',
  'enable_nestloop',
  'parallel_setup_cost',
  'parallel_tuple_cost',
  'cursor_tuple_fraction',
  'spark.sql.shuffle.partitions',
  'spark.sql.autoBroadcastJoinThreshold',
  'spark.sql.adaptive.enabled'
];

export const VOLATILE_PARAMETER_PATTERNS = [
  /(^|_)pid$/,
  /(^|_)time(stamp)?$/,
  /(^|_)id$/,
  /transaction/,
  /session/,
  /client_/,
  /application_name/
];

export function isVolatileParameter(name) {
  return VOLATILE_PARAMETER_PATTERNS.some((pattern) => pattern.test(name));
}
