好的，这是一份基于 **Go + Wails** 技术栈的完整技术设计文档（MD 格式）。你可以直接将其保存为 `DESIGN.md` 作为项目开发的指导蓝图。

---

# Kafka 多数据源管理客户端 - 技术设计方案 (Go + Wails)

## 1. 项目背景与目标
开发一款跨平台（macOS / Windows）的数据库管理客户端。首要支持 **Apache Kafka**，后续可平滑扩展支持 **Elasticsearch** 和 **MySQL**。
核心目标：**轻量级、免安装依赖、原生性能**。

## 2. 技术选型与理由

| 模块 | 选型 | 理由 |
| :--- | :--- | :--- |
| **后端语言** | **Go 1.21+** | 编译为静态二进制文件，无需目标机器安装运行时；原生支持高并发，适合 Kafka 消费场景。 |
| **跨平台框架** | **Wails v3** | 相比 Electron，打包体积小（约 15-30MB），内存占用低；原生调用系统 API（如钥匙串存储密码）极其方便。 |
| **前端框架** | **Vue 3 + TypeScript** | 响应式数据驱动，生态成熟；Wails 官方对 Vue 支持最佳。 |
| **UI 组件库** | **Naive UI** | 目前 Vue 3 生态中性能最优秀的组件库之一，内置**虚拟滚动表格**（处理 Kafka 海量消息时必备）。 |
| **Kafka 客户端** | **`github.com/twmb/franz-go`** | **纯 Go 实现**，无 CGO 依赖，完美匹配 `CGO_ENABLED=0` 静态编译要求；API 设计现代，性能优于 Sarama。 |
| **本地存储** | **`modernc.org/sqlite`** | 纯 Go 实现的 SQLite 驱动（无 CGO 依赖），用于存储连接配置、查询历史等。 |
| **配置加密** | **Go 标准库 `crypto/aes`** | 结合系统钥匙串（macOS）和 Windows 凭据管理器，或本地加密文件存储密码。 |

## 3. 项目目录结构 (Wails 标准布局)

```text
my-db-client/
├── frontend/                # 前端源代码 (Vue 3 + Vite)
│   ├── src/
│   │   ├── assets/          # 静态资源
│   │   ├── components/      # 通用 UI 组件
│   │   │   ├── connection/  # 连接管理相关组件
│   │   │   ├── kafka/       # Kafka 主题/消息浏览组件
│   │   │   └── common/      # 树形控件、Tab 容器
│   │   ├── views/           # 页面视图
│   │   ├── store/           # Pinia 状态管理 (连接池、主题树)
│   │   └── App.vue
│   └── package.json
├── backend/                 # Go 后端源代码 (Wails 默认在根目录，此处逻辑拆分)
│   ├── app.go               # Wails 主应用结构体（暴露给前端的 API）
│   ├── internal/
│   │   ├── kafka/           # Kafka 业务逻辑封装
│   │   │   ├── client.go    # 连接、消费、生产核心代码
│   │   │   └── admin.go     # 主题/分区/消费组管理
│   │   ├── model/           # 数据模型定义
│   │   │   ├── connection.go # 连接配置结构体
│   │   │   └── kafka.go     # Topic, Partition, Message 结构体
│   │   ├── service/         # 服务层（连接池管理）
│   │   └── store/           # 本地数据库 CRUD 操作
│   └── go.mod
├── build/                   # 打包资源（图标、plist、manifest）
├── main.go                  # Wails 应用入口
└── wails.json               # Wails 配置文件
```

## 4. 后端 (Go) 核心架构设计

采用**接口驱动**的设计，为后续扩展 ES 和 MySQL 预留空间。

### 4.1 核心接口定义 (`backend/internal/service/interface.go`)

```go
// DataSource 统一数据源接口
type DataSource interface {
    Connect(config map[string]interface{}) error
    Close() error
    GetName() string
    GetType() string // "kafka", "mysql", "es"
}

// Kafka 特有的扩展接口
type KafkaDataSource interface {
    DataSource
    ListTopics() ([]*model.Topic, error)
    ListConsumerGroups() ([]*model.ConsumerGroup, error)
    ConsumeMessages(topic string, partition int32, offset int64, limit int) ([]*model.Message, error)
    GetPartitionLag(topic string, group string) (map[int32]int64, error)
}
```

### 4.2 连接池管理 (`backend/internal/service/pool.go`)

-   维护一个 `sync.Map` 存储当前已建立的连接实例（Key 为连接 UUID）。
-   前端通过 Wails 绑定的方法（如 `CreateConnection`、`GetTopics`）调用池中的具体实现。
-   连接配置（Broker 地址、SASL 凭证）通过 `model.Connection` 结构体传递，并存储于本地 SQLite。

## 5. 前端 UI/UX 页面设计

遵循 **"左树右页"** 的 IDE 经典布局。

### 5.1 主界面布局

```text
+---------------------------------------------------------------------+
| [Logo]  + 新建连接  |  搜索...   |  主题切换  |  设置   |  [头像]  |  <- 顶部栏
+---------------------------------------------------------------------+
|  📁 数据源树 (左侧)  |  标签页 (Tabs) 工作区 (右侧)                  |
|  ▼ 📁 Kafka          |  [Welcome] [topic-a] [consumer-group-1]      |
|    ├─ 🔗 本地开发    |  +------------------------------------------+ |
|    │  ├─ 📋 Topics   |  | 分区: [All ▼] 偏移量: [最新 ▼] [开始]   | |
|    │  │  ├─ user-log |  | Partition | Offset | Timestamp | Key/Val | |
|    │  │  └─ order-db |  | 0         | 1002   | 12:00:01  | {...}  | |
|    │  └─ 👥 Consumers|  | 1         | 504    | 12:00:02  | {...}  | |
|    ├─ 🔗 生产环境    |  +------------------------------------------+ |
|  ▼ 📁 MySQL (预留)   |                                               |
|  ▼ 📁 ES (预留)      |                                               |
+---------------------------------------------------------------------+
```

### 5.2 关键交互流程

1.  **新建连接 (弹窗)**：
    -   第一步选择数据源类型（Kafka / MySQL / ES）。
    -   第二步动态渲染对应表单。Kafka 需要：集群名称、`bootstrap.servers`、认证方式（PLAIN / SCRAM / SSL）、CA 证书文本域。
    -   点击【测试连接】调用后端 `Ping` 方法，成功后保存到本地 SQLite。

2.  **浏览 Kafka 消息 (核心功能)**：
    -   双击左侧 Topic 节点，右侧打开新 Tab。
    -   **上方过滤栏**：选择分区（All/0/1）、消费起点（Earliest/Latest/指定时间）、**简易过滤表达式**（如 `WHERE key='xxx'`）。
    -   **下方表格**：使用 Naive UI 的 `n-data-table` 开启 `virtual-scroll`。点击某一行，在底部抽屉（Drawer）中格式化展示 JSON 详情，高亮显示 **分区** 和 **偏移量（Offset）**。

3.  **查看消费情况 (Lag 监控)**：
    -   双击 `Consumer Groups` 下的组名。
    -   展示表格：`Topic | Partition | Current Offset | Log End Offset | Lag`。
    -   提供【重置 Offset】按钮，支持重置到 `Latest` / `Earliest` / `指定时间戳`。

4.  **SQL 查询 Kafka (高级功能)**：
    -   在顶部工具栏点击【查询控制台】。
    -   编辑器集成 `monaco-editor`（VS Code 同款），支持 SQL 语法高亮。
    -   **实现策略**：初期不支持复杂 SQL 解析，而是将用户输入的 SQL 提交给后端的 **ksqlDB REST API**（需用户额外部署），或将简易的 `WHERE` 条件翻译为 `franz-go` 的过滤逻辑。界面切换执行引擎下拉框（Kafka / MySQL / ES）。

## 6. 数据持久化设计 (Local SQLite)

创建本地数据库 `~/.db-client/config.db`，仅一张主表 `connections`：

```sql
CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,          -- 'kafka', 'mysql', 'es'
    config_json TEXT NOT NULL,   -- JSON 存储连接详情（密码加密后存入）
    created_at INTEGER,
    updated_at INTEGER
);
```
-   **密码加密**：使用 `crypto/aes` + 用户主密码（首次启动时设置）加密 `config_json` 中的密码字段。

## 7. 跨平台打包策略

在 Mac M1 上执行 Wails 打包命令，生成对应平台的可执行文件：

```bash
# 1. 打包 macOS ARM64 (当前 M1 运行)
wails build --platform darwin/arm64 -o KafkaClient.app

# 2. 打包 macOS Intel (兼容旧款)
wails build --platform darwin/amd64 -o KafkaClient_Intel.app

# 3. 打包 Windows 64位 (在 Mac 上交叉编译)
wails build --platform windows/amd64 -o KafkaClient.exe

# 核心要点：wails build 默认会设置 CGO_ENABLED=0，确保二进制包纯净无依赖
```

-   **图标生成**：将 `build/appicon.png` 替换为你的 Logo，Wails 会自动生成多尺寸图标并嵌入 `.app` 或 `.exe`。
-   **Windows 注意**：若应用依赖 WebView2（Wails 默认），打包时可选择将 WebView2 引导程序嵌入安装包。

## 8. 开发阶段规划 (Roadmap)

| 阶段 | 任务 | 预计工时 |
| :--- | :--- | :--- |
| **Phase 1** | 搭建 Wails 骨架，实现左侧树形组件、新建连接弹窗、本地 SQLite 存储 | 2 天 |
| **Phase 2** | 集成 `franz-go`，实现 Kafka 连接、Topic 列表拉取、树形渲染 | 1 天 |
| **Phase 3** | 实现消息浏览 Tab（分区选择、拉取消息、虚拟滚动表格、JSON 格式化展示） | 2 天 |
| **Phase 4** | 实现消费组 Lag 监控、重置 Offset 功能 | 2 天 |
| **Phase 5** | 实现简易 SQL/过滤查询框、对接 ksqlDB 网关（可选） | 3 天 |
| **Phase 6** | 打包测试（Windows 虚拟机下验证）、适配深色/浅色主题 | 1 天 |

## 9. 关键技术难点预研

1.  **海量消息渲染**：必须使用 `virtual-scroll`，且后端拉取消息采用**流式分批**（例如每次拉 500 条，滚动到底部时通过 Wails `EventsEmit` 触发下一批加载）。
2.  **长连接保活**：`franz-go` 客户端需设置心跳和超时时间；前端关闭 Tab 时应调用后端 `CloseConsumer` 释放资源，防止内存泄漏。
3.  **CGO 陷阱**：**绝对不要**使用 `confluent-kafka-go`（依赖 librdkafka C 库），必须坚持纯 Go 库（`franz-go` 或 `sarama`），否则交叉编译 Windows 会遇到极大的 CGO 兼容性噩梦。

---

以上即为完整的设计方案。接下来你可以按照 **Phase 1** 开始初始化项目：`wails init -n my-db-client -t vue-ts`，然后着手实现连接管理模块。如有特定细节（如 SASL 认证代码或前端树形拖拽逻辑）需要深入，随时告诉我！🚀