import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SqlResultTabs from './SqlResultTabs.vue'

const tabs = [
  { label: '结果 1', status: 'ok' as const, title: 'SELECT 1 · 12 ms · 3 行' },
  { label: '结果 2', status: 'fail' as const, title: 'Syntax error' },
  { label: '结果 3', status: 'running' as const },
  { label: '结果 4', status: 'none' as const },
]

function mountTabs(overrides: Partial<{ tabs: typeof tabs; active: number }> = {}) {
  return mount(SqlResultTabs, { props: { tabs, active: 0, ...overrides } })
}

describe('SqlResultTabs', () => {
  it('渲染 tab 数量与 label', () => {
    const wrapper = mountTabs()
    const items = wrapper.findAll('[data-test^="result-tab-"]')
    expect(items).toHaveLength(4)
    expect(items.map((w) => w.text())).toEqual(['结果 1', '结果 2', '结果 3', '结果 4'])
  })

  it('状态点按 status 渲染对应类(ok/fail/running/none)', () => {
    const wrapper = mountTabs()
    const items = wrapper.findAll('[data-test^="result-tab-"]')
    expect(items[0].find('.tab-dot.ok').exists()).toBe(true)
    expect(items[1].find('.tab-dot.fail').exists()).toBe(true)
    expect(items[2].find('.tab-dot.running').exists()).toBe(true)
    expect(items[3].find('.tab-dot.none').exists()).toBe(true)
  })

  it('active 下标高亮对应 tab', () => {
    const wrapper = mountTabs({ active: 2 })
    const items = wrapper.findAll('[data-test^="result-tab-"]')
    expect(items[2].classes()).toContain('active')
    expect(items[0].classes()).not.toContain('active')
    expect(items[3].classes()).not.toContain('active')
  })

  it('点击 tab emit select(下标)', async () => {
    const wrapper = mountTabs()
    await wrapper.find('[data-test="result-tab-1"]').trigger('click')
    await wrapper.find('[data-test="result-tab-3"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[1], [3]])
  })

  it('title 悬浮透传(缺省不渲染 title 属性)', () => {
    const wrapper = mountTabs()
    const items = wrapper.findAll('[data-test^="result-tab-"]')
    expect(items[0].attributes('title')).toBe('SELECT 1 · 12 ms · 3 行')
    expect(items[1].attributes('title')).toBe('Syntax error')
    expect(items[2].attributes('title')).toBeUndefined()
  })

  it('空 tab 列表渲染空容器', () => {
    const wrapper = mountTabs({ tabs: [] })
    expect(wrapper.findAll('[data-test^="result-tab-"]')).toHaveLength(0)
  })
})
