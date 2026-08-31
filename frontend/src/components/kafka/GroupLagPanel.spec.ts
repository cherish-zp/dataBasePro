import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { PartitionLag, ResetPreviewRow } from '@/api/types'
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

  it('renders the consuming member for each partition', () => {
    const rowsWithMember: PartitionLag[] = [
      { partition: 0, current_offset: 10, log_end_offset: 20, lag: 10, member_id: 'm-1', client_id: 'c-1', client_host: '10.0.0.1' },
    ]
    const wrapper = mount(GroupLagPanel, { props: { rows: rowsWithMember, loading: false } })
    const first = wrapper.find('[data-test="lag-row"]')
    expect(first.find('[data-test="lag-member-id"]').text()).toBe('m-1')
    expect(first.find('[data-test="lag-client-id"]').text()).toBe('c-1')
    expect(first.find('[data-test="lag-client-host"]').text()).toBe('10.0.0.1')
  })

  it('shows a dash for partitions with no active member', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false } })
    const first = wrapper.find('[data-test="lag-row"]')
    expect(first.find('[data-test="lag-member-id"]').text()).toBe('—')
    expect(first.find('[data-test="lag-client-id"]').text()).toBe('—')
    expect(first.find('[data-test="lag-client-host"]').text()).toBe('—')
  })

  it('orders the member columns with Host before Consumer ID and Client ID', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false } })
    const headers = wrapper.findAll('thead th').map((n) => n.text())
    expect(headers).toEqual(['Partition', 'Current Offset', 'Log End Offset', 'Lag', 'Host', 'Consumer ID', 'Client ID'])
  })

  it('shows an empty state when there are no rows', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows: [], loading: false } })
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(true)
  })

  it('does not render the dry-run preview without preview rows', () => {
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false } })
    expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="btn-confirm-reset"]').exists()).toBe(false)
  })

  it('renders the dry-run preview with current and new offsets', () => {
    const preview: ResetPreviewRow[] = [
      { partition: 0, current_offset: 10, new_offset: 20 },
      { partition: 1, current_offset: 15, new_offset: null },
    ]
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false, preview } })
    expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(true)
    const rowsEls = wrapper.findAll('[data-test="dry-run-row"]')
    expect(rowsEls).toHaveLength(2)
    expect(rowsEls[0].text()).toContain('0')
    expect(rowsEls[0].text()).toContain('10')
    expect(rowsEls[0].find('[data-test="dry-run-new-offset"]').text()).toBe('20')
    // A null target is only computed by the broker at execution time.
    expect(rowsEls[1].find('[data-test="dry-run-new-offset"]').text()).toBe('—')
  })

  it('disables confirm-reset when the preview is empty and never emits', async () => {
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false, preview: [] } })
    const btn = wrapper.find('[data-test="btn-confirm-reset"]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    expect(wrapper.emitted('confirm-reset')).toBeUndefined()
  })

  it('keeps confirm-reset enabled when the preview has rows', () => {
    const preview: ResetPreviewRow[] = [{ partition: 0, current_offset: 10, new_offset: 20 }]
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false, preview } })
    expect(wrapper.find('[data-test="btn-confirm-reset"]').attributes('disabled')).toBeUndefined()
  })

  it('emits confirm-reset and cancel-preview from the preview actions', async () => {
    const preview: ResetPreviewRow[] = [{ partition: 0, current_offset: 10, new_offset: 20 }]
    const wrapper = mount(GroupLagPanel, { props: { rows, loading: false, preview } })
    await wrapper.find('[data-test="btn-confirm-reset"]').trigger('click')
    await wrapper.find('[data-test="btn-cancel-preview"]').trigger('click')
    expect(wrapper.emitted('confirm-reset')).toHaveLength(1)
    expect(wrapper.emitted('cancel-preview')).toHaveLength(1)
  })
})
