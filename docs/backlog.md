# Backlog — 遗留 Minor 与加固项（完结）

来源：SDD 开发流程 B1–B4 各任务评审记录的 Minor 问题暂存区（`.superpowers/sdd/progress.md`），
2026-08-30 统一整理。规划文档：`docs/superpowers/plans/2026-08-27-kafka-enhancements.md`。

**完结状态（2026-08-30）**：全部 43 项已处置 —— ✅ 已修 36、🔄 常设流程 1、🚫 保持/淘汰 6。
分三批落地：`feat/backlog-b1`（BL-001..015 大部分）、`feat/backlog-b2`（BL-005/016/017/019/038-040）、
`feat/backlog-b3`（BL-020..036 余项 + 041/043），均已合并 main。

> 图例：✅=已修并合并 main｜🚫=保持/淘汰（附理由）｜🔄=常设流程（每次批次门执行）

---

## P0 · 修正类

| ID | 模块 | 现象 | 处置 |
|----|------|------|------|
| BL-001 | MessageBrowser 跳转 | fraction offset（如 42.5）未被拦截 | ✅ `Number.isInteger` 校验（backlog-b1） |
| BL-002 | MessageBrowser 跳转 | 重复跳转同一 offset 不重滚 | ✅ 每 tab `scrollRequest` 计数 + 无条件重滚（backlog-b1） |
| BL-003 | MessageBrowser 跳转 | 跳转 fetch 失败时旧列表首行可能被误高亮 | ✅ 仅成功后才置 target（backlog-b1） |
| BL-004 | browse 时间过滤 | 仅设置结束时间、起始为空时静默无效 | ✅ 起始为空时禁用结束时间输入 + 提示（backlog-b1） |
| BL-005 | GroupLagPanel 重置 | 预览行为空时确认仍可「全分区重置」 | ✅ 预览空禁用确认 + 禁用视觉态（backlog-b2 + CSS） |
| BL-006 | sqlhistory | `applyQuery` 可绕过 `running` 防抖并发执行 | ✅ 组件层守卫（历史/收藏入口，backlog-b1 B-B） |
| BL-007 | SqlConsole | 切 topic 静默丢弃已编辑未运行 SQL | ✅ 按 topic 保留草稿 + 运行后清除可观察化（backlog-b1 B-B + fix-a） |
| BL-008 | importMessages | JSONL 对象行不抽 `key` | 🚫 **已确认语义**：一条消息就是一个对象，整行 stringify 即预期（用户裁决 2026-08-30） |

## P1 · 一致性 / 迁移类

| ID | 模块 | 现象 | 处置 |
|----|------|------|------|
| BL-009 | MessageDetailDrawer | 暗色模式硬编码白面板 | ✅ 迁移 `--glass-bg`/`--glass-shadow`（backlog-b1 B-C） |
| BL-010 | MessageDetailDrawer | 折叠启发式按行数，超长单行不折叠 | ✅ 加字符下限（backlog-b1 B-C） |
| BL-011 | MessageDetailDrawer | 模式切换按钮缺 aria-pressed | ✅ 已补（backlog-b1 B-C） |
| BL-012 | ProducerPanel | 重开面板旧横幅残留 | ✅ 打开时清 ok/error（backlog-b1 B-C） |
| BL-013 | ConnectionTree | 批量删除完成后已折叠仍 reload | ✅ 折叠则跳过 reload/反馈（backlog-b1 B-C；已知：重展开列表需手动刷新） |
| BL-014 | GroupLagPanel | 确认重置丢失 resetting 防抖 | ✅ 恢复守卫（backlog-b1 B-C，实现在 ConsumerGroupView） |
| BL-015 | GroupLagPanel | members-state 空 badge | ✅ 空态不渲染（backlog-b1 B-C） |
| BL-016 | GlobalLagView | 错误横幅与空占位行同显 | ✅ 失败时不渲染空占位（backlog-b2 B2-A） |
| BL-017 | Layout 快捷键 | IME 守卫短路 Escape | ✅ 守卫窄化至组合键，Escape 正常（backlog-b2 B2-B） |
| BL-018 | ConnectionTree 批量删 | 收窄搜索前勾选计入删除数 | ✅ 提示文案（backlog-b2 B2-A 一并处理；计数诚实） |
| BL-019 | audit | DeleteTopics 失败 detail 封顶无「…」 | ✅ 共享 `joinAuditFailureDetails` 补省略号（backlog-b2 B2-A） |

## P2 · 防御加固 / 可维护性

| ID | 模块 | 现象 | 处置 |
|----|------|------|------|
| BL-020 | 三视图 | 快速切换慢响应覆盖新数据 | ✅ 请求序号防陈旧（backlog-b3 B3-A） |
| BL-021 | CommandPalette | SWR 无防重入 | ✅ 每连接 fetchSeqByConn（backlog-b3 B3-A） |
| BL-022 | CommandPalette | 连接删除后缓存未裁剪 | ✅ 裁剪 entries/loading/error/fetchSeq（backlog-b3 B3-B） |
| BL-023 | TopicDetailDrawer | 保存中关闭多触发 describe | ✅ 关闭/切换 void in-flight（backlog-b3 B3-A） |
| BL-024 | browse | fetchMore 追加循环截断 | ✅ 按调用 clamp（backlog-b3 B3-B） |
| BL-025 | format.ts | renderJsonView/prettyJSON 重复 | ✅ 委托整合（backlog-b3 B3-B） |
| BL-026 | export.ts | revoke 时序/下拉重复/emoji 无测试 | ✅ 延迟 revoke + 抽 ExportDropdown + unicode 测试（backlog-b3 B3-C） |
| BL-027 | 多文件 spec | fakeApi 样板重复 | 🚫 既定惯例，不扫全仓重构（保持） |
| BL-028 | tabs.spec.ts | 游离 it + 缺尾换行 | ✅ 归位整理（backlog-b3 B3-C） |
| BL-029 | SettingsPanel.spec | 类型不安全 stub | ✅ 类型安全假对象（backlog-b3 B3-C） |
| BL-030 | produce | model.ProduceRequest 死类型 | ✅ 删除 + JSON-shape 测试改挂真实 wire 类型（backlog-b3 B3-B） |
| BL-031 | produce 批量 | clamp 仅发送时，输入可显 1500 | ✅ 超上限提示 count-cap-hint（backlog-b3 B3-B） |
| BL-032 | produce 批量 | 60s ctx 与 10s 预算交互 | 🚫 行为合理（发送超时保护），文档化（保持） |
| BL-033 | produce 批量 | 重复 produce-error data-test | ✅ 行内改 produce-value-error（backlog-b3 B3-B） |
| BL-034 | sqlhistory | favForm 关闭不重置 | ✅ 取消/成功重置（backlog-b3 B3-B） |
| BL-035 | kafka/DescribeCluster | ApiVersions 探测失败语义边缘 | 🚫 既定取舍，有注释（保持） |
| BL-036 | admin.go | ListActiveConsumers nil vs [] | 🚫 消费端已容忍，与裁决一致（保持） |

## 测试加固

| ID | 项 | 说明 | 处置 |
|----|----|------|------|
| BL-037 | kfake 全量 | 每批次门在沙箱外跑 `go test ./backend/internal/kafka/ -v`（loopback bind 被沙箱拒） | 🔄 常设流程（批次门步骤） |
| BL-038 | sqlhistory | removeFavorite 持久化回归 + store 层空白拦 | ✅（backlog-b2 B2-C） |
| BL-039 | importMessages CSV | `""` 转义/内嵌换行测试 | ✅（backlog-b2 B2-C；实现原已正确） |
| BL-040 | browse | 截止值相等边界包含性测试 | ✅（backlog-b2 B2-C） |

## 候选新功能

| ID | 功能 | 说明 | 处置 |
|----|------|------|------|
| BL-041 | PreviewResetOffset 只读 API | dry-run earliest/timestamp 真实目标 offset | ✅ 全链路落地（backlog-b3 B3-D，含绑定再生成 + kfake 用例） |
| BL-042 | StatusBar 延迟 ping | 当前连接延迟显示 | 🚫 可选；TestConnection 偏重，原裁决保持轻量（不实现） |
| BL-043 | importMessages 单行 pretty JSON | 单行/美化对象容错 | ✅ 单对象=一条消息（backlog-b3 B3-D） |

## 淘汰项（归档，不修）

| 条目 | 理由 |
|------|------|
| 任务 1.3/1.4 报告计数口径、心智模型描述偏差 | 文档表述问题，代码无缺陷 |
| `fakeApi()` 样板重复（BL-027 的先行表述） | 并入 BL-027，见上 |
| GlobalLagView/ConsumerGroupView 错误横幅+空占位同显（旧版） | 并入 BL-016，已修 |
| ConsumerGroupView describeGroup 双调用（含切组多一次 DescribeGroups） | 无害；3.5 已缓解 |
| CommandPalette SWR 瞬时陈旧 | 并入 BL-021，已修 |
| export CSV 公式注入 | 非本次需求，导出是数据交换非报表 |
| tab topic 联动合并复审的 Minor（重开周期未锁/守卫测试较弱） | 已被 4.3/4.5 覆盖或属测试风格 |
| produce JSON 数组 50k 失败行全渲染 | 已修（B3 clamp 封顶） |
| BL-008 JSONL 对象行不抽 key | 已确认语义（见 P0） |

---

## 统计

- **43 项全部处置**：✅ 已修 36、🔄 常设流程 1（BL-037 kfake gate）、🚫 保持/淘汰 6（BL-008/027/032/035/036/042）。
- 批次落地：backlog-b1（16 commits）→ backlog-b2（9 commits）→ backlog-b3（26 commits），均快进合并 main。
- 遗留观察（记录不修）：ExportDropdown 按钮尺寸与 SqlConsole 局部大按钮风格不一致（外观）；PreviewResetOffset 部分分区失败整体 blank（安全，可加注释）；save() 跨次 finally 清 saving 的既有竞态（B3-A 已缩小影响面）。
