import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
import PostgresSqlConsole from './PostgresSqlConsole.vue'

// wailsjs 绑定尚未生成 Postgres 系列方法,测试整体替换该模块。
const appMocks = vi.hoisted(() => ({
  PostgresExecute: vi.fn(),
  PostgresPreviewCellUpdate: vi.fn(),
  PostgresUpdateCell: vi.fn(),
  ListPostgresTables: vi.fn(),
  ListPostgresDatabases: vi.fn(),
  ListPostgresSchemas: vi.fn(),
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', () => appMocks)
const app = appMocks

interface PgStatementResult {
  statement: string
  duration_ms: number
  error?: string
  columns?: { name: string; type: string }[]
  rows?: (string | null)[][]
  primary_key?: string[]
}

function selectResult(): PgStatementResult {
  return {
    statement: 'SELECT id, name FROM users',
    duration_ms: 3,
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
    ],
    rows: [
      ['1', 'alice'],
      ['2', 'bob'],
    ],
    primary_key: ['id'],
  }
}

function mountConsole(props: Record<string, unknown> = {}) {
  return mount(PostgresSqlConsole, {
    props: {
      tabId: 'postgres-sql:pg1:shop:public',
      connectionId: 'pg1',
      database: 'shop',
      schema: 'public',
      ...props,
    },
    attachTo: document.body,
  })
}

function cmInput(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="pg-sql-input"] .cm-editor').element as HTMLElement
  const view = EditorView.findFromDOM(host)
  expect(view, 'EditorView.findFromDOM 应能取到实例').not.toBeNull()
  return view as EditorView
}

async function typeSql(wrapper: VueWrapper, text: string): Promise<void> {
  const view = cmInput(wrapper)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  await nextTick()
}

function pressRunShortcut(wrapper: VueWrapper, mods: { metaKey?: boolean; shiftKey?: boolean } = { metaKey: true }): void {
  cmInput(wrapper).contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', ...mods, bubbles: true }),
  )
}

function pressSaveShortcut(wrapper: VueWrapper): void {
  cmInput(wrapper).contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem(QUERY_DIR_KEY, '/Users/test/queries')
  appMocks.ListPostgresDatabases.mockResolvedValue(['shop', 'analytics'])
  appMocks.ListPostgresSchemas.mockResolvedValue(['public', 'app'])
  appMocks.ListPostgresTables.mockResolvedValue([
    { schema: 'public', relation: 'users', relation_type: 'table' },
    { schema: 'public', relation: 'orders', relation_type: 'table' },
  ])
  appMocks.PostgresExecute.mockResolvedValue([])
  appMocks.ListQueryFiles.mockResolvedValue([])
  appMocks.ReadQueryFile.mockResolvedValue({ content: '', connection_id: '' })
  appMocks.WriteQueryFile.mockResolvedValue(undefined)
  appMocks.DeleteQueryFile.mockResolvedValue(undefined)
})

describe('PostgresSqlConsole', () => {
  it('挂载时拉取库/schema/表清单,库与 schema 选择器按入口值预选', async () => {
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(appMocks.ListPostgresDatabases).toHaveBeenCalledWith('pg1')
      expect(appMocks.ListPostgresSchemas).toHaveBeenCalledWith({ connection_id: 'pg1', database: 'shop' })
      expect(appMocks.ListPostgresTables).toHaveBeenCalledWith({ connection_id: 'pg1', database: 'shop', schema: 'public' })
    })
    expect((wrapper.find('[data-test="pg-db-select"]').element as HTMLSelectElement).value).toBe('shop')
    expect((wrapper.find('[data-test="pg-schema-select"]').element as HTMLSelectElement).value).toBe('public')
  })

  it('运行全部把整段 SQL 连同 database/schema 发给 PostgresExecute,并渲染结果卡', async () => {
    appMocks.PostgresExecute.mockResolvedValue([selectResult()])
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id, name FROM users')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(appMocks.PostgresExecute).toHaveBeenCalledWith({
        connection_id: 'pg1',
        sql: 'SELECT id, name FROM users',
        database: 'shop',
        schema: 'public',
      })
    })
    await vi.waitFor(() => {
      expect(wrapper.findAllComponents(SqlResultCard)).toHaveLength(1)
    })
  })

  it('多语句结果逐条渲染失败/成功状态', async () => {
    appMocks.PostgresExecute.mockResolvedValue([
      selectResult(),
      { statement: 'SELECT 1/0', duration_ms: 1, error: 'division by zero' },
    ])
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id FROM users; SELECT 1/0;')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      const tabs = wrapper.findAll('[data-test^="result-tab-"]')
      expect(tabs).toHaveLength(2)
      expect(tabs[0].find('.tab-dot.fail').exists()).toBe(false)
      expect(tabs[1].find('.tab-dot.fail').exists()).toBe(true)
    })
  })

  it('切换 schema 后重拉表清单且后续执行携带新 schema', async () => {
    appMocks.PostgresExecute.mockResolvedValue([selectResult()])
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-schema-select"]').exists()).toBe(true)
    })
    await vi.waitFor(() => {
      const select = wrapper.find('[data-test="pg-schema-select"]').element as HTMLSelectElement
      expect(Array.from(select.options).some((o) => o.value === 'app')).toBe(true)
    })
    await wrapper.find('[data-test="pg-schema-select"]').setValue('app')
    await vi.waitFor(() => {
      expect(appMocks.ListPostgresTables).toHaveBeenLastCalledWith({ connection_id: 'pg1', database: 'shop', schema: 'app' })
    })
    await typeSql(wrapper, 'SELECT 1')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(appMocks.PostgresExecute).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: 'shop', schema: 'app' }),
      )
    })
  })

  it('⌘S 保存查询文件时携带 connection/database/schema', async () => {
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT 1')
    // 保存需要文件名:经 PromptDialog 输入并确认。
    pressSaveShortcut(wrapper)
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-test="prompt-input"]')).not.toBeNull()
    })
    const input = document.body.querySelector('[data-test="prompt-input"]') as HTMLInputElement
    input.value = 'pg-query'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => {
      expect((document.body.querySelector('[data-test="prompt-confirm"]') as HTMLButtonElement).disabled).toBe(false)
    })
    ;(document.body.querySelector('[data-test="prompt-confirm"]') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(appMocks.WriteQueryFile).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'pg-query.sql',
          connection_id: 'pg1',
          database: 'shop',
          schema: 'public',
        }),
      )
    })
  })

  it('单表 SELECT 结果可编辑:回车预览携带 schema/relation,确认后执行并刷新', async () => {
    appMocks.PostgresExecute.mockResolvedValue([selectResult()])
    appMocks.PostgresPreviewCellUpdate.mockResolvedValue({
      statement: "UPDATE public.users SET name = 'alice2' WHERE id = '1'",
      matched_rows: 1,
    })
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id, name FROM users')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(wrapper.findAllComponents(SqlResultCard)).toHaveLength(1)
    })
    const card = wrapper.findComponent(SqlResultCard)
    card.vm.$emit('cell-dblclick', 0, 1)
    await nextTick()
    card.vm.$emit('edit-commit', 'alice2')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledWith({
        connection_id: 'pg1',
        database: 'shop',
        schema: 'public',
        relation: 'users',
        relation_kind: 'table',
        set: { column: 'name', value: 'alice2' },
        // WHERE 只取主键列及其当前行值(后端仅允许主键列)。
        where: [{ column: 'id', value: '1' }],
      })
    })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-test="confirm-dialog"]')).not.toBeNull()
    })
    ;(document.body.querySelector('[data-test="confirm-dialog-ok"]') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(appMocks.PostgresUpdateCell).toHaveBeenCalled()
    })
    // 执行成功后按原语句刷新结果。
    await vi.waitFor(() => {
      expect(appMocks.PostgresExecute).toHaveBeenLastCalledWith(
        expect.objectContaining({ sql: 'SELECT id, name FROM users', schema: 'public' }),
      )
    })
  })

  it('执行失败在错误区展示错误信息', async () => {
    appMocks.PostgresExecute.mockRejectedValue(new Error('连接超时'))
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT 1')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-sql-error"]').text()).toContain('连接超时')
    })
  })
})

describe('主键编辑约束', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem(QUERY_DIR_KEY, '/Users/test/queries')
    appMocks.ListPostgresDatabases.mockResolvedValue(['shop'])
    appMocks.ListPostgresSchemas.mockResolvedValue(['public'])
    appMocks.ListPostgresTables.mockResolvedValue([
      { schema: 'public', relation: 'users', relation_type: 'table' },
    ])
    appMocks.PostgresExecute.mockResolvedValue([])
    appMocks.ListQueryFiles.mockResolvedValue([])
    appMocks.ReadQueryFile.mockResolvedValue({ content: '', connection_id: '' })
    appMocks.WriteQueryFile.mockResolvedValue(undefined)
    appMocks.DeleteQueryFile.mockResolvedValue(undefined)
  })

  it('无主键的单表 SELECT 结果整卡只读,不发起预览', async () => {
    appMocks.PostgresExecute.mockResolvedValue([
      {
        statement: 'SELECT id, name FROM users',
        duration_ms: 3,
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'name', type: 'text' },
        ],
        rows: [['1', 'alice']],
        primary_key: [],
      },
    ])
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id, name FROM users')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(wrapper.findAllComponents(SqlResultCard)).toHaveLength(1)
    })
    const card = wrapper.findComponent(SqlResultCard)
    card.vm.$emit('cell-dblclick', 0, 1)
    await nextTick()
    card.vm.$emit('edit-commit', 'x')
    await nextTick()
    // 无主键 → 不可编辑,预览与执行都不会发生。
    expect(appMocks.PostgresPreviewCellUpdate).not.toHaveBeenCalled()
    expect(appMocks.PostgresUpdateCell).not.toHaveBeenCalled()
  })

  it('主键值为 NULL 的行只读,不发起预览', async () => {
    appMocks.PostgresExecute.mockResolvedValue([
      {
        statement: 'SELECT id, name FROM users',
        duration_ms: 3,
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'name', type: 'text' },
        ],
        rows: [
          ['1', 'alice'],
          [null, 'bob'],
        ],
        primary_key: ['id'],
      },
    ])
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id, name FROM users')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(wrapper.findAllComponents(SqlResultCard)).toHaveLength(1)
    })
    const card = wrapper.findComponent(SqlResultCard)
    // 第 0 行主键值正常 → 可编辑并预览(only pk 列进 WHERE)。
    card.vm.$emit('cell-dblclick', 0, 1)
    await nextTick()
    card.vm.$emit('edit-commit', 'alice2')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ relation_kind: 'table', where: [{ column: 'id', value: '1' }] }),
      )
    })
    // 第 1 行主键值为 NULL → 只读。
    card.vm.$emit('cell-dblclick', 1, 1)
    await nextTick()
    card.vm.$emit('edit-commit', 'x')
    await nextTick()
    expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('上下文切换与 relation_kind 推导', () => {
  function exposedApi(wrapper: ReturnType<typeof mountConsole>) {
    return wrapper.vm as unknown as { loadQueryFile(name: string): void }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem(QUERY_DIR_KEY, '/Users/test/queries')
    appMocks.ListPostgresDatabases.mockResolvedValue(['shop', 'analytics'])
    appMocks.ListPostgresSchemas.mockResolvedValue(['public', 'app'])
    appMocks.ListPostgresTables.mockResolvedValue([
      { schema: 'public', relation: 'users', relation_type: 'table' },
    ])
    appMocks.PostgresExecute.mockResolvedValue([])
    appMocks.ListQueryFiles.mockResolvedValue([])
    appMocks.ReadQueryFile.mockResolvedValue({ content: '', connection_id: '' })
    appMocks.WriteQueryFile.mockResolvedValue(undefined)
    appMocks.DeleteQueryFile.mockResolvedValue(undefined)
  })

  it('载入文件头带 database+schema 时合并为一次上下文切换,不产生补全竞态', async () => {
    appMocks.ReadQueryFile.mockResolvedValue({
      content: 'SELECT 1',
      connection_id: 'pg1',
      database: 'analytics',
      schema: 'app',
    })
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      // 挂载期完成初始加载(库/schema/表各一次)。
      expect(appMocks.ListPostgresTables).toHaveBeenCalledTimes(1)
    })
    exposedApi(wrapper).loadQueryFile('ctx.sql')
    await vi.waitFor(() => {
      expect(appMocks.ListPostgresTables).toHaveBeenLastCalledWith({ connection_id: 'pg1', database: 'analytics', schema: 'app' })
    })
    await vi.waitFor(() => {
      // 文件载入只追加一轮加载:schema 清单与表清单各再多一次。
      expect(appMocks.ListPostgresSchemas).toHaveBeenCalledTimes(2)
      expect(appMocks.ListPostgresTables).toHaveBeenCalledTimes(2)
      expect(appMocks.ListPostgresSchemas).toHaveBeenLastCalledWith({ connection_id: 'pg1', database: 'analytics' })
    })
    // 编辑器内容已回填。
    const view = (await import('@codemirror/view')).EditorView
    const host = wrapper.find('[data-test="pg-sql-input"] .cm-editor').element as HTMLElement
    const editor = view.findFromDOM(host) as EditorView
    expect(editor.state.doc.toString()).toBe('SELECT 1')
  })

  it('文件头缺省 database/schema 时保持当前上下文不动', async () => {
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(appMocks.ListPostgresTables).toHaveBeenCalledTimes(1)
    })
    exposedApi(wrapper).loadQueryFile('plain.sql')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-sql-input"]').exists()).toBe(true)
    })
    // 无关联库/schema:不触发任何新一轮加载。
    expect(appMocks.ListPostgresSchemas).toHaveBeenCalledTimes(1)
    expect(appMocks.ListPostgresTables).toHaveBeenCalledTimes(1)
  })

  it('单元格编辑 relation_kind 从表清单元数据推导,不硬编码 table', async () => {
    appMocks.ListPostgresTables.mockResolvedValue([
      { schema: 'public', relation: 'users', relation_type: 'table' },
      { schema: 'public', relation: 'stats', relation_type: 'view', primary_key: ['id'] },
    ])
    appMocks.PostgresExecute.mockResolvedValue([
      {
        statement: 'SELECT id, name FROM stats',
        duration_ms: 3,
        columns: [
          { name: 'id', type: 'integer', is_in_primary_key: true },
          { name: 'name', type: 'text', is_in_primary_key: false },
        ],
        rows: [['1', 'x']],
        primary_key: ['id'],
      },
    ])
    appMocks.PostgresPreviewCellUpdate.mockResolvedValue({ statement: 'UPDATE 1', matched_rows: 1 })
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id, name FROM stats')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(wrapper.findAllComponents(SqlResultCard)).toHaveLength(1)
    })
    const card = wrapper.findComponent(SqlResultCard)
    card.vm.$emit('cell-dblclick', 0, 1)
    await nextTick()
    card.vm.$emit('edit-commit', 'y')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ relation: 'stats', relation_kind: 'view', where: [{ column: 'id', value: '1' }] }),
      )
    })
  })
})

describe('PG 专用语句拆分与代次守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem(QUERY_DIR_KEY, '/Users/test/queries')
    appMocks.ListPostgresDatabases.mockResolvedValue(['shop'])
    appMocks.ListPostgresSchemas.mockResolvedValue(['public'])
    appMocks.ListPostgresTables.mockResolvedValue([
      { schema: 'public', relation: 'users', relation_type: 'table' },
    ])
    appMocks.PostgresExecute.mockResolvedValue([])
    appMocks.ListQueryFiles.mockResolvedValue([])
    appMocks.ReadQueryFile.mockResolvedValue({ content: '', connection_id: '' })
    appMocks.WriteQueryFile.mockResolvedValue(undefined)
    appMocks.DeleteQueryFile.mockResolvedValue(undefined)
  })

  it('DO $$ 块内分号不拆分:状态栏语句计数按 PG 语义为 2', async () => {
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'DO $$ BEGIN PERFORM 1; RAISE NOTICE $$x$$; END $$; SELECT 1;')
    expect(wrapper.find('[data-test="statusbar-statements"]').text()).toContain('2 条')
  })

  it('跨 schema 同名关系按 schema+relation 组合键推导 relation_kind', async () => {
    appMocks.ListPostgresTables.mockResolvedValue([
      { schema: 'app', relation: 'users', relation_type: 'view', relation_kind: 'view' },
      { schema: 'public', relation: 'users', relation_type: 'table', relation_kind: 'table' },
    ])
    appMocks.PostgresExecute.mockResolvedValue([
      {
        statement: 'SELECT id FROM app.users',
        duration_ms: 3,
        columns: [
          { name: 'id', type: 'integer' },
        ],
        rows: [['1']],
        primary_key: ['id'],
      },
    ])
    appMocks.PostgresPreviewCellUpdate.mockResolvedValue({ statement: 'UPDATE 1', matched_rows: 1 })
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await typeSql(wrapper, 'SELECT id FROM app.users')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await vi.waitFor(() => {
      expect(wrapper.findAllComponents(SqlResultCard)).toHaveLength(1)
    })
    const card = wrapper.findComponent(SqlResultCard)
    card.vm.$emit('cell-dblclick', 0, 0)
    await nextTick()
    card.vm.$emit('edit-commit', '2')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ schema: 'app', relation: 'users', relation_kind: 'view' }),
      )
    })
  })

  it('快速切换 schema 时旧 schema 响应不覆盖新状态(代次守卫)', async () => {
    // 调用序列:1=挂载,2=切到 app2(挂起),3=切回 public(立即返回 final)。
    const resolvers: ((v: string[]) => void)[] = []
    let schemaCalls = 0
    appMocks.ListPostgresSchemas.mockImplementation(() => {
      schemaCalls += 1
      if (schemaCalls === 2) return new Promise<string[]>((resolve) => resolvers.push(resolve))
      return Promise.resolve(schemaCalls === 1 ? ['public', 'app2'] : ['final'])
    })
    const wrapper = mountConsole()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-db-select"]').exists()).toBe(true)
    })
    await vi.waitFor(() => {
      expect(schemaCalls).toBe(1)
    })
    await wrapper.find('[data-test="pg-schema-select"]').setValue('app2')
    await vi.waitFor(() => {
      expect(schemaCalls).toBe(2)
    })
    await wrapper.find('[data-test="pg-schema-select"]').setValue('public')
    await vi.waitFor(() => {
      expect(schemaCalls).toBe(3)
      expect(appMocks.ListPostgresTables).toHaveBeenLastCalledWith({ connection_id: 'pg1', database: 'shop', schema: 'public' })
    })
    // 挂起的第 2 次(旧)请求此刻才返回,不得覆盖第 3 次的 final。
    resolvers[0](['stale-schema'])
    await nextTick()
    await nextTick()
    const options = Array.from(
      (wrapper.find('[data-test="pg-schema-select"]').element as HTMLSelectElement).options,
    ).map((o) => o.value)
    expect(options).toContain('final')
    expect(options).not.toContain('stale-schema')
  })
})
