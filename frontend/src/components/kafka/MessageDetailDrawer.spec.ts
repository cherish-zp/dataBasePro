import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageDetailDrawer from './MessageDetailDrawer.vue'
import type { Message } from '@/api/types'

const msg: Message = {
  partition: 3,
  offset: 42,
  timestamp: 1700000000000,
  key: 'order-1',
  value: '{"user":1}',
  headers: [{ key: 'trace', value: 'abc' }],
}

describe('MessageDetailDrawer', () => {
  it('renders nothing when hidden', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: false } })
    expect(wrapper.find('[data-test="message-drawer"]').exists()).toBe(false)
  })

  it('shows partition, offset and formatted value when open', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    expect(wrapper.find('[data-test="meta-partition"]').text()).toContain('3')
    expect(wrapper.find('[data-test="meta-offset"]').text()).toContain('42')
    expect(wrapper.find('[data-test="key-value"]').text()).toBe('order-1')
    expect(wrapper.find('[data-test="value-body"]').text()).toBe('{\n  "user": 1\n}')
    expect(wrapper.find('[data-test="headers-body"]').exists()).toBe(true)
  })

  it('emits close', async () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    await wrapper.find('[data-test="drawer-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
