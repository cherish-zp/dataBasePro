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

  it('暴露 focus(),且挂载时不主动抢占焦点', async () => {
    const wrapper = mount(SqlEditor, { props: { modelValue: '' }, attachTo: document.body })
    const vm = wrapper.vm as unknown as Exposed
    await nextTick()
    expect(document.activeElement === cmView(wrapper).contentDOM).toBe(false)
    vm.focus()
    expect(document.activeElement === cmView(wrapper).contentDOM).toBe(true)
  })
})
