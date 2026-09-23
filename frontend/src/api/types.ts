// Types mirroring the Go model package (snake_case JSON fields).

export type ConnectionType = 'kafka' | 'mysql' | 'tidb' | 'es' | 'redis' | 'clickhouse' | 'postgres'

export interface SASLConfig {
  enabled: boolean
  mechanism: string
  // username/password 用于 PLAIN/SCRAM;GSSAPI (Kerberos) 时不携带,
  // 改用下方 kerberos 字段(镜像 model.SASLConfig)。
  username?: string
  password?: string
  principal?: string
  keytab_path?: string
  krb5_conf_path?: string
  service_name?: string
}

export interface TLSConfig {
  enabled: boolean
  ca_cert?: string
  insecure_skip_verify?: boolean
}

export interface KafkaConfig {
  bootstrap_servers: string[]
  // One of PLAINTEXT | SSL | SASL_PLAINTEXT | SASL_SSL. Legacy connections
  // without this field derive it from the tls/sasl booleans on the backend.
  security_protocol?: string
  sasl?: SASLConfig
  tls?: TLSConfig
}

export interface Connection {
  id: string
  name: string
  type: ConnectionType
  // 按类型多态:kafka → KafkaConfig,redis → RedisConfigShape,
  // clickhouse → CHConfigShape,mysql/tidb → MysqlConfigShape,es → EsConfigShape
  config: KafkaConfig | RedisConfigShape | CHConfigShape | MysqlConfigShape | EsConfigShape | PostgresConfigShape
  created_at: number
  updated_at: number
}

// 编辑已有连接的请求（镜像后端 UpdateConnectionRequest）：config 与
// CreateConnection 的 config 同形，id 定位已存在的连接；后端保持
// id/created_at 不变并刷新 updated_at。type 可选镜像后端 resolvedType
// 的宽松语义（空则默认 kafka），但调用方必须显式携带原类型：否则编辑
// redis/clickhouse 连接会被后端当成 kafka 处理（store 层已固定透传）。
export interface UpdateConnectionRequest {
  id: string
  name: string
  type?: ConnectionType
  config: KafkaConfig | RedisConfigShape | CHConfigShape | MysqlConfigShape | EsConfigShape | PostgresConfigShape
}

export interface Partition {
  id: number
  leader: number
  replicas: number[]
  isr: number[]
}

export interface Topic {
  name: string
  partitions: Partition[]
}

// A single whitelisted topic configuration entry surfaced by DescribeTopic.
export interface TopicConfigEntry {
  key: string
  value: string
}

// Partition topology plus key configs of one topic (mirrors model.TopicDetail).
export interface TopicDetail {
  name: string
  partitions: Partition[]
  configs: TopicConfigEntry[]
}

// Per-topic record counts derived from broker offsets (mirrors
// model.TopicMessageCounts). retained = records still within retention
// (sum of end-start); total = records ever produced (offsets survive
// retention deletion).
export interface TopicMessageCounts {
  retained: number
  total: number
}

// One broker surfaced by the cluster health panel.
export interface BrokerInfo {
  id: number
  host: string
  port: number
  rack: string
  version: string
  online: boolean
}

// Broker topology, controller, Kafka version and under-replicated partitions
// for one connection's cluster (mirrors model.ClusterHealth).
export interface ClusterHealth {
  cluster_id: string
  controller_id: number
  kafka_version: string
  brokers: BrokerInfo[]
  under_replicated_partitions: number
}

export interface Header {
  key: string
  value: string
}

export interface Message {
  partition: number
  offset: number
  timestamp: number
  key: string
  value: string
  headers: Header[]
}

export interface PartitionLag {
  partition: number
  current_offset: number
  log_end_offset: number
  lag: number
  member_id?: string
  client_id?: string
  client_host?: string
}

export interface ConsumerGroup {
  name: string
  state: string
  topics: Record<string, PartitionLag[]>
}

// One member of a consumer group with its per-topic partition assignment
// (mirrors model.GroupMember).
export interface GroupMember {
  member_id: string
  client_id: string
  host: string
  assignment: Record<string, number[]>
}

// State plus member topology of one consumer group (mirrors model.GroupDetail).
export interface GroupDetail {
  group: string
  state: string
  protocol_type: string
  members: GroupMember[]
}

// One row of the reset-offset dry-run preview. new_offset is null when the
// exact target is only computed by the broker at execution time (earliest and
// timestamp modes); latest previews the log end offset verbatim.
export interface ResetPreviewRow {
  partition: number
  current_offset: number
  new_offset: number | null
}

// 'offset' commits the caller-supplied per-partition targets (precise replay);
// the 'earliest'/'latest'/'timestamp' modes compute targets on the broker.
export type ResetOffsetMode = 'earliest' | 'latest' | 'timestamp' | 'offset'

export interface CreateTopicRequest {
  connection_id: string
  topic: string
  partitions: number
  replication_factor: number
}

export interface DeleteTopicRequest {
  connection_id: string
  topic: string
}

export interface DeleteTopicsRequest {
  connection_id: string
  names: string[]
}

// Entries to apply to a topic's whitelisted configs (mirrors the backend
// AlterTopicConfigRequest). Values are set verbatim; empty entries/values are
// rejected by the backend.
export interface AlterTopicConfigRequest {
  connection_id: string
  topic: string
  entries: TopicConfigEntry[]
}

// Grow a topic to a final partition count (mirrors the backend
// AlterTopicPartitionsRequest). Kafka cannot shrink partitions; targets below
// the current count are rejected by the backend.
export interface AlterTopicPartitionsRequest {
  connection_id: string
  topic: string
  partitions: number
}

// Per-topic outcome of a batch delete; error is empty on success
// (mirrors model.TopicDeleteResult).
export interface TopicDeleteResult {
  name: string
  error: string
}

export interface DeleteConsumerGroupRequest {
  connection_id: string
  group: string
}

export interface ConsumeRequest {
  connection_id: string
  topic: string
  partition: number
  offset: number
  timestamp_ms?: number
  limit: number
}

export interface ResetOffsetRequest {
  connection_id: string
  group: string
  topic: string
  mode: ResetOffsetMode
  timestamp_ms?: number
  // Explicit per-partition targets for mode 'offset'; ignored otherwise.
  per_partition_offsets?: Record<number, number>
}

// Request for the read-only reset-offset dry-run. The backend reuses the
// ResetOffsetRequest wire shape; group is context only and never altered.
export interface PreviewOffsetRequest {
  connection_id: string
  group: string
  topic: string
  mode: ResetOffsetMode
  timestamp_ms?: number
}

// Per-partition target offsets a reset would commit, keyed by partition
// (mirrors the backend map[int32]int64 return).
export type PreviewOffsetMap = Record<number, number>

export interface ProduceRequest {
  connection_id: string
  topic: string
  partition: number
  key: string
  value: string
}

// One record inside a batch produce request (mirrors model.BatchProduceMessage).
export interface BatchProduceMessage {
  key: string
  value: string
}

export interface BatchProduceRequest {
  connection_id: string
  topic: string
  partition: number
  messages: BatchProduceMessage[]
}

// Per-message outcome of a batch produce; error is empty on success
// (mirrors model.ProduceResult).
export interface ProduceResult {
  index: number
  partition: number
  offset: number
  error: string
}

// Offset sentinels matching model.OffsetEarliest / OffsetLatest.
export const OffsetEarliest = -2
export const OffsetLatest = -1

// One file to store through the backend's native save dialog (mirrors the
// backend SaveTextFileRequest). Exports must bypass the WebView: WKWebView
// silently drops <a download> clicks, so downloads go over the bridge.
export interface SaveTextFileRequest {
  filename: string
  content: string
  mime?: string
}

// --- 应用更新(镜像 backend/update.go) ---

export interface UpdateCheckRequest {
  current_version: string
}

export interface UpdateCheckResult {
  has_update: boolean
  latest_version: string
  notes?: string
  download_url?: string
}

export interface UpdateDownloadRequest {
  url: string
}

export interface UpdateProgressInfo {
  phase: 'idle' | 'downloading' | 'done' | 'error'
  percent: number
  error?: string
}

export interface ApplyUpdateRequest {}

export interface ActiveProducer {
  topic: string
  partition: number
  producer_id: number
  producer_epoch: number
  last_sequence: number
  last_timestamp: number
  leader: number
}

export interface ActiveConsumer {
  member_id: string
  client_id: string
  client_host: string
  partitions: number[]
}

export interface ActiveMembersRequest {
  connection_id: string
  group: string
  topic: string
}

// One row of the operation audit trail shown in the settings page
// (mirrors model.AuditEntry). result is 'ok' | 'error'.
export interface AuditEntry {
  id?: number
  connection_id: string
  action: string
  target: string
  result: string
  detail?: string
  timestamp: number // unix ms
}

// --- Redis(镜像 backend/model/redis.go) ---

export type RedisConfigShape = {
  addr: string
  password?: string
  db: number
  tls?: boolean
}

export interface RedisDBInfo {
  index: number
  keys: number
}

export interface RedisKeyInfo {
  key: string
  type: string
  ttl_seconds: number // -1 无过期,-2 不存在
  size_bytes: number // MEMORY USAGE,0 = 不可用
}

export interface RedisHashField {
  field: string
  value: string
}

export interface RedisZSetMember {
  member: string
  score: number
}

export interface RedisValue {
  key: string
  type: string
  ttl_seconds: number
  string?: string
  truncated?: boolean
  size_bytes?: number
  hash?: RedisHashField[]
  list?: string[]
  set?: string[]
  zset?: RedisZSetMember[]
}

export interface RedisNodeInfo {
  addr: string
  role: string
}

export interface RedisServerInfo {
  mode: 'standalone' | 'cluster'
  used_memory_human: string
  maxmemory_human?: string
  connected_clients: number
  total_keys: number
  hit_rate?: number | null
  nodes?: RedisNodeInfo[]
}

export interface RedisScanRequest {
  connection_id: string
  db: number
  cursor: number
  match: string
  count: number
}

export interface RedisScanResult {
  cursor: number
  keys: RedisKeyInfo[]
}

export interface RedisKeyRequest {
  connection_id: string
  db: number
  key: string
  new_key?: string
  ttl_seconds?: number
}

export interface RedisDeleteKeysRequest {
  connection_id: string
  db: number
  keys: string[]
}

export interface RedisSetStringRequest {
  connection_id: string
  db: number
  key: string
  value: string
  ttl_seconds?: number
}

export interface RedisFlushRequest {
  connection_id: string
  db: number
}

export interface RedisHashSetFieldRequest {
  connection_id: string
  db: number
  key: string
  field: string
  value: string
}

export interface RedisHashDeleteFieldRequest {
  connection_id: string
  db: number
  key: string
  field: string
}

export interface RedisListSetIndexRequest {
  connection_id: string
  db: number
  key: string
  index: number
  value: string
}

export interface RedisListPushRequest {
  connection_id: string
  db: number
  key: string
  value: string
  at_head?: boolean
}

export interface RedisListDeleteIndexRequest {
  connection_id: string
  db: number
  key: string
  index: number
}

export interface RedisSetAddRequest {
  connection_id: string
  db: number
  key: string
  member: string
}

export interface RedisSetRemoveRequest {
  connection_id: string
  db: number
  key: string
  member: string
}

export interface RedisZSetAddRequest {
  connection_id: string
  db: number
  key: string
  member: string
  score: number
}

export interface RedisZSetRemoveRequest {
  connection_id: string
  db: number
  key: string
  member: string
}

// --- ClickHouse(镜像 backend/model/clickhouse.go) ---

// 多节点部署:hosts 为原生 TCP 端口地址列表(如 node1:9000),与 Redis 的
// 单字符串 Addr 严格区分。password 缺省表示无密码。protocol 指定连接协议:
// native 为原生 TCP(默认端口 9000),http 为 HTTP 接口(默认端口 8123);
// 旧配置缺省时后端按 native 处理(用户把 8123 填进 native 会报
// handshake unexpected packet,应改选 http)。
export interface CHConfigShape {
  hosts: string[]
  username: string
  password?: string
  database: string
  tls?: boolean
  protocol?: 'native' | 'http'
}

export interface CHListTablesRequest {
  connection_id: string
  database: string
  // true 时包含 system.* 库;树/浏览器默认 false(后端同样默认过滤)。
  show_system: boolean
}

// 一张表:engine 为 system.tables.engine,total_rows 为近似行数(不可用时 0)。
export interface CHTableInfo {
  name: string
  engine: string
  total_rows: number
}

// 列头:列名 + ClickHouse 类型(如 UInt32 / String / Nullable(Int64));
// comment 为列注释(system.columns.comment),wire 形状 {name, type, comment?},
// 后端旧版本可能不返回,前端对空 comment 不渲染描述。
export interface CHColumn {
  name: string
  type: string
  comment?: string
}

export interface CHPageRowsRequest {
  connection_id: string
  database: string
  table: string
  // 用户输入的原生 WHERE 片段(不带 WHERE 关键字),空省略。
  where?: string
  order_by?: string
  asc?: boolean
  limit: number
  offset: number
}

// rows 单元格为 string 或 null(NULL);后端把非字符串列格式化为字符串。
// primary_key 为主键列名数组(按 position 序;空数组=无主键),供表浏览器
// 行内编辑决定 UPDATE 的 WHERE 范围;后端旧版本可能不返回,前端兜底为空。
export interface CHPageRowsResult {
  columns: CHColumn[]
  rows: (string | null)[][]
  engine: string
  total_rows: number
  primary_key?: string[]
}

export interface CHTruncateTableRequest {
  connection_id: string
  database: string
  table: string
  // Distributed 引擎时为 true,后端拼 ON CLUSTER。
  on_cluster?: boolean
}

export interface CHExecuteRequest {
  connection_id: string
  sql: string
}

// 多语句逐条返回:每条一条结果,失败语句带 error 文本;成功语句带列与行。
export interface CHStatementResult {
  sql: string
  duration_ms: number
  error?: string
  columns?: CHColumn[]
  rows?: (string | null)[][]
}

// --- MySQL / TiDB(镜像 backend/model/mysql.go) ---

// mysql 与 tidb 共用同一连接配置形状;port 由前端按类型预填(3306/4000)。
export interface MysqlConfigShape {
  host: string
  port: number
  username: string
  password: string
  database: string
  // disabled=明文;skip-verify=TLS 但跳过证书校验;verify-full=TLS + 校验。
  tls_mode: 'disabled' | 'skip-verify' | 'verify-full'
}

// 列头:列名 + 列类型(如 bigint / varchar(255),SQL 结果里可能为空);
// comment 为列注释(空 = 无描述,wire 省略);is_in_primary_key 标记该列
// 是否属于主键(information_schema.columns.column_key = 'PRI')。
export interface MysqlColumn {
  name: string
  type: string
  comment?: string
  is_in_primary_key: boolean
}

export interface MysqlListTablesRequest {
  connection_id: string
  database: string
}

// 一张表:engine 为存储引擎(如 InnoDB);table_rows 镜像
// information_schema.tables.table_rows,引擎无法给出近似行数时为 null。
export interface MysqlTableInfo {
  name: string
  engine: string
  table_rows: number | null
  comment?: string
}

export interface MysqlPageRowsRequest {
  connection_id: string
  database: string
  table: string
  // 用户输入的原生 WHERE 片段(不带 WHERE 关键字),空省略。
  where?: string
  order_by?: string
  asc?: boolean
  limit: number
  offset: number
}

// rows 单元格为 string 或 null(NULL);后端把非字符串列格式化为字符串。
// primary_key 为主键列名数组(按定义序;空数组=无主键),供表浏览器行内
// 编辑决定 UPDATE 的 WHERE 范围;total_rows 为精确行数(COUNT(*))。
export interface MysqlPageRowsResult {
  columns: MysqlColumn[]
  rows: (string | null)[][]
  total_rows: number
  primary_key: string[]
  engine: string
}

export interface MysqlExecuteRequest {
  connection_id: string
  sql: string
  // 非空时后端在该库上执行(等效 USE);空串原样传,由后端按连接默认库处理。
  database?: string
}

// 多语句逐条返回:每条一条结果,失败语句带 error 文本;成功语句带列与行。
export interface MysqlStatementResult {
  sql: string
  duration_ms: number
  error?: string
  columns?: MysqlColumn[]
  rows?: (string | null)[][]
}

export interface MysqlTruncateTableRequest {
  connection_id: string
  database: string
  table: string
}

// 单元格行内编辑的定位/目标描述(镜像 model.MysqlCellValue):value 为
// null 表示写 NULL;与 ClickHouse 不同,没有 Type 字段(执行全程参数化,
// 预览按字符串字面量渲染)。
export interface MysqlCellValue {
  column: string
  value: string | null
}

// where 只允许引用主键列(后端强制);database 为空表示连接的默认库。
export interface MysqlCellUpdateRequest {
  connection_id: string
  database: string
  table: string
  set: MysqlCellValue
  where: MysqlCellValue[]
}

// 预览返回:后端生成的展示语句全文 + 同 WHERE 条件的预计匹配行数
// (>1 需前端警示);实际更新执行参数化语句,不会运行这段文本。
export interface MysqlCellUpdatePreview {
  statement: string
  matched_rows: number
}

// --- Elasticsearch(镜像 backend/model/es.go) ---

// ES 连接配置:hosts 为 "host:port"(可带 http/https 前缀)地址列表,
// 地址自带端口,前端不做端口预填。auth_mode 决定携带哪组凭据:none 不携带、
// basic 用 username/password、apikey 用 api_key;非对应模式的凭据字段
// 保存空串。tls_mode 三档与 MySQL 一致:disabled 明文 HTTP;skip-verify
// 走 HTTPS 但跳过证书校验;verify-full 走 HTTPS 并校验证书。
export interface EsConfigShape {
  hosts: string[]
  username: string
  password: string
  api_key: string
  auth_mode: 'none' | 'basic' | 'apikey'
  tls_mode: 'disabled' | 'skip-verify' | 'verify-full'
}

// 一个索引:docs_count 为近似文档数(_cat indices 的 docs.count,不可用时 0),
// store_size_bytes 为索引存储占用字节数。
export interface EsIndexInfo {
  name: string
  docs_count: number
  store_size_bytes: number
}

// 列头:字段名 + ES 映射类型(text/keyword/long/date…);comment 可选,
// wire 缺省表示无描述。
export interface EsColumn {
  name: string
  type: string
  comment?: string
}

// 索引映射(字段清单):供表头渲染与 SQL 补全(表名→列名数组)使用。
export interface EsMappingRequest {
  connection_id: string
  index: string
}

export interface EsPageRowsRequest {
  connection_id: string
  index: string
  // 用户输入的原生过滤片段(ES query string 语义),空省略。
  where?: string
  order_by?: string
  asc?: boolean
  limit: number
  offset: number
}

// rows 单元格为 string 或 null(NULL/缺字段);后端把非字符串列格式化为
// 字符串。primary_key 为行标识列名数组(ES 即 ["_id"]),供表浏览器行内
// 编辑定位文档;engine 为索引主导出字段来源说明(空串 = 无)。
export interface EsPageRowsResult {
  columns: EsColumn[]
  rows: (string | null)[][]
  total_rows: number
  primary_key: string[]
  engine: string
}

export interface EsExecuteRequest {
  connection_id: string
  sql: string
}

// 多语句逐条返回:每条一条结果,失败语句带 error 文本;成功语句带列与行。
export interface EsStatementResult {
  sql: string
  duration_ms: number
  error?: string
  columns?: EsColumn[]
  rows?: (string | null)[][]
}

// 单元格行内编辑:按 _id 定位文档并更新单个字段;value 为 null 表示清空该
// 字段(写入 null),后端负责转义,前端禁止拼 DSL。
export interface EsCellUpdateRequest {
  connection_id: string
  index: string
  id: string
  column: string
  value: string | null
}

export interface EsGetDocRequest {
  connection_id: string
  index: string
  id: string
}

// 单个文档:id 为 _id,source 为 _source 的 JSON 文本(文档级编辑以 JSON
// 文本往返,由前端做展示与合法性校验)。
export interface EsDoc {
  id: string
  source: string
}

// Put 整文档覆盖写入:doc 为完整 _source 的 JSON 文本。
export interface EsPutDocRequest {
  connection_id: string
  index: string
  id: string
  doc: string
}

// 新增文档:id 留空 = POST /{index}/_doc 由 ES 自动生成;非空 = PUT
// /{index}/_doc/{id} 指定写入(同 _id 已存在则整文档覆盖)。doc_json 为
// 完整 _source 的 JSON 文本(合法性由前端 json.Valid 等价校验 + 服务端把关)。
export interface EsCreateDocRequest {
  connection_id: string
  index: string
  id?: string
  doc_json: string
}

export interface EsDeleteDocRequest {
  connection_id: string
  index: string
  id: string
}

// 按查询删除:query 为 ES 查询 DSL 的 JSON 文本(query 子对象),后端转发
// _delete_by_query;返回删除的文档数。
export interface EsDeleteByQueryRequest {
  connection_id: string
  index: string
  query: string
}

// 新建索引:shards/replicas 为主分片与副本数(后端再做 ≥1 下限保护)。
export interface EsCreateIndexRequest {
  connection_id: string
  index: string
  shards: number
  replicas: number
}

// 删除索引:危险操作,前端经确认对话框二次确认后调用。
export interface EsDeleteIndexRequest {
  connection_id: string
  index: string
}

// 修改索引设置:settings_json 为设置项 JSON 文本(当前用于调整
// number_of_replicas);解析与转义在后端,前端禁止拼 DSL。
export interface EsUpdateIndexSettingsRequest {
  connection_id: string
  index: string
  settings_json: string
}

// 删除索引模板:name 为模板名(与 listEsTemplates 返回项的 name 一致)。
export interface EsDeleteTemplateRequest {
  connection_id: string
  name: string
}

// 一个索引模板:name 为模板名,order 为模板合并顺序(越大优先级越高)
// (镜像 model.EsTemplateInfo)。
export interface EsTemplateInfo {
  name: string
  order: number
}

// 读取单个索引模板:与 listEsTemplates 返回项的 name 一致。
export interface EsGetTemplateRequest {
  connection_id: string
  name: string
}

// 模板正文:template_json 为模板定义的 JSON 文本(编辑往返不解析)。
export interface EsTemplateContent {
  template_json: string
}

// 新建/覆盖索引模板:template_json 为完整模板定义 JSON 文本,由后端转发,
// 前端禁止拼 DSL。
export interface EsPutTemplateRequest {
  connection_id: string
  name: string
  template_json: string
}

// 集群监控:一个 ES 节点摘要(镜像 model.EsNodeInfo);roles 为节点角色名
// 数组(如 master/data/ingest)。
export interface EsNodeInfo {
  name: string
  ip: string
  roles: string
  heap_percent: number
  disk_percent: number
}

// 集群健康总览(镜像 model.EsClusterStats):status 为 green/yellow/red;
// docs_count 为全集群文档总数,store_size_bytes 为全集群存储占用字节数。
export interface EsClusterStats {
  cluster_name: string
  status: string
  number_of_nodes: number
  number_of_data_nodes: number
  active_shards: number
  active_primary_shards: number
  relocating_shards: number
  unassigned_shards: number
  indices_count: number
  docs_count: number
  store_size_bytes: number
  templates_count: number
  nodes: EsNodeInfo[]
}

export interface EsClusterStatsRequest {
  connection_id: string
}

// 驱动管理页一行(镜像 model.DriverInfo):驱动为内置原生实现,
// 无需外部路径。
export interface DriverInfo {
  name: string
  library: string
  version: string
  default_port: number
  description: string
}

// --- SQL 查询库(保存的查询,镜像 backend/model.SavedQuery) ---

export interface SavedQuery {
  id: string
  name: string
  console_type: string // 'kafka-sql' | 'ch-sql'(后续扩展)
  connection_id: string
  content: string
  created_at: number
  updated_at: number
}

export interface ListSavedQueriesRequest {
  console_type?: string
  connection_id?: string
}

export interface SaveSavedQueryRequest {
  name: string
  console_type: string
  connection_id: string
  content: string
}

export interface UpdateSavedQueryRequest {
  id: string
  name: string
  content: string
}

export interface DeleteSavedQueryRequest {
  id: string
}

// --- PostgreSQL(镜像 backend/model/postgres.go) ---

// PG 连接配置:tls_mode 对应 libpq sslmode 的四档;search_path 为可选的
// 默认 schema 搜索路径;connect_timeout_ms 为连接超时(毫秒),前端按 5000 预填。
export interface PostgresConfigShape {
  host: string
  port: number
  username: string
  password: string
  database: string
  tls_mode: 'disable' | 'require' | 'verify-ca' | 'verify-full'
  search_path?: string
  connect_timeout_ms?: number
}

// 树节点与补全用的 relation 信息:与后端 model.PostgresTableInfo 对齐。
// relation_type/relation_kind 为语义类型,raw_relation_type 保留 pg_class
// relkind 原码;primary_key 供表浏览器行内编辑定位(视图无主键,缺省省略)。
export interface PostgresRelationInfo {
  schema: string
  relation: string
  relation_type: 'table' | 'view' | 'materialized_view'
  relation_kind: 'table' | 'view' | 'materialized_view'
  raw_relation_type?: string
  primary_key?: string[]
  comment?: string
}

export interface PostgresListSchemasRequest {
  connection_id: string
  database: string
}

export interface PostgresListTablesRequest {
  connection_id: string
  database: string
  schema: string
  // 是否包含系统 schema(默认 false,后端过滤 pg_catalog/information_schema)。
  include_system?: boolean
}

export interface PostgresColumn {
  name: string
  type: string
  // 该列是否属于主键(镜像 information_schema 约束信息),驱动表格编辑与角标。
  is_in_primary_key: boolean
}

export interface PostgresPageRowsRequest {
  connection_id: string
  database: string
  schema: string
  relation: string
  // 用户输入的原生 WHERE 片段(不带 WHERE 关键字),空省略。
  where?: string
  order_by?: string
  asc?: boolean
  limit: number
  offset: number
}

// rows 单元格为 string 或 null(NULL);primary_key 按定义序(空数组=无主键)。
export interface PostgresPageRowsResult {
  columns: PostgresColumn[]
  rows: (string | null)[][]
  primary_key: string[]
  total_rows: number
}

export interface PostgresExecuteRequest {
  connection_id: string
  sql: string
  database?: string
  schema?: string
}

// 多语句逐条返回:失败语句带 error;成功语句带列与行,单表 SELECT 附主键。
export interface PostgresStatementResult {
  statement: string
  duration_ms: number
  error?: string
  columns?: PostgresColumn[]
  rows?: (string | null)[][]
  affected_rows?: number
  has_rows: boolean
  primary_key?: string[]
}

export interface PostgresTruncateTableRequest {
  connection_id: string
  database: string
  schema: string
  relation: string
  // relation 类型:后端按类型生成 TRUNCATE/UPDATE 目标(视图不允许 TRUNCATE)。
  relation_kind: 'table' | 'view' | 'materialized_view'
}

// 单元格行内编辑的定位/写入描述;where 只允许引用主键列(后端强制)。
export interface PostgresCellValue {
  column: string
  value: string | null
}

export interface PostgresCellUpdateRequest {
  connection_id: string
  database: string
  schema: string
  relation: string
  relation_kind: 'table' | 'view' | 'materialized_view'
  set: PostgresCellValue
  where: PostgresCellValue[]
}

export interface PostgresCellUpdatePreview {
  statement: string
  matched_rows: number
}
