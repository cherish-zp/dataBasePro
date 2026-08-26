import { beforeEach, describe, expect, it } from 'vitest'
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
