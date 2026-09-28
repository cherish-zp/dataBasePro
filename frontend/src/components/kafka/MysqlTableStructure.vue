<script setup lang="ts">
// MySQL/TiDB 表结构编辑弹窗:加载 information_schema 全量列元数据 + DDL,
// 支持「已有列内联编辑(类型/可空/默认值/注释)+ 新增列(含 AFTER 位置)+
// 移除列」的 diff 保存;主键列只读(改主键请用 DDL)。SQL 一律由后端拼装,
// 这里只传结构化 MysqlColumnDef。
import { computed, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { MysqlColumnDef, MysqlTableColumn } from '@/api/types'

const props = defineProps<{ show: boolean; connectionId: string; database: string; table: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// 行编辑模型:isNew = 本次新增未保存;toDrop = 已有列标记为将 DROP;
// dirty = 用户是否真实编辑过该行(零编辑行不进入 modify_columns)。
interface ColumnRow {
  name: string
  columnType: string
  nullable: boolean
  defaultValue: string // 输入框文本;仅 noDefault=false 时生效,空串即空字符串默认值
  noDefault: boolean // 勾选 = 无默认值(DEFAULT NULL);取消勾选后输入框内容(含空串)即默认值字面量
  comment: string
  autoIncrement: boolean
  isPrimaryKey: boolean
  isNew: boolean
  toDrop: boolean
  dirty: boolean
  after: string | null // 仅新增列生效:'' 之外为 AFTER 列名
}

const rows = ref<ColumnRow[]>([])
// 原始列元数据快照,供 diff 判断「该行是否被修改过」。
const originals = ref<Map<string, MysqlTableColumn>>(new Map())
const ddl = ref('')
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const savedTip = ref(false)
const showDdl = ref(false)
// 新增列表单:null = 未展开。
const addForm = ref<null | { name: string; columnType: string; nullable: boolean; defaultValue: string; noDefault: boolean; comment: string; autoIncrement: boolean; after: string }>(null)

const existingNames = computed(() => rows.value.filter((r) => !r.isNew).map((r) => r.name))

function toRow(c: MysqlTableColumn): ColumnRow {
  return {
    name: c.name,
    columnType: c.column_type,
    nullable: c.nullable,
    // 保留原始 default_value:'' 是空字符串默认值,null 才是无默认值,不做归一。
    defaultValue: c.default_value ?? '',
    noDefault: c.default_value === null,
    comment: c.comment,
    autoIncrement: /auto_increment/i.test(c.extra),
    isPrimaryKey: c.is_primary_key,
    isNew: false,
    toDrop: false,
    dirty: false,
    after: null,
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await getApi().mysqlTableColumns?.({
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
    })
    const cols = res?.columns ?? []
    rows.value = cols.map(toRow)
    originals.value = new Map(cols.map((c) => [c.name, c]))
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
  addForm.value = { name: '', columnType: '', nullable: true, defaultValue: '', noDefault: true, comment: '', autoIncrement: false, after: '' }
}

function confirmAdd(): void {
  const f = addForm.value
  if (!f || !f.name.trim() || !f.columnType.trim()) return
  rows.value.push({
    name: f.name.trim(),
    columnType: f.columnType.trim(),
    nullable: f.nullable,
    defaultValue: f.defaultValue,
    noDefault: f.noDefault,
    comment: f.comment,
    autoIncrement: f.autoIncrement,
    isPrimaryKey: false,
    isNew: true,
    toDrop: false,
    dirty: false,
    after: f.after || null,
  })
  addForm.value = null
}

// removeRow:主键列直接不响应(按钮已禁用,此处双保险,主键请用 DDL 调整);
// 已有列标记为将 DROP(可撤销);本次新增行直接移除。
function removeRow(row: ColumnRow): void {
  if (row.isPrimaryKey) return
  if (row.isNew) {
    rows.value = rows.value.filter((r) => r !== row)
  } else {
    row.toDrop = !row.toDrop
  }
}

// 默认值三态:勾选「无默认值」= DEFAULT NULL;否则输入框原文(含空串)即字面量,
// 与原始值直接比较,'' 与 null 语义不同。
function effectiveDefault(noDefault: boolean, text: string): string | null {
  return noDefault ? null : text
}

const addColumns = computed<MysqlColumnDef[]>(() =>
  rows.value
    .filter((r) => r.isNew)
    .map((r) => ({
      name: r.name,
      column_type: r.columnType,
      nullable: r.nullable,
      default_value: effectiveDefault(r.noDefault, r.defaultValue),
      comment: r.comment,
      auto_increment: r.autoIncrement,
      after: r.after,
    })),
)

const modifyColumns = computed<MysqlColumnDef[]>(() => {
  const out: MysqlColumnDef[] = []
  for (const r of rows.value) {
    if (r.isNew || r.toDrop || r.isPrimaryKey) continue
    // 行级 dirty:仅用户真实编辑过的行才参与 diff,零编辑保存不产生 modify。
    if (!r.dirty) continue
    const orig = originals.value.get(r.name)
    if (!orig) continue
    const def = effectiveDefault(r.noDefault, r.defaultValue)
    // 原始值直接比较,不归一:information_schema 的 DEFAULT '' 与 DEFAULT NULL 是两种定义。
    const changed =
      r.columnType !== orig.column_type ||
      r.nullable !== orig.nullable ||
      def !== orig.default_value ||
      r.comment !== orig.comment
    if (!changed) continue
    // 修改列不允许改列名,after 不生效(契约:仅新增列)。
    out.push({
      name: r.name,
      column_type: r.columnType,
      nullable: r.nullable,
      default_value: def,
      comment: r.comment,
      auto_increment: r.autoIncrement,
      after: null,
    })
  }
  return out
})

const dropColumns = computed(() => rows.value.filter((r) => !r.isNew && r.toDrop).map((r) => r.name))

const hasChanges = computed(() => addColumns.value.length > 0 || modifyColumns.value.length > 0 || dropColumns.value.length > 0)

async function save(): Promise<void> {
  if (!hasChanges.value || saving.value) return
  saving.value = true
  saveError.value = ''
  savedTip.value = false
  try {
    await getApi().mysqlAlterTable?.({
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
    <div v-if="show" class="ms-backdrop" data-test="mysql-structure-dialog" @click.self="close">
      <div class="ms-modal">
        <div class="ms-header">
          <span class="ms-title">编辑表字段</span>
          <span class="ms-table" :title="`${database}.${table}`">{{ database }}.{{ table }}</span>
          <button class="ms-close" type="button" data-test="btn-structure-close" @click="close">✕</button>
        </div>

        <div v-if="loading" class="ms-hint" data-test="structure-loading">加载中…</div>
        <div v-else-if="loadError" class="ms-error" data-test="structure-load-error">
          <span>{{ loadError }}</span>
          <button class="btn ghost" type="button" data-test="btn-structure-retry" @click="load">重试</button>
        </div>
        <template v-else>
          <div class="ms-toolbar">
            <button class="btn ghost" type="button" data-test="btn-add-column" @click="openAddForm">＋ 新增列</button>
            <span class="ms-note">主键列只读,主键请用 DDL 调整;修改列不支持改名。默认值留空时请按需选择:勾选 NULL = 无默认值(NULL),取消勾选后留空 = 空字符串('')。</span>
          </div>

          <!-- 新增列表单:确认后作为一行未保存列进入表格。 -->
          <div v-if="addForm" class="ms-add-form" data-test="structure-add-form">
            <input v-model="addForm.name" class="input" type="text" placeholder="列名" data-test="add-name" />
            <input v-model="addForm.columnType" class="input" type="text" placeholder="类型,如 varchar(64)" data-test="add-type" />
            <input v-model="addForm.defaultValue" class="input" type="text" placeholder="默认值" :disabled="addForm.noDefault" data-test="add-default" />
            <label class="ms-check" title="勾选 = 无默认值(NULL);取消勾选后留空 = 空字符串('')">
              <input v-model="addForm.noDefault" type="checkbox" data-test="add-no-default" />无默认值
            </label>
            <input v-model="addForm.comment" class="input" type="text" placeholder="注释" data-test="add-comment" />
            <label class="ms-select">
              位置
              <select v-model="addForm.after" class="input" data-test="add-after">
                <option value="">(表尾)</option>
                <option v-for="n in existingNames" :key="n" :value="n">AFTER {{ n }}</option>
              </select>
            </label>
            <label class="ms-check"><input v-model="addForm.nullable" type="checkbox" data-test="add-nullable" />可空</label>
            <label class="ms-check"><input v-model="addForm.autoIncrement" type="checkbox" data-test="add-auto-increment" />自增</label>
            <button class="btn primary" type="button" data-test="btn-confirm-add-column" :disabled="!addForm.name.trim() || !addForm.columnType.trim()" @click="confirmAdd">添加</button>
            <button class="btn ghost" type="button" data-test="btn-cancel-add-column" @click="addForm = null">取消</button>
          </div>

          <div class="ms-table-wrap">
            <table class="ms-grid">
              <thead>
                <tr>
                  <th>列名</th>
                  <th>类型</th>
                  <th>可空</th>
                  <th>默认值</th>
                  <th>注释</th>
                  <th>自增</th>
                  <th>主键</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in rows"
                  :key="`${row.isNew ? 'new:' : ''}${row.name}`"
                  :class="{ 'row-drop': row.toDrop, 'row-new': row.isNew }"
                  data-test="structure-column-row"
                >
                  <td>
                    <input v-if="row.isNew" v-model="row.name" class="input cell" type="text" data-test="column-name" />
                    <template v-else><span data-test="column-name">{{ row.name }}</span></template>
                  </td>
                  <td><input v-model="row.columnType" class="input cell" type="text" :disabled="!row.isNew && row.isPrimaryKey" data-test="column-type" @input="row.dirty = true" /></td>
                  <td><input v-model="row.nullable" type="checkbox" :disabled="(!row.isNew && row.isPrimaryKey) || row.toDrop" data-test="column-nullable" @change="row.dirty = true" /></td>
                  <td>
                    <div class="ms-default">
                      <input
                        v-model="row.defaultValue"
                        class="input cell"
                        type="text"
                        :placeholder="row.noDefault ? 'NULL' : '(留空 = 空字符串)'"
                        :disabled="(!row.isNew && row.isPrimaryKey) || row.toDrop || row.noDefault"
                        data-test="column-default"
                        @input="row.dirty = true"
                      />
                      <label class="ms-check ms-check-cell" title="勾选 = 无默认值(NULL);取消勾选后输入框留空 = 空字符串('')">
                        <input
                          v-model="row.noDefault"
                          type="checkbox"
                          :disabled="(!row.isNew && row.isPrimaryKey) || row.toDrop"
                          data-test="column-no-default"
                          @change="row.dirty = true"
                        />NULL
                      </label>
                    </div>
                  </td>
                  <td><input v-model="row.comment" class="input cell" type="text" :disabled="(!row.isNew && row.isPrimaryKey) || row.toDrop" data-test="column-comment" @input="row.dirty = true" /></td>
                  <td><input v-model="row.autoIncrement" type="checkbox" :disabled="!row.isNew" data-test="column-auto-increment" /></td>
                  <td><span v-if="row.isPrimaryKey" class="ms-pk" title="主键列">🔑</span></td>
                  <td>
                    <button v-if="!row.isNew" class="ms-drop" type="button" data-test="btn-drop-column" :disabled="row.isPrimaryKey" :title="row.isPrimaryKey ? '主键列不支持在此删除' : undefined" @click="removeRow(row)">
                      {{ row.toDrop ? '撤销' : '移除' }}
                    </button>
                    <button v-else class="ms-drop" type="button" data-test="btn-remove-new-column" @click="removeRow(row)">移除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="saveError" class="ms-error" data-test="structure-save-error">{{ saveError }}</div>
          <div v-if="savedTip" class="ms-saved" data-test="structure-saved">表结构已更新</div>

          <div class="ms-actions">
            <button class="btn ghost" type="button" data-test="btn-toggle-ddl" @click="showDdl = !showDdl">查看 DDL</button>
            <span class="ms-flex"></span>
            <button class="btn primary" type="button" data-test="btn-structure-save" :disabled="!hasChanges || saving" @click="save">
              {{ saving ? '保存中…' : '保存修改' }}
            </button>
          </div>
          <pre v-if="showDdl" class="ms-ddl" data-test="structure-ddl">{{ ddl || '(无 DDL)' }}</pre>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ms-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.ms-modal {
  width: min(880px, calc(100vw - 64px));
  max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  padding: 16px; gap: 10px; overflow: hidden;
}
.ms-header { display: flex; align-items: center; gap: 8px; }
.ms-title { font-size: 14px; font-weight: 600; }
.ms-table { font-size: 12px; color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 6px; }
.ms-close:hover { color: var(--text); background: var(--bg-hover); }
.ms-toolbar { display: flex; align-items: center; gap: 10px; }
.ms-note { font-size: 11px; color: var(--text-tertiary); }
.ms-add-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-subtle); }
.ms-add-form .input { width: 130px; }
.ms-select { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--text-secondary); }
.ms-select .input { width: 150px; }
.ms-check { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--text-secondary); }
.ms-table-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 8px; max-height: 45vh; }
.ms-grid { width: 100%; border-collapse: collapse; font-size: 12px; }
.ms-grid th { text-align: left; padding: 6px 8px; color: var(--text-tertiary); font-weight: 500; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg-elevated); white-space: nowrap; }
.ms-grid td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ms-grid tr:last-child td { border-bottom: none; }
.input.cell { padding: 3px 7px; font-size: 12px; }
.input.cell:disabled { opacity: 0.55; cursor: not-allowed; }
.ms-default { display: flex; align-items: center; gap: 5px; }
.ms-default .input.cell { flex: 1; min-width: 0; width: auto; }
.ms-check-cell { white-space: nowrap; font-size: 10px; color: var(--text-tertiary); }
.row-drop { opacity: 0.55; }
.row-drop td:first-child { text-decoration: line-through; }
.row-new td { background: var(--accent-soft); }
.ms-pk { cursor: default; }
.ms-drop { background: none; border: 1px solid var(--border-strong); color: var(--text-secondary); font-size: 11px; border-radius: 6px; padding: 1px 8px; cursor: pointer; }
.ms-drop:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.ms-drop:disabled { opacity: 0.5; cursor: not-allowed; }
.ms-hint { color: var(--text-secondary); font-size: 12px; padding: 12px 0; }
.ms-error { color: var(--danger); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.ms-saved { color: var(--ok); font-size: 12px; }
.ms-actions { display: flex; align-items: center; gap: 8px; }
.ms-flex { flex: 1; }
.ms-ddl {
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
