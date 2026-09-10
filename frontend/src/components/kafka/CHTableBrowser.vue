<script setup lang="ts">
import { computed, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { getApi } from '@/api/client'
import type { CHColumn, CHTableInfo } from '@/api/types'
import { formatBytes } from '@/utils/bytes'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useCHCellUpdate } from '@/composables/chCellUpdate'

const props = defineProps<{ connectionId: string; database: string; table: string }>()

// 每页行数与后端 CHPageRows 的 limit 对齐。
const PAGE_SIZE = 200
// 超长单元格客户端截断展示(完整值保留在 title 提示中)。
const CELL_TRUNCATE = 200

// currentTable 为内部生效表名:初始取 props.table,工具栏切换器与外部
// props 变化都会改它,后续请求/清空/摘要均以它为准(免回树换表)。
const currentTable = ref(props.table)
const columns = ref<CHColumn[]>([])
const rows = ref<(string | null)[][]>([])
const engine = ref('')
const totalRows = ref(0)
// 该库全部表清单,供工具栏表切换器使用;加载失败仅退化为单选项,不打断浏览。
const dbTables = ref<CHTableInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const where = ref('')
// 已应用的过滤条件:回车/按钮提交后才随请求下发。
const appliedWhere = ref('')
const orderBy = ref('')
const asc = ref(true)
const offset = ref(0)
const confirmTruncate = ref(false)

// --- 数据单元格行内编辑 ---
// cu:单元格 UPDATE 的预览/确认/执行状态机(SQL 与弹窗开关由其管理)。
const cu = useCHCellUpdate()
// 后端 PageRows 返回的主键列名(按 position 序;空数组=无主键)。
const primaryKey = ref<string[]>([])
// 行内编辑态:同一时刻仅一个单元格可编辑,row/col 为行/列下标;
// editValue 为输入框草稿,提交时空串按写 NULL 处理。
const editing = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')

const isDistributed = computed(() => engine.value.trim().toLowerCase() === 'distributed')
const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)

// 切换器选项:接口清单缺当前表(未加载/失败)时兜底补一个当前表。
const tableOptions = computed<CHTableInfo[]>(() => {
  if (dbTables.value.some((t) => t.name === currentTable.value)) return dbTables.value
  return [{ name: currentTable.value, engine: engine.value, total_rows: totalRows.value }, ...dbTables.value]
})

async function fetchPage(): Promise<void> {
  loading.value = true
  error.value = null
  // 换页/刷新后行集合将重建,未完成的行内编辑一并丢弃。
  editing.value = null
  try {
    const res = await getApi().chPageRows({
      connection_id: props.connectionId,
      database: props.database,
      table: currentTable.value,
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

// loadTableList 拉取该库全部表(不含 system)作为切换器选项。
async function loadTableList(): Promise<void> {
  try {
    dbTables.value = await getApi().listCHTables({
      connection_id: props.connectionId,
      database: props.database,
      show_system: false,
    })
  } catch {
    dbTables.value = []
  }
}

onMounted(() => {
  void fetchPage()
  void loadTableList()
})

// resetForTableSwitch 换表后丢弃上一表的过滤/排序/分页状态,回到第一页。
function resetForTableSwitch(): void {
  where.value = ''
  appliedWhere.value = ''
  orderBy.value = ''
  asc.value = true
  offset.value = 0
}

// onSwitchTable 用户通过工具栏切换器换表。
function onSwitchTable(): void {
  resetForTableSwitch()
  void fetchPage()
}

// 外部(树)切换表时同步内部表名并重拉。
watch(
  () => props.table,
  (t) => {
    if (t === currentTable.value) return
    currentTable.value = t
    resetForTableSwitch()
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

// 清空数据:文案包含表名与引擎;Distributed 引擎追加 ON CLUSTER 提示。
const truncateMessage = computed(() => {
  const base = `确认清空表「${currentTable.value}」(引擎 ${engine.value || '未知'})的全部数据？此操作不可恢复。`
  return isDistributed.value ? `${base}将在集群所有节点执行(ON CLUSTER)。` : base
})

async function doTruncate(): Promise<void> {
  confirmTruncate.value = false
  try {
    await getApi().chTruncateTable({
      connection_id: props.connectionId,
      database: props.database,
      table: currentTable.value,
      on_cluster: isDistributed.value ? true : undefined,
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

function cellTitle(v: string | null): string {
  return v ?? ''
}

// colTitle 列头悬停提示:排序说明 + 类型;comment 非空时追加描述。
function colTitle(c: CHColumn): string {
  const base = `按 ${c.name} 排序 · ${c.type}`
  return c.comment ? `${base}\n${c.comment}` : base
}

// --- 单元格行内编辑:双击 → 输入 → 回车 → 预览确认 → 执行并刷新。 ---

function isEditing(ri: number, ci: number): boolean {
  return editing.value?.row === ri && editing.value?.col === ci
}

// startEdit 双击进入编辑:原始值取自 rows 内存(null 显示为空输入框);
// loading 或已有单元格在编辑时忽略,避免并发编辑态。
function startEdit(ri: number, ci: number): void {
  if (loading.value || editing.value || !columns.value[ci]) return
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

// buildTarget 组装更新请求:set 为编辑后的值(空串=写 NULL);where 一律用
// 编辑前的原值快照——有主键仅取主键列,否则整行所有列兜底定位。
function buildTarget(ed: { row: number; col: number }) {
  const cols = columns.value
  const originalRow = rows.value[ed.row] ?? []
  const edited = cols[ed.col]
  const whereNames = primaryKey.value.length > 0 ? primaryKey.value : cols.map((c) => c.name)
  return {
    connection_id: props.connectionId,
    database: props.database,
    table: currentTable.value,
    set: {
      column: edited.name,
      type: edited.type,
      value: editValue.value === '' ? null : editValue.value,
    },
    where: whereNames.map((name) => {
      const i = cols.findIndex((c) => c.name === name)
      return { column: name, type: cols[i]?.type ?? 'String', value: originalRow[i] ?? null }
    }),
  }
}

// submitEdit 回车提交:先固化 target 快照再退出编辑态,cu.request 负责
// 预览并打开确认弹窗;失败时 cu.error 已记录并显示进现有错误区。
async function submitEdit(): Promise<void> {
  const ed = editing.value
  if (!ed) return
  const target = buildTarget(ed)
  cancelEdit()
  try {
    await cu.request(target)
  } catch {
    // cu.error 已承载错误,交由错误区展示。
  }
}

// 确认弹窗开关/错误均来自 cu(嵌套 ref 不被模板自动解包,转一层 computed)。
const cellUpdateOpen = computed(() => cu.confirmOpen.value)
const cellUpdateError = computed(() => cu.error.value)

// 弹窗文案:ALTER 语句全文 + 匹配行数;将波及多行时追加警示。
const cellUpdateMessage = computed(() => {
  const n = Number(cu.matchedRows.value ?? 0)
  const lines = [`将执行以下语句:\n${cu.statement.value}`, `匹配 ${n} 行`]
  if (n > 1) lines.push(`将同时更新 ${n} 行,请确认`)
  return lines.join('\n')
})

// onCellUpdateConfirm 确认执行:成功后刷新当前页;失败由 cu.error 展示。
async function onCellUpdateConfirm(): Promise<void> {
  try {
    await cu.confirm()
  } catch {
    return
  }
  if (cu.error.value) return
  void fetchPage()
}
</script>

<template>
  <div class="ch-browser" data-test="ch-table-browser">
    <div class="summary" data-test="ch-summary">
      <span class="mono table-name" data-test="ch-summary-table">{{ props.database }}.{{ currentTable }}</span>
      <span class="sep">·</span>
      <span data-test="ch-summary-engine">{{ engine || '—' }}</span>
      <span class="sep">·</span>
      <span data-test="ch-summary-rows">≈ {{ totalRows.toLocaleString() }} 行</span>
    </div>

    <div class="toolbar">
      <select
        v-model="currentTable"
        class="table-switcher"
        data-test="ch-table-switcher"
        title="切换到同库其它表"
        @change="onSwitchTable"
      >
        <option v-for="t in tableOptions" :key="t.name" :value="t.name">{{ t.name }}</option>
      </select>
      <input
        v-model="where"
        class="where-input"
        type="search"
        data-test="ch-where"
        placeholder="WHERE 条件,如 col > 1"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter="applyWhere"
      />
      <button class="btn ghost" type="button" data-test="btn-ch-apply" :disabled="loading" @click="applyWhere">过滤</button>
      <button class="btn ghost" type="button" data-test="btn-ch-refresh" :disabled="loading" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
      <button class="btn ghost danger" type="button" data-test="btn-ch-truncate" @click="confirmTruncate = true">清空数据</button>
    </div>

    <div v-if="error || cellUpdateError" class="msg err" data-test="ch-error">{{ error || cellUpdateError }}</div>

    <div v-if="columns.length > 0 && rows.length === 0 && !loading" class="table-wrap">
      <div class="fields-panel" data-test="ch-fields-panel">
        <div class="fields-title" data-test="ch-fields-title">表结构(共 {{ columns.length }} 字段)</div>
        <div v-for="c in columns" :key="c.name" class="fields-row" data-test="ch-field-row">
          <span class="field-name" data-test="ch-field-name">{{ c.name }}</span>
          <span class="field-type" data-test="ch-field-type">{{ c.type }}</span>
          <span v-if="c.comment" class="field-comment" data-test="ch-field-comment">{{ c.comment }}</span>
        </div>
      </div>
      <div class="empty" data-test="ch-grid-empty">
        <div class="empty-icon">◌</div>
        <div>该表暂无数据</div>
        <div class="empty-hint">数据写入后点击「刷新」查看</div>
      </div>
    </div>

    <div v-else class="table-wrap">
      <table class="table" data-test="ch-grid">
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.name"
              data-test="ch-col"
              :title="colTitle(c)"
              @click="sortBy(c.name)"
            >
              <!-- 弹性布局只在内层 div:th 必须保持 table-cell,否则脱离
                   表格列布局,WebKit 会把整行列头堆进一个匿名单元格。 -->
              <div class="col-head">
                <span class="col-name" data-test="ch-col-name">{{ c.name }}<span v-if="orderBy === c.name" class="col-arrow">{{ asc ? '↑' : '↓' }}</span></span>
                <span class="col-type" data-test="ch-col-type">{{ c.type }}</span>
                <span v-if="c.comment" class="col-comment" data-test="ch-col-comment">{{ c.comment }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in rows" :key="ri" data-test="ch-row">
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="mono cell"
              :class="{ 'cell-null': cell === null && !isEditing(ri, ci), 'cell-trunc': isTruncated(cell) }"
              :title="cellTitle(cell)"
              data-test="ch-cell"
              @dblclick="startEdit(ri, ci)"
            >
              <!-- 行内编辑:双击进入,Esc/blur 取消,回车提交预览。 -->
              <input
                v-if="isEditing(ri, ci)"
                :ref="focusEditor"
                v-model="editValue"
                class="cell-editor"
                data-test="ch-cell-editor"
                @blur="cancelEdit"
                @keydown.enter.prevent="submitEdit"
                @keydown.esc.prevent="cancelEdit"
              />
              <template v-else>{{ cellDisplay(cell) }}</template>
            </td>
          </tr>
          <tr v-if="rows.length === 0 && !loading">
            <td :colspan="columns.length || 1" class="empty" data-test="ch-grid-empty">
              <div class="empty-icon">◌</div>
              <div>该表暂无数据</div>
              <div class="empty-hint">数据写入后点击「刷新」查看</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager" data-test="ch-pager">
      <button class="btn ghost" type="button" data-test="btn-ch-prev" :disabled="offset === 0 || loading" @click="prevPage">上一页</button>
      <span class="page-label" data-test="ch-page-label">第 {{ page }} 页</span>
      <button class="btn ghost" type="button" data-test="btn-ch-next" :disabled="rows.length < PAGE_SIZE || loading" @click="nextPage">下一页</button>
    </div>

    <ConfirmDialog
      :show="confirmTruncate"
      :message="truncateMessage"
      confirm-text="清空"
      @confirm="doTruncate"
      @cancel="confirmTruncate = false"
    />

    <!-- 单元格更新确认:展示将执行的 ALTER 语句全文与匹配行数。 -->
    <ConfirmDialog
      :show="cellUpdateOpen"
      :message="cellUpdateMessage"
      confirm-text="执行"
      @confirm="onCellUpdateConfirm"
      @cancel="cu.cancel()"
    />
  </div>
</template>

<style scoped>
.ch-browser { padding: 16px; color: var(--text); font-family: var(--font); }
.summary {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  padding: 8px 12px;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; color: var(--text-secondary);
}
.table-name { font-weight: 600; color: var(--text); }
.sep { color: var(--text-tertiary); }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.table-switcher {
  min-width: 160px; box-sizing: border-box;
  background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 5px 9px; font-size: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.table-switcher:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
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
.col-type { font-size: 10px; color: var(--text-tertiary); font-family: var(--mono); font-weight: 400; }
.col-arrow { color: var(--accent); font-size: 11px; }
/* 第三行:字段描述(comment),灰色小字;超长省略,悬停 title 已含全文。 */
.col-comment { font-size: 10px; color: var(--text-tertiary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.table tbody tr:nth-child(even) td { background: var(--bg-subtle); }
.table tbody tr:hover td { background: var(--bg-hover); }
.table td { padding: 5px 10px; border-bottom: 1px solid var(--border); word-break: break-all; max-width: 420px; }
.cell-null { color: var(--text-tertiary); font-style: italic; }
.cell-trunc { color: var(--text-secondary); }
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
