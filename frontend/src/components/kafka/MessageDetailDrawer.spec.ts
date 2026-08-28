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

const plainMsg: Message = { ...msg, key: 'order-1', value: 'hello world' }

// longMsg pretty-prints to well over the 12-line collapse threshold.
const longMsg: Message = {
  ...msg,
  value: JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => i) }),
}

function find(wrapper: ReturnType<typeof mount>, test: string) {
  return wrapper.find(`[data-test="${test}"]`)
}

describe('MessageDetailDrawer', () => {
  it('renders nothing when hidden', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: false } })
    expect(find(wrapper, 'message-drawer').exists()).toBe(false)
  })

  it('shows partition, offset and formatted value when open', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    expect(find(wrapper, 'meta-partition').text()).toContain('3')
    expect(find(wrapper, 'meta-offset').text()).toContain('42')
    expect(find(wrapper, 'key-value').text()).toBe('order-1')
    expect(find(wrapper, 'value-body').text()).toBe('{\n  "user": 1\n}')
    expect(find(wrapper, 'headers-body').exists()).toBe(true)
  })

  it('emits close', async () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    await find(wrapper, 'drawer-close').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('offers the format toggle only when the value parses as JSON', () => {
    const json = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    expect(find(json, 'value-mode').exists()).toBe(true)
    const raw = mount(MessageDetailDrawer, { props: { message: plainMsg, show: true } })
    expect(find(raw, 'value-mode').exists()).toBe(false)
  })

  it('renders highlighted spans with distinct token classes', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    const body = find(wrapper, 'value-body')
    expect(body.find('.tok-key').text()).toBe('"user"')
    expect(body.find('.tok-number').text()).toBe('1')
    expect(body.find('.tok-plain').exists()).toBe(true)
    expect(body.findAll('span').length).toBeGreaterThan(1)
  })

  it('keeps non-JSON values plain without token spans', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: plainMsg, show: true } })
    const body = find(wrapper, 'value-body')
    expect(body.text()).toBe('hello world')
    expect(body.find('.tok-key').exists()).toBe(false)
    expect(body.find('.tok-string').exists()).toBe(false)
  })

  it('raw mode shows the original bytes and toggles back', async () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    const toggle = find(wrapper, 'value-mode')
    expect(toggle.text()).toBe('原始')
    await toggle.trigger('click')
    const body = find(wrapper, 'value-body')
    expect(body.text()).toBe('{"user":1}')
    expect(body.find('.tok-key').exists()).toBe(false)
    expect(find(wrapper, 'value-mode').text()).toBe('格式化')
    await find(wrapper, 'value-mode').trigger('click')
    expect(find(wrapper, 'value-body').text()).toBe('{\n  "user": 1\n}')
  })

  it('offers the toggle for a JSON key too', () => {
    const jsonKey: Message = { ...msg, key: '{"id":7}' }
    const wrapper = mount(MessageDetailDrawer, { props: { message: jsonKey, show: true } })
    expect(find(wrapper, 'key-mode').exists()).toBe(true)
    expect(find(wrapper, 'key-value').find('.tok-key').text()).toBe('"id"')
    const wrapper2 = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    expect(find(wrapper2, 'key-mode').exists()).toBe(false)
  })

  it('collapses long values and expands on demand', async () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: longMsg, show: true } })
    const body = find(wrapper, 'value-body')
    expect(body.classes()).toContain('collapsed')
    expect(find(wrapper, 'value-expand').text()).toBe('展开')
    await find(wrapper, 'value-expand').trigger('click')
    expect(find(wrapper, 'value-body').classes()).not.toContain('collapsed')
    expect(find(wrapper, 'value-expand').text()).toBe('收起')
    await find(wrapper, 'value-expand').trigger('click')
    expect(find(wrapper, 'value-body').classes()).toContain('collapsed')
  })

  it('does not show expand for short values', () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: msg, show: true } })
    expect(find(wrapper, 'value-expand').exists()).toBe(false)
  })

  it('resets mode and expand state when another message is opened', async () => {
    const wrapper = mount(MessageDetailDrawer, { props: { message: longMsg, show: true } })
    await find(wrapper, 'value-mode').trigger('click')
    await find(wrapper, 'value-expand').trigger('click')
    expect(find(wrapper, 'value-body').classes()).not.toContain('collapsed')
    await wrapper.setProps({ message: { ...longMsg, offset: 43 } })
    expect(find(wrapper, 'value-mode').text()).toBe('原始')
    expect(find(wrapper, 'value-body').classes()).toContain('collapsed')
  })
})
