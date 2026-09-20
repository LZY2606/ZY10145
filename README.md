# Plan Diff — 离线 SQL 执行计划保真对比

这是一个完全离线的 SQL 执行计划导入、规范化和差异审阅应用。系统不连接数据库，也不执行真实 SQL；所有自动化验证均使用仓库内 `fixtures/`。

## 快速开始

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev -- --host 127.0.0.1 --port 5345 --strictPort
```

打开：<http://127.0.0.1:5345>

生产构建和 Node 服务预览：

```bash
corepack pnpm build
corepack pnpm preview
```

SQLite 默认写入 `.data/plans.sqlite`，可用 `PLAN_DIFF_DB=/path/to/db.sqlite` 覆盖。

## 自带 fixture

- `fixtures/postgres-*.json`：PostgreSQL `EXPLAIN (FORMAT JSON)` 风格计划，覆盖 inner hash join 子节点交换、索引、估算漂移、多次耗时和缺估数。
- `fixtures/spark-*.json`：Spark 物理计划 JSON，覆盖 broadcast hash join 到 sort-merge/shuffle 决策、分区裁剪、参数变化和超时样本。
- `fixtures/postgres-union-*.json`：用于演示规则从 `2026-09-21.v1` 到 `2026-09-22.v2` 的升级影响预览。

## 保真中间模型 IR `ir-1.0`

原始 JSON 经厂商解析器白名单映射为中间模型，不直接对原计划做全局排序或改写：

- 根节点与子节点：保留原始子节点顺序、join 顺序、算子、父子物理角色。
- 估算信息：`rows`、`width`、`cost.startup`、`cost.total`；缺失值保留为 `null` 并产生诊断。
- 物理决策：索引名/访问路径、分区列、分区裁剪 filter、join 类型、build/probe 或 outer/inner 角色。
- 表达式：仅保留 filter、join condition、sort key、output columns 等解释计划所需字段。
- 易变值：导入 UUID、绝对时间、进程/query/app ID、Spark `#123L`/`expr_id=123` 等不会进入稳定指纹。
- 样本：保留每次 `ordinal`、`durationMs`、`timeout` 和节点级耗时；不使用单次比值宣布回归。
- 决议隔离：基线发布、候选保留、冻结和批注只写 SQLite 关系表，不覆盖 raw plan 或 normalized plan。

每个节点有：

- `stableId`：语义节点身份。输入稳定、语义键和可交换子节点集合一致时稳定。
- `logicalFingerprint`：逻辑结果指纹，只在规则声明为可交换的节点排序子指纹。
- `physicalFingerprint`：物理计划指纹，保留 build/probe、outer/inner 等角色和原始方向。

数组顺序**不会被全局排序**。排序只发生在明确版本化规则允许的局部节点。

## 可交换规则版本

### `2026-09-21.v1`（当前默认）

- `C-JOIN-001`：INNER/CROSS join 的逻辑结果不依赖输入顺序，逻辑指纹可归一。
- `P-ROLE-001`：Hash Join、Nested Loop、Merge Join、Broadcast/Shuffled Hash Join 的 `outer/inner`、`build/probe` 角色参与物理指纹；子节点交换导致角色反向时，逻辑可能等价但物理不等价。
- Append/UNION ALL 子节点按有序输入处理，v1 不做交换归一。

### `2026-09-22.v2`（升级预览）

- 继承 v1。
- `C-UNION-002`：无全局 `ORDER BY/LIMIT` 的 UNION ALL 在 bag union 语义下可交换。

界面和 API 都先生成“哪些旧计划/旧对比会变化”的预览，不会自动重算。用户确认后才对所选计划按新版本重新规范化；历史比较结果仍保留，可重新生成新比较。

## 三类差异

比较结果显式分开：

1. **结构变化**：算子替换、节点增删、索引决策、分区决策、子节点顺序、物理 build/probe 方向。
2. **估算漂移**：节点 rows、width、startup/total cost 的相对变化，默认超过 20% 标记。
3. **实测耗时**：计划总耗时和稳定节点 timing key 的多次样本中位数。

并排树用稳定 `stableId` 对齐；当节点身份变化但算子/关系粗粒度相同，会标记为“语义配对但稳定指纹不同”，避免把整棵子树误判为完全新增。

## 稳健统计口径

默认配置在 `shared/stats.js`：

- `minSamples: 3`
- `medianRatioThreshold: 1.15`
- `effectThreshold: 0.474`（Cliff's delta）
- `timeoutRateDeltaThreshold: 0.05`

判定：

- 样本不足：`INSUFFICIENT_SAMPLES`，结果只能是 `INCONCLUSIVE`。
- 完全无样本：`SAMPLES_MISSING`。
- 任一侧有超时：附加 `TIMEOUT_PRESENT`，超时率变化可独立构成回归或改善。
- 回归需要重复样本支持的中位数变化和 Cliff's delta，不允许单次耗时比值。
- 输出中位数、Q1/Q3、IQR、MAD、超时率、中位数比值和效应量。

阈值可在创建比较时通过 `statsConfig` 覆盖。

## 独立不可比/异常状态

这些状态相互独立，不合并成单一失败：

- `SAMPLES_MISSING`：缺少一次或多次样本。
- `INSUFFICIENT_SAMPLES`：完成样本数量低于配置阈值。
- `TIMEOUT_PRESENT`：样本中存在超时。
- `PLAN_NODE_FIELDS_MISSING`：计划节点缺少算子或估算 rows 等必填字段。
- `PARAMETER_ENVIRONMENT_NOT_COMPARABLE`：厂商不同，或 `work_mem`、AQE、broadcast 阈值、parallel cost 等性能相关参数不同。
- `QUERY_FINGERPRINT_MISMATCH`：查询指纹不同。
- `SCHEMA_DRIFT`：schema digest 不同；默认作为醒目状态而非直接丢弃比较。
- `STATS_VERSION_CHANGED`：统计信息版本不同；仍可比较估算漂移，但状态明确展示。
- `PLAN_ROOT_MISSING`：无法得到根节点。

查询指纹、schema 摘要、统计版本、运行参数和多次耗时都随计划保存；volatile session/app/pid 参数由解析器过滤。

## 存储和事务

使用 Node.js 内置 `node:sqlite`：

- `raw_plans`：原始导入内容，主键为内容 SHA-256，重复导入幂等。
- `normalized_plans`：IR、规则版本、解析器版本、规范化哈希和节点诊断。
- `baselines`：按查询指纹递增 revision；冻结基线后发布会返回 409，必须显式解冻。
- `candidates`：支持保留多个候选。
- `comparisons`：基线哈希、候选哈希、规则版本、统计配置和结果 JSON 的组合唯一。
- `annotations`：`(comparison_id,node_id)` 唯一，带 `version` 乐观锁。

批量导入先全部解析再写库；批量规范化在单个 `BEGIN IMMEDIATE` 事务中执行，任一源缺失则整体回滚，不留部分成功。批注并发冲突返回节点 ID、期望版本、当前版本和当前内容。

## API 摘要

- `POST /api/imports`
- `POST /api/normalizations`
- `GET /api/plans`
- `POST /api/baselines`、`POST /api/baselines/:id/freeze`、`/unfreeze`
- `POST /api/candidates/retain`
- `POST /api/comparisons`、`GET /api/comparisons/:id`
- `GET/POST /api/comparisons/:id/annotations`
- `POST /api/rule-upgrades/preview`
- `POST /api/rule-upgrades/apply`

## 项目结构

- `shared/model.js`：IR 数据模型。
- `shared/parsers/`：PostgreSQL 与 Spark 适配器。
- `shared/normalize.js`：稳定身份、局部可交换归一、逻辑/物理指纹。
- `shared/compare.js`：树对齐、结构/估算/耗时分类、不可比状态。
- `shared/stats.js`：稳健统计。
- `server/`：SQLite、事务服务和离线 HTTP API。
- `src/`：Vite + React 树形差异界面。
- `test/`：仅使用仓库 fixture 的 Vitest 测试。
