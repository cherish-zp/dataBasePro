import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { CSV_MIME, JSONL_MIME } from '@/utils/export'
import { type InsertTarget } from '@/utils/insertSql'
import { useToastStore } from '@/store/toast'
import SqlResultCard from './SqlResultCard.vue'

// saveFile 打到后端/Wails,这里 mock 掉只断言参数;exportCsv/exportJsonl 用真实实现。
const saveFileMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/export', async () => {
  const actual = await vi.importActual<typeof import('@/utils/export')>('@/utils/export')
  return { ...actual, saveFile: saveFileMock }
})

const baseProps = {
  statement: 'SELECT * FROM t WHERE x = 1',
  durationMs: 12 as number | null,
  columns: [
    { name: 'id', type: 'Int32' },
    { name: 'name' },
  ],
  rows: [
    ['1', 'a'],
    [null, "O'Brien"],
  ] as (string | null)[][],
  insertTarget: { database: 'db1', table: 't1' } as InsertTarget | null,
  exportName: 'query-result',
}

function mountCard(overrides: Record<string, unknown> = {}): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(SqlResultCard, {
    props: { ...baseProps, ...overrides },
    global: { plugins: [pinia] },
  })
}

// jsdom 没有剪贴板,按用例注入/移除。
function useClipboard(writeText?: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })
}

const execCommandMock = vi.fn(() => true)

beforeEach(() => {
  saveFileMock.mockReset()
  useClipboard(undefined)
  execCommandMock.mockClear()
  Object.defineProperty(document, 'execCommand', {
    value: execCommandMock,
    configurable: true,
    writable: true,
  })
})

describe('SqlResultCard', () => {
  it('头部渲染:语句摘要、时长与行数、成功状态点', () => {
    const wrapper = mountCard()
    expect(wrapper.find('[data-test="result-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="result-toggle"]').text()).toContain('SELECT * FROM t WHERE x = 1')
    expect(wrapper.find('[data-test="result-meta"]').text()).toBe('12 ms · 2 行')
    expect(wrapper.find('[data-test="result-status-dot"].ok').exists()).toBe(true)
  })

  it('无时长/有错误时的状态点与 meta', () => {
    const wrapper = mountCard({ durationMs: null })
    expect(wrapper.find('[data-test="result-meta"]').text()).toBe('2 行')
    expect(wrapper.find('[data-test="result-status-dot"].none').exists()).toBe(true)
    const failed = mountCard({ error: 'boom' })
    expect(failed.find('[data-test="result-status-dot"].fail').exists()).toBe(true)
  })

  it('点击语句摘要展开全文,再次点击收起', async () => {
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-toggle"]').trigger('click')
    expect(wrapper.find('.stmt-full').text()).toBe('SELECT * FROM t WHERE x = 1')
    await wrapper.find('[data-test="result-toggle"]').trigger('click')
    expect(wrapper.find('.stmt-full').exists()).toBe(false)
  })

  it('错误结果:渲染错误卡(等宽文本 + 复制),不渲染表格', async () => {
    useClipboard(vi.fn(async () => undefined))
    const wrapper = mountCard({ error: 'Syntax error near FROM' })
    const errorCard = wrapper.find('[data-test="result-error"]')
    expect(errorCard.exists()).toBe(true)
    expect(errorCard.text()).toContain('Syntax error near FROM')
    expect(wrapper.find('[data-test="result-table"]').exists()).toBe(false)
    await wrapper.find('[data-test="result-error-copy"]').trigger('click')
    await flushPromises()
    expect(navigator.clipboard?.writeText).toHaveBeenCalledWith('Syntax error near FROM')
    expect(useToastStore().message).toBe('已复制错误信息')
  })

  it('复制为 INSERT:写入剪贴板并 toast', async () => {
    const writeText = vi.fn(async () => undefined)
    useClipboard(writeText)
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-copy-insert"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(
      "INSERT INTO `db1`.`t1` (`id`, `name`) VALUES\n(1, 'a'), (NULL, 'O''Brien');",
    )
    expect(useToastStore().message).toBe('已复制 INSERT 语句')
  })

  it('无 insertTarget:复制为 INSERT 禁用并提示仅单表可生成,点击不复制', async () => {
    const writeText = vi.fn(async () => undefined)
    useClipboard(writeText)
    const wrapper = mountCard({ insertTarget: null })
    const btn = wrapper.find('[data-test="result-copy-insert"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('仅单表查询结果可生成')
    await btn.trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('复制为 CSV:含表头与全部行,不带 BOM', async () => {
    const writeText = vi.fn(async () => undefined)
    useClipboard(writeText)
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-copy-csv"]').trigger('click')
    await flushPromises()
    // null → 空单元格;csvField 仅对含逗号/引号/换行的字段加引号。
    expect(writeText).toHaveBeenCalledWith("id,name\n1,a\n,O'Brien")
    expect(useToastStore().message).toBe('已复制 CSV')
  })

  it('clipboard.writeText 失败 → 降级 execCommand,仍 toast', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    useClipboard(writeText)
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-copy-csv"]').trigger('click')
    await flushPromises()
    expect(execCommandMock).toHaveBeenCalledWith('copy')
    expect(useToastStore().message).toBe('已复制 CSV')
  })

  it('无 clipboard API → 直接走 execCommand 降级', async () => {
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-copy-csv"]').trigger('click')
    await flushPromises()
    expect(execCommandMock).toHaveBeenCalledWith('copy')
    expect(useToastStore().message).toBe('已复制 CSV')
  })

  it('导出 CSV:saveFile(exportName, 带 BOM 的 CSV, text/csv)', async () => {
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-export-csv"]').trigger('click')
    await flushPromises()
    expect(saveFileMock).toHaveBeenCalledTimes(1)
    expect(saveFileMock).toHaveBeenCalledWith('query-result', "\uFEFFid,name\n1,a\n,O'Brien", CSV_MIME)
  })

  it('导出 JSONL:saveFile(exportName, 列名对象逐行 JSON, application/x-ndjson),null 保留', async () => {
    const wrapper = mountCard()
    await wrapper.find('[data-test="result-export-jsonl"]').trigger('click')
    await flushPromises()
    const expected = [
      { id: '1', name: 'a' },
      { id: null, name: "O'Brien" },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n')
    expect(saveFileMock).toHaveBeenCalledWith('query-result', expected, JSONL_MIME)
  })

  it('表格:行号 1 起、单元格悬浮全文、NULL 显示为空', () => {
    const wrapper = mountCard()
    const rows = wrapper.findAll('[data-test="result-row"]')
    expect(rows).toHaveLength(2)
    const cells0 = rows[0].findAll('td')
    expect(cells0[0].text()).toBe('1') // # 行号列
    expect(cells0[1].text()).toBe('1')
    expect(cells0[1].attributes('title')).toBe('1')
    const cells1 = rows[1].findAll('td')
    expect(cells1[1].text()).toBe('')
    expect(cells1[1].attributes('title')).toBe('NULL')
    expect(cells1[2].text()).toBe("O'Brien")
  })

  it('空行集:显示「0 行」,meta 为 0 行', () => {
    const wrapper = mountCard({ rows: [] })
    expect(wrapper.find('[data-test="result-empty"]').text()).toBe('0 行')
    expect(wrapper.find('[data-test="result-meta"]').text()).toBe('12 ms · 0 行')
  })

  it('单元格双击 emit cell-dblclick(row, col)', async () => {
    const wrapper = mountCard()
    const row1 = wrapper.findAll('[data-test="result-row"]')[1]
    await row1.findAll('td')[1].trigger('dblclick')
    expect(wrapper.emitted('cell-dblclick')?.[0]).toEqual([1, 0])
  })

  it('编辑态:匹配单元格渲染 input,回车提交原样值', async () => {
    const wrapper = mountCard({ editing: { row: 1, col: 1, draft: " new draft " } })
    const input = wrapper.find('[data-test="result-cell-editor"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe(' new draft ')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('edit-commit')?.[0]).toEqual([' new draft '])
  })

  it('编辑态:Esc 与 blur 均 emit edit-cancel,非匹配单元格无输入框', async () => {
    const wrapper = mountCard({ editing: { row: 0, col: 0, draft: 'x' } })
    const input = wrapper.find('[data-test="result-cell-editor"]')
    await input.trigger('keydown.esc')
    expect(wrapper.emitted('edit-cancel')).toHaveLength(1)
    await input.trigger('blur')
    expect(wrapper.emitted('edit-cancel')).toHaveLength(2)
  })

  it('编辑态:仅匹配的单元格渲染输入框', () => {
    const wrapper = mountCard({ editing: { row: 0, col: 0, draft: 'x' } })
    expect(wrapper.findAll('[data-test="result-cell-editor"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="result-row"] [data-test="result-cell-editor"]').exists()).toBe(true)
  })
})
