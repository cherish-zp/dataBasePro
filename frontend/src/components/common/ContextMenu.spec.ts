import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ContextMenu from './ContextMenu.vue'

const items = [
  { key: 'open', label: '打开' },
  { key: 'edit', label: '编辑' },
  { key: 'delete', label: '删除', danger: true },
]

afterEach(() => {
  document.body.innerHTML = ''
})

function menu(): HTMLElement | null {
  return document.body.querySelector('[data-test="context-menu"]')
}
function item(key: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="context-item-${key}"]`)
}

describe('ContextMenu', () => {
  it('renders nothing when hidden', () => {
    mount(ContextMenu, { props: { show: false, x: 10, y: 10, items } })
    expect(menu()).toBeNull()
  })

  it('renders its items as direct children of body at the given position', () => {
    mount(ContextMenu, { props: { show: true, x: 40, y: 60, items } })
    const el = menu() as HTMLElement
    expect(document.body.querySelector(':scope > [data-test="context-menu"]')).not.toBeNull()
    expect(el.style.left).toBe('40px')
    expect(el.style.top).toBe('60px')
    expect(item('open')?.textContent).toBe('打开')
    expect(item('edit')?.textContent).toBe('编辑')
  })

  it('emits select with the item key and close on item click', async () => {
    const wrapper = mount(ContextMenu, { props: { show: true, x: 0, y: 0, items } })
    item('edit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('select')?.[0]).toEqual(['edit'])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('marks danger items with the danger class', () => {
    mount(ContextMenu, { props: { show: true, x: 0, y: 0, items } })
    expect(item('delete')?.classList.contains('danger')).toBe(true)
    expect(item('open')?.classList.contains('danger')).toBe(false)
  })

  it('closes on Escape', async () => {
    const wrapper = mount(ContextMenu, { props: { show: true, x: 0, y: 0, items } })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on a document click outside the menu', async () => {
    const wrapper = mount(ContextMenu, { props: { show: true, x: 0, y: 0, items } })
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('does not close on clicks inside the menu itself', async () => {
    const wrapper = mount(ContextMenu, { props: { show: true, x: 0, y: 0, items } })
    ;(menu() as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: false }))
    await new Promise((r) => setTimeout(r, 0))
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
