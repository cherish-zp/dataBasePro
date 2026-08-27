// Thin wrapper around the generated Wails bindings so stores/components can be
// tested by swapping the Api implementation via setApi().
import * as App from '../../wailsjs/go/backend/App'
import type {
  Connection,
  KafkaConfig,
  Topic,
  TopicDetail,
  ClusterHealth,
  ConsumerGroup,
  Message,
  ConsumeRequest,
  ResetOffsetRequest,
  ProduceRequest,
  CreateTopicRequest,
  DeleteTopicRequest,
  DeleteConsumerGroupRequest,
  ActiveMembersRequest,
  ActiveProducer,
  ActiveConsumer,
} from './types'

export interface Api {
  createConnection(conn: Connection): Promise<Connection>
  listConnections(): Promise<Connection[]>
  getConnection(id: string): Promise<Connection>
  deleteConnection(id: string): Promise<void>
  testConnection(cfg: KafkaConfig): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  listTopics(id: string): Promise<Topic[]>
  describeTopic(id: string, topic: string): Promise<TopicDetail>
  describeCluster(id: string): Promise<ClusterHealth>
  listConsumerGroups(id: string): Promise<ConsumerGroup[]>
  createTopic(req: CreateTopicRequest): Promise<void>
  deleteTopic(req: DeleteTopicRequest): Promise<void>
  deleteConsumerGroup(req: DeleteConsumerGroupRequest): Promise<void>
  consumeMessages(req: ConsumeRequest): Promise<Message[]>
  consumeMessagesByTimestamp(req: ConsumeRequest): Promise<Message[]>
  getPartitionLag(id: string, topic: string, group: string): Promise<Record<number, number>>
  listActiveProducers(req: ActiveMembersRequest): Promise<ActiveProducer[]>
  listActiveConsumers(req: ActiveMembersRequest): Promise<ActiveConsumer[]>
  resetConsumerGroupOffset(req: ResetOffsetRequest): Promise<void>
  produceMessage(req: ProduceRequest): Promise<void>
}

// The Wails binding generator models Go `[]byte` fields as `number[]`, but
// over JSON the transport delivers them as base64 strings. The backend model
// therefore exposes Message.Key/Value and Header.Value as `string` so the
// wire format matches our domain types and text (e.g. UTF-8 Chinese) is
// delivered verbatim instead of base64-encoded.
export class WailsApi implements Api {
  createConnection(conn: Connection): Promise<Connection> {
    return App.CreateConnection(conn as unknown as never) as unknown as Promise<Connection>
  }
  listConnections(): Promise<Connection[]> {
    return App.ListConnections() as unknown as Promise<Connection[]>
  }
  getConnection(id: string): Promise<Connection> {
    return App.GetConnection(id) as unknown as Promise<Connection>
  }
  deleteConnection(id: string): Promise<void> {
    return App.DeleteConnection(id)
  }
  testConnection(cfg: KafkaConfig): Promise<void> {
    return App.TestConnection(cfg as unknown as never) as unknown as Promise<void>
  }
  connect(id: string): Promise<void> {
    return App.Connect(id)
  }
  disconnect(id: string): Promise<void> {
    return App.Disconnect(id)
  }
  listTopics(id: string): Promise<Topic[]> {
    return App.ListTopics(id) as unknown as Promise<Topic[]>
  }
  describeTopic(id: string, topic: string): Promise<TopicDetail> {
    return App.DescribeTopic(id, topic) as unknown as Promise<TopicDetail>
  }
  describeCluster(id: string): Promise<ClusterHealth> {
    return App.DescribeCluster(id) as unknown as Promise<ClusterHealth>
  }
  listConsumerGroups(id: string): Promise<ConsumerGroup[]> {
    return App.ListConsumerGroups(id) as unknown as Promise<ConsumerGroup[]>
  }
  createTopic(req: CreateTopicRequest): Promise<void> {
    return App.CreateTopic(req) as unknown as Promise<void>
  }
  deleteTopic(req: DeleteTopicRequest): Promise<void> {
    return App.DeleteTopic(req) as unknown as Promise<void>
  }
  deleteConsumerGroup(req: DeleteConsumerGroupRequest): Promise<void> {
    return App.DeleteConsumerGroup(req) as unknown as Promise<void>
  }
  consumeMessages(req: ConsumeRequest): Promise<Message[]> {
    return App.ConsumeMessages(req) as unknown as Promise<Message[]>
  }
  consumeMessagesByTimestamp(req: ConsumeRequest): Promise<Message[]> {
    return App.ConsumeMessagesByTimestamp(req) as unknown as Promise<Message[]>
  }
  getPartitionLag(id: string, topic: string, group: string): Promise<Record<number, number>> {
    return App.GetPartitionLag(id, topic, group)
  }
  listActiveProducers(req: ActiveMembersRequest): Promise<ActiveProducer[]> {
    return App.ListActiveProducers(req) as unknown as Promise<ActiveProducer[]>
  }
  listActiveConsumers(req: ActiveMembersRequest): Promise<ActiveConsumer[]> {
    return App.ListActiveConsumers(req) as unknown as Promise<ActiveConsumer[]>
  }
  resetConsumerGroupOffset(req: ResetOffsetRequest): Promise<void> {
    return App.ResetConsumerGroupOffset(req)
  }
  produceMessage(req: ProduceRequest): Promise<void> {
    return App.ProduceMessage(req)
  }
}

let current: Api = new WailsApi()

export function getApi(): Api {
  return current
}

export function setApi(api: Api): void {
  current = api
}
