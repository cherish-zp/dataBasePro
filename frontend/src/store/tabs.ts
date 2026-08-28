import { defineStore } from 'pinia'
import { ref } from 'vue'

export type TabKind = 'topic' | 'group' | 'sql' | 'lag' | 'health'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  connectionId: string
  topic?: string
  group?: string
  partitions?: number[]
}

export const useTabsStore = defineStore('tabs', () => {
  const openTabs = ref<Tab[]>([])
  const activeTabId = ref<string | null>(null)

  function openTopic(connectionId: string, topic: string, partitions: number[] = []): Tab {
    const existing = openTabs.value.find(
      (t) => t.kind === 'topic' && t.connectionId === connectionId && t.topic === topic,
    )
    if (existing) {
      existing.partitions = partitions
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id: `topic:${connectionId}:${topic}`,
      kind: 'topic',
      title: topic,
      connectionId,
      topic,
      partitions,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  function openSql(connectionId: string, topic: string, partitions: number[] = []): Tab {
    const id = `sql:${connectionId}:${topic}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      existing.partitions = partitions
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'sql',
      title: `SQL · ${topic}`,
      connectionId,
      topic,
      partitions,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  function openGroup(connectionId: string, group: string): Tab {
    const existing = openTabs.value.find(
      (t) => t.kind === 'group' && t.connectionId === connectionId && t.group === group,
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id: `group:${connectionId}:${group}`,
      kind: 'group',
      title: group,
      connectionId,
      group,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openLag opens the global consumer-lag overview for a connection. There is
  // one such tab per connection, so the id keys on the connection alone.
  function openLag(connectionId: string): Tab {
    const id = `lag:${connectionId}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'lag',
      title: 'Lag 总览',
      connectionId,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openHealth opens the cluster health overview for a connection. There is
  // one such tab per connection, so the id keys on the connection alone.
  function openHealth(connectionId: string): Tab {
    const id = `health:${connectionId}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'health',
      title: '集群健康',
      connectionId,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  function closeTab(id: string): void {
    const idx = openTabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    openTabs.value.splice(idx, 1)
    if (activeTabId.value === id) {
      activeTabId.value = openTabs.value[idx]?.id ?? openTabs.value[idx - 1]?.id ?? null
    }
  }

  // closeOthers keeps only the requested tab and focuses it. A no-op when the
  // id is not open.
  function closeOthers(id: string): void {
    const keep = openTabs.value.find((t) => t.id === id)
    if (!keep) return
    openTabs.value = [keep]
    activeTabId.value = keep.id
  }

  // closeAll empties the tabbar and clears the active selection.
  function closeAll(): void {
    openTabs.value = []
    activeTabId.value = null
  }

  // move reorders openTabs so the tab at index `from` lands at index `to`
  // (measured in the array after removal). A no-op for equal or out-of-range
  // indices. activeTabId needs no adjustment: it keys on the tab id, which the
  // moved Tab object keeps, so the same tab stays active.
  function move(from: number, to: number): void {
    const len = openTabs.value.length
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return
    const [tab] = openTabs.value.splice(from, 1)
    openTabs.value.splice(to, 0, tab)
  }

  function setActive(id: string): void {
    if (openTabs.value.some((t) => t.id === id)) activeTabId.value = id
  }

  return {
    openTabs,
    activeTabId,
    openTopic,
    openSql,
    openGroup,
    openLag,
    openHealth,
    closeTab,
    closeOthers,
    closeAll,
    move,
    setActive,
  }
})
