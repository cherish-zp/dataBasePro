import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EsTemplatesPanel from './EsTemplatesPanel.vue'
import { useToastStore } from '@/store/toast'

// Es* 模板绑定尚未由 wails generate module 生成:组件按显式形状断言直连
// wailsjs,因此测试只在 wailsjs 模块层 mock(vi.mock 提升到文件顶部,fn
// 须用 vi.hoisted 创建避免 TDZ)。走 legacy /_template API(6.1 OSS 可用)。
const wailsMocks = vi.hoisted(() => ({
  ListEsTemplates: vi.fn(),
  GetEsTemplate: vi.fn(),
  PutEsTemplate: vi.fn(),
  DeleteEsTemplate: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...wailsMocks }
})

// 列表契约形状:name + order。
const tpl = (name: string, order = 0) => ({ name, order })

// ConfirmDialog Teleport 到 body,断言走 document。
function bodyDialog(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
function clickBody(testId: string): void {
  bodyDialog(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function mountPanel(connectionId = 'es1') {
  return mount(EsTemplatesPanel, { props: { connectionId } })
}

// 等列表渲染完成(第一项出现)再继续断言。
async function waitList(wrapper: ReturnType<typeof mount>, n = 2): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-test^="es-tpl-item-"]')).toHaveLength(n)
  })
}

describe('EsTemplatesPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    for (const fn of Object.values(wailsMocks)) fn.mockReset()
  })

  it('挂载拉取模板列表并渲染名称与 order 徽标', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template', 10), tpl('metrics-template', 0)])
    const wrapper = mountPanel()
    await waitList(wrapper)
    expect(wailsMocks.ListEsTemplates).toHaveBeenCalledWith('es1')
    const items = wrapper.findAll('[data-test^="es-tpl-item-"]')
    expect(items[0].text()).toContain('logs-template')
    expect(items[0].find('[data-test="es-tpl-order"]').text()).toBe('10')
    expect(items[1].text()).toContain('metrics-template')
    expect(items[1].find('[data-test="es-tpl-order"]').text()).toBe('0')
    // 未选中模板时右栏显示空态引导。
    expect(wrapper.find('[data-test="es-tpl-guide"]').exists()).toBe(true)
  })

  it('搜索框按名称模糊过滤列表', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template'), tpl('metrics-template'), tpl('logstash-policy')])
    const wrapper = mountPanel()
    await waitList(wrapper, 3)
    await wrapper.find('[data-test="es-tpl-search"]').setValue('log')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test^="es-tpl-item-"]')).toHaveLength(2)
    })
    expect(wrapper.findAll('[data-test^="es-tpl-item-"]').map((i) => i.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('logs-template'), expect.stringContaining('logstash-policy')]),
    )
    // 无匹配时给出提示。
    await wrapper.find('[data-test="es-tpl-search"]').setValue('zzz')
    expect(wrapper.find('[data-test="es-tpl-empty"]').text()).toBe('无匹配模板')
  })

  it('选中模板:调 GetEsTemplate 载入 pretty JSON,名称锁定,选中项高亮', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template', 10), tpl('metrics-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({
      template_json: '{"index_patterns":["log-*"],"order":10}',
    })
    const wrapper = mountPanel()
    await waitList(wrapper)
    await wrapper.find('[data-test="es-tpl-item-logs-template"]').trigger('click')
    await vi.waitFor(() => {
      expect(wailsMocks.GetEsTemplate).toHaveBeenCalledWith({ connection_id: 'es1', name: 'logs-template' })
    })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).not.toBe('')
    })
    const pretty = JSON.stringify({ index_patterns: ['log-*'], order: 10 }, null, 2)
    expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).toBe(pretty)
    // 名称输入框锁定为模板名。
    const name = wrapper.find('[data-test="es-tpl-name"]')
    expect((name.element as HTMLInputElement).value).toBe('logs-template')
    expect((name.element as HTMLInputElement).disabled).toBe(true)
    // 当前选中项高亮。
    expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).toContain('active')
    expect(wrapper.find('[data-test="es-tpl-item-metrics-template"]').classes()).not.toContain('active')
  })

  it('新建态:名称可编辑、编辑器清空;name 为空时保存禁用,补齐后保存下发 payload 并刷新列表', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([])
    wailsMocks.PutEsTemplate.mockResolvedValue(undefined)
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(1)
    })
    await wrapper.find('[data-test="es-tpl-new"]').trigger('click')
    const name = wrapper.find('[data-test="es-tpl-name"]')
    expect((name.element as HTMLInputElement).disabled).toBe(false)
    expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).toBe('')
    // name 为空:保存禁用。
    expect((wrapper.find('[data-test="es-tpl-save"]').element as HTMLButtonElement).disabled).toBe(true)
    await name.setValue('new-template')
    const body = '{"index_patterns":["app-*"]}'
    await wrapper.find('[data-test="es-tpl-editor"]').setValue(body)
    await wrapper.find('[data-test="es-tpl-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(wailsMocks.PutEsTemplate).toHaveBeenCalledWith({
        connection_id: 'es1',
        name: 'new-template',
        template_json: body,
      })
    })
    // 成功 toast + 刷新列表。
    expect(useToastStore().message).toBe('模板已保存')
    await vi.waitFor(() => {
      expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(2)
    })
  })

  it('编辑已有模板后保存:以锁定名称与当前编辑器内容整体替换', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({ template_json: '{"index_patterns":["log-*"]}' })
    wailsMocks.PutEsTemplate.mockResolvedValue(undefined)
    const wrapper = mountPanel()
    await waitList(wrapper, 1)
    await wrapper.find('[data-test="es-tpl-item-logs-template"]').trigger('click')
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).not.toBe('')
    })
    const body = JSON.stringify({ index_patterns: ['log-*'], order: 5 }, null, 2)
    await wrapper.find('[data-test="es-tpl-editor"]').setValue(body)
    await wrapper.find('[data-test="es-tpl-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(wailsMocks.PutEsTemplate).toHaveBeenCalledWith({
        connection_id: 'es1',
        name: 'logs-template',
        template_json: body,
      })
    })
  })

  it('JSON 语法错误由后端拒绝并在错误区展示', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([])
    wailsMocks.PutEsTemplate.mockRejectedValue(new Error('JSON 语法错误(400):unexpected token'))
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(1)
    })
    await wrapper.find('[data-test="es-tpl-new"]').trigger('click')
    await wrapper.find('[data-test="es-tpl-name"]').setValue('bad-template')
    await wrapper.find('[data-test="es-tpl-editor"]').setValue('{"index_patterns":')
    await wrapper.find('[data-test="es-tpl-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-tpl-error"]').text()).toContain('JSON 语法错误(400)')
    })
    // 失败不刷新列表(仅挂载时那一次)。
    expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(1)
  })

  it('删除确认链路:危险确认后 DeleteEsTemplate、清空编辑器并刷新列表', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({ template_json: '{"index_patterns":["log-*"]}' })
    wailsMocks.DeleteEsTemplate.mockResolvedValue(undefined)
    const wrapper = mountPanel()
    await waitList(wrapper, 1)
    await wrapper.find('[data-test="es-tpl-item-logs-template"]').trigger('click')
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).not.toBe('')
    })
    await wrapper.find('[data-test="es-tpl-delete"]').trigger('click')
    // 确认弹窗 Teleport 到 body,文案含模板名,确认按钮为危险样式。
    expect(bodyDialog('confirm-dialog')).not.toBeNull()
    const msg = bodyDialog('confirm-dialog-message')?.textContent ?? ''
    expect(msg).toContain('logs-template')
    expect(msg).toContain('删除')
    expect(bodyDialog('confirm-dialog-ok')?.className).toContain('danger')
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.DeleteEsTemplate).toHaveBeenCalledWith({ connection_id: 'es1', name: 'logs-template' })
    })
    // 编辑器清空回到空态引导,列表刷新。
    await vi.waitFor(() => {
      expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(2)
    })
    expect(wrapper.find('[data-test="es-tpl-guide"]').exists()).toBe(true)
    expect((wrapper.find('[data-test="es-tpl-editor"]').exists())).toBe(false)
  })

  it('删除确认取消:不执行、不刷新', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({ template_json: '{"index_patterns":["log-*"]}' })
    const wrapper = mountPanel()
    await waitList(wrapper, 1)
    await wrapper.find('[data-test="es-tpl-item-logs-template"]').trigger('click')
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).not.toBe('')
    })
    await wrapper.find('[data-test="es-tpl-delete"]').trigger('click')
    expect(bodyDialog('confirm-dialog')).not.toBeNull()
    clickBody('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(bodyDialog('confirm-dialog')).toBeNull()
    })
    expect(wailsMocks.DeleteEsTemplate).not.toHaveBeenCalled()
    expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(1)
  })

  it('空态引导:无模板时展示示例说明,一键填入进入新建态', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([])
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-tpl-guide"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="es-tpl-guide"]').text()).toContain('index_patterns')
    await wrapper.find('[data-test="es-tpl-sample"]').trigger('click')
    const editor = wrapper.find('[data-test="es-tpl-editor"]')
    const value = (editor.element as HTMLTextAreaElement).value
    expect(value).toContain('"index_patterns"')
    expect(value).toContain('log-*')
    // 填入示例即处于新建态:名称可编辑。
    expect((wrapper.find('[data-test="es-tpl-name"]').element as HTMLInputElement).disabled).toBe(false)
  })

  it('新建态删除按钮禁用,仅已有模板可删', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([])
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wailsMocks.ListEsTemplates).toHaveBeenCalledTimes(1)
    })
    await wrapper.find('[data-test="es-tpl-new"]').trigger('click')
    expect((wrapper.find('[data-test="es-tpl-delete"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('列表拉取失败在错误区展示', async () => {
    wailsMocks.ListEsTemplates.mockRejectedValue(new Error('连接超时'))
    const wrapper = mountPanel()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-tpl-error"]').text()).toContain('连接超时')
    })
  })

  // --- 树分段配套:newMode / initialTemplate 定位入口 ---------------------------

  it('newMode 进入新建态:名称可编辑、编辑器清空、列表无选中高亮', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    const wrapper = mount(EsTemplatesPanel, { props: { connectionId: 'es1', newMode: true } })
    await waitList(wrapper, 1)
    // 新建态显示编辑器而非空态引导。
    expect(wrapper.find('[data-test="es-tpl-guide"]').exists()).toBe(false)
    const name = wrapper.find('[data-test="es-tpl-name"]')
    expect((name.element as HTMLInputElement).disabled).toBe(false)
    expect((name.element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).toBe('')
    // 列表项不携带选中高亮。
    expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).not.toContain('active')
  })

  it('initialTemplate 自动选中该模板并载入内容', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template'), tpl('metrics-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({ template_json: '{"index_patterns":["log-*"]}' })
    const wrapper = mount(EsTemplatesPanel, {
      props: { connectionId: 'es1', initialTemplate: 'metrics-template' },
    })
    await waitList(wrapper, 2)
    await vi.waitFor(() => {
      expect(wailsMocks.GetEsTemplate).toHaveBeenCalledWith({ connection_id: 'es1', name: 'metrics-template' })
    })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).not.toBe('')
    })
    // 名称锁定为定位到的模板,选中项高亮。
    const name = wrapper.find('[data-test="es-tpl-name"]')
    expect((name.element as HTMLInputElement).value).toBe('metrics-template')
    expect((name.element as HTMLInputElement).disabled).toBe(true)
    expect(wrapper.find('[data-test="es-tpl-item-metrics-template"]').classes()).toContain('active')
    expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).not.toContain('active')
  })

  it('initialTemplate 不在列表中时忽略定位,维持空态引导', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    const wrapper = mount(EsTemplatesPanel, { props: { connectionId: 'es1', initialTemplate: 'ghost' } })
    await waitList(wrapper, 1)
    expect(wailsMocks.GetEsTemplate).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="es-tpl-guide"]').exists()).toBe(true)
  })

  it('props 变化响应:initialTemplate 切换到另一模板并重新载入', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template'), tpl('metrics-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({ template_json: '{"index_patterns":["x"]}' })
    const wrapper = mount(EsTemplatesPanel, {
      props: { connectionId: 'es1', initialTemplate: 'logs-template' },
    })
    await waitList(wrapper, 2)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).toContain('active')
    })
    // 同 tab 重复打开(:key 不变不重挂载),props 变化驱动切换选中。
    await wrapper.setProps({ initialTemplate: 'metrics-template' })
    await vi.waitFor(() => {
      expect(wailsMocks.GetEsTemplate).toHaveBeenCalledWith({ connection_id: 'es1', name: 'metrics-template' })
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-tpl-item-metrics-template"]').classes()).toContain('active')
    })
    expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).not.toContain('active')
  })

  it('props 变化响应:newMode 变 true 时进入新建态并清除选中', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    wailsMocks.GetEsTemplate.mockResolvedValue({ template_json: '{"index_patterns":["x"]}' })
    const wrapper = mount(EsTemplatesPanel, {
      props: { connectionId: 'es1', initialTemplate: 'logs-template' },
    })
    await waitList(wrapper, 1)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).toContain('active')
    })
    await wrapper.setProps({ initialTemplate: undefined, newMode: true })
    const name = wrapper.find('[data-test="es-tpl-name"]')
    expect((name.element as HTMLInputElement).disabled).toBe(false)
    expect((name.element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('[data-test="es-tpl-editor"]').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.find('[data-test="es-tpl-item-logs-template"]').classes()).not.toContain('active')
  })

  it('newMode 进入新建态后保存走正常保存链路', async () => {
    wailsMocks.ListEsTemplates.mockResolvedValue([tpl('logs-template')])
    wailsMocks.PutEsTemplate.mockResolvedValue(undefined)
    const wrapper = mount(EsTemplatesPanel, { props: { connectionId: 'es1', newMode: true } })
    await waitList(wrapper, 1)
    await wrapper.find('[data-test="es-tpl-name"]').setValue('fresh-template')
    const body = '{"index_patterns":["fresh-*"]}'
    await wrapper.find('[data-test="es-tpl-editor"]').setValue(body)
    await wrapper.find('[data-test="es-tpl-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(wailsMocks.PutEsTemplate).toHaveBeenCalledWith({
        connection_id: 'es1',
        name: 'fresh-template',
        template_json: body,
      })
    })
    expect(useToastStore().message).toBe('模板已保存')
  })
})
