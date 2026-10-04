<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { getApi } from '@/api/client'
import type { HiveColumn, HivePageRowsResult, HiveTableColumnsResult } from '@/api/types'

const props = defineProps<{ connectionId: string; database: string; table: string }>()

// 每页行数与后端 hivePageRows 的 limit 对齐(Hive 不支持 OFFSET,后端用
// ROW_NUMBER() OVER() 窗口包装实现翻页)。
const PAGE_SIZE = 500
// 超长单元格客户端截断展示(完整值保留在 title 提示中)。
const CELL_TRUNCATE = 200

// Hive 表浏览器只读浏览:无过滤/排序/行内编辑/行删除(裁剪自
// MysqlTableBrowser,死代码不留);清空数据仅内部表(MANAGED_TABLE)可用,
// 表类型经 hiveTableColumns 探测。

const columns = ref<HiveColumn[]>([])
const rows = ref<(string | null)[][]>([])
const totalRows = ref(0)
const tableType = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const offset = ref(0)
const confirmTruncate = ref(false)

const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)

// 仅内部表(事务相关数据落在 MANAGED_TABLE)支持 TRUNCATE;外部表/视图禁用。
const isManagedTable = computed(() => tableType.value === 'MANAGED_TABLE')
const truncateDisabledTitle = '仅内部表(MANAGED_TABLE)支持清空'

async function fetchPage(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const res = (await getApi().hivePageRows?.({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
      limit: PAGE_SIZE,
      offset: offset.value,
    })) as HivePageRowsResult | undefined
    // wire 形状防御:后端异常/老版本可能给出 null 或缺字段;模板对
    // columns/rows 按数组、totalRows 按数字直接使用,任何 null/undefined
    // 都会在渲染期抛 TypeError 并中断整个调度队列(WKWebView 表现为白屏)。
    columns.value = res?.columns ?? []
    rows.value = res?.rows ?? []
    const total = Number(res?.total_rows)
    totalRows.value = Number.isFinite(total) ? total : 0
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// 表类型探测(清空数据守卫 + 汇总展示);失败静默为空(按未知类型处理,
// 清空按钮禁用,避免误清外部表)。
async function loadTableType(): Promise<void> {
  try {
    const res = (await getApi().hiveTableColumns?.({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
    })) as HiveTableColumnsResult | undefined
    tableType.value = res?.table_type ?? ''
  } catch {
    tableType.value = ''
  }
}

onMounted(() => {
  void fetchPage()
  void loadTableType()
})

// 外部(树/Layout)切换表时重置分页状态并重拉第一页与表类型。
watch(
  () => props.table,
  () => {
    offset.value = 0
    tableType.value = ''
    void fetchPage()
    void loadTableType()
  },
)

function refresh(): void {
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

// 清空数据:文案包含表名与表类型,确认弹窗走危险色。
const truncateMessage = computed(
  () => `确认清空表「${props.table}」(类型 ${tableType.value || '未知'})的全部数据？此操作不可恢复。`,
)

async function doTruncate(): Promise<void> {
  confirmTruncate.value = false
  try {
    await getApi().hiveTruncateTable?.({
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

// cellTitle 数据单元格悬停提示:完整原值(Hive 只读,无编辑提示)。
function cellTitle(v: string | null): string {
  return v ?? ''
}

// colTitle 列头悬停提示:类型小字;comment 非空时追加描述(不可排序说明)。
function colTitle(c: HiveColumn): string {
  const base = `${c.type} · Hive 表浏览器不排序`
  return c.comment ? `${base}\n${c.comment}` : base
}
</script>

<template>
  <div class="hive-browser" data-test="hive-table-browser">
    <div class="summary" data-test="hive-summary">
      <span class="mono table-name" data-test="hive-summary-table">{{ props.database }}.{{ props.table }}</span>
      <span class="sep">·</span>
      <span data-test="hive-summary-type">{{ tableType || '—' }}</span>
      <span class="sep">·</span>
      <span data-test="hive-summary-rows">≈ {{ totalRows.toLocaleString() }} 行</span>
    </div>

    <div class="toolbar">
      <span class="readonly-hint" data-test="hive-readonly-hint">Hive 表浏览器只读:行级写入请在 SQL 控制台执行</span>
      <span class="flex-spacer"></span>
      <button class="btn ghost" type="button" data-test="btn-hive-refresh" :disabled="loading" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
      <button
        class="btn ghost danger"
        type="button"
        data-test="btn-hive-truncate"
        :disabled="!isManagedTable"
        :title="isManagedTable ? '清空表数据' : truncateDisabledTitle"
        @click="confirmTruncate = true"
      >清空数据</button>
    </div>

    <div v-if="error" class="msg err" data-test="hive-error">{{ error }}</div>

    <div v-if="columns.length > 0 && rows.length === 0 && !loading" class="table-wrap">
      <div class="fields-panel" data-test="hive-fields-panel">
        <div class="fields-title" data-test="hive-fields-title">表结构(共 {{ columns.length }} 字段)</div>
        <div v-for="c in columns" :key="c.name" class="fields-row" data-test="hive-field-row">
          <span class="field-name" data-test="hive-field-name">{{ c.name }}</span>
          <span class="field-type" data-test="hive-field-type">{{ c.type }}</span>
          <span v-if="c.comment" class="field-comment" data-test="hive-field-comment">{{ c.comment }}</span>
        </div>
      </div>
      <div class="empty" data-test="hive-grid-empty">
        <div class="empty-icon">◌</div>
        <div>该表暂无数据</div>
        <div class="empty-hint">数据写入后点击「刷新」查看</div>
      </div>
    </div>

    <div v-else class="table-wrap">
      <table class="table" data-test="hive-grid">
        <thead>
          <tr>
            <!-- Hive 不显示排序控件:列头纯展示(名称 + 类型小字 + 可选注释)。 -->
            <th
              v-for="c in columns"
              :key="c.name"
              data-test="hive-col"
              :title="colTitle(c)"
            >
              <div class="col-head">
                <span class="col-name">
                  <span data-test="hive-col-name">{{ c.name }}</span>
                </span>
                <span class="col-type" data-test="hive-col-type">{{ c.type }}</span>
                <span v-if="c.comment" class="col-comment" data-test="hive-col-comment">{{ c.comment }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in rows" :key="ri" data-test="hive-row">
            <td
              v-for="(cell, ci) in row"
              :key="ci"
              class="mono cell"
              :class="{ 'cell-null': cell === null, 'cell-trunc': isTruncated(cell) }"
              :title="cellTitle(cell)"
              data-test="hive-cell"
            >
              {{ cellDisplay(cell) }}
            </td>
          </tr>
          <tr v-if="rows.length === 0 && !loading">
            <td :colspan="columns.length" class="empty" data-test="hive-grid-empty">
              <div class="empty-icon">◌</div>
              <div>该表暂无数据</div>
              <div class="empty-hint">数据写入后点击「刷新」查看</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager" data-test="hive-pager">
      <button class="btn ghost" type="button" data-test="btn-hive-prev" :disabled="offset === 0 || loading" @click="prevPage">上一页</button>
      <span class="page-label" data-test="hive-page-label">第 {{ page }} 页</span>
      <button class="btn ghost" type="button" data-test="btn-hive-next" :disabled="rows.length < PAGE_SIZE || loading" @click="nextPage">下一页</button>
    </div>

    <!-- 清空数据:危险操作,文案含表名与表类型;仅内部表可点。 -->
    <ConfirmDialog
      :show="confirmTruncate"
      :message="truncateMessage"
      confirm-text="清空"
      danger
      @confirm="doTruncate"
      @cancel="confirmTruncate = false"
    />
  </div>
</template>

<style scoped>
.hive-browser { padding: 16px; color: var(--text); font-family: var(--font); }
.summary {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  padding: 8px 12px;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
  font-size: 12px; color: var(--text-secondary);
}
.table-name { font-weight: 600; color: var(--text); }
.sep { color: var(--text-tertiary); }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.flex-spacer { flex: 1; }
.readonly-hint { font-size: 12px; color: var(--text-tertiary); }
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
  border-bottom: 1px solid var(--border); user-select: none; white-space: nowrap;
}
.col-head { display: flex; flex-direction: column; gap: 1px; white-space: nowrap; }
.col-name { font-weight: 600; display: flex; align-items: center; gap: 4px; }
.col-type { font-size: 10px; color: var(--text-tertiary); font-family: var(--mono); font-weight: 400; }
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
