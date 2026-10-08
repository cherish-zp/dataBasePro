import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import App from './App.vue'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: "", partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: "", controller_id: -1, kafka_version: "", brokers: [], under_replicated_partitions: 0 })),
    alterTopicConfig: vi.fn(async () => {}),
    alterTopicPartitions: vi.fn(async () => {}),
    getTopicMessageCounts: vi.fn(async () => ({})),
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
        checkUpdate: vi.fn(async () => ({ has_update: false, latest_version: 'v1.0.0' })),
        downloadUpdate: vi.fn(async () => {}),
        applyUpdate: vi.fn(async () => {}),
        updateProgress: vi.fn(async () => ({ phase: 'idle' as const, percent: 0 })),
        openURL: vi.fn(async () => {}),
    listSavedQueries: vi.fn(async () => []),
    saveSavedQuery: vi.fn(async (q: never) => ({}) as never),
    updateSavedQuery: vi.fn(async () => ({}) as never),
    deleteSavedQuery: vi.fn(async () => {}),
        testCHConnection: vi.fn(async () => {}),
        listCHDatabases: vi.fn(async () => []),
        listCHTables: vi.fn(async () => []),
        chPageRows: vi.fn(async () => ({ columns: [], rows: [], engine: '', total_rows: 0 })),
        chTruncateTable: vi.fn(async () => {}),
        chExecute: vi.fn(async () => []),
        listDrivers: vi.fn(async () => []),
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
    saveTextFile: vi.fn(async () => ''),
    updateConnection: vi.fn(async () => ({}) as never),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

const conn = (id: string): Connection => ({
  id, name: `conn-${id}`, type: 'kafka',
  config: { bootstrap_servers: ['h:1'] }, sort_order: 0, created_at: 1, updated_at: 1,
})

function mountApp(overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(App)
  return { wrapper, api }
}

// The delete ConfirmDialog teleports to <body>, so it is queried on
// document.body rather than inside the wrapper (same as ConnectionTree.spec).
function confirmDialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="confirm-dialog"]')
}
function clickConfirmDialog(testId: string): void {
  document.body.querySelector(`[data-test="${testId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// 连接行内联操作按钮已收敛进右键菜单:右键 conn-row 打开菜单(teleport 到
// body),再从 document.body 点击菜单项(与 ConfirmDialog 同一查询惯例)。
async function openConnMenu(wrapper: VueWrapper, name: string): Promise<void> {
  const row = wrapper.findAll('[data-test="conn-row"]').find((n) => n.text().includes(name))
  if (!row) throw new Error(`conn-row not found: ${name}`)
  await row.trigger('contextmenu', { clientX: 10, clientY: 10 })
  await vi.waitFor(() => {
    expect(document.body.querySelector('[data-test="context-menu"]')).not.toBeNull()
  })
}
function clickCtxItem(key: string): void {
  (document.body.querySelector(`[data-test="context-item-${key}"]`) as HTMLElement).click()
}

describe('App', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  it('loads connections on mount and passes them to the layout', async () => {
    const { wrapper, api } = mountApp({ listConnections: vi.fn(async () => [conn('a')]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    expect(api.listConnections).toHaveBeenCalled()
    expect(wrapper.find('[data-test="layout"]').exists()).toBe(true)
  })

  it('opens and closes the new connection modal', async () => {
    const { wrapper } = mountApp()
    await wrapper.find('[data-test="btn-new"]').trigger('click')
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(true)
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(false)
  })

  it('creates a connection through the modal and shows it in the tree', async () => {
    const { wrapper, api } = mountApp()
    await wrapper.find('[data-test="btn-new"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('本地')
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await flushPromises()
    expect(api.createConnection).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    expect(wrapper.find('[data-test="conn-name"]').text()).toBe('本地')
  })

  it('asks for confirmation with the connection name before deleting', async () => {
    const { wrapper, api } = mountApp({ listConnections: vi.fn(async () => [conn('a')]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    await openConnMenu(wrapper, 'conn-a')
    clickCtxItem('conn-delete')
    await flushPromises()
    const dialog = confirmDialog()
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('conn-a')
    expect(dialog?.textContent).toContain('此操作不可恢复')
    // 取消:不删除,连接仍在,确认弹窗关闭。
    clickConfirmDialog('confirm-dialog-cancel')
    await flushPromises()
    expect(api.deleteConnection).not.toHaveBeenCalled()
    expect(confirmDialog()).toBeNull()
    expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
  })

  it('deletes a connection after confirming', async () => {
    const { wrapper, api } = mountApp({ listConnections: vi.fn(async () => [conn('a')]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    await openConnMenu(wrapper, 'conn-a')
    clickCtxItem('conn-delete')
    await flushPromises()
    expect(confirmDialog()).not.toBeNull()
    clickConfirmDialog('confirm-dialog-ok')
    await flushPromises()
    expect(api.deleteConnection).toHaveBeenCalledWith('a')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(0)
    })
  })

  it('opens the edit modal prefilled from the tree edit button and saves via updateConnection', async () => {
    const { wrapper, api } = mountApp({
      listConnections: vi.fn(async () => [conn('a')]),
      updateConnection: vi.fn(async (r: never) => ({ ...conn('a'), ...(r as object) })),
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })

    await openConnMenu(wrapper, 'conn-a')
    clickCtxItem('conn-edit')
    await flushPromises()
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="modal-title"]').text()).toBe('编辑连接')
    expect((wrapper.find('[data-test="input-name"]').element as HTMLInputElement).value).toBe('conn-a')
    expect((wrapper.find('[data-test="input-brokers"]').element as HTMLInputElement).value).toBe('h:1')

    await wrapper.find('[data-test="input-name"]').setValue('conn-a-renamed')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await flushPromises()
    expect(api.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', name: 'conn-a-renamed' }))
    expect(api.createConnection).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="conn-name"]').text()).toBe('conn-a-renamed')
    })
    // 保存成功后弹窗关闭。
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(false)
  })
})
