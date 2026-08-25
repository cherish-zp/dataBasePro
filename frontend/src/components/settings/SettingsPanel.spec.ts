import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsPanel from './SettingsPanel.vue'

const KEY = 'dbclient-theme'

function mountPanel(show = true) {
  const wrapper = mount(SettingsPanel, { props: { show } })
  return wrapper
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('renders nothing when hidden', () => {
    const wrapper = mountPanel(false)
    expect(wrapper.find('[data-test="settings-panel"]').exists()).toBe(false)
  })

  it('defaults to light theme and applies it on mount', () => {
    mountPanel()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(KEY)).toBe('light')
  })

  it('switching to light persists and applies the theme', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="select-theme"]').setValue('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(KEY)).toBe('light')
  })

  it('reads a previously stored theme', () => {
    localStorage.setItem(KEY, 'light')
    const wrapper = mountPanel()
    expect((wrapper.find('[data-test="select-theme"]').element as HTMLSelectElement).value).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('emits close', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
