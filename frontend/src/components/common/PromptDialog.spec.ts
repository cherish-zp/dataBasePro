import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PromptDialog from './PromptDialog.vue'

// Teleported to <body> like the other modals.
function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="prompt-dialog"]')
}
function el(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
function click(testId: string): void {
  el(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
function inputEl(): HTMLInputElement {
  return el('prompt-input') as HTMLInputElement
}

describe('PromptDialog', () => {
  it('renders nothing when hidden', () => {
    mount(PromptDialog, { props: { show: false, title: '扩充分区', label: '目标分区数' } })
    expect(dialog()).toBeNull()
  })

  it('shows title, label and the initial value', () => {
    mount(PromptDialog, { props: { show: true, title: '扩充分区', label: '目标分区数', value: 6 } })
    expect(dialog()?.textContent).toContain('扩充分区')
    expect(dialog()?.textContent).toContain('目标分区数')
    expect(inputEl().value).toBe('6')
  })

  it('emits confirm with the entered value', async () => {
    const wrapper = mount(PromptDialog, { props: { show: true, title: '扩充分区', label: '目标分区数', value: 3 } })
    inputEl().value = '9'
    inputEl().dispatchEvent(new Event('input', { bubbles: true }))
    click('prompt-confirm')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('confirm')?.[0]).toEqual(['9'])
  })

  it('emits confirm on Enter', async () => {
    const wrapper = mount(PromptDialog, { props: { show: true, title: 't', label: 'l', value: 'x' } })
    inputEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('confirm')?.[0]).toEqual(['x'])
  })

  it('emits cancel from the cancel button and Escape', async () => {
    const wrapper = mount(PromptDialog, { props: { show: true, title: 't', label: 'l' } })
    click('prompt-cancel')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    inputEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toHaveLength(2)
  })

  it('does not cancel when the overlay backdrop is clicked', async () => {
    const wrapper = mount(PromptDialog, { props: { show: true, title: 't', label: 'l', value: 'v' } })
    const overlay = document.body.querySelector('[data-test="prompt-overlay"]') as HTMLElement
    expect(overlay).not.toBeNull()
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toBeUndefined()
    expect(dialog()).not.toBeNull()
  })

  it('does not cancel when a click lands inside the dialog', async () => {
    const wrapper = mount(PromptDialog, { props: { show: true, title: 't', label: 'l', value: 'v' } })
    dialog()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })

  it('disables confirm while the value is empty', () => {
    mount(PromptDialog, { props: { show: true, title: 't', label: 'l', value: '' } })
    expect((el('prompt-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps autofocus on the input when shown', async () => {
    mount(PromptDialog, { props: { show: true, title: 't', label: 'l', value: 'v' }, attachTo: document.body })
    await new Promise((r) => setTimeout(r, 0))
    expect(document.activeElement).toBe(inputEl())
  })
})
