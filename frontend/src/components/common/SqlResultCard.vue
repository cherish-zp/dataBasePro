<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted, type ComponentPublicInstance } from 'vue'
import { useToastStore } from '@/store/toast'
import { buildInsertStatement, type InsertTarget } from '@/utils/insertSql'
import { CSV_MIME, JSONL_MIME, exportCsv, exportJsonl, saveFile } from '@/utils/export'

export interface ResultColumn {
  name: string
  type?: string
}

// 单元格编辑态由父组件持有:draft 为进入编辑时的初值,输入框不受控,
// 回车时把 input.value 原样通过 edit-commit 交回父组件。
export interface EditingCell {
  row: number
  col: number
  draft: string
}

const props = withDefaults(
  defineProps<{
    statement: string
    durationMs?: number | null
    columns: ResultColumn[]
    rows: (string | null)[][]
    /** 单表查询结果才可生成 INSERT;null 时按钮禁用。 */
    insertTarget?: InsertTarget | null
    exportName: string
    error?: string | null
    editing?: EditingCell | null
    /** true → 行首渲染复选框列 + 表头全选(仅当调用方有 insertTarget 时传 true)。 */
    selectable?: boolean
    /** 表的主键列名列表(空/缺省 = 未识别)。 */
    primaryKey?: string[]
  }>(),
  { durationMs: null, insertTarget: null, error: null, editing: null, selectable: false, primaryKey: () => [] },
)

const emit = defineEmits<{
  (e: 'cell-dblclick', row: number, col: number): void
  (e: 'edit-commit', value: string | null): void
  (e: 'edit-cancel'): void
}>()

const toast = useToastStore()

// —— 头部状态 ——

const dotClass = computed(() => (props.error ? 'fail' : props.durationMs != null ? 'ok' : 'none'))

const metaText = computed(() => {
  const parts: string[] = []
  if (props.durationMs != null) parts.push(`${Math.round(props.durationMs)} ms`)
  parts.push(`${props.rows.length} 行`)
  return parts.join(' · ')
})

const expanded = ref(false)

// —— 剪贴板(navigator.clipboard 失败/缺失时降级 execCommand)——

async function copyText(text: string, okMsg: string): Promise<void> {
  let ok = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    textarea.remove()
  }
  if (ok) toast.show(okMsg)
}

// —— 行选择(勾选行只影响复制 INSERT 的行范围,不参与导出)——

const selected = ref<Set<number>>(new Set())

// 行集变化(重新执行查询/翻页)后旧下标失效,清空选择。
watch(
  () => props.rows,
  () => {
    selected.value = new Set()
  },
)

function toggleRow(index: number): void {
  const next = new Set(selected.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  selected.value = next
}

const allSelected = computed(() => props.rows.length > 0 && selected.value.size === props.rows.length)

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(props.rows.map((_, i) => i))
}

// —— INSERT 选项(下拉开关,持久化 localStorage)——

const INSERT_OPTS_KEY = 'dbclient-insert-opts'

function loadInsertOpts(): { includePK: boolean; perRow: boolean } {
  const fallback = { includePK: false, perRow: false }
  try {
    const raw = localStorage.getItem(INSERT_OPTS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<{ includePK: boolean; perRow: boolean }>
    return { includePK: parsed.includePK === true, perRow: parsed.perRow === true }
  } catch {
    return fallback
  }
}

const initialOpts = loadInsertOpts()
const includePK = ref(initialOpts.includePK)
const perRowOpt = ref(initialOpts.perRow)
const insertOptsOpen = ref(false)

// primaryKey 未识别时「包含主键列」强制视为关闭。
const pkIncluded = computed(() => includePK.value && props.primaryKey.length > 0)
const pkToggleTitle = computed(() => (props.primaryKey.length === 0 ? '未识别到主键列' : undefined))

watch([includePK, perRowOpt], ([inc, per]) => {
  try {
    localStorage.setItem(
      INSERT_OPTS_KEY,
      JSON.stringify({ includePK: inc && props.primaryKey.length > 0, perRow: per }),
    )
  } catch {
    // 持久化失败不影响复制功能。
  }
})

function onCopyInsert(): void {
  if (!props.insertTarget) return
  // 行范围:勾选行优先,未勾选取全部。
  const picked = selected.value.size > 0 ? props.rows.filter((_, i) => selected.value.has(i)) : props.rows
  // 列范围:「包含主键列」关闭时剔除主键列,值按行同步裁剪。
  let cols = props.columns
  let outRows = picked
  if (!pkIncluded.value) {
    const pkSet = new Set(props.primaryKey)
    const keep = props.columns.map((col, i) => ({ col, i })).filter((x) => !pkSet.has(x.col.name))
    if (keep.length !== props.columns.length) {
      cols = keep.map((x) => x.col)
      outRows = picked.map((row) => keep.map((x) => row[x.i] ?? null))
    }
  }
  void copyText(
    buildInsertStatement(props.insertTarget, cols, outRows, 1000, { perRow: perRowOpt.value }),
    '已复制 INSERT 语句',
  )
}

// 点面板外收起 INSERT 选项(与 ExportDropdown 的外部点击关闭一致)。
const insertRoot = ref<HTMLElement | null>(null)

function onDocClick(e: MouseEvent): void {
  if (insertOptsOpen.value && insertRoot.value && !insertRoot.value.contains(e.target as Node)) {
    insertOptsOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

// 行号列不导出/不复制;null 导出为空单元格。
function exportColumns() {
  return props.columns.map((col, i) => ({
    label: col.name,
    value: (row: (string | null)[]) => row[i] ?? '',
  }))
}

function onCopyCsv(): void {
  // exportCsv 的 BOM 供文件导出让 Excel 识别编码;剪贴板场景去掉。
  void copyText(exportCsv(props.rows, exportColumns()).replace(/^\uFEFF/, ''), '已复制 CSV')
}

function onCopyError(): void {
  void copyText(props.error ?? '', '已复制错误信息')
}

async function onExportCsv(): Promise<void> {
  await saveFile(props.exportName, exportCsv(props.rows, exportColumns()), CSV_MIME)
}

async function onExportJsonl(): Promise<void> {
  const jsonlRows = props.rows.map((row) =>
    Object.fromEntries(props.columns.map((col, i) => [col.name, row[i] ?? null])),
  )
  await saveFile(props.exportName, exportJsonl(jsonlRows), JSONL_MIME)
}

// —— 单元格编辑 ——

function isEditing(row: number, col: number): boolean {
  return props.editing != null && props.editing.row === row && props.editing.col === col
}

// 提交后元素随 editing 置空而卸载,部分浏览器会补发 blur → 用标记吞掉,
// 避免提交后紧跟一次多余的 edit-cancel。
let ignoreBlur = false

function onEditCommit(event: Event): void {
  ignoreBlur = true
  emit('edit-commit', (event.target as HTMLInputElement).value)
}

function onEditBlur(): void {
  if (ignoreBlur) {
    ignoreBlur = false
    return
  }
  emit('edit-cancel')
}

watch(
  () => props.editing,
  () => {
    ignoreBlur = false
  },
)

function focusEditor(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLInputElement) el.focus()
}
</script>

<template>
  <div class="result-card" data-test="result-card">
    <div class="result-head">
      <span class="status-dot" :class="dotClass" data-test="result-status-dot"></span>
      <div
        class="stmt"
        data-test="result-toggle"
        :title="expanded ? '点击收起' : '点击展开全文'"
        @click="expanded = !expanded"
      >
        <span v-if="!expanded" class="stmt-summary">{{ statement }}</span>
        <pre v-else class="stmt-full">{{ statement }}</pre>
      </div>
      <span class="meta" data-test="result-meta">{{ metaText }}</span>
      <div class="actions">
        <span v-if="selected.size > 0" class="selected-count" data-test="selected-count">
          已选 {{ selected.size }} 行
        </span>
        <div ref="insertRoot" class="insert-group">
          <button
            type="button"
            class="insert-main"
            data-test="result-copy-insert"
            :disabled="!insertTarget"
            :title="insertTarget ? '复制为 INSERT 语句' : '仅单表查询结果可生成'"
            @click="onCopyInsert"
          >
            复制为 INSERT
          </button>
          <button
            type="button"
            class="insert-arrow"
            data-test="insert-opts"
            :disabled="!insertTarget"
            title="INSERT 选项"
            @click="insertOptsOpen = !insertOptsOpen"
          >
            ▾
          </button>
          <div v-if="insertOptsOpen" class="insert-pop" data-test="insert-pop">
            <label class="opt-row">
              <span>包含主键列</span>
              <input
                v-model="includePK"
                type="checkbox"
                data-test="insert-opt-pk"
                :disabled="primaryKey.length === 0"
                :title="pkToggleTitle"
              />
            </label>
            <label class="opt-row">
              <span>每行单独 INSERT</span>
              <input v-model="perRowOpt" type="checkbox" data-test="insert-opt-perrow" />
            </label>
          </div>
        </div>
        <button type="button" data-test="result-copy-csv" title="复制为 CSV(含表头)" @click="onCopyCsv">
          复制为 CSV
        </button>
        <button type="button" data-test="result-export-csv" title="导出 CSV 文件" @click="onExportCsv">
          导出 CSV
        </button>
        <button
          type="button"
          data-test="result-export-jsonl"
          title="导出 JSONL 文件"
          @click="onExportJsonl"
        >
          导出 JSONL
        </button>
      </div>
    </div>

    <div v-if="error" class="result-error" data-test="result-error">
      <span class="error-text">{{ error }}</span>
      <button type="button" class="error-copy" data-test="result-error-copy" @click="onCopyError">
        复制
      </button>
    </div>
    <div v-else class="table-wrap">
      <table class="result-table" data-test="result-table">
        <thead>
          <tr>
            <th class="rownum">#</th>
            <th v-if="selectable" class="checkcell">
              <input
                type="checkbox"
                data-test="row-check-all"
                :checked="allSelected"
                title="全选/清空"
                @change="toggleAll"
              />
            </th>
            <th v-for="(col, ci) in columns" :key="ci" :title="col.type ? `${col.name}(${col.type})` : col.name">
              {{ col.name }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in rows" :key="ri" data-test="result-row">
            <td class="rownum">{{ ri + 1 }}</td>
            <td v-if="selectable" class="checkcell">
              <input
                type="checkbox"
                data-test="row-check"
                :checked="selected.has(ri)"
                @change="toggleRow(ri)"
              />
            </td>
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="cell"
              :title="cell == null ? 'NULL' : cell"
              @dblclick="emit('cell-dblclick', ri, ci)"
            >
              <input
                v-if="isEditing(ri, ci)"
                :ref="focusEditor"
                class="cell-editor"
                data-test="result-cell-editor"
                :value="editing?.draft ?? ''"
                @keydown.enter.prevent="onEditCommit"
                @keydown.esc.prevent="emit('edit-cancel')"
                @blur="onEditBlur"
              />
              <template v-else>{{ cell ?? '' }}</template>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td class="empty-cell" :colspan="columns.length + (selectable ? 2 : 1)" data-test="result-empty">0 行</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.result-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  overflow: hidden;
}

.result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}

.status-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-dot.ok { background: var(--ok); }
.status-dot.fail { background: var(--danger); }
.status-dot.none { background: var(--text-tertiary); opacity: 0.5; }

.stmt {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-secondary);
}
.stmt-summary {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stmt-full {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
}

.meta {
  flex: none;
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.actions {
  flex: none;
  display: flex;
  gap: 6px;
}
.actions button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 12px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.selected-count {
  flex: none;
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
}

/* 复制为 INSERT:主体 + 下拉箭头的连体按钮,下拉面板承载选项开关 */
.insert-group {
  flex: none;
  position: relative;
  display: flex;
}
.insert-main {
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}
.insert-arrow {
  margin-left: -1px;
  padding: 3px 5px !important;
  border-top-left-radius: 0 !important;
  border-bottom-left-radius: 0 !important;
  color: var(--text-tertiary);
}
.insert-arrow:hover:not(:disabled) {
  color: var(--accent);
}
.insert-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 150px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.opt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 2px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.opt-row input {
  accent-color: var(--accent);
  cursor: pointer;
}
.opt-row input:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

/* 错误卡:红色系 + 等宽字体 */
.result-error {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--danger-soft);
  color: var(--danger);
  font-family: var(--mono);
  font-size: 12px;
}
.error-text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
}
.error-copy {
  flex: none;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: transparent;
  color: var(--danger);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
}
.error-copy:hover {
  background: var(--danger-soft);
}

/* 结果表格:首列行号窄列,斑马纹 + 细网格线 */
.table-wrap {
  overflow: auto;
  max-height: 420px;
}
.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.result-table th,
.result-table td {
  border: 1px solid var(--border);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-table thead th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-weight: 600;
}
.result-table tbody tr:nth-child(even) {
  background: var(--bg-subtle);
}
.result-table tbody tr:hover {
  background: var(--bg-hover);
}
.rownum {
  width: 34px;
  min-width: 34px;
  text-align: right;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
}
.checkcell {
  width: 30px;
  min-width: 30px;
  text-align: center;
}
.checkcell input {
  accent-color: var(--accent);
  cursor: pointer;
  vertical-align: middle;
}
.empty-cell {
  text-align: center !important;
  color: var(--text-tertiary);
  padding: 12px !important;
}

/* 单元格编辑输入框 */
.cell-editor {
  width: 100%;
  min-width: 120px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  padding: 2px 6px;
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft);
}
</style>
