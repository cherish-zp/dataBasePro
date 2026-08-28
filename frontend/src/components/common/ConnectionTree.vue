<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, Topic, ConsumerGroup } from '@/api/types'
import { fuzzyScore } from '@/utils/fuzzy'
import { CSV_MIME, downloadFile, exportCsv, type ExportColumn } from '@/utils/export'
import { useConnectionsStore, type ConnectionStatus } from '@/store/connections'
import ConfirmDialog from './ConfirmDialog.vue'
import TopicDetailDrawer from '@/components/kafka/TopicDetailDrawer.vue'

const props = defineProps<{ connections: Connection[] }>()
const emit = defineEmits<{
  (e: 'open-topic', connectionId: string, topic: string, partitions: number[]): void
  (e: 'open-group', connectionId: string, group: string): void
  (e: 'open-lag', connectionId: string): void
  (e: 'open-health', connectionId: string): void
  (e: 'delete', connectionId: string): void
  (e: 'new'): void
}>()

const connStore = useConnectionsStore()

// Per data-source type metadata so the tree can grow to MySQL/ES later.
const TYPE_META: Record<string, { label: string; icon: string }> = {
  kafka: { label: 'Kafka', icon: '⚡' },
  mysql: { label: 'MySQL', icon: '🐬' },
  es: { label: 'ES', icon: '🔎' },
}

function typeMeta(conn: Connection): { label: string; icon: string } {
  return TYPE_META[conn.type] ?? { label: conn.type, icon: '📦' }
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  unknown: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接失败',
  disconnected: '未连接',
}

function statusOf(id: string): ConnectionStatus {
  return connStore.statusById[id] ?? 'unknown'
}

function isConnected(id: string): boolean {
  return statusOf(id) === 'connected'
}

// statusClass maps a connection's state to the status-dot colouring. The dot
// uses the data-source colour (per type) when connected or connecting, and a
// neutral red/gray otherwise.
function statusClass(conn: Connection): string[] {
  const s = statusOf(conn.id)
  if (s === 'connected') return [`conn-status-${conn.type}`]
  if (s === 'connecting') return [`conn-status-${conn.type}`, 'conn-status-connecting']
  return [`conn-status-${s}`]
}

async function onToggleConnect(conn: Connection): Promise<void> {
  if (isConnected(conn.id)) {
    await connStore.disconnect(conn.id)
  } else {
    await connStore.connect(conn.id)
  }
}

// An "object collection" groups the objects a data source exposes (topics,
// consumers, tables, indices...). Each collection can optionally offer create
// actions, so adding MySQL tables later is a matter of declaring a new entry
// here and a create/delete branch in the dispatch functions below.
type ObjectKind = 'topic' | 'table' | 'group'
interface ObjectCollection {
  key: string
  label: string
  icon: string
  kind: ObjectKind
  creatable: boolean
  emptyText: string
}

const COLLECTIONS_BY_TYPE: Record<string, ObjectCollection[]> = {
  kafka: [
    { key: 'topics', label: 'Topics', icon: '📋', kind: 'topic', creatable: true, emptyText: '（无主题）' },
    { key: 'consumers', label: 'Consumers', icon: '👥', kind: 'group', creatable: false, emptyText: '（无消费组）' },
  ],
  // Future data sources plug in here, e.g.:
  // mysql: [{ key: 'tables', label: 'Tables', icon: '🗄️', kind: 'table', creatable: true, emptyText: '（无表）' }],
  // es: [{ key: 'indices', label: 'Indices', icon: '🔎', kind: 'index', creatable: true, emptyText: '（无索引）' }],
}

function collectionsOf(type: string): ObjectCollection[] {
  return COLLECTIONS_BY_TYPE[type] ?? []
}

const expanded = ref<Record<string, boolean>>({})
const topicsByConn = ref<Record<string, Topic[]>>({})
const groupsByConn = ref<Record<string, ConsumerGroup[]>>({})
const loadingByConn = ref<Record<string, boolean>>({})
const errorByConn = ref<Record<string, string>>({})
const searchByConn = ref<Record<string, string>>({})
const groupSearchByConn = ref<Record<string, string>>({})
const activeSectionByConn = ref<Record<string, string>>({})

function isExpanded(id: string): boolean {
  return !!expanded.value[id]
}

async function toggle(conn: Connection): Promise<void> {
  const id = conn.id
  const nowExpanded = !expanded.value[id]
  expanded.value[id] = nowExpanded
  if (!nowExpanded) {
    // Multi-select state is ephemeral and scoped to the visible tree node, so
    // collapsing the connection discards it.
    clearBatchState(id)
    return
  }
  if (!topicsByConn.value[id] && conn.type === 'kafka') {
    await load(id)
  }
}

async function load(connId: string): Promise<void> {
  loadingByConn.value[connId] = true
  errorByConn.value[connId] = ''
  connStore.setStatus(connId, 'connecting')
  try {
    const [topics, groups] = await Promise.all([
      getApi().listTopics(connId),
      getApi().listConsumerGroups(connId),
    ])
    topicsByConn.value[connId] = topics
    groupsByConn.value[connId] = groups
    connStore.setStatus(connId, 'connected')
  } catch (e) {
    errorByConn.value[connId] = e instanceof Error ? e.message : String(e)
    connStore.setStatus(connId, 'error')
  } finally {
    loadingByConn.value[connId] = false
  }
}

function hasSearch(connId: string): boolean {
  return (searchByConn.value[connId] ?? '').trim().length > 0
}

function hasGroupSearch(connId: string): boolean {
  return (groupSearchByConn.value[connId] ?? '').trim().length > 0
}

function filteredTopics(connId: string): Topic[] {
  const q = (searchByConn.value[connId] ?? '').trim()
  const list = topicsByConn.value[connId] ?? []
  if (!q) return list
  return list
    .map((t) => ({ t, score: fuzzyScore(q, t.name) }))
    .filter((x) => x.score !== Infinity)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.t)
}

function filteredGroups(connId: string): ConsumerGroup[] {
  const q = (groupSearchByConn.value[connId] ?? '').trim()
  const list = groupsByConn.value[connId] ?? []
  if (!q) return list
  return list
    .map((g) => ({ g, score: fuzzyScore(q, g.name) }))
    .filter((x) => x.score !== Infinity)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.g)
}

// activeSection returns the currently selected object collection for a
// connection, defaulting to its first collection (Topics for Kafka).
function activeSection(connId: string, cols: ObjectCollection[]): string {
  return activeSectionByConn.value[connId] ?? cols[0]?.key ?? ''
}

// objectCount returns the total item count for a collection, used by the
// segmented control badges so users can see how full each section is.
function objectCount(connId: string, col: ObjectCollection): number {
  switch (col.kind) {
    case 'topic':
      return (topicsByConn.value[connId] ?? []).length
    case 'group':
      return (groupsByConn.value[connId] ?? []).length
    default:
      return 0
  }
}

const createMeta = ref<{ connId: string; kind: ObjectKind } | null>(null)
const createForm = reactive({ name: '', partitions: 1, replication: 1 })
const creating = ref(false)
const createError = ref<string | null>(null)

function isCreatingFor(connId: string, kind: ObjectKind): boolean {
  return createMeta.value?.connId === connId && createMeta.value?.kind === kind
}

function openCreate(conn: Connection, col: ObjectCollection): void {
  createMeta.value = { connId: conn.id, kind: col.kind }
  createForm.name = ''
  createForm.partitions = 1
  createForm.replication = 1
  createError.value = null
}

function toggleCreate(conn: Connection, col: ObjectCollection): void {
  if (isCreatingFor(conn.id, col.kind)) {
    closeCreate()
  } else {
    openCreate(conn, col)
  }
}

function closeCreate(): void {
  createMeta.value = null
}

async function submitCreate(conn: Connection): Promise<void> {
  const name = createForm.name.trim()
  if (!name) {
    createError.value = '名称不能为空'
    return
  }
  creating.value = true
  createError.value = null
  try {
    const kind = createMeta.value?.kind
    if (kind === 'topic') {
      await getApi().createTopic({
        connection_id: conn.id,
        topic: name,
        partitions: Math.max(1, createForm.partitions || 1),
        replication_factor: Math.max(1, createForm.replication || 1),
      })
      // future: if (kind === 'table') await getApi().createTable({ ... })
    }
    await load(conn.id)
    closeCreate()
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

// confirm holds the pending destructive action. The dialog is rendered by
// Wails (window.confirm is silently unsupported in WKWebView and always
// returns false), so deletion is confirmed in-app instead. `names` marks a
// batch delete of several topics at once.
const confirm = ref<{ connId: string; kind: ObjectKind; name: string; names?: string[] } | null>(null)

const confirmMessage = computed(() => {
  const pending = confirm.value
  if (!pending) return ''
  if (pending.names) return `确认删除 ${pending.names.length} 个 Topic？此操作不可恢复。`
  return `确认删除 ${pending.kind === 'topic' ? 'Topic' : 'Consumer Group'}「${pending.name}」？此操作不可恢复。`
})

const confirmText = computed(() => {
  const pending = confirm.value
  if (!pending) return '删除'
  if (pending.names) return `删除 ${pending.names.length} 个 Topic`
  return `删除 ${pending.kind === 'topic' ? 'Topic' : '消费组'}`
})

// detailMeta holds the topic whose detail drawer is open; null hides it.
const detailMeta = ref<{ connId: string; topic: string } | null>(null)

function askDelete(conn: Connection, kind: ObjectKind, name: string): void {
  confirm.value = { connId: conn.id, kind, name }
}

// Multi-select state is per connection and intentionally ephemeral: it lives
// here (not in the stores) and is cleared when leaving select mode, after a
// batch delete, or when the connection is collapsed.
const selectModeByConn = ref<Record<string, boolean>>({})
const selectedByConn = ref<Record<string, string[]>>({})
const batchFeedbackByConn = ref<Record<string, BatchDeleteFeedback | null>>({})

interface BatchDeleteFeedback {
  deleted: number
  failed: number
  failures: { name: string; error: string }[]
}

function isSelectMode(connId: string): boolean {
  return !!selectModeByConn.value[connId]
}

function selectedOf(connId: string): string[] {
  return selectedByConn.value[connId] ?? []
}

function batchFeedback(connId: string): BatchDeleteFeedback | null {
  return batchFeedbackByConn.value[connId] ?? null
}

function clearBatchState(connId: string): void {
  selectModeByConn.value[connId] = false
  selectedByConn.value[connId] = []
  batchFeedbackByConn.value[connId] = null
}

function toggleSelectMode(conn: Connection): void {
  if (isSelectMode(conn.id)) {
    clearBatchState(conn.id)
  } else {
    selectModeByConn.value[conn.id] = true
    batchFeedbackByConn.value[conn.id] = null
  }
}

function isTopicSelected(connId: string, name: string): boolean {
  return selectedOf(connId).includes(name)
}

function toggleTopicSelected(connId: string, name: string): void {
  const cur = selectedOf(connId)
  selectedByConn.value[connId] = cur.includes(name)
    ? cur.filter((n) => n !== name)
    : [...cur, name]
}

// isAllSelected and toggleSelectAll operate on the visible (search filtered)
// topic list: select-all must never silently include topics the user filtered
// out of view, especially before a destructive batch delete.
function isAllSelected(connId: string): boolean {
  const list = filteredTopics(connId)
  return list.length > 0 && list.every((t) => isTopicSelected(connId, t.name))
}

function toggleSelectAll(connId: string): void {
  const list = filteredTopics(connId)
  selectedByConn.value[connId] = isAllSelected(connId) ? [] : list.map((t) => t.name)
}

function askBatchDelete(connId: string): void {
  const names = selectedOf(connId)
  if (names.length === 0) return
  confirm.value = { connId, kind: 'topic', name: '', names }
}

async function executeDelete(): Promise<void> {
  const pending = confirm.value
  if (!pending) return
  confirm.value = null
  const conn = props.connections.find((c) => c.id === pending.connId)
  if (!conn) return
  try {
    if (pending.names) {
      await executeBatchDelete(conn, pending.names)
      return
    }
    if (pending.kind === 'topic') {
      await getApi().deleteTopic({ connection_id: pending.connId, topic: pending.name })
    } else if (pending.kind === 'group') {
      await getApi().deleteConsumerGroup({ connection_id: pending.connId, group: pending.name })
    }
    await load(pending.connId)
  } catch (e) {
    errorByConn.value[pending.connId] = e instanceof Error ? e.message : String(e)
  }
}

// executeBatchDelete deletes the given topics in one call. Per-topic failures
// are surfaced as feedback while the tree reloads regardless, so topics whose
// deletion failed stay listed.
async function executeBatchDelete(conn: Connection, names: string[]): Promise<void> {
  const results = await getApi().deleteTopics({ connection_id: conn.id, names })
  const failures = results
    .filter((r) => r.error)
    .map((r) => ({ name: r.name, error: r.error }))
  batchFeedbackByConn.value[conn.id] = {
    deleted: results.length - failures.length,
    failed: failures.length,
    failures,
  }
  selectedByConn.value[conn.id] = []
  await load(conn.id)
}

// TOPIC_EXPORT_COLUMNS is deliberately data-source neutral (name + partition
// count only) so the same export shape carries over to future source types.
const TOPIC_EXPORT_COLUMNS: ExportColumn<Topic>[] = [
  { label: 'topic', value: (t) => t.name },
  { label: 'partitions', value: (t) => String(t.partitions.length) },
]

// exportTopics exports the connection's full topic list (not the search
// filtered view and not just the selection), named after the connection.
function exportTopics(conn: Connection): void {
  const topics = topicsByConn.value[conn.id] ?? []
  downloadFile(`topics-${conn.name}`, exportCsv(topics, TOPIC_EXPORT_COLUMNS), CSV_MIME)
}
</script>

<template>
  <div class="tree" data-test="connection-tree">
    <button class="tree-new" type="button" data-test="btn-new" @click="emit('new')">＋ 新建连接</button>
    <div v-if="connections.length === 0" class="tree-empty" data-test="tree-empty">暂无连接</div>
    <div v-for="conn in connections" :key="conn.id" class="conn" data-test="connection">
      <div class="conn-row" data-test="conn-row" @click="toggle(conn)">
        <span class="caret" data-test="conn-caret" :class="{ open: isExpanded(conn.id) }">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span
          class="conn-status"
          data-test="conn-status-dot"
          :class="statusClass(conn)"
          :data-status="statusOf(conn.id)"
          :title="STATUS_LABEL[statusOf(conn.id)]"
        ></span>
        <span class="conn-name" data-test="conn-name">{{ conn.name }}</span>
        <span class="conn-type" :class="`conn-type-${conn.type}`" data-test="conn-type">{{ typeMeta(conn).label }}</span>
        <button class="conn-toggle" type="button" data-test="btn-connect" :title="isConnected(conn.id) ? '关闭连接' : '打开连接'" @click.stop="onToggleConnect(conn)">
          <span class="toggle-icon">⏻</span>
          <span class="toggle-text">{{ isConnected(conn.id) ? '断开' : '连接' }}</span>
        </button>
        <button v-if="conn.type === 'kafka'" class="conn-health" type="button" data-test="btn-cluster-health" title="集群健康" @click.stop="emit('open-health', conn.id)">🩺</button>
        <button class="conn-delete" type="button" data-test="btn-delete" @click.stop="emit('delete', conn.id)">🗑</button>
      </div>

      <div v-if="isExpanded(conn.id) && conn.type === 'kafka'" class="conn-children">
        <div v-if="loadingByConn[conn.id]" class="conn-loading" data-test="tree-loading">加载中…</div>
        <div v-else-if="errorByConn[conn.id]" class="conn-error" data-test="tree-error">{{ errorByConn[conn.id] }}</div>
        <template v-else>
          <div class="segmented" data-test="section-tabs" role="tablist">
            <button
              v-for="col in collectionsOf(conn.type)"
              :key="col.key"
              type="button"
              class="segmented-btn"
              :class="{ active: activeSection(conn.id, collectionsOf(conn.type)) === col.key }"
              :data-test="`section-tab-${col.key}`"
              role="tab"
              :aria-selected="activeSection(conn.id, collectionsOf(conn.type)) === col.key"
              @click="activeSectionByConn[conn.id] = col.key"
            >
              <span class="segmented-icon">{{ col.icon }}</span>
              <span class="segmented-label">{{ col.label }}</span>
              <span class="segmented-count">{{ objectCount(conn.id, col) }}</span>
            </button>
          </div>

          <button
            class="lag-entry"
            type="button"
            data-test="btn-open-lag"
            title="查看该连接所有消费组的 Lag 积压总览"
            @click="emit('open-lag', conn.id)"
          >
            <span class="lag-entry-icon">📊</span>
            <span>Lag 总览</span>
          </button>

          <template v-for="col in collectionsOf(conn.type)" :key="col.key">
            <template v-if="activeSection(conn.id, collectionsOf(conn.type)) === col.key">
            <component
              :is="col.creatable ? 'button' : 'div'"
              class="group-label"
              :class="{ clickable: col.creatable }"
              data-test="object-group"
              :type="col.creatable ? 'button' : undefined"
              :role="col.creatable ? 'button' : undefined"
              :aria-label="col.creatable ? `新建 ${col.label}` : undefined"
              :title="col.creatable ? '新建' : undefined"
              @click="col.creatable ? toggleCreate(conn, col) : undefined"
            >
              <span class="group-title">{{ col.icon }} {{ col.label }}</span>
              <span v-if="col.creatable" class="group-add" data-test="btn-create-object" aria-hidden="true">＋</span>
            </component>

            <div v-if="col.kind === 'topic' && isCreatingFor(conn.id, 'topic')" class="create-form" data-test="create-form">
              <input
                v-model="createForm.name"
                class="input"
                type="text"
                data-test="create-name"
                placeholder="Topic 名称"
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                spellcheck="false"
              />
              <div class="create-row">
                <label class="create-field">
                  分区
                  <input v-model.number="createForm.partitions" class="input num" type="number" min="1" data-test="create-partitions" />
                </label>
                <label class="create-field">
                  副本
                  <input v-model.number="createForm.replication" class="input num" type="number" min="1" data-test="create-replication" />
                </label>
              </div>
              <div v-if="createError" class="create-error" data-test="create-error">{{ createError }}</div>
              <div class="create-actions">
                <button class="btn primary" type="button" data-test="btn-create-submit" :disabled="creating" @click="submitCreate(conn)">
                  {{ creating ? '创建中…' : '创建' }}
                </button>
                <button class="btn ghost" type="button" data-test="btn-create-cancel" @click="closeCreate">取消</button>
              </div>
            </div>

            <div v-if="col.key === 'topics'" class="topic-search">
              <input
                v-model="searchByConn[conn.id]"
                class="search-input"
                type="search"
                data-test="topic-search"
                placeholder="🔍 模糊搜索 Topic…"
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                spellcheck="false"
              />
            </div>

            <div v-if="col.key === 'topics'" class="topic-toolbar">
              <button class="tool-btn" type="button" data-test="select-mode-toggle" @click="toggleSelectMode(conn)">
                {{ isSelectMode(conn.id) ? '退出多选' : '多选' }}
              </button>
              <template v-if="isSelectMode(conn.id)">
                <button class="tool-btn" type="button" data-test="select-all-topics" @click="toggleSelectAll(conn.id)">
                  {{ isAllSelected(conn.id) ? '取消全选' : '全选' }}
                </button>
                <button
                  class="tool-btn danger"
                  type="button"
                  data-test="batch-delete-topics"
                  :disabled="selectedOf(conn.id).length === 0"
                  title="删除勾选的 Topic"
                  @click="askBatchDelete(conn.id)"
                >删除({{ selectedOf(conn.id).length }})</button>
              </template>
              <button class="tool-btn" type="button" data-test="export-topics" title="导出 Topic 列表为 CSV" @click="exportTopics(conn)">导出列表</button>
            </div>

            <div v-if="col.key === 'topics' && batchFeedback(conn.id)" class="batch-result">
              <div class="batch-summary" data-test="batch-delete-summary">
                删除完成：成功 {{ batchFeedback(conn.id)?.deleted ?? 0 }} / 失败 {{ batchFeedback(conn.id)?.failed ?? 0 }}
              </div>
              <div v-if="(batchFeedback(conn.id)?.failures.length ?? 0) > 0" class="batch-failures" data-test="batch-delete-failures">
                <div v-for="f in batchFeedback(conn.id)?.failures" :key="f.name" class="batch-failure">{{ f.name }}：{{ f.error }}</div>
              </div>
            </div>

            <div v-if="col.key === 'consumers'" class="topic-search">
              <input
                v-model="groupSearchByConn[conn.id]"
                class="search-input"
                type="search"
                data-test="group-search"
                placeholder="🔍 模糊搜索 Consumer…"
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                spellcheck="false"
              />
            </div>

            <template v-if="col.kind === 'topic'">
              <div
                v-for="t in filteredTopics(conn.id)"
                :key="t.name"
                class="leaf"
                data-test="topic-node"
                :title="`${t.name} (${t.partitions.length} 分区)`"
                @dblclick="emit('open-topic', conn.id, t.name, t.partitions.map((p) => p.id))"
              >
                <input
                  v-if="isSelectMode(conn.id)"
                  type="checkbox"
                  class="leaf-check"
                  :data-test="`topic-check-${t.name}`"
                  :checked="isTopicSelected(conn.id, t.name)"
                  @click.stop="toggleTopicSelected(conn.id, t.name)"
                  @dblclick.stop
                />
                <span class="leaf-name" data-test="topic-name">{{ t.name }}</span>
                <button
                  class="leaf-info"
                  type="button"
                  data-test="btn-topic-info"
                  title="Topic 详情"
                  @click.stop="detailMeta = { connId: conn.id, topic: t.name }"
                >ℹ</button>
                <button
                  class="leaf-del"
                  type="button"
                  data-test="btn-delete-topic"
                  title="删除 Topic"
                  @click.stop="askDelete(conn, 'topic', t.name)"
                >🗑</button>
              </div>
              <div v-if="filteredTopics(conn.id).length === 0" class="leaf muted" data-test="topic-empty">
                {{ hasSearch(conn.id) ? '无匹配 Topic' : col.emptyText }}
              </div>
            </template>

            <template v-else-if="col.kind === 'group'">
              <div
                v-for="g in filteredGroups(conn.id)"
                :key="g.name"
                class="leaf"
                data-test="group-node"
                @dblclick="emit('open-group', conn.id, g.name)"
              >
                <span class="leaf-name">{{ g.name }}</span>
                <button
                  class="leaf-del"
                  type="button"
                  data-test="btn-delete-group"
                  title="删除 Consumer Group"
                  @click.stop="askDelete(conn, 'group', g.name)"
                >🗑</button>
              </div>
              <div v-if="filteredGroups(conn.id).length === 0" class="leaf muted" data-test="group-empty">
                {{ hasGroupSearch(conn.id) ? '无匹配 Consumer' : col.emptyText }}
              </div>
            </template>
            </template>
          </template>
        </template>
      </div>
      <div v-else-if="isExpanded(conn.id)" class="conn-children">
        <div class="leaf muted" data-test="type-unsupported">{{ typeMeta(conn).label }} 类型暂未支持</div>
      </div>
    </div>
    <TopicDetailDrawer
      :show="!!detailMeta"
      :connection-id="detailMeta?.connId ?? ''"
      :topic="detailMeta?.topic ?? ''"
      @close="detailMeta = null"
    />
    <ConfirmDialog
      :show="!!confirm"
      :message="confirmMessage"
      :confirm-text="confirmText"
      @confirm="executeDelete"
      @cancel="confirm = null"
    />
  </div>
</template>

<style scoped>
.tree { padding: 8px; font-size: 13px; color: var(--text); font-family: var(--font); }
.tree-new {
  width: 100%; box-sizing: border-box;
  background: var(--accent); color: #fff; border: none;
  border-radius: 8px; padding: 8px; cursor: pointer; margin-bottom: 10px; font-size: 13px;
  box-shadow: 0 1px 2px rgba(0, 113, 227, 0.3);
  transition: background 0.15s ease;
}
.tree-new:hover { background: var(--accent-hover); }
.tree-empty { color: var(--text-tertiary); padding: 10px 8px; }
.conn { margin-bottom: 2px; }
.conn-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 8px; cursor: pointer;
  transition: background 0.12s ease;
  user-select: none;
}
.conn-row:hover { background: var(--bg-hover); }
.caret {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; color: var(--text-tertiary);
  transition: transform 0.18s ease, color 0.18s ease;
  flex: none;
}
.caret.open { transform: rotate(90deg); color: var(--text-secondary); }
.conn-name { font-weight: 600; flex: 1; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conn-type { font-size: 11px; font-weight: 500; padding: 1px 7px; border-radius: 5px; flex: none; }
.conn-type-kafka { color: var(--info); background: var(--info-soft); }
.conn-type-mysql { color: var(--warn); background: var(--warn-soft); }
.conn-type-es { color: var(--ok); background: var(--ok-soft); }
.conn-status {
  width: 8px; height: 8px; border-radius: 50%; flex: none; margin: 0 6px;
  background: var(--text-tertiary);
}
.conn-status-kafka { background: var(--ok); }
.conn-status-mysql { background: var(--info); }
.conn-status-es { background: var(--warn); }
.conn-status-connecting { background: var(--ok); animation: conn-pulse 1.1s ease-in-out infinite; }
.conn-status-error { background: var(--danger); }
.conn-status-disconnected { background: var(--text-tertiary); }
.conn-status-unknown { background: var(--text-tertiary); }
@keyframes conn-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.conn-toggle {
  display: flex; align-items: center; gap: 3px;
  background: none; border: 1px solid var(--border-strong); color: var(--text-secondary);
  font-size: 11px; font-weight: 500; border-radius: 6px; padding: 1px 7px; cursor: pointer; flex: none;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.conn-toggle:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.conn-toggle .toggle-icon { font-size: 12px; line-height: 1; }
.conn-delete { background: none; border: none; color: var(--text-tertiary); cursor: pointer; border-radius: 4px; padding: 1px 3px; flex: none; }
.conn-delete:hover { color: var(--danger); background: var(--danger-soft); }
.conn-health { background: none; border: none; color: var(--text-tertiary); cursor: pointer; border-radius: 4px; padding: 1px 3px; font-size: 12px; line-height: 1; flex: none; transition: color 0.15s ease, background 0.15s ease; }
.conn-health:hover { color: var(--ok); background: var(--ok-soft); }
.conn-children { margin-left: 16px; border-left: 1px solid var(--border); padding-left: 8px; }
.topic-search { margin: 6px 0 2px; }
.topic-toolbar { display: flex; align-items: center; gap: 6px; margin: 4px 0 2px; }
.tool-btn {
  background: none; border: 1px solid var(--border-strong); color: var(--text-secondary);
  font-size: 11px; font-weight: 500; border-radius: 6px; padding: 1px 8px; cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}
.tool-btn:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.tool-btn.danger:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.tool-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tool-btn:disabled:hover { color: var(--text-secondary); border-color: var(--border-strong); background: none; }
.leaf-check { margin: 0; flex: none; accent-color: var(--accent); cursor: pointer; }
.batch-result { margin: 4px 0 2px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-subtle); }
.batch-summary { font-size: 12px; color: var(--text); }
.batch-failures { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.batch-failure { font-size: 11px; color: var(--danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 5px 9px; font-size: 12px;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.search-input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-input::placeholder { color: var(--text-tertiary); }
.group-label {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--text-tertiary); text-transform: uppercase;
  letter-spacing: 0.05em; margin: 8px 0 3px;
  position: relative; z-index: 1; isolation: isolate;
  width: 100%; box-sizing: border-box;
  appearance: none; background: none; border: none; padding: 4px 6px;
  margin: 8px -6px 3px;
  font-family: inherit; text-align: left; line-height: inherit;
}
.group-label.clickable { cursor: pointer; border-radius: 6px; transition: background 0.12s ease, color 0.12s ease; }
.group-label.clickable:hover { background: var(--bg-hover); color: var(--text); }
.group-label.clickable:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }
.group-label .group-title { flex: 1; min-width: 0; }
.group-label .group-add { margin-right: -2px; }
.group-label.clickable:active .group-add { color: var(--accent-hover); }
.group-add {
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--accent);
  font-size: 17px; font-weight: 600; line-height: 1;
  min-width: 22px; min-height: 22px; padding: 2px 4px; border-radius: 6px;
  transition: background 0.12s ease, transform 0.12s ease;
}
.group-label.clickable:hover .group-add { background: var(--accent-soft); }
.group-label.clickable:active .group-add { transform: scale(0.92); }
.leaf {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 7px; border-radius: 6px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background 0.12s ease, color 0.12s ease;
}
.leaf:hover { background: var(--bg-hover); color: var(--text); }
.leaf.muted { color: var(--text-tertiary); cursor: default; }
.leaf-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.leaf-del {
  background: none; border: none; color: var(--text-tertiary); cursor: pointer;
  border-radius: 4px; padding: 0 3px; flex: none; opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.leaf:hover .leaf-del { opacity: 1; }
.leaf-del:hover { color: var(--danger); background: var(--danger-soft); }
.leaf-info {
  background: none; border: none; color: var(--text-tertiary); cursor: pointer;
  border-radius: 4px; padding: 0 3px; flex: none; opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.leaf:hover .leaf-info { opacity: 1; }
.leaf-info:hover { color: var(--info); background: var(--info-soft); }
.create-form {
  margin: 6px 0 2px; padding: 8px; border: 1px solid var(--border);
  border-radius: 8px; background: var(--bg-subtle); display: flex; flex-direction: column; gap: 7px;
}
.input {
  background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 5px 9px; font-size: 12px; width: 100%; box-sizing: border-box;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.create-row { display: flex; gap: 8px; }
.create-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-secondary); flex: 1; }
.input.num { width: 100%; }
.create-error { color: var(--danger); font-size: 12px; }
.create-actions { display: flex; gap: 8px; }
.btn { border-radius: 7px; padding: 4px 12px; font-size: 12px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover { background: var(--bg-hover); }
.segmented {
  display: flex; gap: 2px; margin: 6px 0 8px; padding: 3px;
  background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: 9px;
}
.segmented-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
  border: none; background: transparent; color: var(--text-secondary);
  font-size: 12px; font-weight: 500; padding: 5px 8px; border-radius: 7px;
  cursor: pointer; transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  min-width: 0;
}
.segmented-btn:hover { color: var(--text); }
.segmented-btn.active {
  background: var(--bg-elevated); color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.segmented-icon { flex: none; }
.segmented-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.segmented-count {
  flex: none; font-size: 11px; color: var(--text-tertiary);
  background: var(--bg-hover); border-radius: 99px; padding: 0 6px; line-height: 16px;
}
.segmented-btn.active .segmented-count { color: var(--accent); }
.lag-entry {
  display: flex; align-items: center; gap: 6px;
  width: 100%; box-sizing: border-box;
  background: none; border: none; color: var(--text);
  font-size: 13px; font-family: inherit; text-align: left; line-height: inherit;
  padding: 4px 7px; margin-bottom: 2px; border-radius: 6px; cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.lag-entry:hover { background: var(--bg-hover); }
.lag-entry:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent); }
.lag-entry .lag-entry-icon { flex: none; }
.conn-loading { color: var(--text-secondary); padding: 5px; }
.conn-error { color: var(--danger); padding: 5px; }
</style>
