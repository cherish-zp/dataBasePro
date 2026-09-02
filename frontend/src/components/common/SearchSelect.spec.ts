import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, type VueWrapper } from '@vue/test-utils'
import SearchSelect from './SearchSelect.vue'

const options = [
  { value: 'grp-1', label: 'grp-1 (Stable)' },
  { value: 'group_forensics_document_wait', label: 'group_forensics_document_wait (Empty)' },
  { value: 'console-consumer-123', label: 'console-consumer-123 (Empty)' },
]

function mountSelect(overrides: Record<string, unknown> = {}) {
  return mount(SearchSelect, {
    props: { modelValue: null, options, placeholder: '选择…', ...overrides },
  })
}

describe('SearchSelect', () => {
  it('shows the selected option label', () => {
    const wrapper = mountSelect({ modelValue: 'grp-1' })
    expect(wrapper.find('[data-test="search-select-value"]').text()).toBe('grp-1 (Stable)')
  })

  it('shows the placeholder when nothing is selected', () => {
    const wrapper = mountSelect()
    expect(wrapper.find('[data-test="search-select-value"]').text()).toBe('选择…')
  })

  it('opens the panel and lists every option on trigger click', async () => {
    const wrapper = mountSelect()
    expect(wrapper.find('[data-test="search-select-panel"]').exists()).toBe(false)
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    expect(wrapper.find('[data-test="search-select-panel"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="search-select-option"]')).toHaveLength(3)
  })

  it('renders options as role=option divs, never buttons (WKWebView quirk guard)', async () => {
    // WKWebView 对裸 <button> 的 UA 样式会把无显式高度的下拉选项渲染成
    // 压扁重叠的细线;选项一律用 div[role=option] 渲染,面板内不得出现
    // <button> 元素(除触发器,它在面板外)。
    const wrapper = mountSelect()
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    const options = wrapper.findAll('[data-test="search-select-option"]')
    expect(options).toHaveLength(3)
    for (const o of options) {
      expect((o.element as HTMLElement).tagName).toBe('DIV')
      expect(o.attributes('role')).toBe('option')
    }
    expect(wrapper.find('[data-test="search-select-panel"] button').exists()).toBe(false)
  })

  it('opts option rows out of flex shrinking (214-row collapse guard)', () => {
    // jsdom 无法测 flex 布局:用样式契约锁住修复。.options 是
    // max-height + overflow:auto 的 flex 纵向容器,而 .option 的
    // overflow:hidden 会把 flex 自动最小高度清零——一旦没有 flex:none,
    // 选项数量超过容器高度(真实集群 214 个组)时每个选项被等比压瘪成
    // 1px 细线(用户实测翻车现场)。删除 flex:none 必须让本用例变红。
    const src = readFileSync(join(process.cwd(), 'src/components/common/SearchSelect.vue'), 'utf8')
    const optionBlock = src.match(/\.option \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(optionBlock).toContain('flex: none')
  })

  it('confirms an option with Enter keyboard activation', async () => {
    const wrapper = mountSelect()
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    await wrapper
      .findAll('[data-test="search-select-option"]')[0]
      .trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['grp-1'])
    expect(wrapper.find('[data-test="search-select-panel"]').exists()).toBe(false)
  })

  it('filters options by fuzzy search in the search input', async () => {
    const wrapper = mountSelect()
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    await wrapper.find('[data-test="search-select-input"]').setValue('grp')
    const labels = wrapper.findAll('[data-test="search-select-option"]').map((n) => n.text())
    expect(labels).toEqual(['grp-1 (Stable)', 'group_forensics_document_wait (Empty)'])
  })

  it('shows an empty message when the search has no matches', async () => {
    const wrapper = mountSelect()
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    await wrapper.find('[data-test="search-select-input"]').setValue('zzz')
    expect(wrapper.findAll('[data-test="search-select-option"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="search-select-empty"]').exists()).toBe(true)
  })

  it('emits update:modelValue and closes when an option is clicked', async () => {
    const wrapper = mountSelect()
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    await wrapper.findAll('[data-test="search-select-option"]')[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['group_forensics_document_wait'])
    expect(wrapper.find('[data-test="search-select-panel"]').exists()).toBe(false)
  })

  it('closes when clicking outside the component', async () => {
    const wrapper = mountSelect()
    await wrapper.find('[data-test="search-select-trigger"]').trigger('click')
    expect(wrapper.find('[data-test="search-select-panel"]').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="search-select-panel"]').exists()).toBe(false)
  })
})
