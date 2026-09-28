import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { MysqlTableColumn } from '@/api/types'
import MysqlTableStructure from './MysqlTableStructure.vue'

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
// setRowValue 修改第 index 行(0 起)的输入框:第一行通常是只读的主键列。
async function setRowValue(testId: string, index: number, value: string): Promise<void> {
  const el = document.body.querySelectorAll<HTMLInputElement>(`[data-test="${testId}"]`)[index]
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
// setRowChecked 修改第 index 行(0 起)的复选框勾选态(v-model 监听 change)。
async function setRowChecked(testId: string, index: number, checked: boolean): Promise<void> {
  const el = document.body.querySelectorAll<HTMLInputElement>(`[data-test="${testId}"]`)[index]
  el.checked = checked
  el.dispatchEvent(new Event('change', { bubbles: true }))
  await flushPromises()
}

const sampleColumns: MysqlTableColumn[] = [
  { name: 'id', column_type: 'bigint', data_type: 'bigint', nullable: false, default_value: null, extra: '', comment: '', is_primary_key: true },
  { name: 'note', column_type: 'varchar(64)', data_type: 'varchar', nullable: true, default_value: 'abc', extra: '', comment: '备注', is_primary_key: false },
  { name: 'memo', column_type: 'varchar(32)', data_type: 'varchar', nullable: true, default_value: null, extra: '', comment: '', is_primary_key: false },
]

// DEFAULT ''(空字符串默认值)与 DEFAULT NULL 混存的表:title 为空串默认值。
const emptyDefaultColumns: MysqlTableColumn[] = [
  { name: 'id', column_type: 'bigint', data_type: 'bigint', nullable: false, default_value: null, extra: '', comment: '', is_primary_key: true },
  { name: 'title', column_type: 'varchar(64)', data_type: 'varchar', nullable: false, default_value: '', extra: '', comment: '', is_primary_key: false },
  { name: 'note', column_type: 'varchar(64)', data_type: 'varchar', nullable: true, default_value: null, extra: '', comment: '', is_primary_key: false },
]

function mountDialog(mysqlTableColumns: Api['mysqlTableColumns'], mysqlAlterTable: Api['mysqlAlterTable']) {
  setApi(fakeApi({ mysqlTableColumns, mysqlAlterTable }))
  return mount(MysqlTableStructure, {
    props: { show: true, connectionId: 'my', database: 'shop', table: 'users' },
  })
}

describe('MysqlTableStructure', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('loads and renders columns with the pk mark and a collapsed DDL', async () => {
    const mysqlTableColumns = vi.fn(async () => ({ columns: sampleColumns, ddl: 'CREATE TABLE `users` (`id` bigint)' }))
    mountDialog(mysqlTableColumns as never, vi.fn(async () => {}))
    await flushPromises()
    expect(mysqlTableColumns).toHaveBeenCalledWith({ connection_id: 'my', database: 'shop', table: 'users' })
    const nameCells = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"] [data-test="column-name"]'))
    expect(nameCells.map((n) => n.textContent)).toEqual(['id', 'note', 'memo'])
    // 主键列只读,普通列可编辑。
    const typeInputs = document.body.querySelectorAll<HTMLInputElement>('[data-test="column-type"]')
    expect(typeInputs[0].disabled).toBe(true)
    expect(typeInputs[1].disabled).toBe(false)
    // DDL 默认折叠,点开可见原文。
    expect(dlgEl('structure-ddl')).toBeNull()
    dlgClick('btn-toggle-ddl')
    await flushPromises()
    expect(dlgEl('structure-ddl').textContent).toContain('CREATE TABLE `users`')
  })

  it('shows the load error with a retry that succeeds', async () => {
    const mysqlTableColumns = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ columns: sampleColumns, ddl: '' })
    mountDialog(mysqlTableColumns as never, vi.fn(async () => {}))
    await flushPromises()
    expect(dlgEl('structure-load-error').textContent).toContain('boom')
    dlgClick('btn-structure-retry')
    await flushPromises()
    expect(mysqlTableColumns).toHaveBeenCalledTimes(2)
    expect(document.body.querySelectorAll('[data-test="structure-column-row"]')).toHaveLength(3)
  })

  it('keeps 保存修改 disabled until a change is made', async () => {
    mountDialog(vi.fn(async () => ({ columns: sampleColumns, ddl: '' })) as never, vi.fn(async () => {}))
    await flushPromises()
    expect((dlgEl<HTMLButtonElement>('btn-structure-save')).disabled).toBe(true)
    // 第 1 行是只读主键列,改第 2 行(note)的注释。
    await setRowValue('column-comment', 1, '改过的注释')
    expect((dlgEl<HTMLButtonElement>('btn-structure-save')).disabled).toBe(false)
  })

  it('sends add/modify/drop diff groups to mysqlAlterTable and refetches on success', async () => {
    const mysqlTableColumns = vi.fn(async () => ({ columns: sampleColumns, ddl: '' }))
    const mysqlAlterTable = vi.fn(async () => {})
    mountDialog(mysqlTableColumns as never, mysqlAlterTable)
    await flushPromises()

    // 修改已有列类型 + 默认值(note 行,索引 1)。
    const typeInputs = document.body.querySelectorAll<HTMLInputElement>('[data-test="column-type"]')
    typeInputs[1].value = 'varchar(128)'
    typeInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    // 新增列(带 AFTER 位置)。
    dlgClick('btn-add-column')
    await flushPromises()
    await setRowValue('add-name', 0, 'age')
    await setRowValue('add-type', 0, 'int')
    const afterSel = dlgEl<HTMLSelectElement>('add-after')
    afterSel.value = 'note'
    afterSel.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    dlgClick('btn-confirm-add-column')
    // 移除已有列 memo。
    const dropButtons = document.body.querySelectorAll<HTMLButtonElement>('[data-test="btn-drop-column"]')
    dropButtons[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    dlgClick('btn-structure-save')
    await flushPromises()
    expect(mysqlAlterTable).toHaveBeenCalledWith({
      connection_id: 'my',
      database: 'shop',
      table: 'users',
      add_columns: [
        { name: 'age', column_type: 'int', nullable: true, default_value: null, comment: '', auto_increment: false, after: 'note' },
      ],
      modify_columns: [
        { name: 'note', column_type: 'varchar(128)', nullable: true, default_value: 'abc', comment: '备注', auto_increment: false, after: null },
      ],
      drop_columns: ['memo'],
    })
    // 保存成功后重拉列清单并提示。
    expect(mysqlTableColumns).toHaveBeenCalledTimes(2)
    expect(dlgEl('structure-saved').textContent).toContain('表结构已更新')
    expect(dlgEl('structure-save-error')).toBeNull()
  })

  it('keeps the save error inside the dialog when mysqlAlterTable fails', async () => {
    const mysqlAlterTable = vi.fn(async () => {
      throw new Error('alter boom')
    })
    mountDialog(vi.fn(async () => ({ columns: sampleColumns, ddl: '' })) as never, mysqlAlterTable)
    await flushPromises()
    await setRowValue('column-comment', 1, '改过的注释')
    dlgClick('btn-structure-save')
    await flushPromises()
    expect(dlgEl('structure-save-error').textContent).toContain('alter boom')
  })

  // —— P1-4:默认值三态(NULL vs 空字符串)与零编辑保护 ——

  it('零编辑保存不产生 modify_columns:DEFAULT 空串列不被静默改成 NULL', async () => {
    const mysqlAlterTable = vi.fn(async () => {})
    mountDialog(vi.fn(async () => ({ columns: emptyDefaultColumns, ddl: '' })) as never, mysqlAlterTable)
    await flushPromises()
    // 未做任何编辑:保存按钮禁用,点击不发出 ALTER。
    expect((dlgEl<HTMLButtonElement>('btn-structure-save')).disabled).toBe(true)
    dlgClick('btn-structure-save')
    await flushPromises()
    expect(mysqlAlterTable).not.toHaveBeenCalled()
    // 编辑其他行(note 注释)后保存:title(DEFAULT '')不得进入 modify_columns。
    await setRowValue('column-comment', 2, '新注释')
    expect((dlgEl<HTMLButtonElement>('btn-structure-save')).disabled).toBe(false)
    dlgClick('btn-structure-save')
    await flushPromises()
    expect(mysqlAlterTable).toHaveBeenCalledTimes(1)
    expect(mysqlAlterTable).toHaveBeenCalledWith(
      expect.objectContaining({
        modify_columns: [expect.objectContaining({ name: 'note' })],
      }),
    )
  })

  it('勾选 NULL 把 DEFAULT 空串列改为无默认值(default_value null)', async () => {
    const mysqlAlterTable = vi.fn(async () => {})
    mountDialog(vi.fn(async () => ({ columns: emptyDefaultColumns, ddl: '' })) as never, mysqlAlterTable)
    await flushPromises()
    await setRowChecked('column-no-default', 1, true)
    dlgClick('btn-structure-save')
    await flushPromises()
    expect(mysqlAlterTable).toHaveBeenCalledWith(
      expect.objectContaining({
        modify_columns: [expect.objectContaining({ name: 'title', default_value: null })],
      }),
    )
  })

  it('取消勾选 NULL 并留空输入框 = 空字符串默认值(default_value 空串)', async () => {
    const mysqlAlterTable = vi.fn(async () => {})
    mountDialog(vi.fn(async () => ({ columns: emptyDefaultColumns, ddl: '' })) as never, mysqlAlterTable)
    await flushPromises()
    // note 行原本 default_value null → 勾选态,输入框禁用;取消勾选后恢复可输入。
    expect(document.body.querySelectorAll<HTMLInputElement>('[data-test="column-default"]')[2].disabled).toBe(true)
    await setRowChecked('column-no-default', 2, false)
    expect(document.body.querySelectorAll<HTMLInputElement>('[data-test="column-default"]')[2].disabled).toBe(false)
    dlgClick('btn-structure-save')
    await flushPromises()
    expect(mysqlAlterTable).toHaveBeenCalledWith(
      expect.objectContaining({
        modify_columns: [expect.objectContaining({ name: 'note', default_value: '' })],
      }),
    )
  })

  it('取消勾选 NULL 并输入字面量时原样发送(default_value foo)', async () => {
    const mysqlAlterTable = vi.fn(async () => {})
    mountDialog(vi.fn(async () => ({ columns: emptyDefaultColumns, ddl: '' })) as never, mysqlAlterTable)
    await flushPromises()
    await setRowChecked('column-no-default', 2, false)
    await setRowValue('column-default', 2, 'foo')
    dlgClick('btn-structure-save')
    await flushPromises()
    expect(mysqlAlterTable).toHaveBeenCalledWith(
      expect.objectContaining({
        modify_columns: [expect.objectContaining({ name: 'note', default_value: 'foo' })],
      }),
    )
  })

  // —— P2-10:主键列不允许在此移除 ——

  it('主键行移除按钮禁用且点击不标记 toDrop', async () => {
    const mysqlAlterTable = vi.fn(async () => {})
    mountDialog(vi.fn(async () => ({ columns: sampleColumns, ddl: '' })) as never, mysqlAlterTable)
    await flushPromises()
    const dropBtn = document.body.querySelectorAll<HTMLButtonElement>('[data-test="btn-drop-column"]')[0]
    expect(dropBtn.disabled).toBe(true)
    expect(dropBtn.title).toContain('主键列不支持在此删除')
    dropBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    const pkRow = document.body.querySelectorAll('[data-test="structure-column-row"]')[0]
    expect(pkRow.classList.contains('row-drop')).toBe(false)
    expect((dlgEl<HTMLButtonElement>('btn-structure-save')).disabled).toBe(true)
    expect(mysqlAlterTable).not.toHaveBeenCalled()
  })
})
