<script setup lang="ts">
import { computed, onMounted, ref, unref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { CHStatementResult } from '@/api/types'
import { CSV_MIME, JSONL_MIME, exportCsv, exportJsonl, saveFile, type ExportColumn } from '@/utils/export'
import { parseCHSingleTableSelect } from '@/utils/chSql'
import { useCHCellUpdate } from '@/composables/chCellUpdate'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore } from '@/store/tabs'
import SqlEditor from '@/components/common/SqlEditor.vue'
import PromptDialog from '@/components/common/PromptDialog.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

// tabId 必填:控制台据此把 tabs store 中自己的 tab 重命名为当前关联文件名。
const props = defineProps<{ tabId: string; connectionId: string; database?: string }>()

const sql = ref('')
const running = ref(false)
const error = ref<string | null>(null)
const results = ref<CHStatementResult[]>([])
const editor = ref<InstanceType<typeof SqlEditor> | null>(null)

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

// 运行:编辑器有选区 → 仅执行选中文本;否则执行整段(多语句由后端拆分)。
async function run(): Promise<void> {
  if (running.value) return
  const selection = editor.value?.getSelection() ?? ''
  const script = selection.trim() !== '' ? selection : sql.value
  if (!script.trim()) return
  running.value = true
  error.value = null
  results.value = []
  try {
    results.value = await getApi().chExecute({
      connection_id: props.connectionId,
      sql: script,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

// --- 查询结果行内编辑(仅单表 SELECT 结果可编辑) -----------------------------
// 结果若来自单表 SELECT(允许 WHERE/ORDER BY/LIMIT),双击单元格进入行内
// 编辑;回车后经 chCellUpdate composable 预览(确认弹窗展示 ALTER 语句全文
// 与匹配行数),确认执行成功后重新执行该条语句刷新结果。复杂查询只读。
const cu = useCHCellUpdate()
const cuOpen = computed(() => unref(cu.confirmOpen))
const cuStatement = computed(() => unref(cu.statement) ?? '')
const cuMatchedRows = computed(() => unref(cu.matchedRows) ?? 0)
const cuError = computed(() => unref(cu.error))

// 每条语句结果是否可编辑:有 error 的结果与解析不出单表来源的结果只读。
const editableResults = computed<boolean[]>(() =>
  results.value.map((r) => !r.error && parseCHSingleTableSelect(r.sql) !== null),
)

// 行内编辑状态:目标(结果索引/行索引/列索引)+ 草稿;null 表示未在编辑。
interface CellEdit {
  stmtIndex: number
  rowIndex: number
  colIndex: number
  draft: string
}
const cellEdit = ref<CellEdit | null>(null)

function isEditing(stmtIndex: number, rowIndex: number, colIndex: number): boolean {
  const e = cellEdit.value
  return !!e && e.stmtIndex === stmtIndex && e.rowIndex === rowIndex && e.colIndex === colIndex
}

// 进入编辑:原始值取结果行内存;NULL → 空输入框。运行中禁止进入编辑。
function startCellEdit(stmtIndex: number, rowIndex: number, colIndex: number): void {
  if (running.value || !editableResults.value[stmtIndex]) return
  const row = results.value[stmtIndex]?.rows?.[rowIndex]
  if (!row) return
  cellEdit.value = {
    stmtIndex,
    rowIndex,
    colIndex,
    draft: row[colIndex] ?? '',
  }
}

// 行内输入框渲染后自动聚焦(函数 ref 挂载时机即焦点时机)。
function setCellInputRef(el: unknown): void {
  const input = el as HTMLInputElement | null
  if (input && typeof input.focus === 'function') input.focus()
}

function cancelCellEdit(): void {
  cellEdit.value = null
}

// where 条件 = 整行所有列的原值(列名/类型取结果列定义,NULL 列 value=null)。
function buildWhere(r: CHStatementResult, rowIndex: number): { column: string; type: string; value: string | null }[] {
  const row = r.rows?.[rowIndex] ?? []
  return (r.columns ?? []).map((c, i) => ({ column: c.name, type: c.type, value: row[i] ?? null }))
}

// 回车提交:构造 set(空输入→null)与整行 where,交给 composable 预览并弹确认。
function commitCellEdit(): void {
  const e = cellEdit.value
  if (!e) return
  const r = results.value[e.stmtIndex]
  const parsed = r ? parseCHSingleTableSelect(r.sql) : null
  const col = r?.columns?.[e.colIndex]
  cellEdit.value = null
  if (!r || !parsed || !col) return
  pendingStmtIndex = e.stmtIndex
  void cu.request({
    connection_id: props.connectionId,
    database: parsed.database,
    table: parsed.table,
    set: { column: col.name, type: col.type, value: e.draft === '' ? null : e.draft },
    where: buildWhere(r, e.rowIndex),
  })
}

// 待刷新的结果索引:确认成功后重跑该条语句并原位替换结果。
let pendingStmtIndex: number | null = null

// 确认弹窗文案:ALTER 语句全文 + 匹配行数;匹配多行时追加警示并把按钮置为危险色。
const cellUpdateMessage = computed(() => {
  const n = cuMatchedRows.value
  const base = `${cuStatement.value}\n匹配 ${n} 行`
  return n > 1 ? `${base}\n注意:该条件命中 ${n} 行,将全部更新。` : base
})

async function confirmCellUpdate(): Promise<void> {
  const idx = pendingStmtIndex
  pendingStmtIndex = null
  try {
    await cu.confirm()
  } catch {
    return // 失败:composable 已写 cu.error,复用错误展示区显示
  }
  if (unref(cu.error)) return
  const target = idx === null ? undefined : results.value[idx]
  if (!target) return
  try {
    const fresh = await getApi().chExecute({ connection_id: props.connectionId, sql: target.sql })
    if (fresh.length > 0) {
      // 仅替换该索引的结果,其他语句结果保持不变。
      results.value = results.value.map((old, i) => (i === idx ? fresh[0] : old))
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function cancelCellUpdate(): void {
  pendingStmtIndex = null
  cu.cancel()
}

// --- 查询文件:保存/载入/删除由共享 composable 驱动,文件列表展示在全局右栏
// (Layout 层);本组件只负责编辑器侧的对话框与脏检查。 ---
// 快照:最近一次「载入/保存」完成时的编辑器内容,用于载入前的脏检查。
const savedSnapshot = ref('')

const qf = useQueryFiles({
  connectionId: () => props.connectionId,
  getContent: () => sql.value,
  // 文件内容回填编辑器的时刻 = 已保存状态,同步刷新快照。
  setContent: (s: string) => {
    sql.value = s
    savedSnapshot.value = s
  },
})

// composable 把 ref 嵌在普通对象里返回,模板不自动解包,这里统一取值。
const currentFile = computed(() => unref(qf.currentFile))
const nameDialogShow = computed(() => unref(qf.nameDialog.open))
const nameDialogMode = computed(() => unref(qf.nameDialog.mode))
const nameDialogTitle = computed(() => (nameDialogMode.value === 'save-as' ? '另存查询' : '保存查询'))
const overwriteShow = computed(() => unref(qf.overwriteConfirm.open))
const deleteConfirmShow = computed(() => unref(qf.deleteConfirm.open))
const deleteConfirmMessage = computed(() => unref(qf.deleteConfirm.message))

// 保存成功(currentFile 变化)也刷新快照,避免刚保存的内容被误判为脏。
watch(currentFile, () => {
  savedSnapshot.value = sql.value
})

// --- tab 标题跟随当前打开的 SQL 文件 -----------------------------------------
// 载入文件、⌘S 保存为新文件(关联变化)、删除/取消关联(currentFile 归空回退
// 默认标题「SQL 控制台」)都经 currentFile 变化驱动;immediate 保证挂载时校准。
const tabs = useTabsStore()
watch(
  currentFile,
  (f) => {
    tabs.renameTab(props.tabId, f ?? 'SQL 控制台')
  },
  { immediate: true },
)

// ⌘S / Ctrl+S 保存;⌘Enter / Ctrl+Enter 运行(与 Kafka SQL 控制台一致,忽略
// IME 组合中的按键)。SqlEditor 不绑定这些组合键,事件从 CodeMirror
// contentDOM 冒泡到外层容器在此接住;与运行按钮一样遵循「选中优先」。
function onEditorKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (running.value) return
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    qf.requestSave()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void run()
  }
}

// --- 载入前的未保存确认(组件本地状态):右栏载入文件时,若编辑器有
// 未保存改动,先弹确认,避免无声覆盖用户正在编辑的 SQL。 ---
const loadConfirmShow = ref(false)
let pendingLoadName: string | null = null

function isDirty(): boolean {
  // 已关联文件:内容与快照不一致即脏;未关联:只要输入过非空白内容即脏。
  return currentFile.value ? sql.value !== savedSnapshot.value : sql.value.trim() !== ''
}

function requestLoadQueryFile(name: string): void {
  if (isDirty()) {
    pendingLoadName = name
    loadConfirmShow.value = true
    return
  }
  void qf.loadQueryFile(name)
}

function confirmLoad(): void {
  loadConfirmShow.value = false
  const name = pendingLoadName
  pendingLoadName = null
  if (name) void qf.loadQueryFile(name)
}

function cancelLoad(): void {
  loadConfirmShow.value = false
  pendingLoadName = null
}

// 暴露给全局右栏(Layout 层)调用的查询文件能力。
defineExpose({
  requestSave: () => {
    qf.requestSave()
  },
  requestSaveAs: () => {
    qf.requestSaveAs()
  },
  loadQueryFile: requestLoadQueryFile,
  askRemoveCurrentFile: () => {
    qf.askRemoveCurrentFile()
  },
  currentFile: (): string | null => currentFile.value,
})

onMounted(() => {
  void loadTables()
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
    <div class="toolbar">
      <label class="sql-field grow" @keydown="onEditorKeydown">
        <span class="label">SQL(支持多语句,以分号分隔;选中运行只执行选中文本;⌘S 保存)</span>
        <SqlEditor
          ref="editor"
          v-model="sql"
          :tables="tables"
          height="260px"
          data-test="ch-sql-input"
          placeholder="SELECT database, table FROM system.tables WHERE database = 'default'"
        />
      </label>
      <button class="btn primary" type="button" data-test="btn-ch-run" :disabled="running || !sql.trim()" @click="run">
        {{ running ? '运行中…' : '运行' }}
      </button>
    </div>

    <!-- 运行错误与单元格更新失败(cu.error)共用错误展示区。 -->
    <div v-if="error || cuError" class="msg err" data-test="ch-sql-error">{{ error || cuError }}</div>

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
                  :title="editableResults[i] ? '双击编辑' : '仅单表查询结果可编辑'"
                  @dblclick="startCellEdit(i, ri, ci)"
                >
                  <input
                    v-if="cellEdit && isEditing(i, ri, ci)"
                    :ref="setCellInputRef"
                    v-model="cellEdit.draft"
                    class="cell-editor"
                    data-test="ch-cell-editor"
                    @keydown.enter.prevent="commitCellEdit"
                    @keydown.esc.prevent="cancelCellEdit"
                    @blur="cancelCellEdit"
                  />
                  <template v-else>{{ cell ?? 'NULL' }}</template>
                </td>
              </tr>
              <tr v-if="(r.rows?.length ?? 0) === 0">
                <td :colspan="(r.columns?.length ?? 1)" class="empty">无结果行</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 查询文件相关弹窗:名称输入(保存/另存为)、覆盖确认、删除确认由
         composable 的状态驱动;载入确认是本组件的本地状态。 -->
    <PromptDialog
      :show="nameDialogShow"
      :title="nameDialogTitle"
      label="文件名"
      confirm-text="保存"
      @confirm="qf.confirmName"
      @cancel="qf.nameDialog.cancel()"
    />
    <ConfirmDialog
      :show="overwriteShow"
      message="文件已存在,是否覆盖?"
      confirm-text="覆盖"
      :danger="false"
      @confirm="qf.overwriteConfirm.confirm()"
      @cancel="qf.overwriteConfirm.cancel()"
    />
    <ConfirmDialog
      :show="deleteConfirmShow"
      :message="deleteConfirmMessage"
      confirm-text="删除"
      danger
      @confirm="qf.deleteConfirm.confirm()"
      @cancel="qf.deleteConfirm.cancel()"
    />
    <ConfirmDialog
      :show="loadConfirmShow"
      message="当前 SQL 未保存,载入将替换?"
      confirm-text="载入"
      :danger="false"
      @confirm="confirmLoad"
      @cancel="cancelLoad"
    />
    <!-- 单元格更新确认:展示将执行的 ALTER 语句全文与匹配行数(多行置危险色)。 -->
    <ConfirmDialog
      :show="cuOpen"
      :message="cellUpdateMessage"
      confirm-text="执行"
      :danger="cuMatchedRows > 1"
      @confirm="confirmCellUpdate"
      @cancel="cancelCellUpdate"
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

.toolbar { display: flex; align-items: flex-end; gap: 12px; }
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
.cell-editor {
  width: 100%; box-sizing: border-box; padding: 2px 5px;
  font-family: var(--mono); font-size: 13px; color: var(--text); background: var(--bg);
  border: 1px solid var(--accent); border-radius: 5px; outline: none;
}
.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.small { padding: 3px 9px; font-size: 12px; }
</style>
