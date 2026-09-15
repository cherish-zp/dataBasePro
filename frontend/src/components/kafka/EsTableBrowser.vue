<script setup lang="ts">
import { computed, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import * as App from '../../../wailsjs/go/backend/App'

const props = defineProps<{ connectionId: string; index: string }>()

// 每页行数与后端 ESPageRows 的 limit 对齐(后端换算为 from/size)。
const PAGE_SIZE = 200
// 超长单元格客户端截断展示(完整值保留在 title 提示中)。
const CELL_TRUNCATE = 200

interface EsColumn {
  name: string
  type: string
  comment?: string
}

interface EsPageRowsResult {
  columns: EsColumn[]
  rows: (string | null)[][]
  total_rows: number
  primary_key: string[]
  engine: string
}

// Es* 绑定尚未由 wails generate module 生成,这里按显式形状断言调用
// (req 为契约形状原样,Wails 按字段名序列化,snake_case 已对齐);生成后
// 签名一致,无需改动本文件。
const app = App as unknown as {
  ESPageRows(req: {
    connection_id: string
    index: string
    where?: string
    order_by?: string
    asc?: boolean
    limit: number
    offset: number
  }): Promise<EsPageRowsResult>
  EsRefreshIndex(req: { connection_id: string; index: string }): Promise<void>
  ESGetDoc(req: { connection_id: string; index: string; id: string }): Promise<{ doc_json: string }>
  ESPutDoc(req: { connection_id: string; index: string; id: string; doc_json: string }): Promise<void>
  ESUpdateCell(req: {
    connection_id: string
    index: string
    id: string
    column: string
    value: string | null
  }): Promise<void>
  ESDeleteDoc(req: { connection_id: string; index: string; id: string }): Promise<void>
  ESDeleteByQuery(req: { connection_id: string; index: string }): Promise<void>
}

const columns = ref<EsColumn[]>([])
const rows = ref<(string | null)[][]>([])
const engine = ref('')
const totalRows = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)

const where = ref('')
// 已应用的过滤条件:回车/按钮提交后才随请求下发;语义两级——含冒号视为
// query_string 高级语法(字段:值、AND/OR),否则按普通关键词全字段匹配
// (后端 multi_match lenient),避免 query_string 把 `2026-08-21`、
// `abc-def` 这类值按操作符拆解导致结果错乱。
const appliedWhere = ref('')
const orderBy = ref('')
const asc = ref(true)
const offset = ref(0)

// 行内编辑态:同一时刻仅一个单元格可编辑,row/col 为行/列下标;
// editValue 为输入框草稿,提交时空串按写 null 处理。
const editing = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')

// 首列 _id(columns[0].type === '_id')承载文档标识:只读、不可排序,
// 行首操作按钮(JSON 编辑/删除)也挂在该列;缺失时整表只读。
const hasIdColumn = computed(() => columns.value[0]?.type === '_id')
const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function fetchPage(): Promise<void> {
  loading.value = true
  error.value = null
  // 换页/刷新后行集合将重建,未完成的行内编辑一并丢弃。
  editing.value = null
  try {
    const res = await app.ESPageRows({
      connection_id: props.connectionId,
      index: props.index,
      where: appliedWhere.value || undefined,
      order_by: orderBy.value || undefined,
      asc: asc.value,
      limit: PAGE_SIZE,
      offset: offset.value,
    })
    // wire 形状防御:后端异常/老版本可能给出 null 或缺字段;模板对
    // columns/rows 按数组、totalRows 按数字直接使用,任何 null/undefined
    // 都会在渲染期抛 TypeError 并中断整个调度队列(WKWebView 表现为白屏)。
    columns.value = res.columns ?? []
    rows.value = res.rows ?? []
    engine.value = res.engine ?? ''
    const total = Number(res.total_rows)
    totalRows.value = Number.isFinite(total) ? total : 0
  } catch (e) {
    error.value = errMsg(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void fetchPage()
})

// 外部(树/Layout)切换索引时重置过滤/排序/分页状态并重拉第一页。
watch(
  () => props.index,
  () => {
    where.value = ''
    appliedWhere.value = ''
    orderBy.value = ''
    asc.value = true
    offset.value = 0
    void fetchPage()
  },
)

// applyWhere 提交过滤条件并回到第一页重新请求。
function applyWhere(): void {
  appliedWhere.value = where.value.trim()
  offset.value = 0
  void fetchPage()
}

// refreshThenFetch 手动刷新与写后自动刷新共用:先 best-effort 显式 _refresh
// (POST /{index}/_refresh;失败忽略——最坏情况只是数据可见性延迟到 ES 自身
// 刷新周期),再立即重取当前页,使写入/删除无需等待 refresh_interval 即可见。
async function refreshThenFetch(): Promise<void> {
  try {
    await app.EsRefreshIndex({ connection_id: props.connectionId, index: props.index })
  } catch {
    // best-effort:刷新失败不阻断取数,也不进错误区。
  }
  await fetchPage()
}

function refresh(): void {
  void refreshThenFetch()
}

// sortBy 点击列头排序:同一列翻转方向,新列默认升序;回第一页。
// 仅映射字段列可排序(_id 列头不触发);不可排序字段由服务端报错透出。
function sortBy(col: string): void {
  if (orderBy.value === col) {
    asc.value = !asc.value
  } else {
    orderBy.value = col
    asc.value = true
  }
  offset.value = 0
  void fetchPage()
}

function sortByCol(col: string, ci: number): void {
  if (ci === 0 && hasIdColumn.value) return
  sortBy(col)
}

function nextPage(): void {
  offset.value += PAGE_SIZE
  void fetchPage()
}

function prevPage(): void {
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  void fetchPage()
}

// --- 单元格渲染:nil → NULL(浅色);超长值截断(浅色标注 + title 全文)。 ---

function isTruncated(v: string | null): boolean {
  return v !== null && v.length > CELL_TRUNCATE
}

function cellDisplay(v: string | null): string {
  if (v === null) return 'NULL'
  return isTruncated(v) ? `${v.slice(0, CELL_TRUNCATE)}…` : v
}

// cellTitle 数据单元格悬停提示:_id 列固定提示;缺 _id 列整表只读;
// 其余展示完整原值。
function cellTitle(v: string | null, ci: number): string {
  if (ci === 0 && hasIdColumn.value) return '文档 _id'
  if (!hasIdColumn.value) return '缺少文档 _id,不支持编辑'
  return v ?? ''
}

// colTitle 列头悬停提示:_id 列只读说明;其余为排序说明 + 类型,
// comment 非空时追加描述。
function colTitle(c: EsColumn, ci: number): string {
  if (ci === 0 && hasIdColumn.value) return '文档 _id'
  const base = `按 ${c.name} 排序 · ${c.type}`
  return c.comment ? `${base}\n${c.comment}` : base
}

// --- 单元格行内编辑:双击 → 输入 → 回车 → 预览确认 → 执行并刷新。 ---

function isEditing(ri: number, ci: number): boolean {
  return editing.value?.row === ri && editing.value?.col === ci
}

// startEdit 双击进入编辑:原始值取自 rows 内存(null 显示为空输入框);
// _id 列只读,loading 或已有单元格在编辑时忽略,避免并发编辑态。
function startEdit(ri: number, ci: number): void {
  if (loading.value || editing.value || !hasIdColumn.value) return
  if (ci === 0) return
  if (!columns.value[ci]) return
  editing.value = { row: ri, col: ci }
  editValue.value = rows.value[ri]?.[ci] ?? ''
}

// focusEditor 编辑框渲染后自动聚焦(function ref 挂载时触发)。
function focusEditor(el: Element | ComponentPublicInstance | null): void {
  if (el) (el as HTMLInputElement).focus()
}

function cancelEdit(): void {
  editing.value = null
  editValue.value = ''
}

// rowId 取行文档 _id(首列值);无 _id 列时返回 null。
function rowId(ri: number): string | null {
  if (!hasIdColumn.value) return null
  return rows.value[ri]?.[0] ?? null
}

// --- 字段级更新预览/确认/执行状态机:ES 无独立预览接口,确认文案由前端
// 按 _update 语义构造;因本次只允许新建组件与测试两个文件,状态机内联。 ---

// 预览通过后暂存的待执行目标,确认时原样发给执行。
let pendingEdit: { id: string; column: string; value: string | null } | null = null
const confirmEdit = ref(false)
const editError = ref<string | null>(null)
const editPreview = ref('')

// submitEdit 回车提交:先固化新值快照再退出编辑态,随后按 _update 语义
// 生成预览文案并打开确认弹窗(空串=写 null)。
function submitEdit(): void {
  const ed = editing.value
  if (!ed) return
  const col = columns.value[ed.col]
  const id = rowId(ed.row)
  const value = editValue.value === '' ? null : editValue.value
  cancelEdit()
  if (!col || id === null) return
  pendingEdit = { id, column: col.name, value }
  editPreview.value = `POST /${props.index}/_update/${id} ${JSON.stringify({ doc: { [col.name]: value } })}`
  editError.value = null
  confirmEdit.value = true
}

// onEditConfirm 确认执行:成功后关闭弹窗并刷新当前页;失败弹窗保持
// 打开(MySQL 行为一致),错误显示在弹窗内(用户点确认后立刻可见),
// 并同步进页面错误区——即使取消关闭弹窗,服务端原因也不会消失。
async function onEditConfirm(): Promise<void> {
  const target = pendingEdit
  if (!target) {
    confirmEdit.value = false
    return
  }
  try {
    await app.ESUpdateCell({
      connection_id: props.connectionId,
      index: props.index,
      id: target.id,
      column: target.column,
      value: target.value,
    })
    pendingEdit = null
    confirmEdit.value = false
    editError.value = null
    void refreshThenFetch()
  } catch (e) {
    editError.value = errMsg(e)
    error.value = errMsg(e)
  }
}

// onEditCancel 取消:关闭弹窗并清空全部状态(含待执行目标)。
function onEditCancel(): void {
  pendingEdit = null
  confirmEdit.value = false
  editPreview.value = ''
  editError.value = null
}

// --- 整文档 JSON 编辑:行首「JSON」按钮 → 弹窗 textarea → 保存整文档替换。 ---

const jsonOpen = ref(false)
const jsonSaving = ref(false)
const jsonId = ref('')
const jsonDraft = ref('')

// prettyJson 将后端返回的 doc_json 格式化为两空格缩进;解析失败原样展示。
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

async function openJson(ri: number): Promise<void> {
  const id = rowId(ri)
  if (id === null || loading.value || jsonOpen.value) return
  try {
    const res = await app.ESGetDoc({ connection_id: props.connectionId, index: props.index, id })
    jsonId.value = id
    jsonDraft.value = prettyJson(res.doc_json ?? '')
    jsonOpen.value = true
  } catch (e) {
    error.value = errMsg(e)
  }
}

// saveJson 整文档替换(PUT _doc);语法错误等后端 400 时弹窗保持打开,
// 错误进错误区供修正后重试。
async function saveJson(): Promise<void> {
  if (!jsonOpen.value || jsonSaving.value || !jsonId.value) return
  jsonSaving.value = true
  try {
    await app.ESPutDoc({
      connection_id: props.connectionId,
      index: props.index,
      id: jsonId.value,
      doc_json: jsonDraft.value,
    })
    jsonOpen.value = false
    void refreshThenFetch()
  } catch (e) {
    error.value = errMsg(e)
  } finally {
    jsonSaving.value = false
  }
}

function closeJson(): void {
  jsonOpen.value = false
  jsonId.value = ''
  jsonDraft.value = ''
}

// --- 删除文档:行首 ✕ → 危险确认(含 _id)→ 执行并刷新当前页。 ---

const confirmDelete = ref(false)
const deleteId = ref('')

const deleteMessage = computed(() => `确认删除文档 ${deleteId.value}?此操作不可恢复。`)

function askDelete(ri: number): void {
  const id = rowId(ri)
  if (id === null || loading.value) return
  deleteId.value = id
  confirmDelete.value = true
}

async function doDelete(): Promise<void> {
  confirmDelete.value = false
  const id = deleteId.value
  deleteId.value = ''
  if (!id) return
  try {
    await app.ESDeleteDoc({ connection_id: props.connectionId, index: props.index, id })
    void refreshThenFetch()
  } catch (e) {
    error.value = errMsg(e)
  }
}

// --- 清空索引:危险确认(_delete_by_query)→ 执行并回第一页刷新。 ---

const confirmClear = ref(false)

const clearMessage = computed(
  () => `将删除索引 ${props.index} 的全部文档(_delete_by_query),不可恢复`,
)

async function doClear(): Promise<void> {
  confirmClear.value = false
  try {
    await app.ESDeleteByQuery({ connection_id: props.connectionId, index: props.index })
    offset.value = 0
    await refreshThenFetch()
  } catch (e) {
    error.value = errMsg(e)
  }
}
</script>

<template>
  <div class="es-browser" data-test="es-table-browser">
    <div class="summary" data-test="es-summary">
      <span class="mono index-name" data-test="es-summary-index">{{ props.index }}</span>
      <span class="sep">·</span>
      <span data-test="es-summary-engine">{{ engine || '—' }}</span>
      <span class="sep">·</span>
      <span data-test="es-summary-rows">≈ {{ totalRows.toLocaleString() }} 行</span>
    </div>

    <div class="toolbar">
      <input
        v-model="where"
        class="where-input"
        type="search"
        data-test="es-where"
        placeholder="关键词,如 20260821;高级语法用 字段:值(如 level:ERROR AND app:pay)"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        spellcheck="false"
        title="不含冒号 = 全字段关键词匹配;含冒号 = query_string 高级语法(字段:值,支持 AND/OR/通配符)"
        @keydown.enter="applyWhere"
      />
      <button class="btn ghost" type="button" data-test="btn-es-apply" :disabled="loading" @click="applyWhere">过滤</button>
      <button class="btn ghost" type="button" data-test="es-refresh" :disabled="loading" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
      <button class="btn ghost danger" type="button" data-test="btn-es-clear" @click="confirmClear = true">清空文档</button>
    </div>

    <div v-if="error || editError" class="msg err" data-test="es-error">{{ error || editError }}</div>

    <!-- 兜底:无列信息(老后端/异常 wire 形状)时仅渲染空态。正常情况
         后端分页恒返回 _id + 映射列,走下方数据表分支;不再渲染竖排字段
         面板(映射字段已作为表头可见,与 MySQL 浏览器行为一致)。 -->
    <div v-if="!loading && columns.length === 0" class="table-wrap">
      <div class="empty" data-test="es-grid-empty">
        <div class="empty-icon">◌</div>
        <div>该索引暂无文档</div>
        <div class="empty-hint">数据写入后点击「刷新」查看</div>
      </div>
    </div>

    <div v-else class="table-wrap">
      <table class="table" data-test="es-grid">
        <thead>
          <tr>
            <th
              v-for="(c, ci) in columns"
              :key="c.name"
              data-test="es-col"
              :class="{ 'col-nosort': ci === 0 && hasIdColumn }"
              :title="colTitle(c, ci)"
              @click="sortByCol(c.name, ci)"
            >
              <!-- 弹性布局只在内层 div:th 必须保持 table-cell,否则脱离
                   表格列布局,WebKit 会把整行列头堆进一个匿名单元格。 -->
              <div class="col-head">
                <span class="col-name">
                  <span data-test="es-col-name">{{ c.name }}</span>
                  <span v-if="orderBy === c.name" class="col-arrow">{{ asc ? '↑' : '↓' }}</span>
                </span>
                <span class="col-type" data-test="es-col-type">{{ c.type }}</span>
                <span v-if="c.comment" class="col-comment" data-test="es-col-comment">{{ c.comment }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in rows" :key="ri" data-test="es-row">
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="mono cell"
              :class="{ 'cell-null': cell === null && !isEditing(ri, ci), 'cell-trunc': isTruncated(cell), 'cell-readonly': ci === 0 && hasIdColumn }"
              :title="cellTitle(cell, ci)"
              data-test="es-cell"
              @dblclick="startEdit(ri, ci)"
            >
              <!-- _id 列(首列):只读,行首挂 JSON 编辑与删除按钮。 -->
              <template v-if="ci === 0 && hasIdColumn">
                <div class="id-cell">
                  <button
                    class="mini-btn"
                    type="button"
                    :data-test="`es-doc-json-${ri}`"
                    title="编辑整文档 JSON"
                    @click="openJson(ri)"
                  >
                    JSON
                  </button>
                  <button
                    class="mini-btn danger"
                    type="button"
                    :data-test="`es-doc-delete-${ri}`"
                    title="删除文档"
                    @click="askDelete(ri)"
                  >
                    ✕
                  </button>
                  <span class="id-text" data-test="es-id-value">{{ cell ?? '' }}</span>
                </div>
              </template>
              <!-- 行内编辑:双击进入,Esc/blur 取消,回车提交预览。 -->
              <template v-else>
                <input
                  v-if="isEditing(ri, ci)"
                  :ref="focusEditor"
                  v-model="editValue"
                  class="cell-editor"
                  data-test="es-cell-editor"
                  @blur="cancelEdit"
                  @keydown.enter.prevent="submitEdit"
                  @keydown.esc.prevent="cancelEdit"
                />
                <template v-else>{{ cellDisplay(cell) }}</template>
              </template>
            </td>
          </tr>
          <!-- 零行(空索引/过滤无匹配):表头保持横排,空态作为表内一行,
               不再用竖排字段面板替换整表。loading 期间不渲染,避免首屏闪现。 -->
          <tr v-if="rows.length === 0 && !loading">
            <td :colspan="columns.length">
              <div class="empty" data-test="es-grid-empty">
                <div class="empty-icon">◌</div>
                <div>无匹配文档</div>
                <div class="empty-hint">数据写入后点击「刷新」查看</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager" data-test="es-pager">
      <button class="btn ghost" type="button" data-test="btn-es-prev" :disabled="offset === 0 || loading" @click="prevPage">上一页</button>
      <span class="page-label" data-test="es-page-label">第 {{ page }} 页</span>
      <button class="btn ghost" type="button" data-test="btn-es-next" :disabled="rows.length < PAGE_SIZE || loading" @click="nextPage">下一页</button>
    </div>

    <!-- 清空索引:危险操作,文案含索引名与 _delete_by_query。 -->
    <ConfirmDialog
      :show="confirmClear"
      :message="clearMessage"
      confirm-text="清空"
      danger
      @confirm="doClear"
      @cancel="confirmClear = false"
    />

    <!-- 删除文档:危险操作,文案含文档 _id。 -->
    <ConfirmDialog
      :show="confirmDelete"
      :message="deleteMessage"
      confirm-text="删除"
      danger
      @confirm="doDelete"
      @cancel="confirmDelete = false"
    />

    <!-- 字段更新确认:展示将执行的 _update 语义。 -->
    <ConfirmDialog
      :show="confirmEdit"
      :message="editError ? `将执行以下更新:\n${editPreview}\n\n执行失败:\n${editError}` : `将执行以下更新:\n${editPreview}`"
      confirm-text="更新"
      :danger="false"
      @confirm="onEditConfirm"
      @cancel="onEditCancel"
    />

    <!-- 整文档 JSON 编辑弹窗:保存即整文档替换(PUT _doc)。 -->
    <Teleport to="body">
      <div v-if="jsonOpen" class="modal-backdrop" data-test="es-doc-json-modal" @click.self="closeJson">
        <div class="modal json-modal">
          <div class="modal-header">
            <span class="modal-title">编辑文档 JSON <span class="mono doc-id">{{ jsonId }}</span></span>
            <button class="modal-close" type="button" data-test="es-doc-json-close" @click="closeJson">✕</button>
          </div>
          <div class="modal-body">
            <textarea
              v-model="jsonDraft"
              class="json-editor"
              data-test="es-doc-json-editor"
              rows="14"
              autocapitalize="off"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
            ></textarea>
            <div class="json-hint">保存将以该 JSON 整体替换文档(PUT /{{ props.index }}/_doc/{{ jsonId }})</div>
          </div>
          <div class="modal-footer">
            <button class="btn ghost" type="button" data-test="es-doc-json-cancel" @click="closeJson">取消</button>
            <button class="btn primary" type="button" data-test="es-doc-json-save" :disabled="jsonSaving" @click="saveJson">
              {{ jsonSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.es-browser { padding: 16px; color: var(--text); font-family: var(--font); }
.summary {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  padding: 8px 12px;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; color: var(--text-secondary);
}
.index-name { font-weight: 600; color: var(--text); }
.sep { color: var(--text-tertiary); }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.where-input {
  flex: 1; min-width: 220px; max-width: 420px;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px;
}
.where-input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.msg { padding: 8px 10px; font-size: 13px; border-radius: 7px; margin-top: 8px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.table-wrap {
  margin-top: 10px; overflow: auto; max-height: calc(100vh - 320px);
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated);
}
.table {
  /* width:max-content:列数多时按内容自然宽度横向滚动,而不是把列头
     压成竖排文字;min-width:100% 保证列少时仍铺满容器。 */
  width: max-content; min-width: 100%;
  border-collapse: collapse; font-size: 13px;
}
.table th {
  position: sticky; top: 0; z-index: 1;
  text-align: left; padding: 7px 10px; background: var(--bg-subtle);
  border-bottom: 1px solid var(--border); cursor: pointer; user-select: none;
  transition: background 0.12s ease; white-space: nowrap;
}
.table th:hover { background: var(--bg-hover); }
/* _id 列头不可排序:去掉指针与悬停反馈。 */
.table th.col-nosort { cursor: default; }
.table th.col-nosort:hover { background: var(--bg-subtle); }
.col-head { display: flex; flex-direction: column; gap: 1px; white-space: nowrap; }
.col-name { font-weight: 600; display: flex; align-items: center; gap: 4px; }
.col-type { font-size: 10px; color: var(--text-tertiary); font-family: var(--mono); font-weight: 400; }
.col-arrow { color: var(--accent); font-size: 11px; }
/* 第三行:字段描述(comment),灰色小字;超长省略,悬停 title 已含全文。 */
.col-comment { font-size: 10px; color: var(--text-tertiary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.table tbody tr:nth-child(even) td { background: var(--bg-subtle); }
.table tbody tr:hover td { background: var(--bg-hover); }
.table td { padding: 5px 10px; border-bottom: 1px solid var(--border); word-break: break-all; max-width: 420px; }
.cell-null { color: var(--text-tertiary); font-style: italic; }
.cell-trunc { color: var(--text-secondary); }
/* _id 列只读:不出现文本光标,提示走 title。 */
.cell-readonly { cursor: default; }
/* _id 单元格:行首操作按钮 + 文档标识。 */
.id-cell { display: flex; align-items: center; gap: 5px; }
.id-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.mini-btn {
  flex: none; font-size: 10px; line-height: 1;
  padding: 2px 5px; border-radius: 4px; cursor: pointer;
  background: transparent; color: var(--text-secondary);
  border: 1px solid var(--border-strong);
}
.mini-btn:hover { background: var(--bg-hover); color: var(--text); }
.mini-btn.danger { color: var(--danger); border-color: var(--danger); }
.mini-btn.danger:hover { background: var(--danger-soft); }
/* 行内编辑输入框:覆盖单元格内容,细边框紧凑,与表格行高一致。 */
.cell-editor {
  box-sizing: border-box; width: 100%; min-width: 80px;
  background: var(--bg-elevated); color: var(--text);
  border: 1px solid var(--accent); border-radius: 4px;
  padding: 1px 6px; font-size: 13px; font-family: var(--mono);
}
.cell-editor:focus { outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
.mono { font-family: var(--mono); }
.empty { text-align: center; color: var(--text-tertiary); padding: 28px 24px; }
.empty-icon { font-size: 26px; margin-bottom: 6px; }
.empty-hint { font-size: 11px; margin-top: 4px; color: var(--text-tertiary); }
.pager { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.page-label { font-size: 12px; color: var(--text-secondary); }
.btn { border-radius: 7px; padding: 6px 13px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn.danger:hover:not(:disabled) { background: var(--danger-soft); }
/* JSON 编辑弹窗:与 ConfirmDialog 同一视觉语言,弹窗更宽以容纳文档。 */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 380px; max-width: calc(100vw - 48px);
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.json-modal { width: 640px; }
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.modal-title { font-size: 14px; font-weight: 600; }
.doc-id { font-size: 12px; color: var(--text-secondary); font-weight: 400; }
.modal-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 6px; }
.modal-close:hover { color: var(--text); background: var(--bg-hover); }
.modal-body { padding: 16px 18px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 0 18px 16px; }
.json-editor {
  box-sizing: border-box; width: 100%; min-height: 280px; resize: vertical;
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 8px 10px; font-size: 12px; line-height: 1.5;
  font-family: var(--mono);
}
.json-editor:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.json-hint { margin-top: 8px; font-size: 11px; color: var(--text-tertiary); }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
</style>
