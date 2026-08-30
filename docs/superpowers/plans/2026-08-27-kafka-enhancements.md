# Kafka 功能增强路线图 · 实施计划

> **给执行代理：** 实现本计划时需使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务执行。每批开始前把该批展开为「小步 TDD 任务清单」（先写失败测试 → 实现 → 转绿 → 按 AGENTS.md 打包验证 → 用户确认 → 提交推送）。

**Goal:** 在现有 Kafka 多源管理客户端上，补齐监控、数据效率、体验与高级运维四类共 18 项功能，全部按 TDD 落地并逐步发布。

**Architecture:** 纯看数据的监控/导出类功能尽量复用现有 `ListConsumerGroups` 返回的 lag 数据在前端聚合（减少后端往返）；涉及元数据（topic config、broker、组成员）与写操作（批量 produce、改 config）的新能力在 `backend/internal/kafka`（franz-go/kadm）加方法，经 `service` → `app.go` 暴露，前端 `client.ts`/`types.ts` 增加绑定方法并 `wails generate module` 重新生成。所有功能挂在已有「数据源抽象」上（`ConnectionTree.ObjectCollection`、`TYPE_META`、连接 store），确保 MySQL/ES 后续可复用。

**Tech Stack:** Go + franz-go/kadm（kfake 测试）、Wails v2、Vue 3（`<script setup lang="ts">` + Pinia + Vitest）。

---

## 分批发版策略

每批都是独立可交付的完整软件（各自跑通测试→打包→确认→提交推送），避免一次性大改动难以验收。批次按「价值/成本」排序：

| 批次 | 主题 | 功能 | 后端新增 | 依赖 |
|---|---|---|---|---|
| B1 | P0 监控 | 全局 Lag 总览、Topic 详情、集群健康、时间范围过滤 | DescribeTopic、DescribeCluster | 无 |
| B2 | P0 数据效率 | JSON 格式化、导出、offset/时间戳跳转、SQL 历史 | 无（批量导出可选） | 无 |
| B3 | P1 体验 | 生产批量增强、组成员拓扑+趋势+自动刷新+reset dry-run、批量删除、命令面板 ⌘K、标签页增强 | DescribeGroup、ProduceMessages、DeleteTopics | B1 |
| B4 | P2 高级 | Topic config 编辑、导入回放、快捷键、审计日志、状态栏 | AlterTopicConfig、审计存储 | B1/B2 |

**每批工作流（遵循 AGENTS.md）**：测试+构建验证 → `wails build` → 关旧程序 → 装 `/Applications` → 启动 → 清残留 → **等用户确认** → Conventional Commit + push。

---

## 批次 B1 · P0 监控（4 项）

### 任务 1.1 全局 Lag 总览

**Files**
- Create: `frontend/src/components/kafka/GlobalLagView.vue`、`frontend/src/components/kafka/GlobalLagView.spec.ts`
- Modify: `frontend/src/components/layout/Layout.vue`（加入口 Tab/按钮）、`frontend/src/store/tabs.ts`（`kind='lag'`）、`frontend/src/components/common/ConnectionTree.vue`

**设计**：复用现有 `ListConsumerGroups` 返回的 `Topics: Record<topic, PartitionLag[]>`，在前端聚合成一张「group × topic → 总 Lag」表，按 Lag 降序，支持 group/topic 模糊搜索与阈值染色（>1000 红、>100 橙）。无需新后端 API。
**TDD**：先写聚合工具 `frontend/src/utils/lag.ts`（`sumLag(partitions)`、`flattenGroupLag(groups)`）+ 单测；再写 `GlobalLagView.spec.ts` 验证渲染/排序/搜索/染色。
**验收**：展开连接后能看到「Lag 总览」入口；表格按积压排序；搜索与阈值染色生效。

### 任务 1.2 Topic 详情（分区拓扑 + config）

**Files**
- Create: `backend/internal/kafka/admin.go`（`DescribeTopic`）、`backend/internal/model/topic_detail.go`、`backend/internal/kafka/kafka_test.go`（kfake 用例）、`backend/app.go`、`frontend/src/api/types.ts`、`frontend/src/api/client.ts`、`frontend/src/components/kafka/TopicDetailDrawer.vue`(+spec)
- Modify: `backend/internal/service/interface.go`、`service.go`、`frontend/src/components/common/ConnectionTree.vue`（topic 行加详情按钮）

**设计**：`DescribeTopic(ctx, id, name)` → `kadm.DescribeTopicConfigs` + `kadm.ListTopicDetails`，返回分区 Leader/Replica/ISR 拓扑 + 关键 config（retention.ms、cleanup.policy、segment.bytes 等白名单）。
**TDD**：后端 kfake 先建 topic 再断言 detail 字段；前端抽屉渲染拓扑与 config。
**验收**：点击 topic 行「ℹ」打开抽屉，展示分区拓扑与 config；暗色/亮色主题适配。

### 任务 1.3 集群健康（Broker / 版本 / under-replicated）

**Files**
- Create: `backend/internal/kafka/admin.go`（`DescribeCluster`）、`backend/internal/model/cluster_health.go`、kfake 用例、`backend/app.go`、`frontend/src/api/*`、`frontend/src/components/kafka/ClusterHealthPanel.vue`(+spec)
- Modify: `backend/internal/service/interface.go`、`service.go`、`frontend/src/components/settings/SettingsPanel.vue` 或连接行入口

**设计**：`DescribeCluster(ctx, id)` → `kadm.DescribeCluster`，返回 broker 列表（id/host/rack）、controller、Kafka 版本、在线状态。前端以卡片列表展示，异常 broker 红色。
**TDD**：kfake 断言 broker 数/controller；前端面板渲染与空态。
**验收**：能看到 broker 拓扑与版本；无 broker 时给友好提示。

### 任务 1.4 消息时间范围过滤

**Files**
- Modify: `frontend/src/components/kafka/MessageBrowser.vue`(+spec)、`frontend/src/store/browse.ts`(+spec)

**设计**：过滤条加「起始时间 / 结束时间」两个 datetime-local 输入；为空则走现有 offset 查询，填了起始则用现有 `consumeMessagesByTimestamp`（后端已支持）。
**TDD**：browse store 增加 `queryByTime` 分支用例；组件测试输入时间后触发对应 API。
**验收**：填时间可查到该时刻后消息；清空恢复原查询。

---

## 批次 B2 · P0 数据效率（4 项）

### 任务 2.1 消息 JSON 格式化 / 语法高亮

**Files**
- Create: `frontend/src/utils/jsonview.ts`(+spec)、`frontend/src/components/kafka/MessageDetailDrawer.vue`(+spec 更新)

**设计**：详情抽屉对 key/value 尝试 JSON.parse；成功则缩进格式化 + 轻量高亮（字符串/数字/布尔/键不同色），失败保留原文；提供「原始/格式化」切换。
**TDD**：`jsonview.ts` 纯函数单测（合法 JSON、非法、嵌套）；抽屉渲染高亮片段。
**验收**：中文/中文 JSON 不乱码（沿用现有 UTF-8 直传），长 value 可展开。

### 任务 2.2 导出 CSV / JSONL

**Files**
- Create: `frontend/src/utils/export.ts`(+spec)
- Modify: `frontend/src/components/kafka/MessageBrowser.vue`(+spec)、`frontend/src/components/kafka/SqlConsole.vue`(+spec)

**设计**：`exportCsv(rows, cols)`、`exportJsonl(rows)` 生成字符串并 `Blob` 下载（Wails 内可用 `a[download]`）。消息列表与 SQL 结果各加「导出」按钮（CSV/JSONL 下拉）。
**TDD**：export utils 单测（表头转义、空数据、JSON 行）；组件按钮点击产生下载。
**验收**：导出的 CSV/JSONL 内容正确、中文不乱码。

### 任务 2.3 offset / 时间戳跳转定位

**Files**
- Modify: `frontend/src/components/kafka/MessageBrowser.vue`(+spec)、`frontend/src/store/browse.ts`(+spec)

**设计**：过滤条加「跳转 offset」输入（从该 offset 起拉一批）与「时间戳跳转」入口（复用 2.4/现有 API）。跳转后结果高亮目标记录。
**TDD**：store 用例验证 offset 参数传递与结果定位；组件输入→查询。
**验收**：输入 offset 能定位到对应消息。

### 任务 2.4 SQL 查询历史 + 保存查询

**Files**
- Modify: `frontend/src/components/kafka/SqlConsole.vue`(+spec)、`frontend/src/store/sqlhistory.ts`(+spec)

**设计**：本地 `sqlhistory` Pinia store（localStorage 持久化）：自动记录最近 20 条执行语句 + 用户「保存查询」命名收藏；控制台内「历史/收藏」下拉可回填。
**TDD**：store 单测（追加/去重/上限/收藏）；组件下拉回填触发执行。
**验收**：重启应用历史仍在；收藏可命名管理。

---

## 批次 B3 · P1 体验（5 项）

### 任务 3.1 生产消息批量增强

**Files**
- Modify: `backend/internal/kafka/kafka.go`（`ProduceMessages`）、`backend/internal/model/produce.go`、`backend/app.go`、`frontend/src/components/kafka/ProducerPanel.vue`(+spec)

**设计**：后端 `ProduceMessages(req) ([]ProduceResult, error)` 一次发多条（JSON 数组批量/循环 N 条），返回每条 partition/offset/error；前端加「批量行数」「随机 key」「循环发送」与结果计数反馈、最近模板。
**TDD**：kfake 批量发送后 `ConsumeMessages` 断言条数；组件批量输入→计数显示。
**验收**：可一次发多条并看到成功/失败统计。

### 任务 3.2 消费组成员拓扑 + Lag 趋势 + 自动刷新 + reset dry-run

**Files**
- Modify: `backend/internal/kafka/admin.go`（`DescribeGroup` 返回成员 assignment）、`backend/app.go`、`frontend/src/components/kafka/ConsumerGroupView.vue`(+spec)、`frontend/src/components/kafka/GroupLagPanel.vue`(+spec)、新增 `frontend/src/components/kafka/LagTrend.vue`(+spec)

**设计**：`DescribeGroup(id, group)` → kadm `DescribeGroups` 成员 partition 拓扑（复用 `ListActiveConsumers` 的映射思路，抽象成通用成员解析）；`LagTrend.vue` 用定时器（可选手动/自动间隔）采样 Lag 画迷你折线（canvas/svg）；「重置偏移」加 Dry-run 预览受影响分区与新旧 offset。
**TDD**：后端成员拓扑 kfake 用例；前端趋势组件定时采样与渲染；reset dry-run 预览数据断言。
**验收**：组成员分区归属清晰；趋势图随时间更新；重置前可预览影响。

### 任务 3.3 批量删除 Topic + 导出列表

**Files**
- Modify: `backend/internal/kafka/admin.go`（`DeleteTopics`）、`backend/app.go`、`frontend/src/components/common/ConnectionTree.vue`(+spec)

**设计**：后端 `DeleteTopics(id, names)` 批量（kadm `DeleteTopics` 返回 per-topic 结果）；前端 topic 区加「多选模式」勾选多个后批量删除（复用 ConfirmDialog）与「导出列表」。
**TDD**：kfake 批量删除断言；前端多选→确认→删除计数。
**验收**：可勾选多个 topic 一次删除并逐个报错；列表可导出。

### 任务 3.4 全局命令面板 ⌘K

**Files**
- Create: `frontend/src/components/common/CommandPalette.vue`(+spec)
- Modify: `frontend/src/components/layout/Layout.vue`、`frontend/src/App.vue`

**设计**：`⌘K` 唤起居中面板，跨连接模糊搜索 topic/group（用现有 `fuzzyScore`），选中即打开对应 Tab；支持键盘上下选择/回车。Teleport 到 body。
**TDD**：组件搜索列表、键盘导航、回车打开；Layout 挂载与快捷键监听。
**验收**：任意界面 ⌘K 可搜到并直达。

### 任务 3.5 标签页增强（右键菜单 / 拖拽 / 统一刷新）

**Files**
- Modify: `frontend/src/components/layout/Layout.vue`(+spec)、`frontend/src/store/tabs.ts`(+spec)、`frontend/src/store/browse.ts`

**设计**：tab 右键菜单（关闭、关闭其他、关闭全部、刷新）；拖拽排序（轻量 HTML5 drag 或引入排序逻辑，避免重依赖）；顶栏/工作区「统一刷新」按钮触发当前 topic/group/lag 重新加载。
**TDD**：tabs store 增加 `closeOthers/closeAll/move` 用例；Layout 右键菜单与刷新事件。
**验收**：右键管理与拖拽可用；刷新按钮生效。

---

## 批次 B4 · P2 高级（5 项）

### 任务 4.1 Topic Config 编辑
- 后端 `AlterTopicConfig(id, topic, entries)`（kadm `AlterTopicConfigs`）+ kfake 用例；前端在 TopicDetailDrawer 里对白名单 config 提供编辑并保存。
- 验收：修改 retention.ms 等后重新 Describe 确认生效。

### 任务 4.2 数据导入回放
- 前端选择本地文件（CSV/JSONL）→ 解析为消息 → 走 `ProduceMessages` 批量发送；提供进度与失败列表。
- 验收：导入 100 行 JSONL 全部发送成功且可消费回读。

### 任务 4.3 快捷键体系
- 全局 `keydown` 监听：`⌘K` 命令面板、`⌘R` 刷新、`⌘Enter` 执行 SQL、`⌘D` 删除当前；在 Layout 注册、组件内避免与输入框冲突。
- 验收：各快捷键在不同界面可用且不影响输入。

### 任务 4.4 操作审计日志
- 后端 `store` 新增审计表（SQLite），`App` 在 create/delete/reset/config 修改处写入；前端「设置」页展示最近操作（时间/动作/对象/结果）。
- 验收：危险操作有留痕可查。

### 任务 4.5 全局状态栏
- `Layout` 底部状态栏：当前连接数/在线数、最近错误、当前连接延迟（可选 ping）；数据源通用，为 MySQL/ES 铺路。
- 验收：状态随连接变化实时更新。

---

## 多源（MySQL/ES）铺路原则
- 新增功能优先做成「与数据源类型无关」：命令面板、导出、状态栏、审计、快捷键、时间过滤，后续 MySQL/ES 直接复用。
- 连接树 `ObjectCollection`/`TYPE_META` 已预留扩展点；B1 的「详情」「健康」按「数据源元数据」抽象设计，便于未来映射为 MySQL 库/表/实例健康。

## 风险与依赖
- 所有 kfake 用例需绑定本地 TCP，须在沙箱外运行（已纳入 AGENTS.md）。
- Topic config 与集群健康依赖 franz-go/kadm 版本能力（v1.21.6 / kadm v1.18.0，已确认支持 DescribeCluster、DescribeTopicConfigs、AlterTopicConfigs、DeleteTopics）。
- B3 依赖 B1 的聚合/趋势基础；B4 的审计依赖 store 扩展。
- 每批独立验证打包，避免大范围回归难定位。

## 自检清单（Writing-Plans）
- 覆盖：18 项功能均映射到 B1–B4 的任务。
- 占位符：无 TBD/「适当处理」类空话；每项均有文件路径、API 形态、TDD 与验收。
- 一致性：后端统一走 kafka→service→app→绑定；前端统一 Pinia+`setApi()`+`data-test`。
