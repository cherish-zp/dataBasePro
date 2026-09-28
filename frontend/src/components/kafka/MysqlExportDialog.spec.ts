import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import { saveFile } from '@/utils/export'
import { useToastStore } from '@/store/toast'
import MysqlExportDialog from './MysqlExportDialog.vue'

// saveFile 走后端原生对话框,单测中 mock 掉并断言入参。
vi.mock('@/utils/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/export')>()
  return { ...actual, downloadFile: vi.fn(), saveFile: vi.fn(async () => {}) }
})

const STORAGE_KEY = 'dbclient-mysql-export-options'

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
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 })),
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

// 弹窗 Teleport 到 <body>,所有交互都走 document.body。
function dlgEl<T extends HTMLElement>(testId: string): T {
  return document.body.querySelector(`[data-test="${testId}"]`) as T
}
function dlgClick(testId: string): void {
  dlgEl(testId).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
function dlgInput<T extends HTMLInputElement>(testId: string): T {
  return dlgEl<T>(testId)
}
async function setChecked(testId: string, checked: boolean): Promise<void> {
  const el = dlgEl<HTMLInputElement>(testId)
  el.checked = checked
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
}
async function setValue(testId: string, value: string): Promise<void> {
  const el = dlgEl<HTMLInputElement>(testId)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
let mounted: ReturnType<typeof mount> | null = null
// mountDialog 挂载弹窗;重挂载前先卸载上一个实例,避免 Teleport 的旧 DOM
// 残留导致 dlgEl 命中陈旧节点。
function mountDialog(mysqlExportTable: Api['mysqlExportTable'] = vi.fn(async () => ({ filename: 'users.sql', content: 'CREATE TABLE `users` (`id` int);' }))) {
  mounted?.unmount()
  mounted = null
  setApi(fakeApi({ mysqlExportTable }))
  mounted = mount(MysqlExportDialog, {
    props: { show: true, connectionId: 'my', database: 'shop', table: 'users' },
  })
  return mounted
}

describe('MysqlExportDialog', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
  })

  it('renders defaults: ddl and data checked, multi-row insert selected, extra options unchecked', () => {
    mountDialog()
    expect(document.body.querySelector('[data-test="mysql-export-dialog"]')).not.toBeNull()
    // 标题 + db.table 副标题。
    expect(document.body.querySelector('[data-test="mysql-export-dialog"]')?.textContent).toContain('导出表')
    expect(document.body.querySelector('[data-test="mysql-export-dialog"]')?.textContent).toContain('shop.users')
    expect(dlgInput('export-opt-ddl').checked).toBe(true)
    expect(dlgInput('export-opt-data').checked).toBe(true)
    expect(dlgInput('export-opt-create-db').checked).toBe(false)
    expect(dlgInput('export-opt-drop').checked).toBe(false)
    expect(dlgInput('export-opt-strip-auto-increment').checked).toBe(false)
    expect(dlgInput('export-opt-insert-multi').checked).toBe(true)
    expect(dlgInput('export-opt-insert-per-row').checked).toBe(false)
    expect(dlgInput('export-opt-data-limit').value).toBe('')
    expect(dlgInput('export-opt-data-limit').placeholder).toBe('留空 = 不限制')
    // 默认状态下导出按钮可用。
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables export and shows a hint when both ddl and data are unchecked', async () => {
    mountDialog()
    await setChecked('export-opt-ddl', false)
    await setChecked('export-opt-data', false)
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).disabled).toBe(true)
    // 重新勾选任一项即恢复可用。
    await setChecked('export-opt-ddl', true)
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('sends the full payload with defaults and no data_limit when the field is empty, then closes', async () => {
    const mysqlExportTable = vi.fn(async () => ({ filename: 'users_20260928.sql', content: 'CREATE TABLE `users` (`id` int);' }))
    const wrapper = mountDialog(mysqlExportTable)
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(mysqlExportTable).toHaveBeenCalledTimes(1)
    expect(mysqlExportTable).toHaveBeenCalledWith({
      connection_id: 'my',
      database: 'shop',
      table: 'users',
      include_ddl: true,
      include_data: true,
      insert_per_row: false,
      drop_table_if_exists: false,
      strip_auto_increment: false,
      include_create_db: false,
    })
    expect(vi.mocked(saveFile)).toHaveBeenCalledWith('users_20260928.sql', 'CREATE TABLE `users` (`id` int);', 'application/sql')
    expect(wrapper.emitted('close')).toBeTruthy()
    // 发起导出前展示 toast 提示(大表耗时)。
    expect(useToastStore().message).toBe('正在导出表 shop.users（大表可能需要一些时间）…')
  })

  it('passes every option through the payload including data_limit and per-row insert', async () => {
    const mysqlExportTable = vi.fn(async () => ({ filename: 'users.sql', content: '--' }))
    mountDialog(mysqlExportTable)
    await setChecked('export-opt-ddl', false)
    await setChecked('export-opt-create-db', true)
    await setChecked('export-opt-drop', true)
    await setChecked('export-opt-strip-auto-increment', true)
    await setChecked('export-opt-insert-per-row', true)
    await setValue('export-opt-data-limit', '500')
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(mysqlExportTable).toHaveBeenCalledWith({
      connection_id: 'my',
      database: 'shop',
      table: 'users',
      include_ddl: false,
      include_data: true,
      insert_per_row: true,
      drop_table_if_exists: true,
      strip_auto_increment: true,
      include_create_db: true,
      data_limit: 500,
    })
  })

  it('keeps the dialog open with the error shown and allows retrying after a failure', async () => {
    const mysqlExportTable = vi
      .fn()
      .mockRejectedValueOnce(new Error('dial tcp failed'))
      .mockResolvedValueOnce({ filename: 'users.sql', content: '--' })
    const wrapper = mountDialog(mysqlExportTable)
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(dlgEl('export-error').textContent).toBe('dial tcp failed')
    expect(document.body.querySelector('[data-test="mysql-export-dialog"]')).not.toBeNull()
    // 错误后可直接重试,成功后关闭。
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(mysqlExportTable).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(dlgEl('export-error')).toBeNull()
  })

  it('ignores a second export click while the first is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const mysqlExportTable = vi.fn(async () => {
      await gate
      return { filename: 'users.sql', content: '--' }
    })
    mountDialog(mysqlExportTable)
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(mysqlExportTable).toHaveBeenCalledTimes(1)
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).textContent).toContain('导出中')
    // busy 期间再点不重复发起;取消/遮罩也不关闭。
    dlgClick('btn-export-confirm')
    expect(mysqlExportTable).toHaveBeenCalledTimes(1)
    dlgClick('btn-export-cancel')
    expect(document.body.querySelector('[data-test="mysql-export-dialog"]')).not.toBeNull()
    release()
    await flushPromises()
    expect(vi.mocked(saveFile)).toHaveBeenCalled()
  })

  it('closes on cancel, ✕ and backdrop click when not busy', async () => {
    const wrapper = mountDialog()
    dlgClick('btn-export-cancel')
    expect(wrapper.emitted('close')).toBeTruthy()
    ;(document.body.querySelector('[data-test="mysql-export-dialog"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(wrapper.emitted('close')?.length).toBe(2)
  })

  it('persists the options after exporting and prefills them on the next mount', async () => {
    const mysqlExportTable = vi.fn(async () => ({ filename: 'users.sql', content: '--' }))
    const wrapper = mountDialog(mysqlExportTable)
    await setChecked('export-opt-ddl', false)
    await setChecked('export-opt-insert-per-row', true)
    await setChecked('export-opt-drop', true)
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(wrapper.emitted('close')).toBeTruthy()
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored).toEqual({
      include_ddl: false,
      include_data: true,
      insert_per_row: true,
      drop_table_if_exists: true,
      strip_auto_increment: false,
      include_create_db: false,
    })
    // 重新挂载:上次的选择被预填。
    mountDialog()
    expect(dlgInput('export-opt-ddl').checked).toBe(false)
    expect(dlgInput('export-opt-data').checked).toBe(true)
    expect(dlgInput('export-opt-insert-per-row').checked).toBe(true)
    expect(dlgInput('export-opt-drop').checked).toBe(true)
  })

  it('does not persist data_limit and leaves it empty on the next mount', async () => {
    const mysqlExportTable = vi.fn(async () => ({ filename: 'users.sql', content: '--' }))
    mountDialog(mysqlExportTable)
    await setValue('export-opt-data-limit', '42')
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).not.toHaveProperty('data_limit')
    mountDialog()
    expect(dlgInput('export-opt-data-limit').value).toBe('')
  })

  it('prefills defaults when the stored value is corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')
    mountDialog()
    expect(dlgInput('export-opt-ddl').checked).toBe(true)
    expect(dlgInput('export-opt-data').checked).toBe(true)
    expect(dlgInput('export-opt-insert-multi').checked).toBe(true)
  })

  it('disables export with a hint for an invalid data limit and omits it otherwise', async () => {
    const mysqlExportTable = vi.fn(async () => ({ filename: 'users.sql', content: '--' }))
    mountDialog(mysqlExportTable)
    await setValue('export-opt-data-limit', '-1')
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.querySelector('[data-test="mysql-export-dialog"]')?.textContent).toContain('数据行数上限')
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(mysqlExportTable).not.toHaveBeenCalled()
    // 改回合法值(0 = 不限制)后可导出,data_limit 以数字 0 传递。
    await setValue('export-opt-data-limit', '0')
    expect((dlgEl('btn-export-confirm') as HTMLButtonElement).disabled).toBe(false)
    dlgClick('btn-export-confirm')
    await flushPromises()
    expect(mysqlExportTable).toHaveBeenCalledWith(expect.objectContaining({ data_limit: 0 }))
  })
})
