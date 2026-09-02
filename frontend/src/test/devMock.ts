// 仅开发调试用:URL 带 ?mock 时注入假 API,让浏览器里无需 Wails 即可
// 渲染消费组视图等界面(生产构建 tree-shake 不到也不生效,入口处有
// import.meta.env.DEV 双重保险)。
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ConsumerGroup } from '@/api/types'

const groupNames = [
  'DataCollect11AnalyseDxltApp',
  'DsCuFile15DataRecognitionApp',
  'DsCuFile36DataKeyWordResultApp',
  'ISMS-CU',
  'MonitorLog4AnalyseDxltApp',
]

function groups(): ConsumerGroup[] {
  // 214 个组:与真实集群规模一致,专门复现「选项多时下拉压扁」。
  const out: ConsumerGroup[] = groupNames.map((name, i) => ({
    name,
    state: i % 2 === 0 ? 'Stable' : 'Empty',
    topics: { 't_ods_idc_monitor_result': [
      { partition: 0, current_offset: 278, log_end_offset: 100072, lag: 99794 },
      { partition: 1, current_offset: -1, log_end_offset: 1698, lag: 1699 },
    ] },
  }))
  for (let i = 0; i < 209; i++) {
    out.push({
      name: `console-consumer-${10000 + i * 7}`,
      state: 'Empty',
      topics: {},
    })
  }
  return out
}

export function installDevMock(): void {
  const api: Api = {
      listConnections: async () => [
        { id: 'mock', name: 'Mock 集群', type: 'kafka', config: { bootstrap_servers: ['mock:9092'] }, created_at: 1, updated_at: 1 },
      ],
      createConnection: async (c) => c,
      deleteConnection: async () => {},
      testConnection: async () => {},
      connect: async () => {},
      disconnect: async () => {},
      getConnection: async () => ({}) as never,
      listTopics: async () => [
        { name: 't_ods_idc_monitor_result', partitions: [{ id: 0, leader: 1, replicas: [1], isr: [1] }] },
      ],
      describeTopic: async () => ({ name: '', partitions: [], configs: [] }),
      alterTopicConfig: async () => {},
      alterTopicPartitions: async () => {},
      getTopicMessageCounts: async () => ({}),
      describeCluster: async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }),
      listConsumerGroups: async () => groups(),
      describeGroup: async () => ({ group: '', state: 'Stable', protocol_type: 'consumer', members: [] }),
      consumeMessages: async () => [],
      consumeMessagesByTimestamp: async () => [],
      getPartitionLag: async () => ({ 0: 99794, 1: 1699 }),
      listActiveProducers: async () => [],
      listActiveConsumers: async () => [],
      resetConsumerGroupOffset: async () => {},
      previewResetOffset: async () => ({}),
      produceMessage: async () => {},
      produceMessages: async () => [],
      listAudit: async () => [],
      saveTextFile: async () => '',
      updateConnection: async () => ({}) as never,
      createTopic: async () => {},
      deleteTopic: async () => {},
      deleteTopics: async () => [],
      deleteConsumerGroup: async () => {},
    }
    setApi(api)
}
