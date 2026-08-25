import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { PartitionLag } from '@/api/types'
import GroupLagPanel from './GroupLagPanel.vue'

describe('GroupLagPanel', () => {
  const rows: PartitionLag[] = [
    { partition: 0, current_offset: 10, log_end_offset: 20, lag: 10 },
    { partition: 1, current_offset: 15, log_end_offset: 15, lag: 0 },
  ]

  it('renders a row per partition with offsets and lag', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false } })
    expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-test="lag-value"]').map((n) => n.text())).toEqual(['10', '0'])
    const first = wrapper.find('[data-test="lag-row"]')
    expect(first.text()).toContain('0')
    expect(first.text()).toContain('10')
    expect(first.text()).toContain('20')
  })

  it('highlights positive lag', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false } })
    const first = wrapper.find('[data-test="lag-value"]')
    expect(first.classes()).toContain('lag-high')
    expect(wrapper.findAll('[data-test="lag-value"]')[1].classes()).not.toContain('lag-high')
  })

  it('shows an empty state when there are no rows', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows: [], loading: false } })
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(true)
  })
})
