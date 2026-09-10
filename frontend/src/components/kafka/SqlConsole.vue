<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { Message, SavedQuery } from '@/api/types'
import { OffsetEarliest } from '@/api/types'
import { parseSelect, matchesWhere } from '@/utils/sql'
import { formatTime, displayValue } from '@/utils/format'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, exportCsv, exportJsonl, saveFile } from '@/utils/export'
import ExportDropdown from '@/components/common/ExportDropdown.vue'
import PromptDialog from '@/components/common/PromptDialog.vue'
import SqlEditor from '@/components/common/SqlEditor.vue'
import type { SqlTableSchema } from '@/components/common/SqlEditor.vue'
import { useSqlHistoryStore } from '@/store/sqlhistory'

const props = defineProps<{
  tabId: string
  connectionId: string
  topic: string
  partitions: number[]
}>()

const sql = ref(`SELECT * FROM ${props.topic} LIMIT 100`)
const running = ref(false)
const error = ref<string | null>(null)
const results = ref<Message[]>([])

// --- CodeMirror 补全来源:当前连接的 topic 列表映射为 {name: topic} ----------
// 仅作补全提示,拉取失败静默降级为空(不阻塞控制台主流程)。
const tables = ref<SqlTableSchema[]>([])

async function loadTables(): Promise<void> {
  try {
    const topics = await getApi().listTopics(props.connectionId)
    tables.value = topics.map((t) => ({ name: t.name }))
  } catch {
    tables.value = []
  }
}

onMounted(() => void loadTables())

// Per-topic SQL draft cache (BL-007): unrun editor content survives a topic
// switch. Component-local only — drafts are dropped on unmount and never
// persisted. A draft is written when leaving a topic (unless the editor is
// blank, which means the user cleared it, or the content equals the last
// successfully-run query, which means nothing is pending), read back when
// returning, and dropped once the query runs successfully. Drafts are keyed by
// `${connectionId}:${topic}` so sql tabs on different connections sharing a
// topic name do not share a draft.
const draftByTopic: Record<string, string> = {}
const lastRunByTopic: Record<string, string> = {}

function draftKey(connectionId: string, topic: string): string {
  return `${connectionId}:${topic}`
}

watch(
  () => props.topic,
  (t, old) => {
    if (old) {
      const oldKey = draftKey(props.connectionId, old)
      if (sql.value.trim()) {
        if (sql.value !== lastRunByTopic[oldKey]) {
          draftByTopic[oldKey] = sql.value
        }
      } else {
        // Editor was cleared to blank → the old draft is obsolete.
        delete draftByTopic[oldKey]
      }
    }
    sql.value = draftByTopic[draftKey(props.connectionId, t)] ?? `SELECT * FROM ${t} LIMIT 100`
    results.value = []
  },
)

const sqlHistory = useSqlHistoryStore()

async function run(): Promise<void> {
  error.value = null
  results.value = []
  const parsed = parseSelect(sql.value)
  if (parsed.error) {
    error.value = parsed.error
    return
  }
  const topic = parsed.topic ?? props.topic
  // Record at submission: the query was accepted for execution, regardless of
  // whether the broker later returns rows or errors (simple console behavior).
  const submitted = sql.value
  sqlHistory.record(submitted)
  running.value = true
  try {
    const fetched = await getApi().consumeMessages({
      connection_id: props.connectionId,
      topic,
      partition: -1,
      offset: OffsetEarliest,
      limit: parsed.limit ?? 500,
    })
    let out = fetched.filter((m) => matchesWhere(m, parsed.where))
    if (parsed.limit != null) out = out.slice(0, parsed.limit)
    results.value = out
    // A successful run validates the query: no longer a pending draft for the
    // current topic. Remember what was run so the topic-switch watch skips
    // re-saving it (which would otherwise resurrect the just-run SQL).
    const key = draftKey(props.connectionId, props.topic)
    lastRunByTopic[key] = submitted
    delete draftByTopic[key]
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

// onEditorKeydown runs the query on ⌘Enter/Ctrl+Enter. The IME guard leaves
// Enter during composition (e.g. committing a Chinese candidate) untouched, so
// the IME keeps the key; a plain Enter stays a newline in the editor.
function onEditorKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  // 与「执行」按钮的 :disabled="running" 守卫一致：运行中连按 ⌘Enter 不重复 fetch / 不重复记历史。
  if (running.value) return
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void run()
  }
}

// exportAs downloads the current result rows in the picked format. The
// dropdown component owns its open state and outside-click closing.
function exportAs(format: 'csv' | 'jsonl'): void {
  if (format === 'csv') {
    void saveFile('query-results', exportCsv(results.value, MESSAGE_EXPORT_COLUMNS), CSV_MIME)
  } else {
    void saveFile('query-results', exportJsonl(results.value), JSONL_MIME)
  }
}

// History/favorites dropdown: refills the editor and re-executes the picked
// query; favorites are named, savable and removable inline.
const historyOpen = ref(false)
const historyRoot = ref<HTMLElement | null>(null)
const favFormOpen = ref(false)
const favName = ref('')

// applyQuery fills the editor with the picked query and executes it right
// away (回填触发执行), closing the menu. Like the ⌘Enter guard, it must not
// start a second fetch while a query is in flight (BL-006).
function applyQuery(q: string): void {
  if (running.value) return
  historyOpen.value = false
  sql.value = q
  void run()
}

function openFavForm(): void {
  favFormOpen.value = true
}

// confirmSave stores the current editor SQL under the entered name, then
// collapses the inline form (the dropdown stays open to show the new entry).
function confirmSave(): void {
  const name = favName.value.trim()
  if (!name) return
  sqlHistory.saveFavorite(name, sql.value)
  favFormOpen.value = false
  favName.value = ''
}

// Closing the history menu (toggle off, outside click, or applying a query)
// must also dismiss the inline favorite form and clear its draft name, so
// reopening the menu never shows a stale half-typed favorite (BL-034).
watch(historyOpen, (open) => {
  if (!open) {
    favFormOpen.value = false
    favName.value = ''
  }
})

// --- 查询库侧栏(保存的查询,按连接隔离) ------------------------------------
// 打开面板时按当前连接拉取列表;单击条目 = 载入编辑器(记住条目 id)。
// 「保存」:已载入条目 → updateSavedQuery,否则弹名称输入 → saveSavedQuery;
// 「另存为」:强制弹名称输入 → saveSavedQuery;「删除」仅对已载入条目可用。
const queryLibOpen = ref(false)
const savedQueries = ref<SavedQuery[]>([])
const queryLibError = ref<string | null>(null)
const loadedQueryId = ref<string | null>(null)

async function refreshSavedQueries(): Promise<void> {
  queryLibError.value = null
  try {
    savedQueries.value = await getApi().listSavedQueries({
      console_type: 'kafka-sql',
      connection_id: props.connectionId,
    })
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  }
}

function toggleQueryLib(): void {
  queryLibOpen.value = !queryLibOpen.value
  if (queryLibOpen.value) void refreshSavedQueries()
}

// 切换连接:保持编辑器 SQL 不动,仅按新连接刷新列表;旧连接的已载入条目
// 不再属于当前列表,清空已载入状态以免 update/delete 打到不可见条目上。
watch(
  () => props.connectionId,
  () => {
    loadedQueryId.value = null
    void loadTables()
    if (queryLibOpen.value) void refreshSavedQueries()
  },
)

function loadQuery(q: SavedQuery): void {
  sql.value = q.content
  loadedQueryId.value = q.id
}

// 名称输入弹窗:save(未载入条目时)与 save-as 共用。
const nameDialogOpen = ref(false)
const nameDialogMode = ref<'save' | 'save-as'>('save')

function requestSaveQuery(forceNew: boolean): void {
  if (!forceNew && loadedQueryId.value) {
    void updateLoadedQuery()
    return
  }
  nameDialogMode.value = forceNew ? 'save-as' : 'save'
  nameDialogOpen.value = true
}

async function updateLoadedQuery(): Promise<void> {
  const id = loadedQueryId.value
  if (!id) return
  const current = savedQueries.value.find((q) => q.id === id)
  queryLibError.value = null
  try {
    const updated = await getApi().updateSavedQuery({ id, name: current?.name ?? '', content: sql.value })
    await refreshSavedQueries()
    loadedQueryId.value = updated.id
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  }
}

async function confirmSaveQuery(name: string): Promise<void> {
  nameDialogOpen.value = false
  queryLibError.value = null
  try {
    const saved = await getApi().saveSavedQuery({
      name,
      console_type: 'kafka-sql',
      connection_id: props.connectionId,
      content: sql.value,
    })
    await refreshSavedQueries()
    // 新建的条目即为「已载入」,后续保存走 update 而不是重复新建。
    loadedQueryId.value = saved.id
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  }
}

async function removeLoadedQuery(): Promise<void> {
  const id = loadedQueryId.value
  if (!id) return
  queryLibError.value = null
  try {
    await getApi().deleteSavedQuery({ id })
    loadedQueryId.value = null
    await refreshSavedQueries()
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  }
}

function onSavedQueryName(v: string): void {
  void confirmSaveQuery(v)
}


function onDocClick(e: MouseEvent): void {
  if (historyOpen.value && historyRoot.value && !historyRoot.value.contains(e.target as Node)) {
    historyOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="sql-console" data-test="sql-console">
    <div class="sql-toolbar" data-test="sql-toolbar">
      <button class="btn ghost" type="button" data-test="btn-query-lib-toggle" @click="toggleQueryLib">
        查询库
      </button>
      <aside v-if="queryLibOpen" class="query-lib" data-test="query-lib">
        <div class="ql-head">
          <span class="ql-title">查询库</span>
          <span class="ql-sub">保存的查询按连接隔离</span>
        </div>
        <div class="ql-actions">
          <button class="btn mini" type="button" data-test="btn-query-save" @click="requestSaveQuery(false)">
            保存
          </button>
          <button class="btn mini" type="button" data-test="btn-query-save-as" @click="requestSaveQuery(true)">
            另存为
          </button>
          <button
            class="btn mini"
            type="button"
            data-test="btn-query-delete"
            :disabled="!loadedQueryId"
            @click="removeLoadedQuery"
          >
            删除
          </button>
        </div>
        <div v-if="queryLibError" class="ql-error" data-test="query-lib-error">{{ queryLibError }}</div>
        <div class="ql-list">
          <button
            v-for="(q, i) in savedQueries"
            :key="q.id"
            class="ql-item"
            type="button"
            :class="{ active: q.id === loadedQueryId }"
            :data-test="`query-item-${i}`"
            @click="loadQuery(q)"
          >
            <span class="ql-name">{{ q.name }}</span>
            <span class="ql-time">{{ new Date(q.updated_at).toLocaleString() }}</span>
          </button>
          <div v-if="!savedQueries.length" class="ql-empty" data-test="query-lib-empty">暂无保存的查询</div>
        </div>
      </aside>
      <label class="sql-field grow" data-test="sql-field">
        <span class="label">SQL</span>
        <div class="cm-host" @keydown="onEditorKeydown">
          <SqlEditor v-model="sql" :tables="tables" height="220px" data-test="input-sql" />
        </div>
      </label>
      <div ref="historyRoot" class="history-menu" data-test="history-menu">
        <button class="btn ghost" type="button" data-test="history-toggle" @click="historyOpen = !historyOpen">
          历史/收藏 ▾
        </button>
        <div v-if="historyOpen" class="history-pop" data-test="history-pop">
          <div class="pop-section">
            <div class="pop-title">历史</div>
            <button
              v-for="q in sqlHistory.history"
              :key="q"
              class="pop-item"
              type="button"
              data-test="history-item"
              :title="q"
              @click="applyQuery(q)"
            >
              {{ q }}
            </button>
            <div v-if="!sqlHistory.history.length" class="pop-empty" data-test="history-empty">暂无历史</div>
          </div>
          <div class="pop-section">
            <div class="pop-title-row">
              <span class="pop-title">收藏</span>
              <button class="fav-save" type="button" data-test="fav-save" :disabled="!sql.trim()" @click="openFavForm">
                保存当前查询
              </button>
            </div>
            <div v-if="favFormOpen" class="fav-form">
              <input
                v-model="favName"
                class="fav-name"
                data-test="fav-name-input"
                placeholder="收藏名称"
                @keydown.enter.prevent="confirmSave"
              />
              <button
                class="btn primary fav-confirm"
                type="button"
                data-test="fav-confirm"
                :disabled="!favName.trim()"
                @click="confirmSave"
              >
                确认
              </button>
            </div>
            <div v-for="f in sqlHistory.favorites" :key="f.name" class="fav-row">
              <button
                class="pop-item"
                type="button"
                data-test="fav-item"
                :title="f.sql"
                @click="applyQuery(f.sql)"
              >
                {{ f.name }}
              </button>
              <button
                class="fav-remove"
                type="button"
                data-test="fav-remove"
                title="删除收藏"
                @click="sqlHistory.removeFavorite(f.name)"
              >
                ✕
              </button>
            </div>
            <div v-if="!sqlHistory.favorites.length" class="pop-empty" data-test="fav-empty">暂无收藏</div>
          </div>
        </div>
      </div>
      <button class="btn primary" type="button" data-test="btn-run" :disabled="running" @click="run">
        {{ running ? '执行中…' : '执行' }}
      </button>
    </div>

    <div class="hint">支持：<code>SELECT * FROM &lt;topic&gt;</code>，<code>WHERE key='x' / value LIKE '%x%'</code>，<code>LIMIT n</code>。</div>

    <div v-if="error" class="msg err" data-test="sql-error">{{ error }}</div>

    <div class="results-panel" data-test="sql-results">
      <div class="results-header">
        <span>查询结果（{{ results.length }} 条）</span>
        <ExportDropdown :disabled="results.length === 0" @export="exportAs" />
      </div>
      <div v-if="results.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Partition</th>
              <th>Offset</th>
              <th>Timestamp</th>
              <th>Key</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in results" :key="`${m.partition}:${m.offset}`" data-test="sql-row">
              <td>{{ m.partition }}</td>
              <td class="mono">{{ m.offset }}</td>
              <td class="mono">{{ formatTime(m.timestamp) }}</td>
              <td class="mono truncate">{{ displayValue(m.key) }}</td>
              <td class="truncate">{{ displayValue(m.value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty" data-test="sql-empty">暂无结果</div>
    </div>

    <PromptDialog
      :show="nameDialogOpen"
      :title="nameDialogMode === 'save-as' ? '另存查询' : '保存查询'"
      label="查询名称"
      hint="保存的查询按连接隔离"
      @confirm="onSavedQueryName"
      @cancel="nameDialogOpen = false"
    />
  </div>
</template>

<style scoped>
.sql-console {
  height: 100%;
  display: flex;
  flex-direction: column;
  font-family: var(--font);
  color: var(--text);
  background: var(--bg-elevated);
}
.sql-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.72);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
}
.sql-field { display: flex; flex-direction: column; gap: 5px; }
.sql-field.grow { flex: 1; min-width: 0; }
.label { font-size: 11px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.02em; }
.cm-host { width: 100%; }
.hint { font-size: 12px; color: var(--text-tertiary); padding: 7px 16px 0; }
.hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 5px; font-family: var(--mono); }
.msg { font-size: 13px; border-radius: 9px; padding: 8px 12px; margin: 8px 16px 0; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
/* 查询库侧栏:宽约 240px,与编辑器同高拉伸。 */
.query-lib {
  flex: none; width: 240px; align-self: stretch;
  display: flex; flex-direction: column; gap: 8px; min-height: 0;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-subtle); padding: 10px;
}
.ql-head { display: flex; flex-direction: column; gap: 2px; }
.ql-title { font-size: 12px; font-weight: 600; color: var(--text); }
.ql-sub { font-size: 11px; color: var(--text-tertiary); }
.ql-actions { display: flex; gap: 6px; }
.ql-error {
  font-size: 12px; color: var(--danger); background: var(--danger-soft);
  border-radius: 7px; padding: 6px 8px;
}
.ql-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.ql-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left;
  border: 1px solid transparent; background: transparent; cursor: pointer; border-radius: 7px; padding: 6px 8px;
  transition: background 0.1s ease;
}
.ql-item:hover { background: var(--bg-hover); }
.ql-item.active { background: var(--accent-soft); }
.ql-name {
  width: 100%; font-size: 13px; color: var(--text); font-family: var(--font);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ql-time { font-size: 11px; color: var(--text-tertiary); }
.ql-empty { font-size: 12px; color: var(--text-tertiary); padding: 4px 2px; }
.results-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 16px 16px; }
.results-header { display: flex; align-items: center; gap: 12px; justify-content: space-between; font-size: 13px; font-weight: 600; padding: 6px 0 10px; }
.history-menu { position: relative; }
.history-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 380px; max-width: 70vw;
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.pop-section { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pop-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.02em; padding: 0 2px 3px; }
.pop-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 3px; }
.pop-item {
  display: block; width: 100%; box-sizing: border-box; text-align: left; border: none; background: transparent; cursor: pointer;
  color: var(--text); font-size: 13px; font-family: var(--mono); padding: 7px 10px; border-radius: var(--radius-sm);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background 0.1s ease;
}
.pop-item:hover { background: var(--bg-hover); }
.pop-empty { font-size: 12px; color: var(--text-tertiary); padding: 4px 2px 2px; }
.fav-save {
  border: none; background: transparent; cursor: pointer; font-size: 12px; font-family: var(--font);
  color: var(--accent); padding: 2px 4px; border-radius: var(--radius-sm);
  transition: background 0.1s ease;
}
.fav-save:hover:not(:disabled) { background: var(--accent-soft); }
.fav-save:disabled { opacity: 0.5; cursor: not-allowed; color: var(--text-tertiary); }
.fav-form { display: flex; gap: 6px; padding: 2px 0 4px; }
.fav-name {
  flex: 1; min-width: 0; box-sizing: border-box; font-size: 13px; font-family: var(--font);
  color: var(--text); background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px;
}
.fav-name:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.fav-confirm { padding: 6px 14px; font-size: 12px; }
.fav-row { display: flex; align-items: center; gap: 2px; }
.fav-row .pop-item { flex: 1; min-width: 0; }
.fav-remove {
  flex: none; border: none; background: transparent; cursor: pointer; color: var(--text-tertiary);
  font-size: 12px; padding: 6px 8px; border-radius: var(--radius-sm); line-height: 1;
  transition: background 0.1s ease, color 0.1s ease;
}
.fav-remove:hover { background: var(--danger-soft); color: var(--danger); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.table-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { position: sticky; top: 0; background: var(--bg-subtle); text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1; }
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.truncate { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--text-tertiary); padding: 24px; }
.btn { border-radius: 9px; padding: 9px 20px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; box-shadow: 0 1px 2px rgba(0, 113, 227, 0.3); }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.mini { padding: 4px 10px; font-size: 12px; border-radius: 7px; background: var(--bg-elevated); color: var(--text); border-color: var(--border); }
.btn.mini:hover:not(:disabled) { background: var(--bg-hover); }
</style>
