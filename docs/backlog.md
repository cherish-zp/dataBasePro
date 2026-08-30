# Backlog — 遗留 Minor 与加固项

来源：SDD 开发流程 B1–B4 各任务评审记录的 Minor 问题暂存区（`.superpowers/sdd/progress.md`），
在本文件生成时（2026-08-30）统一整理、去重、分级。规划文档：`docs/superpowers/plans/2026-08-27-kafka-enhancements.md`。

> 图例：P0=修正类（影响正确性或可能误操作）｜P1=一致性/迁移类｜P2=防御加固/可维护性｜
> 状态：`待修` / `待用户决策` / `淘汰`（记录在案但不修，附理由）。
> 凡已在批次内修复的条目不再列入（已修：JSON 数组批量封顶、topic checkbox 双击冒泡、⌘Enter 防重入守卫、
> 导入列表跨 topic 存活、导入值污染最近模板、删除连接后 statusById 清理、右键菜单视口钳制）。

---

## P0 · 修正类（正确性 / 误操作风险）

| ID | 模块 | 现象 | 建议修法 |
|----|------|------|----------|
| BL-001 | MessageBrowser 跳转 | fraction offset（如 42.5）未被拦截（`isFinite` 放行） | 校验用 `Number.isInteger`；测试补分数 offset 用例 |
| BL-002 | MessageBrowser 跳转 | 重复跳转同一 offset 不重滚（跳后滚走再重跳失效） | `jumpToOffset` 内 `await`+`nextTick` 后无条件滚动 |
| BL-003 | MessageBrowser 跳转 | 跳转 fetch 失败时旧列表首行可能被误高亮 | 成功后再置 `target`；失败保持原状 |
| BL-004 | browse 时间过滤 | 仅设置结束时间、起始为空时静默无效 | 起始缺失时禁用或给出提示 |
| BL-005 | GroupLagPanel 重置 | 预览行（待重置分区）为空时确认仍可「全分区重置」 | 预览空时禁用确认按钮 |
| BL-006 | sqlhistory | `applyQuery` 可绕过 `running` 防抖并发执行 | store 层加 running 守卫（同 SqlConsole 执行按钮语义） |
| BL-007 | SqlConsole | 切换 topic 静默丢弃已编辑未运行的 SQL | 加 dirty-guard（确认/提示）；测试已记录现有语义 |

## P1 · 一致性 / 迁移类

| ID | 模块 | 现象 | 建议修法 |
|----|------|------|----------|
| BL-009 | MessageDetailDrawer | 暗色模式仍硬编码白色面板（:48/:52） | 两行替换为 `--glass-bg`/`--glass-shadow` |
| BL-010 | MessageDetailDrawer | 折叠启发式按 `\n` 行数计，超长单行（base64/hex）不折叠 | 增加字符/字节下限触发折叠 |
| BL-011 | MessageDetailDrawer | 模式切换按钮缺 `aria-pressed` | 补可访问性属性 |
| BL-012 | ProducerPanel | 重开面板时旧 ok/error 横幅残留 | watch 打开时清横幅（约 2 行） |
| BL-013 | ConnectionTree | 批量删除完成后连接已折叠仍写反馈并 reload | 完成时若已折叠则跳过 reload/反馈 |
| BL-014 | GroupLagPanel | 确认重置丢失 `resetting` 防抖（双击重复调用，幂等无害） | 恢复防抖守卫 |
| BL-015 | GroupLagPanel | `members-state` 空 badge 样式问题 | 空成员态不渲染 badge |
| BL-016 | GlobalLagView | 加载失败时错误横幅与空占位行同显 | 失败时不显示空占位 |
| BL-017 | Layout 快捷键 | 全局 IME 守卫同时短路 Escape（IME 合成期右键菜单不关闭） | 补测试锁定行为，或窄化守卫只作用于组合键 |
| BL-018 | ConnectionTree 批量删 | 收窄搜索前勾选的项在过滤后仍计入删除数 | 加提示文案（当前计数诚实，仅注意点） |
| BL-019 | audit | DeleteTopics 失败 detail 封顶 10 未加「…」 | 补省略标记 |

## P2 · 防御加固 / 可维护性

| ID | 模块 | 现象 | 建议修法 |
|----|------|------|----------|
| BL-020 | GlobalLagView / TopicDetailDrawer / ClusterHealthPanel | 快速切换（连接/对象）时慢响应后到覆盖新数据（last-write-wins） | 请求序号/AbortController 加固（同侪视图共享习语，统一改） |
| BL-021 | CommandPalette | 并发 SWR 刷新无请求序号/防重入，快速开关可能旧结果覆盖新结果 | 序号/防重入（瞬时陈旧，可接受） |
| BL-022 | CommandPalette | 连接删除后 entriesByConn/loadingByConn/errorByConn 缓存未裁剪 | 删除连接时同步裁剪（卫生项） |
| BL-023 | TopicDetailDrawer | 保存中关闭抽屉，挂起 save 回调对隐藏抽屉多触发一次 describe | 关闭时丢弃 in-flight 回调 |
| BL-024 | browse | fetchMore 追加循环未复制截断（当前不可达） | 加固，防未来回归 |
| BL-025 | format.ts | `renderJsonView` 与既有 `prettyJSON` 语义重复 | 单行委托整合 |
| BL-026 | export.ts | WKWebView 下同步 `revokeObjectURL`；下拉标记两处重复；emoji/星形字符无测试 | 延迟 revoke（setTimeout 0）；抽公共标记函数；补测试 |
| BL-027 | 多文件 spec | 各 spec 的 `fakeApi()` 样板重复 | 抽共享工厂（既定惯例，成本低收益中） |
| BL-028 | tabs.spec.ts | 文件尾既有游离 `it()` + 缺尾换行（pre-existing） | 整理文件结构 |
| BL-029 | SettingsPanel.spec | `getConnection: () => ({}) as never` 类型不安全 stub | 改类型安全的假对象 |
| BL-030 | produce 批量 | `model.ProduceRequest` 死类型（真 wire 类型是 BatchProduceRequest） | 删除死类型 |
| BL-031 | produce 批量 | clamp 仅发送时生效，输入框可显 1500 实发 1000 | 输入即 clamp 或提示 |
| BL-032 | produce 批量 | 批量 60s ctx 与「每条 10s 预算」交互，N 大慢集群可能静默截断 | 文档化/前端预估耗时提示 |
| BL-033 | produce 批量 | 重复 `produce-error` data-test（pre-existing） | 去重命名 |
| BL-034 | sqlhistory | `favFormOpen`/`favName` 关闭不重置（重开显旧表单） | 关闭时重置 |
| BL-035 | kafka/DescribeCluster | ApiVersions 整体探测失败时全部 broker 显在线+版本未知；countUnderReplicated 对 leader==-1 语义边缘 | 已有注释既定取舍，保持（记录在案） |
| BL-036 | admin.go | ListActiveConsumers 组缺失路径 nil vs 旧 `[]` 偏差 | 消费端已容忍，与裁决一致，保持 |

## 测试加固（gate-verify）

| ID | 项 | 说明 |
|----|----|------|
| BL-037 | kfake 全量 | 每批次门在沙箱外跑 `go test ./backend/internal/kafka/ -v`（loopback bind 被沙箱拒） |
| BL-038 | sqlhistory | `removeFavorite` 持久化无直接回归测试；`saveFavorite` store 层未拦纯空白 SQL |
| BL-039 | importMessages CSV | 引号转义 `""`/内嵌换行已实现但未测试（逗号引号已测） |
| BL-040 | browse | 时间过滤截止值相等边界包含性测试缺失 |

## 候选新功能（源自遗留需求）

| ID | 功能 | 说明 | 前置 |
|----|------|------|------|
| BL-041 | PreviewResetOffset 只读 API | dry-run earliest/timestamp 目标新 offset 显示 `—`，无后端预览 API 无法精确 | 后端只读 API + 前端回填（B4 候补） |
| BL-042 | StatusBar 延迟 ping | 当前连接延迟显示（可选） | TestConnection 偏重，需轻量 ping 端点 |
| BL-043 | importMessages 单行 pretty JSON | 单行 pretty-printed JSON 对象走逐行解析报错，可容错为整文件解析 | 解析器增强 |

## 淘汰项（记录在案，不修）

| 条目 | 理由 |
|------|------|
| 任务 1.3/1.4 报告计数口径、心智模型描述偏差 | 文档表述问题，代码无缺陷 |
| `fakeApi()` 样板重复（BL-027 的先行表述） | 既定惯例，见 BL-027 |
| GlobalLagView/ConsumerGroupView 错误横幅+空占位同显（旧版） | BL-016 已并入 |
| ConsumerGroupView describeGroup 双调用（含切组多一次 DescribeGroups） | 无害；3.5 已缓解 |
| CommandPalette SWR 瞬时陈旧 | BL-021 已并入 |
| export CSV 公式注入 | 非本次需求，导出是数据交换非报表 |
| BL-008 importMessages JSONL 对象行不抽 key | **已确认语义**（用户 2026-08-30）：一条消息就是一个对象，整行 stringify 即为预期行为 |
| tab topic 联动合并复审的 Minor（重开周期未锁/守卫测试较弱） | 已被后续 4.3/4.5 覆盖或属于测试风格 |
| produce JSON 数组 50k 失败行全渲染 | 已修（c782d94 clamp 封顶） |

---

## 统计与建议执行顺序

- 总计 **43 项**：P0 × 7、P1 × 11、P2 × 17、测试加固 × 4、候选功能 × 3、淘汰 × 9（含已确认语义的 BL-008）。
- 建议分批：**第一批**（P0，不含 BL-008）+ BL-009/012/014（低成本高价值）；**第二批**（P1 余项 + 测试加固）；**第三批**（P2 加固 + 候选功能按需）。
- 各条目可直接作为任务简报派发（复用 SDD 流程：简报 → 实现（TDD）→ 评审）。
