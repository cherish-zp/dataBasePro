# 仓库指南

面向基于 Go、Wails 与 Vue 3 构建的 Kafka 多数据源管理客户端的贡献指南。权威需求文档见 [数据库-kafka设计方案.md](./数据库-kafka设计方案.md)。

## 项目结构与模块组织

- `main.go` / `wails.json` — Wails 桌面端入口与配置；内嵌 `frontend/dist` 静态资源。
- `backend/` — Go 后端。`app.go` 为 Wails 绑定层；`internal/` 下分 `model`、`store`（SQLite + AES-GCM）、`service`（接口与连接池）、`kafka`（franz-go 封装）。
- `frontend/src/` — Vue 3 应用：`api/`（类型与绑定适配层）、`store/`（Pinia）、`components/`、`views/`、`utils/`。
- `frontend/wailsjs/` — 自动生成的绑定代码，**禁止手改**；需重新生成时执行 `wails generate module`。
- `cmd/dbclient/` — 供非 GUI 验证的 CLI 演示入口。

## 构建、测试与开发命令

- 后端：`GOCACHE=/tmp/gocache go build ./...` 与 `go test ./...`；竞态检查：`go test -race ./...`。
- 前端：`npm test`（Vitest）、`npm run typecheck`（vue-tsc）、`npm run build`（vue-tsc + vite build）、`npm run dev`。
- 桌面端：`wails dev`（热重载）与 `wails build -o KafkaClient`。
- CLI 演示：`go run . list | add <名称> <brokers> | test <brokers> | topics <连接ID>`。

## 编码风格与命名约定

- Go：遵循 `gofmt`；包保持接口驱动；Wails v2 无法绑定 `context.Context` 参数，因此 `App` 方法内部自行创建带超时的 context。
- Vue/TS：使用 `<script setup lang="ts">`、严格 TypeScript、kebab-case 文件名、camelCase 函数名、snake_case JSON 字段（与 Go 侧保持一致）。
- 改动保持最小化，并与现有组件/store 的写法保持一致。

## 测试规范

- 后端：Go 标准库 `testing` + `kfake`（无需真实 Kafka）。测试命名 `TestXxx`；按包运行（如 `go test ./backend/internal/kafka/ -v`）。kfake 需绑定本地 TCP 端口，请在沙箱外运行。
- 前端：Vitest + `@vue/test-utils`；测试文件与源码同目录且命名为 `*.spec.ts`。通过 `setApi()` 注入 fake API，并用 `data-test` 属性定位元素。
- 遵循 TDD：先编写会失败的测试，再实现功能。

## 提交与 PR 规范

- 使用 Conventional Commits（如 `feat:`、`fix:`、`test:`、`docs:`）并以祈使语气书写；可参考现有提交历史（`git log`）。
- PR 需说明：改了什么、为什么改、如何验证（附上测试命令），如涉及需求文档请链接对应章节。

## 改动提交流程（自动提交）

- 每次完成代码改动后，先运行相关测试与构建验证（见「构建、测试与开发命令」），确保无问题、无回归。
- 改动验证通过后，**先等待用户明确确认**，确认后再自动执行提交，不要擅自提交未确认的改动。
- 提交信息使用 Conventional Commits（如 `feat:`、`fix:`、`test:`、`docs:`），祈使语气，必要时附简短正文说明改动原因与验证方式。
- 提交范围遵循 `.gitignore`，禁止混入构建产物、本地配置或凭据。
- 提交后同步推送到远程（本仓库 `origin` 指向 `git@gitee.com:princess-zp/dataBasePro.git`，默认分支 `main`）。

## 打包、安装与启动流程（用户确认后执行）

本机为 Apple Silicon（M1），目标平台为 `darwin/arm64`。仅在**用户明确确认后**执行以下步骤：

1. 打包：`wails build --platform darwin/arm64`（`wails.json` 的 `outputfilename` 已设为 `dataBasePro`，无需 `-o`；若用 `-o` 勿带 `.app` 后缀，否则与 Wails 自动追加的 `.app` 撞名导致打包失败），产物位于 `build/bin/dataBasePro.app`（gitignored）。
2. 安装：将产物复制到 `/Applications/dataBasePro.app`；若已存在旧版本，先移除旧目录再复制。
3. 启动：`open /Applications/dataBasePro.app`。
4. 清理：安装后删除构建残留 `build/bin/dataBasePro.app`，避免 Spotlight 搜索出现两个同名应用。

打包前先通过测试与构建验证（见「构建、测试与开发命令」）；产物为 ad-hoc 自签名，未公证。

注意：`wails build` 会清空 `frontend/dist`（vite `emptyOutDir`），连带删除被跟踪的 `frontend/dist/.gitkeep`；提交前需恢复：`touch frontend/dist/.gitkeep`。

## 安全与配置要点

- 连接密码以 AES-256-GCM 加密后落盘到 `~/.db-client/config.db`。通过环境变量 `DB_CLIENT_MASTER` 设置主密码。
- 严禁打印凭据；密码仅经 store 的加密层使用（`Config.SASL.Password`）。
