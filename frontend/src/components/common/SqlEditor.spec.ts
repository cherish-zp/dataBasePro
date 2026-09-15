import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { language } from '@codemirror/language'
import SqlEditor from './SqlEditor.vue'

// defineExpose 出来的方法(通过 wrapper.vm 访问)。
interface Exposed {
  focus: () => void
  getValue: () => string
  getSelection: () => string
}

// CM6 会在宿主容器内创建自己的 .cm-editor 元素,借 findFromDOM 拿到 view。
function cmView(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="sql-editor-content"] .cm-editor').element as HTMLElement
  const view = EditorView.findFromDOM(host)
  expect(view, 'EditorView.findFromDOM 应能取到实例').not.toBeNull()
  return view as EditorView
}

describe('SqlEditor', () => {
  it('挂载后渲染容器与 CM 编辑器', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: 'SELECT 1' } })
    expect(wrapper.find('[data-test="sql-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="sql-editor-content"] .cm-editor').exists()).toBe(true)
  })

  it('props.modelValue 外部变化 → 编辑器文档同步更新', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: 'SELECT 1' } })
    const vm = wrapper.vm as unknown as Exposed
    expect(vm.getValue()).toBe('SELECT 1')
    await wrapper.setProps({ modelValue: 'SELECT 2' })
    expect(vm.getValue()).toBe('SELECT 2')
    expect(cmView(wrapper).state.doc.toString()).toBe('SELECT 2')
  })

  it('编辑器文档变化 → emit update:modelValue', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: '' } })
    cmView(wrapper).dispatch({ changes: { from: 0, insert: 'SELECT 3' } })
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]).toEqual(['SELECT 3'])
  })

  it('父组件回写相同值不重复 emit(防回环),真正变化仍生效', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: 'A' } })
    cmView(wrapper).dispatch({ changes: { from: 0, insert: 'B' } })
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
    // v-model 回写,值与当前文档一致 → 不应再 emit。
    await wrapper.setProps({ modelValue: 'BA' })
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
    expect(cmView(wrapper).state.doc.toString()).toBe('BA')
    // 外部真正变化 → 文档替换。
    await wrapper.setProps({ modelValue: 'SELECT 9' })
    expect(cmView(wrapper).state.doc.toString()).toBe('SELECT 9')
  })

  it('传入 tables 后组件不崩且包含 SQL 语言扩展', () => {
    const wrapper = mount(SqlEditor, {
      props: {
        modelValue: 'SELECT a FROM t1',
        tables: [
          { name: 't1', columns: ['a', 'b'] },
          { name: 't2' },
        ],
      },
    })
    const lang = cmView(wrapper).state.facet(language)
    expect(lang?.name).toBe('sql')
  })

  it('未配置语言扩展的空组件不存在(冒烟:无 tables 也含 sql 扩展)', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: 'SELECT 1' } })
    expect(cmView(wrapper).state.facet(language)?.name).toBe('sql')
  })

  it('placeholder 在文档为空时渲染,非空时消失', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: '', placeholder: '输入 SQL…' } })
    expect(wrapper.find('.cm-placeholder').exists()).toBe(true)
    expect(wrapper.find('.cm-placeholder').text()).toBe('输入 SQL…')
    await wrapper.setProps({ modelValue: 'SELECT 1' })
    expect(wrapper.find('.cm-placeholder').exists()).toBe(false)
  })

  it('height prop 作用于内容区高度(默认 180px)', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: '' } })
    const content = wrapper.find('[data-test="sql-editor-content"]').element as HTMLElement
    expect(content.style.height).toBe('180px')
    await wrapper.setProps({ height: '300px' })
    expect(content.style.height).toBe('300px')
  })

  it('getSelection:无选区返回空串,有选区(含反向)返回选中文本', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: 'SELECT 1; SELECT 2' } })
    const vm = wrapper.vm as unknown as Exposed
    // 初始只有光标没有选区 → 空串。
    expect(vm.getSelection()).toBe('')
    // 正向选中 'SELECT 1'(0..8)。
    cmView(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
    expect(vm.getSelection()).toBe('SELECT 1')
    // 反向选中 'SELECT 2'(head 10 → anchor 18)。
    cmView(wrapper).dispatch({ selection: { anchor: 18, head: 10 } })
    expect(vm.getSelection()).toBe('SELECT 2')
  })

  it('暴露 focus(),且挂载时不主动抢占焦点', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: '' }, attachTo: document.body })
    const vm = wrapper.vm as unknown as Exposed
    await nextTick()
    expect(document.activeElement === cmView(wrapper).contentDOM).toBe(false)
    vm.focus()
    expect(document.activeElement === cmView(wrapper).contentDOM).toBe(true)
  })
})

// —— 语句级增强(▶ 运行槽 / 状态标记 / cursor 事件 / 光标语句高亮)——
describe('SqlEditor 语句级增强', () => {
  // seg1: from 0 to 9(含分号);seg2: from 10 to 18(尾句无分号)。
  const doc = 'SELECT 1;\nSELECT 2'

  it('statementGutter:每条语句首行渲染 ▶,点击 emit run-statement(语句原文)', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc, statementGutter: true } })
    const btns = wrapper.findAll('.cm-run-statement')
    expect(btns).toHaveLength(2)
    expect(btns[0].attributes('title')).toBe('执行该语句')
    await btns[0].trigger('mousedown')
    await btns[1].trigger('mousedown')
    const emitted = wrapper.emitted('run-statement')
    expect(emitted?.[0]).toEqual(['SELECT 1;'])
    expect(emitted?.[1]).toEqual(['SELECT 2'])
  })

  it('statementGutter:默认关闭不渲染,运行期开启后出现', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc } })
    expect(wrapper.find('.cm-run-statement').exists()).toBe(false)
    await wrapper.setProps({ statementGutter: true })
    expect(wrapper.findAll('.cm-run-statement')).toHaveLength(2)
  })

  it('statementGutter:文档编辑后 ▶ 跟随最新拆分结果', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc, statementGutter: true } })
    expect(wrapper.findAll('.cm-run-statement')).toHaveLength(2)
    // 在句间插入新语句 → 3 条。
    cmView(wrapper).dispatch({ changes: { from: 9, insert: 'SELECT 3;\n' } })
    expect(wrapper.findAll('.cm-run-statement')).toHaveLength(3)
  })

  it('statementMarks:✓/✗ 渲染并悬浮 detail,映射不到的 from 忽略', () => {
    const wrapper = mount(SqlEditor, {
      props: {
        modelValue: doc,
        statementMarks: [
          { from: 0, status: 'ok', detail: '12 ms' },
          { from: 10, status: 'fail', detail: 'boom' },
          { from: 999, status: 'running' },
        ],
      },
    })
    expect(wrapper.findAll('.cm-statement-mark')).toHaveLength(2)
    expect(wrapper.findAll('.cm-statement-mark-ok')).toHaveLength(1)
    expect(wrapper.findAll('.cm-statement-mark-fail')).toHaveLength(1)
    expect(wrapper.find('.cm-statement-mark-ok').attributes('title')).toBe('12 ms')
    expect(wrapper.find('.cm-statement-mark-fail').attributes('title')).toBe('boom')
  })

  it('statementMarks:running 渲染转圈,prop 更新后重渲染', async () => {
    const wrapper = mount(SqlEditor, {
      props: { modelValue: doc, statementMarks: [{ from: 0, status: 'running' }] },
    })
    expect(wrapper.findAll('.cm-statement-mark-running')).toHaveLength(1)
    await wrapper.setProps({ statementMarks: [{ from: 0, status: 'ok', detail: '9 ms' }] })
    expect(wrapper.findAll('.cm-statement-mark-running')).toHaveLength(0)
    expect(wrapper.findAll('.cm-statement-mark-ok')).toHaveLength(1)
  })

  it('cursor:光标移动 emit 1 基行列', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc } })
    cmView(wrapper).dispatch({ selection: { anchor: 11 } }) // 第 2 行第 2 列
    const emitted = wrapper.emitted('cursor')
    expect(emitted?.length).toBeGreaterThan(0)
    expect(emitted?.at(-1)).toEqual([{ line: 2, col: 2 }])
  })

  it('cursor:文档编辑同样触发,行内列号正确', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: 'AB' } })
    cmView(wrapper).dispatch({ changes: { from: 2, insert: 'CD' }, selection: { anchor: 4 } })
    const emitted = wrapper.emitted('cursor')
    expect(emitted?.length).toBeGreaterThan(0)
    // 插入后主光标移到 offset 4 → 第 1 行第 5 列。
    expect(emitted?.at(-1)).toEqual([{ line: 1, col: 5 }])
  })

  it('highlightCursorStatement:光标所在语句整段高亮(cm-current-statement)', () => {
    const wrapper = mount(SqlEditor, {
      props: { modelValue: doc, highlightCursorStatement: true },
    })
    cmView(wrapper).dispatch({ selection: { anchor: 12 } })
    const marks = wrapper.findAll('.cm-current-statement')
    expect(marks).toHaveLength(1)
    expect(marks[0].text()).toBe('SELECT 2')
  })

  it('highlightCursorStatement:默认关闭不渲染高亮', () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc } })
    cmView(wrapper).dispatch({ selection: { anchor: 12 } })
    expect(wrapper.find('.cm-current-statement').exists()).toBe(false)
  })

  it('highlightCursorStatement:光标位于语句外(前导空白/注释)不高亮', () => {
    const wrapper = mount(SqlEditor, {
      props: { modelValue: '  -- 头注释\nSELECT 1', highlightCursorStatement: true },
    })
    cmView(wrapper).dispatch({ selection: { anchor: 1 } })
    expect(wrapper.find('.cm-current-statement').exists()).toBe(false)
  })

  it('highlightCursorStatement:运行期开启后随光标高亮', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc } })
    cmView(wrapper).dispatch({ selection: { anchor: 3 } })
    expect(wrapper.find('.cm-current-statement').exists()).toBe(false)
    await wrapper.setProps({ highlightCursorStatement: true })
    cmView(wrapper).dispatch({ selection: { anchor: 3 } })
    expect(wrapper.findAll('.cm-current-statement')).toHaveLength(1)
  })
})

// —— 右键执行菜单(enableRunMenu)——
describe('SqlEditor 右键执行菜单', () => {
  const doc = 'SELECT 1; SELECT 2'

  // 在 CM contentDOM 上派发 contextmenu,返回事件供 defaultPrevented 断言。
  function openRunMenu(wrapper: VueWrapper, x = 24, y = 36): MouseEvent {
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    })
    cmView(wrapper).contentDOM.dispatchEvent(ev)
    return ev
  }

  it('未开启 enableRunMenu(默认):contextmenu 不被拦截,菜单不出现', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc } })
    const ev = openRunMenu(wrapper)
    await nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(false)
  })

  it('开启后:contextmenu 被阻止,菜单在光标坐标处出现', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc, enableRunMenu: true } })
    const ev = openRunMenu(wrapper, 30, 40)
    await nextTick()
    expect(ev.defaultPrevented).toBe(true)
    const menu = wrapper.find('[data-test="editor-run-menu"]')
    expect(menu.exists()).toBe(true)
    expect(menu.attributes('style')).toContain('left: 30px')
    expect(menu.attributes('style')).toContain('top: 40px')
  })

  it('有选区 → 「执行选中语句」,点击 emit run-selection(选中文本)并关闭', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc, enableRunMenu: true } })
    cmView(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
    openRunMenu(wrapper)
    await nextTick()
    const item = wrapper.find('[data-test="menu-run-selection"]')
    expect(item.exists()).toBe(true)
    // 菜单内部 mousedown 不应提前关闭菜单(外部点击才关闭)。
    await item.trigger('mousedown')
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(true)
    await item.trigger('click')
    const emitted = wrapper.emitted('run-selection')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]).toEqual(['SELECT 1'])
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(false)
  })

  it('无选区 → 无「执行选中语句」;当前语句/运行全部 emit 并带快捷键 title', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc, enableRunMenu: true } })
    openRunMenu(wrapper)
    await nextTick()
    expect(wrapper.find('[data-test="menu-run-selection"]').exists()).toBe(false)
    const current = wrapper.find('[data-test="menu-run-current"]')
    expect(current.attributes('title')).toContain('⌘Enter')
    await current.trigger('click')
    expect(wrapper.emitted('run-current')).toHaveLength(1)
    expect(wrapper.emitted('run-selection')).toBeUndefined()
    // 点击后菜单已关闭,重新打开再验证「运行全部」。
    openRunMenu(wrapper)
    await nextTick()
    const all = wrapper.find('[data-test="menu-run-all"]')
    expect(all.attributes('title')).toContain('⌘⇧Enter')
    await all.trigger('click')
    expect(wrapper.emitted('run-all')).toHaveLength(1)
  })

  it('Esc 关闭;点击外部(冒泡 mousedown)关闭,菜单内部 mousedown 不关', async () => {
    const wrapper = mount(SqlEditor, {
      props: { modelValue: doc, enableRunMenu: true },
      attachTo: document.body,
    })
    openRunMenu(wrapper)
    await nextTick()
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(true)
    // Esc 关闭。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(false)
    // 重新打开:菜单内部 mousedown 不关闭。
    openRunMenu(wrapper)
    await nextTick()
    await wrapper.find('[data-test="editor-run-menu"]').trigger('mousedown')
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(true)
    // 菜单外(编辑器内容区)mousedown 冒泡到 document → 关闭。
    await wrapper.find('.cm-content').trigger('mousedown')
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('运行期关闭 enableRunMenu → 菜单消失且不再拦截 contextmenu', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: doc, enableRunMenu: true } })
    openRunMenu(wrapper)
    await nextTick()
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(true)
    await wrapper.setProps({ enableRunMenu: false })
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(false)
    const ev = openRunMenu(wrapper)
    await nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(wrapper.find('[data-test="editor-run-menu"]').exists()).toBe(false)
  })
})
