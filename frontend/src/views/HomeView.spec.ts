import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HomeView from './HomeView.vue'

describe('HomeView', () => {
  it('renders a welcome message', () => {
    const wrapper = mount(HomeView)
    expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="home-title"]').text()).toContain('多数据源')
  })

  it('不再渲染「新建连接」按钮(与左上角连接树入口重复)', () => {
    const wrapper = mount(HomeView)
    expect(wrapper.find('[data-test="home-new"]').exists()).toBe(false)
    expect(wrapper.emitted('new')).toBeFalsy()
  })

  it('以功能卡片展示已有能力', () => {
    const wrapper = mount(HomeView)
    const cards = wrapper.findAll('[data-test="feature-card"]')
    expect(cards.length).toBeGreaterThanOrEqual(6)
    const text = wrapper.text()
    // 覆盖当前已上线的核心能力,文案不得落后于实现。
    for (const keyword of ['Kafka', 'ClickHouse', 'Redis', 'SQL', '消费组', '单元格']) {
      expect(text).toContain(keyword)
    }
    // 每张卡片都有标题与描述。
    for (const card of cards) {
      expect(card.find('[data-test="feature-title"]').text()).not.toBe('')
      expect(card.find('[data-test="feature-desc"]').text()).not.toBe('')
    }
  })

  it('引导文案指向左侧数据源树,不再承诺未支持的数据源', () => {
    const wrapper = mount(HomeView)
    expect(wrapper.text()).toContain('左侧')
    expect(wrapper.text()).not.toContain('后续将扩展')
  })
})
