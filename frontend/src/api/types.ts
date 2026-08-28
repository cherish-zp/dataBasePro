// Types mirroring the Go model package (snake_case JSON fields).

export type ConnectionType = 'kafka' | 'mysql' | 'es'

export interface SASLConfig {
  enabled: boolean
  mechanism: string
  username: string
  password: string
}

export interface TLSConfig {
  enabled: boolean
  ca_cert?: string
  insecure_skip_verify?: boolean
}

export interface KafkaConfig {
  bootstrap_servers: string[]
  sasl?: SASLConfig
  tls?: TLSConfig
}

export interface Connection {
  id: string
  name: string
  type: ConnectionType
  config: KafkaConfig
  created_at: number
  updated_at: number
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

export type ResetOffsetMode = 'earliest' | 'latest' | 'timestamp'

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
}

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
