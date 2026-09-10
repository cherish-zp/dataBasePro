<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { CHColumn, CHTableInfo } from '@/api/types'
import { formatBytes } from '@/utils/bytes'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useTabsStore } from '@/store/tabs'

const props = defineProps<{ connectionId: string; database: string; table: string }>()
// 在 SQL 控制台打开:由 Layout 转发(预填可选,当前仅打开控制台)。
const emit = defineEmits<{ (e: 'open-ch-sql'): void }>()

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
    columns.value = res.columns
    rows.value = res.rows
    engine.value = res.engine
    totalRows.value = res.total_rows
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

const tabs = useTabsStore()

// openInSqlConsole 打开该连接的 ClickHouse SQL 控制台。
function openInSqlConsole(): void {
  tabs.openCHSql(props.connectionId)
  emit('open-ch-sql')
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
      <button class="btn ghost" type="button" data-test="btn-ch-open-sql" @click="openInSqlConsole">在 SQL 控制台打开</button>
      <button class="btn ghost danger" type="button" data-test="btn-ch-truncate" @click="confirmTruncate = true">清空数据</button>
    </div>

    <div v-if="error" class="msg err" data-test="ch-error">{{ error }}</div>

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
              :class="{ 'cell-null': cell === null, 'cell-trunc': isTruncated(cell) }"
              :title="cellTitle(cell)"
              data-test="ch-cell"
            >{{ cellDisplay(cell) }}</td>
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
