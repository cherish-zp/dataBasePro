<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getApi } from '@/api/client'
import type { CHStatementResult, SavedQuery } from '@/api/types'
import { CSV_MIME, JSONL_MIME, exportCsv, exportJsonl, saveFile, type ExportColumn } from '@/utils/export'
import { formatTime } from '@/utils/format'
import SqlEditor from '@/components/common/SqlEditor.vue'
import PromptDialog from '@/components/common/PromptDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

// database 可选:未指定(Layout 直接打开控制台)时按 default 库拉取表清单。
const props = defineProps<{ connectionId: string; database?: string }>()

const sql = ref('')
const running = ref(false)
const error = ref<string | null>(null)
const results = ref<CHStatementResult[]>([])

// --- 表清单(供编辑器自动补全):挂载时拉取一次并缓存,失败静默退化为无补全。 ---
const tables = ref<{ name: string; columns?: string[] }[]>([])

async function loadTables(): Promise<void> {
  try {
    const list = await getApi().listCHTables({
      connection_id: props.connectionId,
      database: props.database ?? 'default',
      show_system: false,
    })
    // CHTableInfo 不含列信息,列可空,补全只到表名一层。
    tables.value = list.map((t) => ({ name: t.name }))
  } catch {
    tables.value = []
  }
}

async function run(): Promise<void> {
  if (!sql.value.trim() || running.value) return
  running.value = true
  error.value = null
  results.value = []
  try {
    results.value = await getApi().chExecute({
      connection_id: props.connectionId,
      sql: sql.value,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

// ⌘Enter / Ctrl+Enter 运行(与 Kafka SQL 控制台一致,忽略 IME 组合中的按键)。
// SqlEditor 不绑定该组合键,事件从 CodeMirror contentDOM 冒泡到外层容器在此接住。
function onEditorKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (running.value) return
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void run()
  }
}

// --- 查询库:console_type=ch-sql 的已存查询,左侧可折叠面板。 ---
const queryLibOpen = ref(false)
const queries = ref<SavedQuery[]>([])
const queriesLoaded = ref(false)
const queryLibError = ref<string | null>(null)
const saving = ref(false)
// 当前载入的查询:非空时「保存」走原地更新、「删除」可用。
const loadedId = ref<string | null>(null)
const loadedName = ref('')

async function loadQueries(): Promise<void> {
  try {
    queries.value = await getApi().listSavedQueries({
      console_type: 'ch-sql',
      connection_id: props.connectionId,
    })
    queriesLoaded.value = true
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  }
}

function toggleQueryLib(): void {
  queryLibOpen.value = !queryLibOpen.value
}

// loadQuery 把选中的查询回填进编辑器,并记为「已载入」。
function loadQuery(q: SavedQuery): void {
  loadedId.value = q.id
  loadedName.value = q.name
  sql.value = q.content
}

// 保存:已载入 → updateSavedQuery;否则弹 PromptDialog 输名称后新建。
function onSaveClick(): void {
  if (!sql.value.trim() || saving.value) return
  if (loadedId.value) {
    void updateLoaded()
  } else {
    promptMode.value = 'save'
    promptShow.value = true
  }
}

// 另存为:总是弹窗输入新名称,创建为新查询。
function onSaveAsClick(): void {
  if (!sql.value.trim() || saving.value) return
  promptMode.value = 'saveAs'
  promptShow.value = true
}

const promptShow = ref(false)
const promptMode = ref<'save' | 'saveAs'>('save')
const promptTitle = computed(() => (promptMode.value === 'saveAs' ? '另存查询' : '保存查询'))
// 另存为预填当前名称;新建预填为空。
const promptValue = computed(() => (promptMode.value === 'saveAs' ? loadedName.value : ''))

async function onPromptConfirm(name: string): Promise<void> {
  promptShow.value = false
  queryLibError.value = null
  saving.value = true
  try {
    const saved = await getApi().saveSavedQuery({
      name,
      console_type: 'ch-sql',
      connection_id: props.connectionId,
      content: sql.value,
    })
    if (saved?.id) {
      loadedId.value = saved.id
      loadedName.value = saved.name
    }
    await loadQueries()
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function updateLoaded(): Promise<void> {
  const id = loadedId.value
  if (!id) return
  queryLibError.value = null
  saving.value = true
  try {
    const saved = await getApi().updateSavedQuery({ id, name: loadedName.value, content: sql.value })
    if (saved?.name) loadedName.value = saved.name
    await loadQueries()
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

// 删除:ConfirmDialog 确认后删除当前载入的查询并清空载入状态。
const confirmDelete = ref(false)

function onDeleteClick(): void {
  if (!loadedId.value || saving.value) return
  confirmDelete.value = true
}

const deleteMessage = computed(() => `确认删除查询「${loadedName.value}」?删除后不可恢复。`)

async function doDelete(): Promise<void> {
  confirmDelete.value = false
  const id = loadedId.value
  if (!id) return
  queryLibError.value = null
  saving.value = true
  try {
    await getApi().deleteSavedQuery({ id })
    loadedId.value = null
    loadedName.value = ''
    await loadQueries()
  } catch (e) {
    queryLibError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadTables()
  void loadQueries()
})

// 导出第 i 条语句的结果。行是数组,列头来自后端返回的 columns;文件名
// ch-result-<i> 与语句顺序一一对应。
type Row = (string | null)[]

function exportResult(r: CHStatementResult, index: number, format: 'csv' | 'jsonl'): void {
  const cols: ExportColumn<Row>[] = (r.columns ?? []).map((c, i) => ({
    label: c.name,
    value: (row) => row[i] ?? '',
  }))
  const name = `ch-result-${index}`
  if (format === 'csv') {
    void saveFile(name, exportCsv(r.rows ?? [], cols), CSV_MIME)
  } else {
    void saveFile(name, exportJsonl(r.rows ?? []), JSONL_MIME)
  }
}
</script>

<template>
  <div class="ch-sql" data-test="ch-sql-console">
    <div class="layout">
      <aside v-if="queryLibOpen" class="query-lib" data-test="ch-query-lib">
        <div class="ql-head">
          <span class="ql-title">查询库</span>
          <button
            class="btn ghost small"
            type="button"
            data-test="btn-ch-query-lib-save"
            :disabled="!sql.trim() || saving"
            @click="onSaveClick"
          >
            保存
          </button>
          <button
            class="btn ghost small"
            type="button"
            data-test="btn-ch-query-lib-save-as"
            :disabled="!sql.trim() || saving"
            @click="onSaveAsClick"
          >
            另存为
          </button>
          <button
            class="btn ghost small danger"
            type="button"
            data-test="btn-ch-query-lib-delete"
            :disabled="!loadedId || saving"
            @click="onDeleteClick"
          >
            删除
          </button>
        </div>
        <div v-if="queryLibError" class="msg err" data-test="ch-query-lib-error">{{ queryLibError }}</div>
        <div class="ql-list">
          <button
            v-for="(q, i) in queries"
            :key="q.id"
            class="ql-item"
            type="button"
            :class="{ active: q.id === loadedId }"
            :data-test="`ch-query-item-${i}`"
            :title="q.content"
            @click="loadQuery(q)"
          >
            <span class="ql-name">{{ q.name }}</span>
            <span class="ql-time">{{ formatTime(q.updated_at) }}</span>
          </button>
          <div v-if="queriesLoaded && queries.length === 0" class="ql-empty">暂无保存的查询</div>
        </div>
      </aside>

      <div class="main grow">
        <div class="toolbar">
          <button class="btn ghost toggle" type="button" data-test="btn-ch-query-lib-toggle" @click="toggleQueryLib">
            {{ queryLibOpen ? '收起查询库' : '查询库' }}
          </button>
          <label class="sql-field grow" @keydown="onEditorKeydown">
            <span class="label">SQL(支持多语句,以分号分隔)</span>
            <SqlEditor
              v-model="sql"
              :tables="tables"
              height="240px"
              data-test="ch-sql-input"
              placeholder="SELECT database, table FROM system.tables WHERE database = 'default'"
            />
          </label>
          <button class="btn primary" type="button" data-test="btn-ch-run" :disabled="running || !sql.trim()" @click="run">
            {{ running ? '运行中…' : '运行' }}
          </button>
        </div>

        <div v-if="error" class="msg err" data-test="ch-sql-error">{{ error }}</div>

        <div class="results" data-test="ch-results">
          <div v-if="results.length === 0 && !error" class="empty" data-test="ch-results-empty">运行后在此查看每条语句的结果</div>
          <div v-for="(r, i) in results" :key="i" class="stmt-card" data-test="ch-stmt-card">
            <div class="stmt-head">
              <span class="mono stmt-sql" data-test="ch-stmt-sql">{{ r.sql }}</span>
              <span class="stmt-ms" data-test="ch-stmt-ms">{{ r.duration_ms }} ms</span>
              <span class="spacer"></span>
              <template v-if="!r.error && (r.rows?.length ?? 0) > 0">
                <button class="btn ghost small" type="button" data-test="btn-ch-export-csv" @click="exportResult(r, i, 'csv')">CSV</button>
                <button class="btn ghost small" type="button" data-test="btn-ch-export-jsonl" @click="exportResult(r, i, 'jsonl')">JSONL</button>
              </template>
            </div>
            <div v-if="r.error" class="msg err stmt-error" data-test="ch-stmt-error">{{ r.error }}</div>
            <div v-else class="table-wrap">
              <table class="table" data-test="ch-stmt-grid">
                <thead>
                  <tr>
                    <th v-for="c in r.columns ?? []" :key="c.name">
                      {{ c.name }}
                      <span class="col-type">{{ c.type }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, ri) in r.rows ?? []" :key="ri" data-test="ch-stmt-row">
                    <td
                      v-for="(cell, ci) in row"
                      :key="ci"
                      class="mono"
                      :class="{ 'cell-null': cell === null }"
                    >{{ cell ?? 'NULL' }}</td>
                  </tr>
                  <tr v-if="(r.rows?.length ?? 0) === 0">
                    <td :colspan="(r.columns?.length ?? 1)" class="empty">无结果行</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

    <PromptDialog
      :show="promptShow"
      :title="promptTitle"
      label="查询名称"
      :value="promptValue"
      confirm-text="保存"
      @confirm="onPromptConfirm"
      @cancel="promptShow = false"
    />
    <ConfirmDialog
      :show="confirmDelete"
      :message="deleteMessage"
      confirm-text="删除"
      danger
      @confirm="doDelete"
      @cancel="confirmDelete = false"
    />
  </div>
</template>

<style scoped>
.ch-sql {
  height: 100%;
  display: flex; flex-direction: column;
  padding: 14px 16px; box-sizing: border-box;
  color: var(--text); font-family: var(--font);
}
.layout { flex: 1; min-height: 0; display: flex; gap: 12px; }
.main { display: flex; flex-direction: column; }
.grow { flex: 1; min-width: 0; }

/* 左侧查询库面板 */
.query-lib {
  flex: none; width: 250px; min-height: 0; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated);
}
.ql-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ql-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-right: auto; }
.ql-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.ql-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  max-width: 100%; text-align: left; cursor: pointer;
  border: none; background: transparent; color: var(--text);
  padding: 7px 9px; border-radius: 8px;
  transition: background 0.12s ease;
}
.ql-item:hover { background: var(--bg-hover); }
.ql-item.active { background: var(--accent-soft); }
.ql-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.ql-time { font-size: 11px; color: var(--text-tertiary); font-family: var(--mono); }
.ql-empty { font-size: 12px; color: var(--text-tertiary); padding: 8px 4px; }

.toolbar { display: flex; align-items: flex-end; gap: 12px; }
.toggle { flex: none; }
.sql-field { display: flex; flex-direction: column; gap: 5px; }
.sql-field.grow { flex: 1; min-width: 0; }
.label { font-size: 11px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.02em; }
.mono { font-family: var(--mono); }
.msg { font-size: 13px; border-radius: 9px; padding: 8px 12px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.toolbar + .msg { margin-top: 10px; }
.results { flex: 1; min-height: 0; overflow: auto; margin-top: 12px; display: flex; flex-direction: column; gap: 12px; }
.empty { text-align: center; color: var(--text-tertiary); padding: 24px; font-size: 13px; }
.stmt-card {
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated);
  padding: 10px 12px;
}
.stmt-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.stmt-sql { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-secondary); }
.stmt-ms { flex: none; font-size: 11px; color: var(--text-tertiary); font-family: var(--mono); }
.spacer { flex: none; }
.stmt-error { margin-top: 4px; }
.table-wrap { overflow: auto; max-height: 360px; border: 1px solid var(--border); border-radius: 8px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th {
  position: sticky; top: 0; background: var(--bg-subtle); text-align: left;
  padding: 6px 10px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border);
}
.col-type { font-size: 11px; color: var(--text-tertiary); font-family: var(--mono); font-weight: 400; margin-left: 4px; }
.table td { padding: 5px 10px; border-bottom: 1px solid var(--border); word-break: break-all; }
.cell-null { color: var(--text-tertiary); font-style: italic; }
.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.small { padding: 3px 9px; font-size: 12px; }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn.danger:hover:not(:disabled) { background: var(--danger-soft); }
</style>
