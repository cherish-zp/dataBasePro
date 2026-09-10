<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { Message } from '@/api/types'
import { OffsetEarliest } from '@/api/types'
import { parseSelect, matchesWhere } from '@/utils/sql'
import { formatTime, displayValue } from '@/utils/format'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, exportCsv, exportJsonl, saveFile } from '@/utils/export'
import ExportDropdown from '@/components/common/ExportDropdown.vue'
import PromptDialog from '@/components/common/PromptDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import SqlEditor from '@/components/common/SqlEditor.vue'
import type { SqlTableSchema } from '@/components/common/SqlEditor.vue'
import { useQueryFiles } from '@/composables/queryFiles'
import { useSqlHistoryStore } from '@/store/sqlhistory'
import { useTabsStore } from '@/store/tabs'

const props = defineProps<{
  tabId: string
  connectionId: string
  topic: string
  partitions: number[]
}>()

// 有 topic 时预填模板;无 topic 的 tab(顶栏「新建查询」)以空编辑器打开。
const sql = ref(props.topic ? `SELECT * FROM ${props.topic} LIMIT 100` : '')
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
    // 无 topic 的 tab 回退为空串(而不是产生 "FROM " 的坏模板)。
    sql.value = draftByTopic[draftKey(props.connectionId, t)] ?? (t ? `SELECT * FROM ${t} LIMIT 100` : '')
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
  if (!topic) {
    // 无 topic 的 tab:SQL 里也没写 FROM <topic>,无法确定查询目标。
    error.value = 'SQL 中未找到表名,请写 SELECT ... FROM <topic>'
    return
  }
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

// onEditorKeydown runs the query on ⌘Enter/Ctrl+Enter and saves on ⌘S/Ctrl+S.
// The IME guard leaves keys during composition (e.g. committing a Chinese
// candidate) untouched, so the IME keeps the key; a plain Enter stays a
// newline in the editor.
function onEditorKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  // 与「执行」按钮的 :disabled="running" 守卫一致：运行中连按快捷键不重复触发。
  if (running.value) return
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    saveCurrent()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void run()
  }
}

// --- 查询文件:保存/载入/删除由共享 composable 驱动,文件列表展示在全局右栏
// (Layout 层);本控制台只负责编辑器侧的对话框与脏检查。 ----------------------
// 快照:最近一次「载入/保存」完成时的编辑器内容,用于载入前的脏检查。
const savedSnapshot = ref(sql.value)

const qf = useQueryFiles({
  connectionId: () => props.connectionId,
  getContent: () => sql.value,
  // 文件内容回填编辑器的时刻 = 已保存状态,同步刷新快照。
  setContent: (s: string) => {
    sql.value = s
    savedSnapshot.value = s
  },
})

// composable 把 ref 嵌在普通对象里返回,模板不自动解包,这里取到顶层。
const currentFile = qf.currentFile
const nameDialogOpen = qf.nameDialog.open
const nameDialogMode = qf.nameDialog.mode
const overwriteConfirmOpen = qf.overwriteConfirm.open
const deleteConfirmOpen = qf.deleteConfirm.open
const deleteConfirmMessage = qf.deleteConfirm.message

// 保存成功(currentFile 变化,如另存/确认新名)也刷新快照,避免刚保存的
// 内容被下一次载入误判为脏。
watch(currentFile, () => {
  savedSnapshot.value = sql.value
})

// --- tab 标题跟随当前打开的 SQL 文件 -----------------------------------------
// 默认标题与 tabs.openSql 保持一致:有 topic 为「SQL · <topic>」,否则「SQL 查询」。
const defaultTitle = computed(() => (props.topic ? `SQL · ${props.topic}` : 'SQL 查询'))
const tabs = useTabsStore()
// 载入文件、⌘S 保存为新文件(关联变化)、删除/取消关联(currentFile 归空回退
// 默认标题)都经 currentFile 变化驱动;immediate 保证挂载时校准一次。
watch(
  currentFile,
  (f) => {
    tabs.renameTab(props.tabId, f ?? defaultTitle.value)
  },
  { immediate: true },
)

// 保存:已关联文件 → 直接覆盖写,此时无弹窗、currentFile 不变,先对齐基线;
// 未关联 → 由 composable 打开名称输入弹窗,确认后经 currentFile watcher 校准。
function saveCurrent(): void {
  if (currentFile.value) savedSnapshot.value = sql.value
  qf.requestSave()
}

// --- 载入前的未保存确认(组件本地状态):载入文件时若编辑器有未保存改动,
// 先弹确认,避免无声覆盖正在编辑的 SQL。 ---
const loadConfirmOpen = ref(false)
let pendingLoadName: string | null = null

function isDirty(): boolean {
  // 已关联文件:内容与快照不一致即脏;未关联:只要有非空白内容即脏。
  return currentFile.value ? sql.value !== savedSnapshot.value : sql.value.trim() !== ''
}

function loadQueryFile(name: string): void {
  if (isDirty()) {
    pendingLoadName = name
    loadConfirmOpen.value = true
    return
  }
  void qf.loadQueryFile(name)
}

function confirmLoad(): void {
  loadConfirmOpen.value = false
  const name = pendingLoadName
  pendingLoadName = null
  if (name) void qf.loadQueryFile(name)
}

function cancelLoad(): void {
  loadConfirmOpen.value = false
  pendingLoadName = null
}

// 暴露给全局右栏(Layout 层)调用的查询文件能力。
defineExpose({
  requestSave: () => {
    saveCurrent()
  },
  requestSaveAs: () => {
    qf.requestSaveAs()
  },
  loadQueryFile: (name: string) => {
    loadQueryFile(name)
  },
  askRemoveCurrentFile: () => {
    qf.askRemoveCurrentFile()
  },
  currentFile: (): string | null => currentFile.value,
})

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
      <label class="sql-field grow" data-test="sql-field">
        <span class="label">SQL</span>
        <div class="cm-host" @keydown="onEditorKeydown">
          <SqlEditor
            v-model="sql"
            :tables="tables"
            :placeholder="topic ? undefined : '输入 SQL,表名写在 FROM 子句'"
            height="220px"
            data-test="input-sql"
          />
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

    <!-- 查询文件相关弹窗:名称输入(保存/另存为)、覆盖确认、删除确认由
         composable 的状态驱动;载入确认是本组件的本地状态。 -->
    <PromptDialog
      :show="nameDialogOpen"
      :title="nameDialogMode === 'save-as' ? '另存查询' : '保存查询'"
      label="查询名称"
      hint="保存为 .sql 文件,目录可在设置中配置"
      confirm-text="保存"
      @confirm="qf.confirmName"
      @cancel="qf.nameDialog.cancel"
    />
    <ConfirmDialog
      :show="overwriteConfirmOpen"
      message="文件已存在,是否覆盖?"
      confirm-text="覆盖"
      :danger="false"
      @confirm="qf.overwriteConfirm.confirm"
      @cancel="qf.overwriteConfirm.cancel"
    />
    <ConfirmDialog
      :show="deleteConfirmOpen"
      :message="deleteConfirmMessage"
      confirm-text="删除"
      danger
      @confirm="qf.deleteConfirm.confirm"
      @cancel="qf.deleteConfirm.cancel"
    />
    <ConfirmDialog
      :show="loadConfirmOpen"
      message="当前 SQL 未保存,载入将替换?"
      confirm-text="载入"
      :danger="false"
      @confirm="confirmLoad"
      @cancel="cancelLoad"
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
</style>
