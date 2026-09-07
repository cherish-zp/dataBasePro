import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { RedisKeyInfo } from '@/api/types'
import RedisKeysView from './RedisKeysView.vue'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    updateConnection: vi.fn(async () => ({}) as never),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    alterTopicConfig: vi.fn(async () => {}),
    alterTopicPartitions: vi.fn(async () => {}),
    getTopicMessageCounts: vi.fn(async () => ({})),
    describeCluster: vi.fn(
      async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }) as never,
    ),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    previewResetOffset: vi.fn(async () => ({})),
    listAudit: vi.fn(async () => []),
    saveTextFile: vi.fn(async () => ''),
    checkUpdate: vi.fn(async () => ({ has_update: false, latest_version: 'v1.0.1' })),
    downloadUpdate: vi.fn(async () => {}),
    applyUpdate: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => ({ phase: 'idle' as const, percent: 0 })),
    openURL: vi.fn(async () => {}),
    redisHashSetField: vi.fn(async () => {}),
    redisHashDeleteField: vi.fn(async () => {}),
    redisListSetIndex: vi.fn(async () => {}),
    redisListPush: vi.fn(async () => {}),
    redisListDeleteIndex: vi.fn(async () => {}),
    redisSetAdd: vi.fn(async () => {}),
    redisSetRemove: vi.fn(async () => {}),
    redisZSetAdd: vi.fn(async () => {}),
    redisZSetRemove: vi.fn(async () => {}),
    testRedisConnection: vi.fn(async () => {}),
    listRedisDBs: vi.fn(async () => []),
    redisScan: vi.fn(async () => ({ cursor: 0, keys: [] })),
    redisGetKey: vi.fn(async () => ({ key: '', type: 'string', ttl_seconds: -1 })),
    redisRenameKey: vi.fn(async () => {}),
    redisDeleteKeys: vi.fn(async () => 0),
    redisSetTTL: vi.fn(async () => {}),
    redisSetString: vi.fn(async () => {}),
    redisFlushDB: vi.fn(async () => {}),
    redisFlushAll: vi.fn(async () => {}),
    redisServerInfo: vi.fn(async () => ({ mode: 'standalone' as const, used_memory_human: '', connected_clients: 0, total_keys: 0 })),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

const key = (k: string, type = 'string', ttl = -1, size = 0): RedisKeyInfo => ({ key: k, type, ttl_seconds: ttl, size_bytes: size })

describe('RedisKeysView', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
  })

  it('scans keys on mount and renders the key list with types', async () => {
    ;(api.redisScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 0,
      keys: [
        { key: 'greeting', type: 'string', ttl_seconds: -1, size_bytes: 120 },
        { key: 'user:1', type: 'hash', ttl_seconds: 60, size_bytes: 15360 },
      ],
    })
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 0 } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="redis-key-row"]')).toHaveLength(2)
    })
    const texts = wrapper.findAll('[data-test="redis-key-row"]').map((r) => r.text())
    expect(texts[0]).toContain('greeting')
    expect(texts[0]).toContain('120 B')
    expect(texts[1]).toContain('hash')
    expect(texts[1]).toContain('15 KB')  // 整数倍去尾零
    expect(api.redisScan).toHaveBeenCalledWith(
      expect.objectContaining({ connection_id: 'r1', db: 0, cursor: 0, match: '*', count: 50 }),
    )
  })

  it('shows the server summary from redisServerInfo', async () => {
    ;(api.redisServerInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      mode: 'standalone',
      used_memory_human: '1.2M',
      connected_clients: 4,
      total_keys: 12,
    })
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 0 } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="redis-summary"]').text()).toContain('1.2M')
      expect(wrapper.find('[data-test="redis-summary"]').text()).toContain('12')
    })
  })

  it('loads the selected key value on click', async () => {
    ;(api.redisScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 0,
      keys: [key('user:1', 'hash')],
    })
    ;(api.redisGetKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'user:1',
      type: 'hash',
      ttl_seconds: -1,
      hash: [
        { field: 'name', value: 'ann' },
        { field: 'age', value: '30' },
      ],
    })
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 0 } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="redis-key-row"]')).toHaveLength(1)
    })
    await wrapper.findAll('[data-test="redis-key-row"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(api.redisGetKey).toHaveBeenCalledWith(
        expect.objectContaining({ connection_id: 'r1', db: 0, key: 'user:1' }),
      )
      const panel = wrapper.find('[data-test="redis-value-panel"]')
      expect(panel.exists()).toBe(true)
      expect(panel.text()).toContain('name')
      expect(panel.text()).toContain('ann')
    })
  })

  it('deletes the selected key through the confirm dialog', async () => {
    ;(api.redisScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 0,
      keys: [key('greeting')],
    })
    const del = vi.fn(async () => 1)
    ;(api.redisDeleteKeys as ReturnType<typeof vi.fn>).mockImplementation(del)
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 0 } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="redis-key-row"]')).toHaveLength(1)
    })
    await wrapper.findAll('[data-test="redis-key-row"]')[0].trigger('click')
    await wrapper.find('[data-test="btn-key-delete"]').trigger('click')
    // 确认弹窗出现(teleport 到 body)
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-test="confirm-dialog"]')).not.toBeNull()
    })
    ;(document.body.querySelector('[data-test="confirm-dialog-ok"]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(del).toHaveBeenCalledWith({ connection_id: 'r1', db: 0, keys: ['greeting'] })
    })
  })

  it('edits and saves a string value', async () => {
    ;(api.redisScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 0,
      keys: [key('greeting')],
    })
    ;(api.redisGetKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'greeting',
      type: 'string',
      ttl_seconds: -1,
      string: 'hello',
    })
    const set = vi.fn(async () => {})
    ;(api.redisSetString as ReturnType<typeof vi.fn>).mockImplementation(set)
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 0 } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="redis-key-row"]')).toHaveLength(1)
    })
    await wrapper.findAll('[data-test="redis-key-row"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="redis-string-editor"]').exists()).toBe(true)
    })
    const editor = wrapper.find('[data-test="redis-string-editor"] textarea')
    await editor.setValue('world')
    await wrapper.find('[data-test="btn-string-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ connection_id: 'r1', db: 0, key: 'greeting', value: 'world' }),
      )
    })
  })

  it('flushes the db through the confirm dialog', async () => {
    const flush = vi.fn(async () => {})
    ;(api.redisFlushDB as ReturnType<typeof vi.fn>).mockImplementation(flush)
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 3 } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="btn-flushdb"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-flushdb"]').trigger('click')
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-test="confirm-dialog"]')).not.toBeNull()
    })
    ;(document.body.querySelector('[data-test="confirm-dialog-ok"]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(flush).toHaveBeenCalledWith({ connection_id: 'r1', db: 3 })
    })
  })

  // 挂载并选中一个键,redisGetKey 返回给定值(编辑类用例共用)。
  async function mountWithValue(val: { key: string; type: string } & Record<string, unknown>) {
    ;(api.redisScan as ReturnType<typeof vi.fn>).mockResolvedValue({
      cursor: 0,
      keys: [key(val.key, val.type)],
    })
    ;(api.redisGetKey as ReturnType<typeof vi.fn>).mockResolvedValue(val)
    const wrapper = mount(RedisKeysView, { props: { connectionId: 'r1', db: 0 } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="redis-key-row"]')).toHaveLength(1)
    })
    await wrapper.findAll('[data-test="redis-key-row"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="redis-value-panel"]').text()).toContain(val.key)
    })
    return wrapper
  }

  describe('集合类型值编辑', () => {
    it('hash:行内编辑字段调 redisHashSetField 并刷新', async () => {
      const setField = vi.fn(async () => {})
      ;(api.redisHashSetField as ReturnType<typeof vi.fn>).mockImplementation(setField)
      const wrapper = await mountWithValue({
        key: 'user:1', type: 'hash', ttl_seconds: -1,
        hash: [{ field: 'name', value: 'ann' }],
      })
      await wrapper.find('[data-test="redis-hash-edit-0"]').trigger('click')
      const hashEditor = wrapper.find('[data-test="input-hash-edit-value"]')
      expect(hashEditor.element.tagName).toBe('TEXTAREA')
      await hashEditor.setValue('ann2')
      await wrapper.find('[data-test="btn-hash-edit-ok"]').trigger('click')
      await vi.waitFor(() => {
        expect(setField).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'user:1', field: 'name', value: 'ann2' }),
        )
      })
      // 编辑后重新加载该 key(选中 1 次 + 刷新 1 次)
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('hash:底部添加字段调 redisHashSetField', async () => {
      const setField = vi.fn(async () => {})
      ;(api.redisHashSetField as ReturnType<typeof vi.fn>).mockImplementation(setField)
      const wrapper = await mountWithValue({
        key: 'user:1', type: 'hash', ttl_seconds: -1,
        hash: [{ field: 'name', value: 'ann' }],
      })
      await wrapper.find('[data-test="input-hash-add-field"]').setValue('age')
      await wrapper.find('[data-test="input-hash-add-value"]').setValue('30')
      await wrapper.find('[data-test="redis-hash-add-field"]').trigger('click')
      await vi.waitFor(() => {
        expect(setField).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'user:1', field: 'age', value: '30' }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('hash:删除字段调 redisHashDeleteField 并刷新', async () => {
      const delField = vi.fn(async () => {})
      ;(api.redisHashDeleteField as ReturnType<typeof vi.fn>).mockImplementation(delField)
      const wrapper = await mountWithValue({
        key: 'user:1', type: 'hash', ttl_seconds: -1,
        hash: [{ field: 'name', value: 'ann' }],
      })
      await wrapper.find('[data-test="redis-hash-del-0"]').trigger('click')
      await vi.waitFor(() => {
        expect(delField).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'user:1', field: 'name' }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('list:行内编辑下标调 redisListSetIndex 并刷新', async () => {
      const setIndex = vi.fn(async () => {})
      ;(api.redisListSetIndex as ReturnType<typeof vi.fn>).mockImplementation(setIndex)
      const wrapper = await mountWithValue({
        key: 'tasks', type: 'list', ttl_seconds: -1, list: ['a', 'b'],
      })
      await wrapper.find('[data-test="redis-list-edit-0"]').trigger('click')
      // 编辑器必须是全宽多行 textarea(单行 input 装不下长日志/JSON)。
      const editor = wrapper.find('[data-test="input-list-edit-value"]')
      expect(editor.element.tagName).toBe('TEXTAREA')
      await editor.setValue('a2')
      await wrapper.find('[data-test="btn-list-edit-ok"]').trigger('click')
      await vi.waitFor(() => {
        expect(setIndex).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'tasks', index: 0, value: 'a2' }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('list:追加元素调 redisListPush 且 at_head 未传(尾插)', async () => {
      const push = vi.fn(async () => {})
      ;(api.redisListPush as ReturnType<typeof vi.fn>).mockImplementation(push)
      const wrapper = await mountWithValue({
        key: 'tasks', type: 'list', ttl_seconds: -1, list: ['a', 'b'],
      })
      await wrapper.find('[data-test="input-list-add-value"]').setValue('c')
      await wrapper.find('[data-test="redis-list-add-value"]').trigger('click')
      await vi.waitFor(() => {
        expect(push).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'tasks', value: 'c' }),
        )
      })
      expect(((push.mock.calls[0] as unknown as [{ at_head?: boolean }])[0]).at_head).toBeFalsy()
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('list:删除下标调 redisListDeleteIndex 并刷新', async () => {
      const delIndex = vi.fn(async () => {})
      ;(api.redisListDeleteIndex as ReturnType<typeof vi.fn>).mockImplementation(delIndex)
      const wrapper = await mountWithValue({
        key: 'tasks', type: 'list', ttl_seconds: -1, list: ['a', 'b'],
      })
      await wrapper.find('[data-test="redis-list-del-1"]').trigger('click')
      await vi.waitFor(() => {
        expect(delIndex).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'tasks', index: 1 }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('set:添加成员调 redisSetAdd 并刷新', async () => {
      const add = vi.fn(async () => {})
      ;(api.redisSetAdd as ReturnType<typeof vi.fn>).mockImplementation(add)
      const wrapper = await mountWithValue({
        key: 'tags', type: 'set', ttl_seconds: -1, set: ['a', 'b'],
      })
      await wrapper.find('[data-test="input-set-add-member"]').setValue('c')
      await wrapper.find('[data-test="redis-set-add-member"]').trigger('click')
      await vi.waitFor(() => {
        expect(add).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'tags', member: 'c' }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('set:删除成员调 redisSetRemove 并刷新', async () => {
      const remove = vi.fn(async () => {})
      ;(api.redisSetRemove as ReturnType<typeof vi.fn>).mockImplementation(remove)
      const wrapper = await mountWithValue({
        key: 'tags', type: 'set', ttl_seconds: -1, set: ['a', 'b'],
      })
      await wrapper.find('[data-test="redis-set-del-0"]').trigger('click')
      await vi.waitFor(() => {
        expect(remove).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'tags', member: 'a' }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('zset:行内编辑成员调 redisZSetAdd(member+score)并刷新', async () => {
      const zadd = vi.fn(async () => {})
      ;(api.redisZSetAdd as ReturnType<typeof vi.fn>).mockImplementation(zadd)
      const wrapper = await mountWithValue({
        key: 'rank', type: 'zset', ttl_seconds: -1,
        zset: [{ member: 'alice', score: 1 }],
      })
      await wrapper.find('[data-test="redis-zset-edit-0"]').trigger('click')
      await wrapper.find('[data-test="input-zset-edit-member"]').setValue('alice2')
      await wrapper.find('[data-test="input-zset-edit-score"]').setValue('9.5')
      await wrapper.find('[data-test="btn-zset-edit-ok"]').trigger('click')
      await vi.waitFor(() => {
        expect(zadd).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'rank', member: 'alice2', score: 9.5 }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })

    it('zset:删除成员调 redisZSetRemove 并刷新', async () => {
      const zrem = vi.fn(async () => {})
      ;(api.redisZSetRemove as ReturnType<typeof vi.fn>).mockImplementation(zrem)
      const wrapper = await mountWithValue({
        key: 'rank', type: 'zset', ttl_seconds: -1,
        zset: [{ member: 'alice', score: 1 }],
      })
      await wrapper.find('[data-test="redis-zset-del-0"]').trigger('click')
      await vi.waitFor(() => {
        expect(zrem).toHaveBeenCalledWith(
          expect.objectContaining({ connection_id: 'r1', db: 0, key: 'rank', member: 'alice' }),
        )
      })
      expect(api.redisGetKey).toHaveBeenCalledTimes(2)
    })
  })
})
