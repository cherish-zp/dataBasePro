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

  it('opens a clickhouse table tab keyed by connection, database and table', () => {
    const store = useTabsStore()
    const tab = store.openCHTable('conn-1', 'logs', 'events')
    expect(tab.kind).toBe('ch-table')
    expect(tab.id).toBe('ch:conn-1:logs:events')
    expect(tab.title).toBe('events')
    expect(tab.connectionId).toBe('conn-1')
    expect(tab.database).toBe('logs')
    expect(tab.table).toBe('events')
    expect(store.activeTabId).toBe(tab.id)
    // 重复打开只聚焦,不新开。
    const again = store.openCHTable('conn-1', 'logs', 'events')
    expect(again.id).toBe(tab.id)
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(tab.id)
    // 不同表是不同 tab。
    const other = store.openCHTable('conn-1', 'logs', 'users')
    expect(store.openTabs).toHaveLength(2)
    expect(other.id).toBe('ch:conn-1:logs:users')
  })

  it('opens a mysql table tab keyed by connection, database and table', () => {
    const store = useTabsStore()
    const tab = store.openMysqlTable('conn-1', 'logs', 'events')
    expect(tab.kind).toBe('mysql-table')
    expect(tab.id).toBe('mysql:conn-1:logs:events')
    expect(tab.title).toBe('表 · logs.events')
    expect(tab.connectionId).toBe('conn-1')
    expect(tab.database).toBe('logs')
    expect(tab.table).toBe('events')
    expect(store.activeTabId).toBe(tab.id)
    // 重复打开只聚焦,不新开。
    const again = store.openMysqlTable('conn-1', 'logs', 'events')
    expect(again.id).toBe(tab.id)
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(tab.id)
    // 不同表/不同库是不同 tab。
    const otherTable = store.openMysqlTable('conn-1', 'logs', 'users')
    expect(store.openTabs).toHaveLength(2)
    expect(otherTable.id).toBe('mysql:conn-1:logs:users')
    const otherDb = store.openMysqlTable('conn-1', 'shop', 'users')
    expect(store.openTabs).toHaveLength(3)
    expect(otherDb.id).toBe('mysql:conn-1:shop:users')
  })

  it('opens a mysql SQL console per connection+database and focuses it on reopen', () => {
    const store = useTabsStore()
    const tab = store.openMysqlSql('conn-1')
    expect(tab.kind).toBe('mysql-sql')
    expect(tab.id).toBe('mysql-sql:conn-1')
    expect(tab.title).toBe('SQL 控制台')
    expect(tab.connectionId).toBe('conn-1')
    expect(tab.database).toBeUndefined()
    expect(store.activeTabId).toBe(tab.id)
    // 带 database 打开:按 connectionId+database 去重,id 携带库名。
    const dbTab = store.openMysqlSql('conn-1', 'logs')
    expect(dbTab.kind).toBe('mysql-sql')
    expect(dbTab.id).toBe('mysql-sql:conn-1:logs')
    expect(dbTab.database).toBe('logs')
    expect(dbTab.title).toBe('SQL 控制台')
    expect(store.openTabs.filter((t) => t.kind === 'mysql-sql')).toHaveLength(2)
    store.setActive(tab.id)
    const again = store.openMysqlSql('conn-1', 'logs')
    expect(again.id).toBe(dbTab.id)
    expect(store.openTabs.filter((t) => t.kind === 'mysql-sql')).toHaveLength(2)
    expect(store.activeTabId).toBe(dbTab.id)
  })

  it('renameTab updates the title of the open tab by id', () => {
    const store = useTabsStore()
    const tab = store.openSql('conn-1', 'orders')
    store.renameTab(tab.id, 'a.sql')
    expect(store.openTabs[0].title).toBe('a.sql')
    // 其他 tab 不受影响。
    const other = store.openSql('conn-1', 'users')
    store.renameTab(tab.id, 'b.sql')
    expect(store.openTabs.find((t) => t.id === other.id)?.title).toBe('SQL · users')
  })

  it('renameTab is a no-op for an unknown tab id', () => {
    const store = useTabsStore()
    const tab = store.openSql('conn-1', 'orders')
    store.renameTab('nope', 'a.sql')
    expect(store.openTabs[0].title).toBe('SQL · orders')
  })

  it('opens a clickhouse SQL console per connection and focuses it on reopen', () => {
    const store = useTabsStore()
    const tab = store.openCHSql('conn-1')
    expect(tab.kind).toBe('ch-sql')
    expect(tab.id).toBe('ch-sql:conn-1')
    expect(tab.title).toBe('SQL 控制台')
    expect(tab.connectionId).toBe('conn-1')
    expect(store.activeTabId).toBe(tab.id)
    store.openCHSql('conn-2')
    expect(store.openTabs.filter((t) => t.kind === 'ch-sql')).toHaveLength(2)
    store.setActive(store.openTabs[1].id)
    const again = store.openCHSql('conn-1')
    expect(again.id).toBe(tab.id)
    expect(store.openTabs.filter((t) => t.kind === 'ch-sql')).toHaveLength(2)
    expect(store.activeTabId).toBe(tab.id)
  })

  it('opens an es index tab keyed by connection and index', () => {
    const store = useTabsStore()
    const tab = store.openEsIndex('conn-1', 'user-logs')
    expect(tab.kind).toBe('es-index')
    expect(tab.id).toBe('es-index:conn-1:user-logs')
    expect(tab.title).toBe('索引 · user-logs')
    expect(tab.connectionId).toBe('conn-1')
    expect(tab.index).toBe('user-logs')
    expect(store.activeTabId).toBe(tab.id)
    // 重复打开只聚焦,不新开。
    const again = store.openEsIndex('conn-1', 'user-logs')
    expect(again.id).toBe(tab.id)
    expect(store.openTabs).toHaveLength(1)
    expect(store.activeTabId).toBe(tab.id)
    // 不同索引/不同连接是不同 tab。
    const otherIndex = store.openEsIndex('conn-1', 'orders')
    expect(otherIndex.id).toBe('es-index:conn-1:orders')
    expect(store.openTabs).toHaveLength(2)
    const otherConn = store.openEsIndex('conn-2', 'orders')
    expect(otherConn.id).toBe('es-index:conn-2:orders')
    expect(store.openTabs).toHaveLength(3)
  })

  it('opens an es templates tab per connection and focuses it on reopen', () => {
    const store = useTabsStore()
    const tab = store.openEsTemplates('conn-1')
    expect(tab.kind).toBe('es-templates')
    expect(tab.id).toBe('es-templates:conn-1')
    expect(tab.title).toBe('索引模板')
    expect(tab.connectionId).toBe('conn-1')
    expect(store.activeTabId).toBe(tab.id)
    // 每连接一个模板管理 tab:重复打开只聚焦,不新开。
    store.openTopic('conn-1', 't1')
    store.setActive(store.openTabs[0].id)
    const again = store.openEsTemplates('conn-1')
    expect(again.id).toBe(tab.id)
    expect(store.openTabs.filter((t) => t.kind === 'es-templates')).toHaveLength(1)
    expect(store.activeTabId).toBe('es-templates:conn-1')
    // 不同连接是不同 tab。
    const other = store.openEsTemplates('conn-2')
    expect(other.id).toBe('es-templates:conn-2')
    expect(store.openTabs.filter((t) => t.kind === 'es-templates')).toHaveLength(2)
  })

  it('opens an es templates tab carrying the located template name', () => {
    const store = useTabsStore()
    const tab = store.openEsTemplates('conn-1', { template: 'logs-template' })
    expect(tab.kind).toBe('es-templates')
    expect(tab.id).toBe('es-templates:conn-1')
    expect(tab.template).toBe('logs-template')
    expect(tab.newTemplate).toBeUndefined()
    expect(store.activeTabId).toBe(tab.id)
  })

  it('opens an es templates tab in create mode when create is set', () => {
    const store = useTabsStore()
    const tab = store.openEsTemplates('conn-1', { create: true })
    expect(tab.id).toBe('es-templates:conn-1')
    expect(tab.newTemplate).toBe(true)
    expect(tab.template).toBeUndefined()
    expect(store.activeTabId).toBe(tab.id)
  })

  it('updates es templates tab fields and focuses it on reopen with opts', () => {
    // 树分段入口:同一 tab 在「定位到模板」/「新建态」之间复用,重复打开更新字段并聚焦。
    const store = useTabsStore()
    const first = store.openEsTemplates('conn-1', { template: 'logs-template' })
    store.openTopic('conn-1', 't1')
    store.setActive(store.openTabs.find((t) => t.kind === 'topic')!.id)
    const second = store.openEsTemplates('conn-1', { create: true })
    expect(second.id).toBe(first.id)
    expect(store.openTabs.filter((t) => t.kind === 'es-templates')).toHaveLength(1)
    expect(second.template).toBeUndefined()
    expect(second.newTemplate).toBe(true)
    expect(store.activeTabId).toBe('es-templates:conn-1')
    // 再切回定位:字段随 opts 刷新。
    const third = store.openEsTemplates('conn-1', { template: 'metrics-template' })
    expect(third.template).toBe('metrics-template')
    expect(third.newTemplate).toBeUndefined()
    expect(store.activeTabId).toBe('es-templates:conn-1')
  })

  it('clears es templates tab fields when reopened without opts', () => {
    const store = useTabsStore()
    const first = store.openEsTemplates('conn-1', { create: true })
    expect(first.newTemplate).toBe(true)
    const second = store.openEsTemplates('conn-1')
    expect(second.id).toBe(first.id)
    expect(second.newTemplate).toBeUndefined()
    expect(second.template).toBeUndefined()
    expect(store.activeTabId).toBe(second.id)
  })

  it('opens an es cluster monitor tab per connection and activates it', () => {
    const store = useTabsStore()
    const tab = store.openEsMonitor('conn-1')
    expect(tab.kind).toBe('es-monitor')
    expect(tab.id).toBe('es-monitor:conn-1')
    expect(tab.title).toBe('集群监控')
    expect(tab.connectionId).toBe('conn-1')
    expect(store.activeTabId).toBe(tab.id)
  })

  it('dedupes an already open es cluster monitor tab and focuses it', () => {
    const store = useTabsStore()
    store.openEsMonitor('conn-1')
    const other = store.openTopic('conn-1', 't1')
    store.setActive(other.id)
    const second = store.openEsMonitor('conn-1')
    expect(store.openTabs.filter((t) => t.kind === 'es-monitor')).toHaveLength(1)
    expect(second.id).toBe('es-monitor:conn-1')
    expect(store.activeTabId).toBe('es-monitor:conn-1')
    // 不同连接是不同 tab。
    store.openEsMonitor('conn-2')
    expect(store.openTabs.filter((t) => t.kind === 'es-monitor')).toHaveLength(2)
  })

  it('opens an es SQL console per connection and focuses it on reopen', () => {
    const store = useTabsStore()
    const tab = store.openEsSql('conn-1')
    expect(tab.kind).toBe('es-sql')
    expect(tab.id).toBe('es-sql:conn-1')
    expect(tab.title).toBe('SQL 控制台')
    expect(tab.connectionId).toBe('conn-1')
    expect(store.activeTabId).toBe(tab.id)
    store.openEsSql('conn-2')
    expect(store.openTabs.filter((t) => t.kind === 'es-sql')).toHaveLength(2)
    store.setActive(store.openTabs[0].id)
    const again = store.openEsSql('conn-1')
    expect(again.id).toBe(tab.id)
    expect(store.openTabs.filter((t) => t.kind === 'es-sql')).toHaveLength(2)
    expect(store.activeTabId).toBe(tab.id)
  })
})
