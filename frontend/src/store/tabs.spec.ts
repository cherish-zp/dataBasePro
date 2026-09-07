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

  it('opens a redis keys tab keyed by connection and db', () => {
    const store = useTabsStore()
    const tab = store.openRedisKeys('conn-1', 2)
    expect(tab.kind).toBe('redis-keys')
    expect(tab.db).toBe(2)
    expect(store.activeTabId).toBe(tab.id)
    const again = store.openRedisKeys('conn-1', 2)
    expect(again.id).toBe(tab.id)
    expect(store.openTabs).toHaveLength(1)
  })

  it('carries the topic into a new group tab and updates it on reopen', () => {
    // Lag 总览行点击:同一组永远只有一个 tab(Group 唯一定位),
    // Topic 作为 tab 内的初始选中项带入;重复打开更新 topic 而非新开。
    const store = useTabsStore()
    const first = store.openGroup('conn-1', 'grp-1', 'topic-a')
    expect(first.topic).toBe('topic-a')
    const second = store.openGroup('conn-1', 'grp-1', 'topic-b')
    expect(second.id).toBe(first.id)
    expect(store.openTabs).toHaveLength(1)
    expect(second.topic).toBe('topic-b')
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

  it('opens a lag overview tab per connection and activates it', () => {
    const store = useTabsStore()
    const tab = store.openLag('conn-1')
    expect(tab.kind).toBe('lag')
    expect(tab.title).toBe('Lag 总览')
    expect(tab.connectionId).toBe('conn-1')
    expect(store.activeTabId).toBe(tab.id)
  })

  it('dedupes an already open lag overview tab', () => {
    const store = useTabsStore()
    store.openLag('conn-1')
    const second = store.openLag('conn-1')
    expect(store.openTabs).toHaveLength(1)
    expect(second.id).toBe(store.openTabs[0].id)
    expect(store.activeTabId).toBe(second.id)
  })

  it('opens a cluster health tab per connection and activates it', () => {
    const store = useTabsStore()
    const tab = store.openHealth('conn-1')
    expect(tab.kind).toBe('health')
    expect(tab.title).toBe('集群健康')
    expect(tab.connectionId).toBe('conn-1')
    expect(tab.id).toBe('health:conn-1')
    expect(store.activeTabId).toBe(tab.id)
  })

  it('dedupes an already open cluster health tab and focuses it', () => {
    const store = useTabsStore()
    store.openHealth('conn-1')
    const other = store.openTopic('conn-1', 't1')
    store.setActive(other.id)
    const second = store.openHealth('conn-1')
    expect(store.openTabs.filter((t) => t.kind === 'health')).toHaveLength(1)
    expect(second.id).toBe('health:conn-1')
    expect(store.activeTabId).toBe('health:conn-1')
  })

  it('closeOthers keeps only the requested tab and focuses it', () => {
    const store = useTabsStore()
    const a = store.openTopic('conn-1', 'a')
    store.openTopic('conn-1', 'b')
    store.openTopic('conn-1', 'c')
    store.closeOthers(a.id)
    expect(store.openTabs).toHaveLength(1)
    expect(store.openTabs[0].id).toBe(a.id)
    expect(store.activeTabId).toBe(a.id)
  })

  it('closeOthers is a no-op for an unknown tab', () => {
    const store = useTabsStore()
    store.openTopic('conn-1', 'a')
    store.openTopic('conn-1', 'b')
    store.closeOthers('nope')
    expect(store.openTabs).toHaveLength(2)
  })

  it('closeAll clears every tab and the active selection', () => {
    const store = useTabsStore()
    store.openTopic('conn-1', 'a')
    store.openTopic('conn-1', 'b')
    store.openLag('conn-1')
    store.closeAll()
    expect(store.openTabs).toHaveLength(0)
    expect(store.activeTabId).toBeNull()
  })

  it('move reorders tabs and keeps the active tab id', () => {
    const store = useTabsStore()
    const a = store.openTopic('conn-1', 'a')
    const b = store.openTopic('conn-1', 'b')
    const c = store.openTopic('conn-1', 'c')
    const d = store.openTopic('conn-1', 'd')
    store.setActive(a.id)
    store.move(0, 2)
    expect(store.openTabs.map((t) => t.id)).toEqual([b.id, c.id, a.id, d.id])
    expect(store.activeTabId).toBe(a.id)
  })

  it('move with equal indices is a no-op', () => {
    const store = useTabsStore()
    const a = store.openTopic('conn-1', 'a')
    const b = store.openTopic('conn-1', 'b')
    store.move(1, 1)
    expect(store.openTabs.map((t) => t.id)).toEqual([a.id, b.id])
  })

  it('move ignores out-of-range indices', () => {
    const store = useTabsStore()
    const a = store.openTopic('conn-1', 'a')
    const b = store.openTopic('conn-1', 'b')
    store.move(0, 99)
    store.move(-1, 1)
    expect(store.openTabs.map((t) => t.id)).toEqual([a.id, b.id])
  })

  it('stores partition metadata on topic tabs', () => {
    const store = useTabsStore()
    const tab = store.openTopic('conn-1', 'user-log', [0, 1, 2])
    expect(tab.partitions).toEqual([0, 1, 2])
    const reopened = store.openTopic('conn-1', 'user-log', [5])
    expect(reopened.id).toBe(tab.id)
    expect(reopened.partitions).toEqual([5])
  })
})
