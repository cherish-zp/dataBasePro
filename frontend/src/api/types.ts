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
