# Pair-wise SQL Plan Diff

离线 SQL 执行计划保真转换、树形差异审查与稳健性能判定应用。应用只解析仓库内 JSON fixture 或用户导入的计划 JSON，不连接数据库，也不执行真实 SQL。

## 快速开始

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run && corepack pnpm dev -- --host 127.0.0.1 --port 5345 --strictPort
```

打开：<http://127.0.0.1:5345>

首次启动 Vite 服务时会把 `test/fixtures/*.json` 幂等导入到 `data/demo.sqlite`，并创建演示对比。删除 `data/` 可恢复初始演示状态。

## 能力边界

- 支持两种自带格式：PostgreSQL EXPLAIN JSON envelope（`postgresql`）和 MySQL JSON 风格 envelope（`mysql`）。
- 原始计划完整存入 SQLite；规范化、差异、批注和基线决议都不会改写原始 JSON。
- 过滤每次运行会改变的值：源节点编号、执行器实例 ID、绝对采集/开始时间、actual rows/loops、实际耗时、buffer/I/O 等运行计数器。
- 保留并显式建模：join 顺序、算子、join 类型与方向、估算行数和成本、索引、访问/过滤表达式摘要、投影摘要、分区选择/裁剪决策、并行度和优化器 hint。
- 结构变化、估算漂移、实测时间变化分开呈现；索引和分区决策单独成类。
- 性能判定必须有多组完成样本；单次耗时或单比值不会产生回归结论。
- 缺样本、超时、计划节点缺字段、参数/查询/schema/规则版本不可比均为独立状态。

## 中间模型

模型版本固定为 `plan-v1`，定义见 `shared/model.ts`。核心节点字段：

- `operator` / `relation` / `alias`：物理算子和关系身份。
- `children[].role`：`outer`、`inner`、`build`、`probe`、`left`、`right` 等方向。
- `joinKind` / `joinDirection` / `joinConditionDigest` / `equiJoin`：join 语义和 build/probe 或 outer/inner 方向。
- `index` / `indexColumns` / `scanDirection`：索引和顺序扫描决策。
- `filterDigest` / `projectionDigest`：表达式稳定摘要；不直接依赖源节点 ID 或绝对时间。
- `partitions.selected` / `partitions.pruned` / `partitions.strategy`：分区决策。
- `estimatedRows` / `estimatedCost`：估算值，独立于实测样本。
- `warnings`：缺失字段、不支持形态和被过滤的易变字段，不作为静默成功处理。

规范化入口在 `server/lib/normalizer.ts`，厂商适配器在 `server/adapters/postgresql.ts` 和 `server/adapters/mysql.ts`。

### 稳定指纹

每个计划生成三个指纹：

- `physicalFingerprint`：保留原始角色和子节点位置，用于发现真实物理树改变。
- `semanticFingerprint`：仅在当前规则版本声明为可交换的局部节点中归一子输入，用于识别语义等价重排。
- `shapeFingerprint`：只描述算子/关系/join 形态，辅助 UI 和审查。

数组顺序不会被全局排序。规范化只在符合版本规则的单个可交换节点内重排其直接子输入；非交换 join、算子层级和其他数组顺序保持原样。

## 可交换规则及版本

规则注册表见 `shared/rules.ts`。

### `2026.09.21-v1`

- `VOLATILE-1`：移除源节点 ID、绝对时间、瞬态计数器和执行实例 ID。
- `JOIN-DIR-1`：显式保留 outer/inner 与 build/probe 角色，不全局排序 join 子节点。
- `COMM-HASH-1`：hash join 不可交换；交换 build/probe 会改变物理执行。
- `COMM-MERGE-1`：inner merge join 需要有序输入，保留子顺序。
- `COMM-NL-1`：nested-loop 的 child order 在 v1 保留，等值 inner join 也不自动归一。
- `COMM-UNION-1`：分支投影稳定的 `UNION ALL` 可交换。
- `PART-1` / `EST-1`：分区决策保留；估算值与实测样本分离。

### `2026.09.22-v2`（当前）

- `COMM-NL-2`：当 normalized operator 为 `nested_loop` 或 `nested_loop_join`、`joinKind=inner`、等值谓词为 true、方向为 outer/inner、节点和直接子节点均无顺序/扫描方向依赖时，该节点可交换。
- outer、right/full、semi、anti、hash、merge join 仍不可交换。
- 即使被识别为可交换，页面也保留物理树原顺序，并把该节点标成 `equivalent_reorder`，不会把它伪装成完全无变化。

规则升级通过“先生成影响预览，再由用户确认重算”执行。预览只在内存重算候选结果；确认后旧对比置为 inactive 并记录 superseded 关系，不删除旧结果。

## 差异口径

差异算法在 `server/lib/diff.ts`：

- `structure_changed`：join 类型、方向、算子层级或非交换子输入变化。
- `equivalent_reorder`：物理位置交换，但当前版本规则认为语义输入集合等价。
- `estimate_drift`：估算行数或成本相对漂移达到阈值。
- `index_changed`：索引名、索引列或扫描方向变化。
- `partition_changed`：分区选择、裁剪或策略变化。
- `added` / `removed`：只存在于一侧的节点。

节点对齐优先使用稳定语义子树和当前节点局部键；不会对整棵树做全局排序。

## 统计口径

默认选项在 `server/lib/statistics.ts`：

- 最少完成且有耗时样本：每侧 5 个。
- 稳健统计：中位数、MAD、默认 15% trimmed mean、最小值/最大值。
- 回归/改进：确定性可复现 pseudo-bootstrap 95% 置信区间（默认 999 次重采样）。
- 默认回归：候选/基线中位时间比值的置信下界大于 1.20。
- 默认改进：置信上界小于 0.80。
- 置信区间跨阈值：`indeterminate`，不宣布回归或改进。
- 单次异常值不足以造成回归；样本不足、超时或字段缺失直接返回独立状态。

状态优先级：`incomparable_environment` → `timeout` → `insufficient_samples` → `missing_fields` → `comparable`。

## 不可比条件

以下任一项不同即不进行性能胜负判定：

- 查询指纹 `queryFingerprint` 不同。
- schema 摘要摘要值 `schemaDigest` 不同。
- 规范化规则版本不同。
- 影响计划环境的运行参数对象不同（以稳定 JSON digest 比较）。

`statsVersion` 被单独保留和展示，因为统计信息版本本来就是估算漂移解释的一部分；它不自动阻断比较。计划节点缺少估算字段或节点解析 warning 会返回 `missing_fields`。

## 存储和事务

SQLite 通过 Node.js 内置 `node:sqlite` 访问，不需要原生编译依赖。表结构在 `server/db/repository.ts`。

- 导入以原始内容 SHA-256 生成 plan ID；相同内容重复导入返回 existing。
- 批量导入在一个事务内完成；任一 payload 或 batch 内重复 hash 会整体回滚。
- 批量规范化在一个事务内完成；未知 plan 会导致整批无写入。
- 单条和批量基线发布都在事务内完成；批量中任一计划不存在或命中冻结基线会整体回滚，冻结基线不能被候选覆盖。
- 规则重算保留旧对比，创建新对比并在同一事务中切换 active 状态。
- 批注使用乐观版本号；冲突返回 409，并携带该计划节点级 diff、已存版本和内容。

## HTTP API

- `GET /api/state`：计划、active 对比、基线和规则版本。
- `POST /api/plans/import`：payload、`{plans:[]}` 或数组批量导入。
- `POST /api/plans/normalize`：按规则版本规范化已有计划。
- `GET /api/plans/:id?ruleVersion=...`：原始计划、规范化模型和样本。
- `POST /api/compare`：生成并持久化对比。
- `POST /api/baselines/publish` / `POST /api/baselines/publish-batch` / `POST /api/baselines/freeze`：发布、事务性批量发布或冻结基线。
- `POST /api/annotations`：保存节点决议，支持 `expectedVersion`。
- `POST /api/rules/upgrade-preview`：只返回受影响旧对比。
- `POST /api/rules/upgrade`：用户确认后事务性重算。

## Fixture

`test/fixtures` 自带六份 JSON：

- `pg-baseline.json`：PostgreSQL nested-loop 基线，含分区裁剪和 actual volatile fields。
- `pg-equiv-reorder.json`：等值 inner nested-loop 子输入交换，v1 不等价、v2 识别为等价重排。
- `pg-hash-swap.json`：hash join/build-probe 形态与耗时回归样本。
- `pg-index-drift.json`：索引、估算和分区变化审查。
- `mysql-baseline.json`：MySQL nested-loop、主键访问和易变 executor ID。
- `mysql-candidate.json`：MySQL hash join 候选。

## 开发脚本

```bash
corepack pnpm test -- --run      # 行为测试
corepack pnpm build              # TypeScript 和 Vite 生产构建
corepack pnpm dev -- --host 127.0.0.1 --port 5345 --strictPort
```

环境变量 `PLAN_DIFF_DB=/path/to/app.sqlite` 可覆盖演示数据库路径。
