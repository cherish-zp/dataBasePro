import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from './ConfirmDialog.vue'

// The dialog teleports to <body>, so assertions and clicks target document.body.
function dialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="confirm-dialog"]')
}
function clickDialog(testId: string): void {
  document.body.querySelector(`[data-test="${testId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('ConfirmDialog', () => {
  it('renders nothing when hidden', () => {
    mount(ConfirmDialog, { props: { show: false, message: '删除？' } })
    expect(dialog()).toBeNull()
  })

  it('shows the message when visible', () => {
    mount(ConfirmDialog, { props: { show: true, message: '确认删除 Topic「t1」？' } })
    expect(dialog()?.textContent).toContain('确认删除 Topic「t1」？')
  })

  it('emits confirm when the ok button is clicked', async () => {
    const wrapper = mount(ConfirmDialog, { props: { show: true, message: '删除？' } })
    clickDialog('confirm-dialog-ok')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('confirm')).toBeTruthy()
  })

  it('emits cancel when the cancel button is clicked', async () => {
    const wrapper = mount(ConfirmDialog, { props: { show: true, message: '删除？' } })
    clickDialog('confirm-dialog-cancel')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('emits cancel when the close button is clicked', async () => {
    const wrapper = mount(ConfirmDialog, { props: { show: true, message: '删除？' } })
    clickDialog('confirm-dialog-close')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('applies the danger style to the confirm button by default', () => {
    mount(ConfirmDialog, { props: { show: true, message: '删除？' } })
    expect(dialog()?.querySelector('[data-test="confirm-dialog-ok"]')?.classList.contains('danger')).toBe(true)
  })

  it('teleports the dialog to body so it is not confined to a scrolled container', () => {
    mount(ConfirmDialog, { props: { show: true, message: '删除？' } })
    expect(dialog()).not.toBeNull()
  })

  it('confirmDisabled=true 禁用确认按钮,取消仍可用', async () => {
    const wrapper = mount(ConfirmDialog, { props: { show: true, message: '删除？', confirmDisabled: true } })
    const ok = dialog()?.querySelector('[data-test="confirm-dialog-ok"]') as HTMLButtonElement
    expect(ok.disabled).toBe(true)
    // 组件层再兜底:confirmDisabled 时点击确认不 emit(合成事件绕过 disabled 也拦截)。
    clickDialog('confirm-dialog-ok')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('confirm')).toBeFalsy()
    clickDialog('confirm-dialog-cancel')
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('confirmDisabled 缺省时确认按钮可点(向后兼容)', () => {
    mount(ConfirmDialog, { props: { show: true, message: '删除？' } })
    const ok = dialog()?.querySelector('[data-test="confirm-dialog-ok"]') as HTMLButtonElement
    expect(ok.disabled).toBe(false)
  })
})
