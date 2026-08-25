import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../wailsjs/go/backend/App', () => ({
  ListTopics: vi.fn(async () => [{ name: 't1', partitions: [] }]),
  ConsumeMessages: vi.fn(async () => [{ partition: 0, offset: 1, timestamp: 1, key: 'k', value: 'v', headers: [] }]),
  CreateConnection: vi.fn(async (c: unknown) => ({ id: 'x', ...(c as object) })),
  GetPartitionLag: vi.fn(async () => ({ 0: 5 })),
  ListConnections: vi.fn(async () => []),
}))

import * as App from '../../wailsjs/go/backend/App'
import { WailsApi, getApi, setApi } from './client'
import type { ConsumeRequest } from './types'

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
