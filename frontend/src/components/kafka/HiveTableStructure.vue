<script setup lang="ts">
// Hive 表结构编辑弹窗:加载 hiveTableColumns 全量列元数据 + DDL,按 Hive
// 方言裁剪——「新增列(只能追加表尾,无 AFTER)+ 修改列(仅类型/注释,不
// 支持改名)+ 删除列(Hive 3 直接 DROP COLUMN,低版本由后端自动降级
// REPLACE COLUMNS 重建)」。分区列只读展示(分区列不可改);Hive 无主键
// 概念,不显示主键列。SQL 一律由后端拼装,这里只传结构化 HiveColumnDef。
import { computed, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { HiveColumn, HiveColumnDef, HiveTableColumnsResult } from '@/api/types'

const props = defineProps<{ show: boolean; connectionId: string; database: string; table: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// 行编辑模型:isPartition = 分区列(只读展示);isNew = 本次新增未保存;
// toDrop = 已有列标记为将 DROP;dirty = 用户是否真实编辑过该行(零编辑行
// 不进入 modify_columns)。
interface ColumnRow {
  name: string
  type: string
  comment: string
  isPartition: boolean
  isNew: boolean
  toDrop: boolean
  dirty: boolean
}

const rows = ref<ColumnRow[]>([])
// 原始列元数据快照(含分区列),供 diff 判断「该行是否被修改过」。
const originals = ref<Map<string, HiveColumn>>(new Map())
const tableType = ref('')
const transactional = ref(false)
const ddl = ref('')
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const savedTip = ref(false)
const showDdl = ref(false)
// 新增列表单:null = 未展开。
const addForm = ref<null | { name: string; type: string; comment: string }>(null)

function toRow(c: HiveColumn, isPartition: boolean): ColumnRow {
  return {
    name: c.name,
    type: c.type,
    comment: c.comment ?? '',
    isPartition,
    isNew: false,
    toDrop: false,
    dirty: false,
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = (await getApi().hiveTableColumns?.({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
    })) as HiveTableColumnsResult | undefined
    const cols = res?.columns ?? []
    const parts = res?.partition_columns ?? []
    // 普通列在前,分区列随后只读展示(分区列不可改)。
    rows.value = [...cols.map((c) => toRow(c, false)), ...parts.map((c) => toRow(c, true))]
    originals.value = new Map([...cols, ...parts].map((c) => [c.name, c]))
    tableType.value = res?.table_type ?? ''
    transactional.value = res?.transactional ?? false
    ddl.value = res?.ddl ?? ''
    addForm.value = null
    showDdl.value = false
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.show,
  (show) => {
    if (show) {
      savedTip.value = false
      void load()
    }
  },
  { immediate: true },
)

function openAddForm(): void {
  addForm.value = { name: '', type: '', comment: '' }
}

function confirmAdd(): void {
  const f = addForm.value
  if (!f || !f.name.trim() || !f.type.trim()) return
  rows.value.push({
    name: f.name.trim(),
    type: f.type.trim(),
    comment: f.comment,
    isPartition: false,
    isNew: true,
    toDrop: false,
    dirty: false,
  })
  addForm.value = null
}

// removeRow:分区列直接不响应(按钮已禁用,分区列不可改);已有列标记为将
// DROP(可撤销);本次新增行直接移除。
function removeRow(row: ColumnRow): void {
  if (row.isPartition) return
  if (row.isNew) {
    rows.value = rows.value.filter((r) => r !== row)
  } else {
    row.toDrop = !row.toDrop
  }
}

// 新增列:只能追加表尾(Hive 无 AFTER 位置选项)。
const addColumns = computed<HiveColumnDef[]>(() =>
  rows.value
    .filter((r) => r.isNew)
    .map((r) => ({
      name: r.name,
      type: r.type,
      comment: r.comment,
    })),
)

// 修改列:仅类型/注释(不支持改列名);分区列只读不参与;行级 dirty 过滤
// 零编辑行,保存不产生空 modify。
const modifyColumns = computed<HiveColumnDef[]>(() => {
  const out: HiveColumnDef[] = []
  for (const r of rows.value) {
    if (r.isNew || r.toDrop || r.isPartition) continue
    if (!r.dirty) continue
    const orig = originals.value.get(r.name)
    if (!orig) continue
    const changed = r.type !== orig.type || r.comment !== (orig.comment ?? '')
    if (!changed) continue
    out.push({ name: r.name, type: r.type, comment: r.comment })
  }
  return out
})

const dropColumns = computed(() => rows.value.filter((r) => !r.isNew && !r.isPartition && r.toDrop).map((r) => r.name))

const hasChanges = computed(() => addColumns.value.length > 0 || modifyColumns.value.length > 0 || dropColumns.value.length > 0)

async function save(): Promise<void> {
  if (!hasChanges.value || saving.value) return
  saving.value = true
  saveError.value = ''
  savedTip.value = false
  try {
    await getApi().hiveAlterTable?.({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
      add_columns: addColumns.value,
      modify_columns: modifyColumns.value,
      drop_columns: dropColumns.value,
    })
    savedTip.value = true
    await load()
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function close(): void {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="hs-backdrop" data-test="hive-structure-dialog" @click.self="close">
      <div class="hs-modal">
        <div class="hs-header">
          <span class="hs-title">编辑表字段</span>
          <span class="hs-table" :title="`${database}.${table}`">{{ database }}.{{ table }}</span>
          <span v-if="tableType" class="hs-meta" :title="`表类型 ${tableType}`">{{ tableType }}</span>
          <span v-if="transactional" class="hs-meta acide" title="ACID 事务表">ACID</span>
          <button class="hs-close" type="button" data-test="btn-structure-close" @click="close">✕</button>
        </div>

        <div v-if="loading" class="hs-hint" data-test="structure-loading">加载中…</div>
        <div v-else-if="loadError" class="hs-error" data-test="structure-load-error">
          <span>{{ loadError }}</span>
          <button class="btn ghost" type="button" data-test="btn-structure-retry" @click="load">重试</button>
        </div>
        <template v-else>
          <div class="hs-toolbar">
            <button class="btn ghost" type="button" data-test="btn-add-column" @click="openAddForm">＋ 新增列</button>
            <span class="hs-note">Hive 方言:新增列只能追加表尾;修改列仅支持类型/注释(不支持改名);删除列在 Hive 3 直接生效,低版本由后端自动以 REPLACE COLUMNS 降级重建;分区列只读。</span>
          </div>

          <!-- 新增列表单:确认后作为一行未保存列进入表格(追加表尾,无位置选项)。 -->
          <div v-if="addForm" class="hs-add-form" data-test="structure-add-form">
            <input v-model="addForm.name" class="input" type="text" placeholder="列名" data-test="add-name" />
            <input v-model="addForm.type" class="input" type="text" placeholder="类型,如 string/bigint" data-test="add-type" />
            <input v-model="addForm.comment" class="input" type="text" placeholder="注释" data-test="add-comment" />
            <span class="hs-note">(追加表尾)</span>
            <button class="btn primary" type="button" data-test="btn-confirm-add-column" :disabled="!addForm.name.trim() || !addForm.type.trim()" @click="confirmAdd">添加</button>
            <button class="btn ghost" type="button" data-test="btn-cancel-add-column" @click="addForm = null">取消</button>
          </div>

          <div class="hs-table-wrap">
            <table class="hs-grid">
              <thead>
                <tr>
                  <th>列名</th>
                  <th>类型</th>
                  <th>注释</th>
                  <th>分区</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in rows"
                  :key="`${row.isNew ? 'new:' : ''}${row.name}`"
                  :class="{ 'row-drop': row.toDrop, 'row-new': row.isNew, 'row-partition': row.isPartition }"
                  data-test="structure-column-row"
                >
                  <td>
                    <input v-if="row.isNew" v-model="row.name" class="input cell" type="text" data-test="column-name" />
                    <template v-else><span data-test="column-name">{{ row.name }}</span></template>
                  </td>
                  <!-- 修改列支持类型变更(兼容性由 Hive 校验,失败原样透出);
                       分区列只读。 -->
                  <td><input v-model="row.type" class="input cell" type="text" :disabled="row.isPartition || row.toDrop" data-test="column-type" @input="row.dirty = true" /></td>
                  <td><input v-model="row.comment" class="input cell" type="text" :disabled="row.isPartition || row.toDrop" data-test="column-comment" @input="row.dirty = true" /></td>
                  <td><span v-if="row.isPartition" class="hs-partition" data-test="partition-badge" title="分区列不可修改">分区</span></td>
                  <td>
                    <button v-if="!row.isNew" class="hs-drop" type="button" data-test="btn-drop-column" :disabled="row.isPartition" :title="row.isPartition ? '分区列不支持在此删除' : undefined" @click="removeRow(row)">
                      {{ row.toDrop ? '撤销' : '移除' }}
                    </button>
                    <button v-else class="hs-drop" type="button" data-test="btn-remove-new-column" @click="removeRow(row)">移除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="saveError" class="hs-error" data-test="structure-save-error">{{ saveError }}</div>
          <div v-if="savedTip" class="hs-saved" data-test="structure-saved">表结构已更新</div>

          <div class="hs-actions">
            <button class="btn ghost" type="button" data-test="btn-toggle-ddl" @click="showDdl = !showDdl">查看 DDL</button>
            <span class="hs-flex"></span>
            <button class="btn primary" type="button" data-test="btn-structure-save" :disabled="!hasChanges || saving" @click="save">
              {{ saving ? '保存中…' : '保存修改' }}
            </button>
          </div>
          <pre v-if="showDdl" class="hs-ddl" data-test="structure-ddl">{{ ddl || '(无 DDL)' }}</pre>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hs-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.hs-modal {
  width: min(820px, calc(100vw - 64px));
  max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  padding: 16px; gap: 10px; overflow: hidden;
}
.hs-header { display: flex; align-items: center; gap: 8px; }
.hs-title { font-size: 14px; font-weight: 600; }
.hs-table { font-size: 12px; color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hs-meta { flex: none; font-size: 10px; font-family: var(--mono); background: var(--bg-hover); border-radius: 4px; padding: 1px 6px; color: var(--text-secondary); }
.hs-meta.acide { color: var(--ok); background: var(--ok-soft); }
.hs-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 6px; }
.hs-close:hover { color: var(--text); background: var(--bg-hover); }
.hs-toolbar { display: flex; align-items: center; gap: 10px; }
.hs-note { font-size: 11px; color: var(--text-tertiary); }
.hs-add-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-subtle); }
.hs-add-form .input { width: 130px; }
.hs-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 8px; max-height: 45vh; }
.hs-grid { width: 100%; border-collapse: collapse; font-size: 12px; }
.hs-grid th { text-align: left; padding: 6px 8px; color: var(--text-tertiary); font-weight: 500; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg-elevated); white-space: nowrap; }
.hs-grid td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.hs-grid tr:last-child td { border-bottom: none; }
.input.cell { padding: 3px 7px; font-size: 12px; }
.input.cell:disabled { opacity: 0.55; cursor: not-allowed; }
.row-drop { opacity: 0.55; }
.row-drop td:first-child { text-decoration: line-through; }
.row-new td { background: var(--accent-soft); }
.row-partition td { background: var(--bg-subtle); }
.hs-partition { flex: none; font-size: 10px; background: var(--bg-hover); border-radius: 4px; padding: 1px 6px; color: var(--text-secondary); }
.hs-drop { background: none; border: 1px solid var(--border-strong); color: var(--text-secondary); font-size: 11px; border-radius: 6px; padding: 1px 8px; cursor: pointer; }
.hs-drop:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.hs-drop:disabled { opacity: 0.5; cursor: not-allowed; }
.hs-hint { color: var(--text-secondary); font-size: 12px; padding: 12px 0; }
.hs-error { color: var(--danger); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.hs-saved { color: var(--ok); font-size: 12px; }
.hs-actions { display: flex; align-items: center; gap: 8px; }
.hs-flex { flex: 1; }
.hs-ddl {
  margin: 0; padding: 10px; font-family: var(--mono); font-size: 11px; line-height: 1.5;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
  max-height: 200px; overflow: auto; white-space: pre; color: var(--text);
}
.btn { border-radius: 7px; padding: 4px 12px; font-size: 12px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover { background: var(--bg-hover); }
</style>
