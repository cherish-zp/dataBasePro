<script setup lang="ts">
// MySQL/TiDB 表导出选项弹窗(两种数据源共用):选择导出内容(DDL/数据)、
// 附加选项(建库语句/DROP TABLE/省略 AUTO_INCREMENT)、INSERT 格式与数据行数
// 上限,确认后才真正调用 mysqlExportTable 并经 saveFile 存盘。
// checkbox/radio 选择持久化到 localStorage(data_limit 不持久化)。
import { computed, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { MysqlExportTableRequest } from '@/api/types'
import { saveFile } from '@/utils/export'
import { useToastStore } from '@/store/toast'

const props = defineProps<{ show: boolean; connectionId: string; database: string; table: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// SQL_MIME 是导出 .sql 文件使用的 MIME;保存走后端原生对话框,文件名自带 .sql。
const SQL_MIME = 'application/sql'

// 选项持久化:仅记住勾选状态,行数上限是一次性输入不记忆。
const STORAGE_KEY = 'dbclient-mysql-export-options'
interface PersistedOptions {
  include_ddl: boolean
  include_data: boolean
  insert_per_row: boolean
  drop_table_if_exists: boolean
  strip_auto_increment: boolean
  include_create_db: boolean
}
const DEFAULT_OPTIONS: PersistedOptions = {
  include_ddl: true,
  include_data: true,
  insert_per_row: false,
  drop_table_if_exists: false,
  strip_auto_increment: false,
  include_create_db: false,
}

const includeDdl = ref(DEFAULT_OPTIONS.include_ddl)
const includeData = ref(DEFAULT_OPTIONS.include_data)
const insertPerRow = ref(DEFAULT_OPTIONS.insert_per_row)
const dropIfExists = ref(DEFAULT_OPTIONS.drop_table_if_exists)
const stripAutoIncrement = ref(DEFAULT_OPTIONS.strip_auto_increment)
const includeCreateDb = ref(DEFAULT_OPTIONS.include_create_db)
const dataLimitInput = ref('')
const busy = ref(false)
const errorMsg = ref('')

// loadOptions 读取上次选择;JSON 损坏/字段缺失时逐项回落默认值。
function loadOptions(): void {
  const opts = { ...DEFAULT_OPTIONS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedOptions>
      for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof PersistedOptions)[]) {
        if (typeof parsed[key] === 'boolean') opts[key] = parsed[key]
      }
    }
  } catch {
    // 解析失败用默认值,不影响打开弹窗。
  }
  includeDdl.value = opts.include_ddl
  includeData.value = opts.include_data
  insertPerRow.value = opts.insert_per_row
  dropIfExists.value = opts.drop_table_if_exists
  stripAutoIncrement.value = opts.strip_auto_increment
  includeCreateDb.value = opts.include_create_db
}

function persistOptions(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        include_ddl: includeDdl.value,
        include_data: includeData.value,
        insert_per_row: insertPerRow.value,
        drop_table_if_exists: dropIfExists.value,
        strip_auto_increment: stripAutoIncrement.value,
        include_create_db: includeCreateDb.value,
      } satisfies PersistedOptions),
    )
  } catch {
    // 持久化失败不影响导出流程。
  }
}

// 每次打开都重置为持久化状态;行数上限与错误不残留上次会话。
watch(
  () => props.show,
  (show) => {
    if (show) {
      errorMsg.value = ''
      dataLimitInput.value = ''
      busy.value = false
      loadOptions()
    }
  },
  { immediate: true },
)

// dataLimitInput 合法性:留空 = 不限制;非空必须是 ≥ 0 的整数(后端字段为
// int,小数会被 JSON 反序列化拒绝),非法禁用导出。
// v-model 在 type=number 输入上会把值转成 number,这里统一转回字符串再解析。
const parsedDataLimit = computed<number | null>(() => {
  const text = String(dataLimitInput.value ?? '').trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN
})
const dataLimitInvalid = computed(() => Number.isNaN(parsedDataLimit.value))
const canExport = computed(() => (includeDdl.value || includeData.value) && !dataLimitInvalid.value)

function tryClose(): void {
  // busy 中不允许关闭,防止导出在途时弹窗状态丢失造成重复触发。
  if (busy.value) return
  emit('close')
}

async function doExport(): Promise<void> {
  if (busy.value || !canExport.value) return
  busy.value = true
  errorMsg.value = ''
  // 「成功发起」即记录本次选择,下次打开预填。
  persistOptions()
  try {
    try {
      useToastStore().show(`正在导出表 ${props.database}.${props.table}（大表可能需要一些时间）…`)
    } catch {
      // pinia 未激活时忽略提示,不能中断导出流程
    }
    const req: MysqlExportTableRequest = {
      connection_id: props.connectionId,
      database: props.database,
      table: props.table,
      include_ddl: includeDdl.value,
      include_data: includeData.value,
      insert_per_row: insertPerRow.value,
      drop_table_if_exists: dropIfExists.value,
      strip_auto_increment: stripAutoIncrement.value,
      include_create_db: includeCreateDb.value,
    }
    const limit = parsedDataLimit.value
    if (limit !== null) req.data_limit = limit
    const result = await getApi().mysqlExportTable?.(req)
    if (result) await saveFile(result.filename, result.content, SQL_MIME)
    emit('close')
  } catch (e) {
    // 失败错误留在弹窗内,可修改选项后重试。
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="me-backdrop" data-test="mysql-export-dialog" @click.self="tryClose">
      <div class="me-modal">
        <div class="me-header">
          <span class="me-title">导出表</span>
          <span class="me-sub" :title="`${database}.${table}`">{{ database }}.{{ table }}</span>
          <button class="me-close" type="button" data-test="btn-export-close" :disabled="busy" @click="tryClose">✕</button>
        </div>

        <div class="me-group">
          <div class="me-group-title">导出内容</div>
          <label class="me-check"><input v-model="includeDdl" type="checkbox" data-test="export-opt-ddl" :disabled="busy" />表结构 (DDL)</label>
          <label class="me-check"><input v-model="includeData" type="checkbox" data-test="export-opt-data" :disabled="busy" />表数据 (INSERT)</label>
        </div>

        <div class="me-group">
          <div class="me-group-title">选项</div>
          <label class="me-check"><input v-model="includeCreateDb" type="checkbox" data-test="export-opt-create-db" :disabled="busy" />导出建库语句（CREATE DATABASE / USE）</label>
          <label class="me-check"><input v-model="dropIfExists" type="checkbox" data-test="export-opt-drop" :disabled="busy" />导出前添加 DROP TABLE IF EXISTS</label>
          <label class="me-check"><input v-model="stripAutoIncrement" type="checkbox" data-test="export-opt-strip-auto-increment" :disabled="busy" />省略 AUTO_INCREMENT 计数</label>
        </div>

        <div class="me-group">
          <div class="me-group-title">INSERT 格式</div>
          <label class="me-check"><input v-model="insertPerRow" type="radio" name="mysql-insert-format" :value="false" data-test="export-opt-insert-multi" :disabled="busy" />多行合并（每 100 行一条，文件更小）</label>
          <label class="me-check"><input v-model="insertPerRow" type="radio" name="mysql-insert-format" :value="true" data-test="export-opt-insert-per-row" :disabled="busy" />每行一条 INSERT（文件更大、可单条重放）</label>
        </div>

        <div class="me-group">
          <div class="me-group-title">数据行数上限</div>
          <input v-model="dataLimitInput" class="input me-limit" type="number" min="0" step="1" placeholder="留空 = 不限制" data-test="export-opt-data-limit" :disabled="busy" />
          <div v-if="dataLimitInvalid" class="me-limit-error">数据行数上限需为不小于 0 的数字，或留空表示不限制</div>
        </div>

        <div v-if="errorMsg" class="me-error" data-test="export-error">{{ errorMsg }}</div>

        <div class="me-actions">
          <span class="me-flex"></span>
          <button class="btn ghost" type="button" data-test="btn-export-cancel" :disabled="busy" @click="tryClose">取消</button>
          <button class="btn primary" type="button" data-test="btn-export-confirm" :disabled="!canExport || busy" @click="doExport">
            {{ busy ? '导出中…' : '导出' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.me-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.32);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.me-modal {
  width: min(420px, calc(100vw - 64px));
  max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  padding: 16px; gap: 12px; overflow: auto;
}
.me-header { display: flex; align-items: center; gap: 8px; }
.me-title { font-size: 14px; font-weight: 600; }
.me-sub { font-size: 12px; color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 6px; }
.me-close:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
.me-close:disabled { opacity: 0.5; cursor: not-allowed; }
.me-group { display: flex; flex-direction: column; gap: 6px; }
.me-group-title { font-size: 11px; color: var(--text-tertiary); font-weight: 600; }
.me-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; }
.me-check input { cursor: pointer; }
.me-check input:disabled { cursor: not-allowed; }
.me-limit { width: 160px; }
.me-limit-error { font-size: 11px; color: var(--danger); }
.me-error { color: var(--danger); font-size: 12px; }
.me-actions { display: flex; align-items: center; gap: 8px; }
.me-flex { flex: 1; }
.btn { border-radius: 7px; padding: 4px 12px; font-size: 12px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
