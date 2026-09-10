<script setup lang="ts">
import { computed, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import * as App from '../../../wailsjs/go/backend/App'

const props = defineProps<{ connectionId: string; database: string; table: string }>()

// 每页行数与后端 MysqlPageRows 的 limit 对齐。
const PAGE_SIZE = 200
// 超长单元格客户端截断展示(完整值保留在 title 提示中)。
const CELL_TRUNCATE = 200

interface MysqlColumn {
  name: string
  type: string
  comment?: string
  is_in_primary_key?: boolean
}

interface MysqlPageRowsResult {
  columns: MysqlColumn[]
  rows: (string | null)[][]
  total_rows: number
  primary_key: string[]
  engine: string
}

// 单元格更新的定位/写入描述;set 为新值(null = 写 NULL),where 为行定位
// 条件(MySQL 语义下后端契约:仅主键列,前端禁止拼 SQL 文本)。
interface MysqlCellRef {
  column: string
  value: string | null
}

interface MysqlCellUpdateTarget {
  connection_id: string
  database: string
  table: string
  set: MysqlCellRef
  where: MysqlCellRef[]
}

// Mysql* 绑定尚未由 wails generate module 生成,这里按显式形状断言调用
// (req 为契约形状原样,Wails 按字段名序列化,snake_case 已对齐);生成后
// 签名一致,无需改动本文件。
const app = App as unknown as {
  MysqlPageRows(req: {
    connection_id: string
    database: string
    table: string
    where?: string
    order_by?: string
    asc?: boolean
    limit: number
    offset: number
  }): Promise<MysqlPageRowsResult>
  MysqlTruncateTable(req: { connection_id: string; database: string; table: string }): Promise<void>
  MysqlPreviewCellUpdate(req: unknown): Promise<{ statement: string; matched_rows: number }>
  MysqlUpdateCell(req: unknown): Promise<void>
}

const columns = ref<MysqlColumn[]>([])
const rows = ref<(string | null)[][]>([])
const engine = ref('')
const totalRows = ref(0)
// 后端返回的主键列名列表(空数组=无主键,整表只读)。
const primaryKey = ref<string[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const where = ref('')
// 已应用的过滤条件:回车/按钮提交后才随请求下发。
const appliedWhere = ref('')
const orderBy = ref('')
const asc = ref(true)
const offset = ref(0)
const confirmTruncate = ref(false)

// 行内编辑态:同一时刻仅一个单元格可编辑,row/col 为行/列下标;
// editValue 为输入框草稿,提交时空串按写 NULL 处理。
const editing = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')

// 仅当表有主键时开放行内编辑;无主键表所有数据单元格只读。
const canEdit = computed(() => primaryKey.value.length > 0)
const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)

async function fetchPage(): Promise<void> {
  loading.value = true
  error.value = null
  // 换页/刷新后行集合将重建,未完成的行内编辑一并丢弃。
  editing.value = null
  try {
    const res = await app.MysqlPageRows({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
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
    primaryKey.value = res.primary_key ?? []
    const total = Number(res.total_rows)
    totalRows.value = Number.isFinite(total) ? total : 0
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void fetchPage()
})

// 外部(树/Layout)切换表时重置过滤/排序/分页状态并重拉第一页。
watch(
  () => props.table,
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

function refresh(): void {
  void fetchPage()
}

// sortBy 点击列头排序:同一列翻转方向,新列默认升序;回第一页。
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

function nextPage(): void {
  offset.value += PAGE_SIZE
  void fetchPage()
}

function prevPage(): void {
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  void fetchPage()
}

// 清空数据:文案包含表名与引擎,确认弹窗走危险色。
const truncateMessage = computed(
  () => `确认清空表「${props.table}」(引擎 ${engine.value || '未知'})的全部数据？此操作不可恢复。`,
)

async function doTruncate(): Promise<void> {
  confirmTruncate.value = false
  try {
    await app.MysqlTruncateTable({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
    })
    offset.value = 0
    await fetchPage()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

// --- 单元格渲染:nil → NULL(浅色);超长值截断(浅色标注 + title 全文)。 ---

function isTruncated(v: string | null): boolean {
  return v !== null && v.length > CELL_TRUNCATE
}

function cellDisplay(v: string | null): string {
  if (v === null) return 'NULL'
  return isTruncated(v) ? `${v.slice(0, CELL_TRUNCATE)}…` : v
}

// cellTitle 数据单元格悬停提示:无主键表为只读原因;有主键时展示完整原值。
function cellTitle(v: string | null): string {
  if (!canEdit.value) return '表无主键,不支持编辑'
  return v ?? ''
}

// colTitle 列头悬停提示:排序说明 + 类型;comment 非空时追加描述。
function colTitle(c: MysqlColumn): string {
  const base = `按 ${c.name} 排序 · ${c.type}`
  return c.comment ? `${base}\n${c.comment}` : base
}

// --- 单元格行内编辑:双击 → 输入 → 回车 → 预览确认 → 执行并刷新。 ---

function isEditing(ri: number, ci: number): boolean {
  return editing.value?.row === ri && editing.value?.col === ci
}

// startEdit 双击进入编辑:原始值取自 rows 内存(null 显示为空输入框);
// 无主键/loading 或已有单元格在编辑时忽略,避免并发编辑态。
function startEdit(ri: number, ci: number): void {
  if (loading.value || editing.value || !canEdit.value || !columns.value[ci]) return
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

// buildTarget 组装更新请求:set 为编辑后的值(空串=写 NULL);where 一律
// 只用主键列的编辑前原值快照(后端契约,前端不拼 SQL 文本)。
function buildTarget(ed: { row: number; col: number }): MysqlCellUpdateTarget {
  const cols = columns.value
  const originalRow = rows.value[ed.row] ?? []
  const edited = cols[ed.col]
  return {
    connection_id: props.connectionId,
    database: props.database,
    table: props.table,
    set: {
      column: edited.name,
      value: editValue.value === '' ? null : editValue.value,
    },
    where: primaryKey.value.map((name) => {
      const i = cols.findIndex((c) => c.name === name)
      return { column: name, value: originalRow[i] ?? null }
    }),
  }
}

// --- 单元格更新预览/确认/执行状态机(与 useCHCellUpdate 契约一致;因本次
// 只允许新建组件与测试两个文件,状态机内联于此组件)。 ---
const cuError = ref<string | null>(null)
const confirmOpen = ref(false)
const statement = ref('')
const matchedRows = ref(0)
// 预览通过后暂存的待执行目标,确认时原样发给执行。
let pending: MysqlCellUpdateTarget | null = null

// submitEdit 回车提交:先固化 target 快照再退出编辑态,随后预览并打开
// 确认弹窗;失败时 cuError 已记录并显示进现有错误区。
async function submitEdit(): Promise<void> {
  const ed = editing.value
  if (!ed) return
  const target = buildTarget(ed)
  cancelEdit()
  cuError.value = null
  pending = target
  try {
    const res = await app.MysqlPreviewCellUpdate(target)
    statement.value = res.statement
    matchedRows.value = res.matched_rows
    confirmOpen.value = true
  } catch (e) {
    cuError.value = e instanceof Error ? e.message : String(e)
    pending = null
  }
}

// 弹窗文案:UPDATE 语句全文 + 匹配行数;将波及多行时追加警示。
const cellUpdateMessage = computed(() => {
  const n = Number(matchedRows.value ?? 0)
  const lines = [`将执行以下语句:\n${statement.value}`, `匹配 ${n} 行`]
  if (n > 1) lines.push(`将同时更新 ${n} 行,请确认`)
  return lines.join('\n')
})

// onCellUpdateConfirm 确认执行:成功后关闭弹窗并刷新当前页;失败弹窗保持
// 打开(CH 行为一致),错误同时进错误区。
async function onCellUpdateConfirm(): Promise<void> {
  const target = pending
  if (!target) {
    confirmOpen.value = false
    return
  }
  try {
    await app.MysqlUpdateCell(target)
    pending = null
    confirmOpen.value = false
    statement.value = ''
    matchedRows.value = 0
    void fetchPage()
  } catch (e) {
    cuError.value = e instanceof Error ? e.message : String(e)
  }
}

// onCellUpdateCancel 取消:关闭弹窗并清空全部状态(含待执行目标)。
function onCellUpdateCancel(): void {
  pending = null
  confirmOpen.value = false
  statement.value = ''
  matchedRows.value = 0
  cuError.value = null
}
</script>

<template>
  <div class="mysql-browser" data-test="mysql-table-browser">
    <div class="summary" data-test="mysql-summary">
      <span class="mono table-name" data-test="mysql-summary-table">{{ props.database }}.{{ props.table }}</span>
      <span class="sep">·</span>
      <span data-test="mysql-summary-engine">{{ engine || '—' }}</span>
      <span class="sep">·</span>
      <span data-test="mysql-summary-rows">≈ {{ totalRows.toLocaleString() }} 行</span>
    </div>

    <div class="toolbar">
      <input
        v-model="where"
        class="where-input"
        type="search"
        data-test="mysql-where"
        placeholder="WHERE 条件,如 age > 18"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter="applyWhere"
      />
      <button class="btn ghost" type="button" data-test="btn-mysql-apply" :disabled="loading" @click="applyWhere">过滤</button>
      <button class="btn ghost" type="button" data-test="btn-mysql-refresh" :disabled="loading" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
      <button class="btn ghost danger" type="button" data-test="btn-mysql-truncate" @click="confirmTruncate = true">清空数据</button>
    </div>

    <div v-if="error || cuError" class="msg err" data-test="mysql-error">{{ error || cuError }}</div>

    <div v-if="columns.length > 0 && rows.length === 0 && !loading" class="table-wrap">
      <div class="fields-panel" data-test="mysql-fields-panel">
        <div class="fields-title" data-test="mysql-fields-title">表结构(共 {{ columns.length }} 字段)</div>
        <div v-for="c in columns" :key="c.name" class="fields-row" data-test="mysql-field-row">
          <span class="field-name" data-test="mysql-field-name">{{ c.name }}</span>
          <span class="field-type" data-test="mysql-field-type">{{ c.type }}</span>
          <span v-if="c.comment" class="field-comment" data-test="mysql-field-comment">{{ c.comment }}</span>
        </div>
      </div>
      <div class="empty" data-test="mysql-grid-empty">
        <div class="empty-icon">◌</div>
        <div>该表暂无数据</div>
        <div class="empty-hint">数据写入后点击「刷新」查看</div>
      </div>
    </div>

    <div v-else class="table-wrap">
      <table class="table" data-test="mysql-grid">
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.name"
              data-test="mysql-col"
              :title="colTitle(c)"
              @click="sortBy(c.name)"
            >
              <!-- 弹性布局只在内层 div:th 必须保持 table-cell,否则脱离
                   表格列布局,WebKit 会把整行列头堆进一个匿名单元格。 -->
              <div class="col-head">
                <span class="col-name">
                  <span data-test="mysql-col-name">{{ c.name }}</span>
                  <!-- 主键角标:后端 is_in_primary_key 标记。 -->
                  <span v-if="c.is_in_primary_key" class="pk-badge" data-test="mysql-pk-badge" title="主键">🔑</span>
                  <span v-if="orderBy === c.name" class="col-arrow">{{ asc ? '↑' : '↓' }}</span>
                </span>
                <span class="col-type" data-test="mysql-col-type">{{ c.type }}</span>
                <span v-if="c.comment" class="col-comment" data-test="mysql-col-comment">{{ c.comment }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in rows" :key="ri" data-test="mysql-row">
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="mono cell"
              :class="{ 'cell-null': cell === null && !isEditing(ri, ci), 'cell-trunc': isTruncated(cell), 'cell-readonly': !canEdit }"
              :title="cellTitle(cell)"
              data-test="mysql-cell"
              @dblclick="startEdit(ri, ci)"
            >
              <!-- 行内编辑:双击进入,Esc/blur 取消,回车提交预览。 -->
              <input
                v-if="isEditing(ri, ci)"
                :ref="focusEditor"
                v-model="editValue"
                class="cell-editor"
                data-test="mysql-cell-editor"
                @blur="cancelEdit"
                @keydown.enter.prevent="submitEdit"
                @keydown.esc.prevent="cancelEdit"
              />
              <template v-else>{{ cellDisplay(cell) }}</template>
            </td>
          </tr>
          <tr v-if="rows.length === 0 && !loading">
            <td :colspan="columns.length || 1" class="empty" data-test="mysql-grid-empty">
              <div class="empty-icon">◌</div>
              <div>该表暂无数据</div>
              <div class="empty-hint">数据写入后点击「刷新」查看</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager" data-test="mysql-pager">
      <button class="btn ghost" type="button" data-test="btn-mysql-prev" :disabled="offset === 0 || loading" @click="prevPage">上一页</button>
      <span class="page-label" data-test="mysql-page-label">第 {{ page }} 页</span>
      <button class="btn ghost" type="button" data-test="btn-mysql-next" :disabled="rows.length < PAGE_SIZE || loading" @click="nextPage">下一页</button>
    </div>

    <!-- 清空数据:危险操作,文案含表名与引擎。 -->
    <ConfirmDialog
      :show="confirmTruncate"
      :message="truncateMessage"
      confirm-text="清空"
      danger
      @confirm="doTruncate"
      @cancel="confirmTruncate = false"
    />

    <!-- 单元格更新确认:展示将执行的 UPDATE 语句全文与匹配行数。 -->
    <ConfirmDialog
      :show="confirmOpen"
      :message="cellUpdateMessage"
      confirm-text="执行"
      @confirm="onCellUpdateConfirm"
      @cancel="onCellUpdateCancel"
    />
  </div>
</template>

<style scoped>
.mysql-browser { padding: 16px; color: var(--text); font-family: var(--font); }
.summary {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  padding: 8px 12px;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; color: var(--text-secondary);
}
.table-name { font-weight: 600; color: var(--text); }
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
.col-head { display: flex; flex-direction: column; gap: 1px; white-space: nowrap; }
.col-name { font-weight: 600; display: flex; align-items: center; gap: 4px; }
/* 主键角标:列名后的小钥匙,悬停提示「主键」。 */
.pk-badge { font-size: 10px; line-height: 1; }
.col-type { font-size: 10px; color: var(--text-tertiary); font-family: var(--mono); font-weight: 400; }
.col-arrow { color: var(--accent); font-size: 11px; }
/* 第三行:字段描述(comment),灰色小字;超长省略,悬停 title 已含全文。 */
.col-comment { font-size: 10px; color: var(--text-tertiary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.table tbody tr:nth-child(even) td { background: var(--bg-subtle); }
.table tbody tr:hover td { background: var(--bg-hover); }
.table td { padding: 5px 10px; border-bottom: 1px solid var(--border); word-break: break-all; max-width: 420px; }
.cell-null { color: var(--text-tertiary); font-style: italic; }
.cell-trunc { color: var(--text-secondary); }
/* 无主键表整表只读:不出现文本光标,提示走 title。 */
.cell-readonly { cursor: default; }
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
/* 空表字段结构面板:每字段一行(名称 + 类型徽标 + 可选描述)。 */
.fields-panel { padding: 0 0 4px; }
.fields-title {
  padding: 10px 12px; font-size: 12px; font-weight: 600;
  color: var(--text-secondary); border-bottom: 1px solid var(--border);
}
.fields-row {
  display: flex; align-items: baseline; gap: 10px;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
}
.fields-row:last-child { border-bottom: none; }
.field-name { font-weight: 600; font-family: var(--mono); font-size: 13px; color: var(--text); }
.field-type {
  flex: none; font-size: 10px; font-family: var(--mono);
  background: var(--bg-hover); border-radius: 4px; padding: 1px 5px;
  color: var(--text-secondary);
}
.field-comment {
  flex: 1; min-width: 0; font-size: 12px; color: var(--text-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pager { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.page-label { font-size: 12px; color: var(--text-secondary); }
.btn { border-radius: 7px; padding: 6px 13px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.danger { color: var(--danger); border-color: var(--danger); }
.btn.danger:hover:not(:disabled) { background: var(--danger-soft); }
</style>
