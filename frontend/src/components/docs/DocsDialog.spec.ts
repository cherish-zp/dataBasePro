import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DocsDialog from './DocsDialog.vue'
import { DOCS_LAST_KEY } from '@/docs'

function mountDialog(show = true) {
  return mount(DocsDialog, { props: { show } })
}

// 弹窗 Teleport 到 body,查询与交互都走 document 上的真实 DOM;
// 原生 click 会触发 Vue 绑定的事件处理器,nextTick 后断言更新。
function bodyEl(selector: string): HTMLElement {
  const el = document.body.querySelector(selector)
  expect(el, `expect ${selector} rendered`).not.toBeNull()
  return el as HTMLElement
}

describe('DocsDialog', () => {
  beforeEach(() => {
    // Teleported DOM 与 localStorage 状态不跨用例泄漏。
    document.body.innerHTML = ''
    localStorage.removeItem(DOCS_LAST_KEY)
  })

  it('show=false 时不渲染弹窗', () => {
    mountDialog(false)
    expect(document.body.querySelector('[data-test="docs-dialog"]')).toBeNull()
  })

  it('打开后渲染目录两篇,内容区默认第一篇且有 HTML', async () => {
    mountDialog(true)
    await nextTick()
    expect(bodyEl('[data-test="docs-dialog"]')).not.toBeNull()
    const toc = bodyEl('[data-test="docs-toc"]')
    expect(toc.querySelectorAll('[data-test="docs-toc-item-shortcuts"]')).toHaveLength(1)
    expect(toc.querySelectorAll('[data-test="docs-toc-item-quick-start"]')).toHaveLength(1)
    const content = bodyEl('[data-test="docs-content"]')
    // 第一篇《快捷键》渲染出真实标题与表格元素。
    expect(content.querySelector('h1')?.textContent).toContain('快捷键')
    expect(content.querySelector('table')).not.toBeNull()
  })

  it('点击目录第二篇切换内容并高亮', async () => {
    mountDialog(true)
    await nextTick()
    const item = bodyEl('[data-test="docs-toc-item-quick-start"]')
    item.click()
    await nextTick()
    expect(item.classList.contains('active')).toBe(true)
    expect(bodyEl('[data-test="docs-toc-item-shortcuts"]').classList.contains('active')).toBe(false)
    const content = bodyEl('[data-test="docs-content"]')
    expect(content.querySelector('h1')?.textContent).toContain('快速上手')
  })

  it('点击目录后把篇章写入 localStorage', async () => {
    mountDialog(true)
    await nextTick()
    bodyEl('[data-test="docs-toc-item-quick-start"]').click()
    await nextTick()
    expect(localStorage.getItem(DOCS_LAST_KEY)).toBe('quick-start')
  })

  it('重新打开时恢复上次看过的篇章', async () => {
    localStorage.setItem(DOCS_LAST_KEY, 'quick-start')
    mountDialog(true)
    await nextTick()
    expect(bodyEl('[data-test="docs-toc-item-quick-start"]').classList.contains('active')).toBe(true)
    expect(bodyEl('[data-test="docs-content"]').textContent).toContain('快速上手')
  })

  it('localStorage 记录无效时回落到第一篇', async () => {
    localStorage.setItem(DOCS_LAST_KEY, 'no-such-doc')
    mountDialog(true)
    await nextTick()
    expect(bodyEl('[data-test="docs-toc-item-shortcuts"]').classList.contains('active')).toBe(true)
  })

  it('按 Esc 触发 close', async () => {
    const wrapper = mountDialog(true)
    await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('show=false 时不响应 Esc', async () => {
    const wrapper = mountDialog(false)
    await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('点击 ✕ 触发 close', async () => {
    const wrapper = mountDialog(true)
    await nextTick()
    bodyEl('[data-test="btn-docs-close"]').click()
    await nextTick()
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
