import { defineStore } from 'pinia'
import { ref } from 'vue'

export type TabKind = 'topic' | 'group' | 'sql' | 'lag' | 'health' | 'redis-keys' | 'ch-table' | 'ch-sql' | 'mysql-table' | 'mysql-sql' | 'es-index' | 'es-sql' | 'es-templates' | 'es-monitor'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  connectionId: string
  topic?: string
  group?: string
  db?: number
  // ClickHouse 表浏览器 / SQL 控制台携带的库与表名。
  database?: string
  table?: string
  // Elasticsearch 索引浏览器携带的索引名。
  index?: string
  // es-templates tab 携带的定位/新建标记:template 指向待选中的模板名(树模板
  // 项单击),newTemplate 表示进入新建态(树分区标题 + 入口)。
  template?: string
  newTemplate?: boolean
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
      // topic 为空表示「不针对某个 Topic」的通用 SQL 查询(顶栏/文件面板入口)。
      title: topic ? `SQL · ${topic}` : 'SQL 查询',
      connectionId,
      topic,
      partitions,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  function openGroup(connectionId: string, group: string, topic?: string): Tab {
    const existing = openTabs.value.find(
      (t) => t.kind === 'group' && t.connectionId === connectionId && t.group === group,
    )
    if (existing) {
      if (topic) existing.topic = topic
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id: `group:${connectionId}:${group}`,
      kind: 'group',
      title: group,
      connectionId,
      group,
      topic,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // Redis 键浏览器 tab:连接+DB 唯一定位,重复打开只聚焦。
  function openRedisKeys(connectionId: string, db: number): Tab {
    const id = `redis:${connectionId}:${db}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'redis-keys',
      title: `DB${db}`,
      connectionId,
      db,
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

  // openCHTable opens a ClickHouse table browser keyed by connection +
  // database + table; reopening an already open table only focuses it.
  function openCHTable(connectionId: string, database: string, table: string): Tab {
    const id = `ch:${connectionId}:${database}:${table}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'ch-table',
      title: table,
      connectionId,
      database,
      table,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openCHSql opens the ClickHouse SQL console for a connection. One console
  // per connection: the id keys on the connection alone.
  function openCHSql(connectionId: string): Tab {
    const id = `ch-sql:${connectionId}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'ch-sql',
      title: 'SQL 控制台',
      connectionId,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openMysqlTable opens a MySQL/TiDB table browser keyed by connection +
  // database + table (dedupe rules copied from openCHTable); reopening an
  // already open table only focuses it. Title carries db.table to disambiguate
  // same-named tables across databases.
  function openMysqlTable(connectionId: string, database: string, table: string): Tab {
    const id = `mysql:${connectionId}:${database}:${table}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'mysql-table',
      title: `表 · ${database}.${table}`,
      connectionId,
      database,
      table,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openMysqlSql opens the MySQL/TiDB SQL console. One console per connection
  // + database: database 为空表示「不限定库」的通用控制台,id 省略库名段。
  function openMysqlSql(connectionId: string, database?: string): Tab {
    const id = database ? `mysql-sql:${connectionId}:${database}` : `mysql-sql:${connectionId}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'mysql-sql',
      title: 'SQL 控制台',
      connectionId,
      database,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openEsIndex opens an Elasticsearch index browser keyed by connection +
  // index (dedupe rules copied from openMysqlTable); reopening an already
  // open index only focuses it.
  function openEsIndex(connectionId: string, index: string): Tab {
    const id = `es-index:${connectionId}:${index}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'es-index',
      title: `索引 · ${index}`,
      connectionId,
      index,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openEsSql opens the Elasticsearch SQL console. One console per connection:
  // the id keys on the connection alone (copied from openCHSql).
  function openEsSql(connectionId: string): Tab {
    const id = `es-sql:${connectionId}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'es-sql',
      title: 'SQL 控制台',
      connectionId,
    }
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openEsTemplates opens the Elasticsearch index-template management panel.
  // One such tab per connection (legacy /_template API), so the id keys on the
  // connection alone (copied from openEsSql). opts carries the segmented-tree
  // entry intent: { template } locates a template's editor, { create: true }
  // enters the new-template mode. Reopening refreshes both fields on the
  // existing tab (cleared when opts is omitted) and focuses it — the panel
  // reacts to the prop change since :key=active.id does not remount it.
  function openEsTemplates(connectionId: string, opts?: { template?: string; create?: boolean }): Tab {
    const id = `es-templates:${connectionId}`
    const applyOpts = (tab: Tab): void => {
      tab.template = opts?.template
      tab.newTemplate = opts?.create === true ? true : undefined
    }
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      applyOpts(existing)
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'es-templates',
      title: '索引模板',
      connectionId,
    }
    applyOpts(tab)
    openTabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  // openEsMonitor opens the Elasticsearch cluster monitoring panel. One such
  // tab per connection, so the id keys on the connection alone (copied from
  // openHealth).
  function openEsMonitor(connectionId: string): Tab {
    const id = `es-monitor:${connectionId}`
    const existing = openTabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = existing.id
      return existing
    }
    const tab: Tab = {
      id,
      kind: 'es-monitor',
      title: '集群监控',
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

  // renameTab updates the title of an open tab by id. SQL consoles use it to
  // retitle their tab to the currently opened query file; a no-op when the id
  // is not open.
  function renameTab(id: string, title: string): void {
    const tab = openTabs.value.find((t) => t.id === id)
    if (!tab) return
    tab.title = title
  }

  return {
    openTabs,
    activeTabId,
    openTopic,
    openSql,
    openGroup,
    openRedisKeys,
    openLag,
    openHealth,
    openCHTable,
    openCHSql,
    openMysqlTable,
    openMysqlSql,
    openEsIndex,
    openEsSql,
    openEsTemplates,
    openEsMonitor,
    closeTab,
    closeOthers,
    closeAll,
    move,
    setActive,
    renameTab,
  }
})
