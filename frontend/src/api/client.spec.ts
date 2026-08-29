import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../wailsjs/go/backend/App', () => ({
  ListTopics: vi.fn(async () => [{ name: 't1', partitions: [] }]),
  DescribeTopic: vi.fn(async () => ({
    name: 'orders',
    partitions: [{ id: 0, leader: 1, replicas: [1], isr: [1] }],
    configs: [{ key: 'retention.ms', value: '604800000' }],
  })),
  DescribeCluster: vi.fn(async () => ({
    cluster_id: 'kfake',
    controller_id: 0,
    kafka_version: 'v3.7',
    brokers: [],
    under_replicated_partitions: 0,
  })),
  ConsumeMessages: vi.fn(async () => [{ partition: 0, offset: 1, timestamp: 1, key: 'k', value: 'v', headers: [] }]),
  CreateConnection: vi.fn(async (c: unknown) => ({ id: 'x', ...(c as object) })),
  GetPartitionLag: vi.fn(async () => ({ 0: 5 })),
  ListConnections: vi.fn(async () => []),
  DescribeGroup: vi.fn(async () => ({ group: 'g1', state: 'Stable', protocol_type: 'consumer', members: [] })),
  DeleteTopics: vi.fn(async () => [{ name: 't1', error: '' }]),
  ListAudit: vi.fn(async () => [
    { connection_id: 'c1', action: 'create_topic', target: 't1', result: 'ok', timestamp: 1700000000000 },
  ]),
}))

import * as App from '../../wailsjs/go/backend/App'
import { WailsApi, getApi, setApi } from './client'
import type { ConsumeRequest, DeleteTopicsRequest } from './types'

const mocked = vi.mocked(App, true)

describe('WailsApi delegation', () => {
  const api = new WailsApi()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates listTopics with the connection id', async () => {
    const topics = await api.listTopics('conn-1')
    expect(mocked.ListTopics).toHaveBeenCalledWith('conn-1')
    expect(topics[0].name).toBe('t1')
  })

  it('delegates consumeMessages with the request payload', async () => {
    const req: ConsumeRequest = { connection_id: 'c', topic: 't', partition: 0, offset: -2, limit: 50 }
    const msgs = await api.consumeMessages(req)
    expect(mocked.ConsumeMessages).toHaveBeenCalledWith(req)
    expect(msgs[0].offset).toBe(1)
  })

  it('delegates getPartitionLag', async () => {
    const lag = await api.getPartitionLag('c', 't', 'g')
    expect(mocked.GetPartitionLag).toHaveBeenCalledWith('c', 't', 'g')
    expect(lag[0]).toBe(5)
  })

  it('delegates describeTopic with connection id and topic', async () => {
    const got = await api.describeTopic('c-1', 'orders')
    expect(mocked.DescribeTopic).toHaveBeenCalledWith('c-1', 'orders')
    expect(got.name).toBe('orders')
    expect(got.partitions[0].leader).toBe(1)
    expect(got.configs[0].key).toBe('retention.ms')
  })

  it('delegates describeCluster with the connection id', async () => {
    const got = await api.describeCluster('c-1')
    expect(mocked.DescribeCluster).toHaveBeenCalledWith('c-1')
    expect(got.cluster_id).toBe('kfake')
    expect(got.kafka_version).toBe('v3.7')
  })

  it('delegates describeGroup with the connection id and group', async () => {
    const got = await api.describeGroup('c-1', 'g1')
    expect(mocked.DescribeGroup).toHaveBeenCalledWith('c-1', 'g1')
    expect(got.group).toBe('g1')
    expect(got.state).toBe('Stable')
  })

  it('delegates deleteTopics with the request payload', async () => {
    const req: DeleteTopicsRequest = { connection_id: 'c', names: ['t1', 't2'] }
    const got = await api.deleteTopics(req)
    expect(mocked.DeleteTopics).toHaveBeenCalledWith(req)
    expect(got[0]).toEqual({ name: 't1', error: '' })
  })

  it('delegates listAudit, defaulting the limit to the store cap', async () => {
    const got = await api.listAudit()
    expect(mocked.ListAudit).toHaveBeenCalledWith(200)
    expect(got[0]).toMatchObject({ action: 'create_topic', result: 'ok' })
  })

  it('delegates listAudit with an explicit limit', async () => {
    await api.listAudit(50)
    expect(mocked.ListAudit).toHaveBeenCalledWith(50)
  })
})

describe('api holder', () => {
  it('defaults to the Wails api and can be swapped for tests', () => {
    expect(getApi()).toBeInstanceOf(WailsApi)
    const fake: WailsApi = {} as unknown as WailsApi
    setApi(fake)
    expect(getApi()).toBe(fake)
    setApi(new WailsApi())
  })
})
