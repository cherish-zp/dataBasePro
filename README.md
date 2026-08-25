# Kafka 多数据源管理客户端（Go + Wails + Vue 3）

依据 [数据库-kafka设计方案.md](./数据库-kafka设计方案.md) 实现，采用 **TDD（测试驱动开发）**
逐包推进：先写测试刻画设计文档中的行为，再实现并通过测试。

## 技术栈
- 后端：Go 1.21+（实际在 1.27 下开发），`CGO_ENABLED=0` 可静态编译
- Kafka 客户端：`github.com/twmb/franz-go`（纯 Go，无 CGO）
- 本地存储：`modernc.org/sqlite`（纯 Go，无 CGO）
- 密码加密：`crypto/aes`(AES-256-GCM) + 标准库 `crypto/pbkdf2`（用户主密码派生密钥）
- 测试用假集群：`franz-go/pkg/kfake`（无需真实 Kafka）
- 桌面框架：Wails v2（`wails.json` 配置，`main.go` 将 `backend.App` 绑定到前端）
- 前端：Vue 3 + TypeScript + Pinia + Vitest（`frontend/`）

## 目录结构
```text
.
├── main.go                     # Wails 桌面入口（绑定 backend.App，嵌入 frontend/dist）
├── wails.json                  # Wails 配置（frontend:build / dev 接线）
├── cmd/dbclient/               # 演示 CLI（非 GUI 验证入口）
├── backend/
│   ├── app.go                  # Wails 绑定层：暴露给前端的所有 API 方法
│   ├── bootstrap.go            # 装配 store + service + app 的引导函数
│   └── internal/
│       ├── model/              # 数据模型：Connection / Topic / Message / ConsumerGroup 等
│       ├── store/              # SQLite 持久化 + AES-GCM 密码加解密
│       ├── service/            # 接口定义、连接池、服务编排（统一入口）
│       └── kafka/              # franz-go 封装：连接/消费/生产 + 主题/消费组/Lag 管理
├── frontend/
│   ├── src/api/                # 类型定义 + Wails 绑定适配层（可注入 fake 便于测试）
│   ├── src/store/              # Pinia：connections / tabs / browse / groups
│   ├── src/components/         # 连接树、新连接弹窗、消息浏览、消费组、生产、查询控制台、设置
│   ├── src/views/              # HomeView（欢迎页）等视图
│   ├── src/App.vue / main.ts   # 装配：store + Layout + 弹窗
│   └── wailsjs/                # wails generate module 生成的绑定（勿手改）
└── 数据库-kafka设计方案.md
```

## 功能覆盖（对应设计方案）
- **连接管理**：新建/列表/获取/删除连接、`TestConnection`（Ping 校验）、连接池自动建立/释放
- **主题浏览**：`ListTopics` 返回主题与分区元数据；左侧树双击 Topic 打开浏览 Tab
- **消息浏览**：分区选择（All / 单个）、起点（Earliest / Latest / 指定时间戳）、分批加载、
  底部抽屉展示分区/偏移量/JSON 详情
- **生产消息**：`ProduceMessage` 单条投递（分区可选自动）
- **消费组监控**：组状态 + 逐分区 Lag 表格；`ResetConsumerGroupOffset` 支持 earliest / latest / timestamp
- **查询控制台**：简易 SQL（`SELECT * FROM <topic> [WHERE key='x' / value LIKE '%x%'] [LIMIT n]`），
  执行引擎下拉（Kafka / MySQL / ES 预留）
- **设置**：深色/浅色主题切换（持久化到 localStorage）
- **持久化与安全**：连接存入本地 SQLite，密码字段 AES-GCM 加密落盘

## 运行测试
### 前端
```bash
cd frontend
npm install
npm run typecheck   # vue-tsc
npm test            # Vitest 全量（109 个用例）
npm run build       # vue-tsc + vite build，产物输出到 frontend/dist
```

### 后端
```bash
# 注：kfake 假集群需要监听本地 TCP 端口，受限环境请提权运行
go test ./...          # 全量
go test -race ./...    # 含竞态检测
go test ./backend/internal/kafka/ -v   # kafka 包集成测试（基于假集群）
```

## 桌面运行
```bash
# 1. 编译前端（wails build / wails dev 会自动执行 frontend:build）
# 2. 启动开发模式（热重载）
wails dev
# 3. 打包
wails build -o KafkaClient
```
数据库默认存放在 `~/.db-client/config.db`，可用 `DB_CLIENT_MASTER` 指定主密码。

## 演示 CLI
```bash
go run . list                          # 列出已保存连接
go run . add <名称> <brokers>           # 新建连接（如 localhost:9092）
go run . test <brokers>                 # 测试连通性
go run . topics <连接ID>                # 列出某连接的主题
```

## 已知说明
- Wails v2 绑定不支持 `context.Context` 参数，`backend.App` 方法内部自行创建带超时的 context。
- 列表类 API（`ListConnections`/`ListConsumerGroups`/`ConsumeMessages*`）空结果统一返回 `[]` 而非 `null`，避免前端 `length` 判空崩溃。
- Go `[]byte`（Message.Key/Value）经 JSON 传输为 base64 字符串；Wails 生成器将其建模为
  `number[]`，`frontend/src/api/client.ts` 作为适配层在边界做类型转换（运行时不改变行为）。
