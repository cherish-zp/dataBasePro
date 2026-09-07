// Types mirroring the Go model package (snake_case JSON fields).

export type ConnectionType = 'kafka' | 'mysql' | 'es' | 'redis'

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
  // 按类型多态:kafka → KafkaConfig,redis → RedisConfigShape
  config: KafkaConfig | RedisConfigShape
  created_at: number
  updated_at: number
}

// 编辑已有连接的请求（镜像后端 UpdateConnectionRequest）：config 与
// CreateConnection 的 config 同形，id 定位已存在的连接；后端保持
// id/created_at 不变并刷新 updated_at。
export interface UpdateConnectionRequest {
  id: string
  name: string
  config: KafkaConfig
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
