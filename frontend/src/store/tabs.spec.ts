import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from './tabs'

describe('tabs store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens a topic tab and activates it', () => {
    const store = useTabsStore()
    const tab = store.openTopic('conn-1', 'user-log')
    expect(tab.kind).toBe('topic')
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(tab.id)
  })

  it('dedupes an already open topic tab', () => {
    const store = useTabsStore()
    store.openTopic('conn-1', 'user-log')
    const second = store.openTopic('conn-1', 'user-log')
    expect(store.openTabs).toHaveLength(1)
    expect(second.id).toBe(store.openTabs[0].id)
  })

  it('keeps tabs for different topics distinct', () => {
    const store = useTabsStore()
    store.openTopic('conn-1', 'a')
    store.openTopic('conn-1', 'b')
    expect(store.openTabs).toHaveLength(2)
  })

  it('opens a group tab', () => {
    const store = useTabsStore()
    const tab = store.openGroup('conn-1', 'grp-1')
    expect(tab.kind).toBe('group')
    expect(tab.group).toBe('grp-1')
    expect(store.activeTabId).toBe(tab.id)
  })

  it('closes a tab and falls back to a neighbour', () => {
    const store = useTabsStore()
    store.openTopic('conn-1', 'a')
    const b = store.openTopic('conn-1', 'b')
    store.closeTab(store.openTabs[0].id)
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(b.id)
  })

  it('setActive only accepts open tabs', () => {
    const store = useTabsStore()
    store.openTopic('conn-1', 'a')
    const b = store.openTopic('conn-1', 'b')
    store.setActive('nope')
    expect(store.activeTabId).toBe(b.id)
  })

  it('opens a sql console tab for a topic and activates it', () => {
    const store = useTabsStore()
    const tab = store.openSql('conn-1', 'orders', [0, 1])
    expect(tab.kind).toBe('sql')
    expect(tab.topic).toBe('orders')
    expect(tab.partitions).toEqual([0, 1])
    expect(store.activeTabId).toBe(tab.id)
  })

  it('dedupes an already open sql console tab', () => {
    const store = useTabsStore()
    store.openSql('conn-1', 'orders')
    const second = store.openSql('conn-1', 'orders')
    expect(store.openTabs).toHaveLength(1)
    expect(second.id).toBe(store.openTabs[0].id)
    expect(store.activeTabId).toBe(second.id)
  })
})

  it('stores partition metadata on topic tabs', () => {
    const store = useTabsStore()
    const tab = store.openTopic('conn-1', 'user-log', [0, 1, 2])
    expect(tab.partitions).toEqual([0, 1, 2])
    const reopened = store.openTopic('conn-1', 'user-log', [5])
    expect(reopened.id).toBe(tab.id)
    expect(reopened.partitions).toEqual([5])
  })