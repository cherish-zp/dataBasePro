<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { getApi } from '@/api/client'
import type { AuditEntry } from '@/api/types'
import { formatTime } from '@/utils/format'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const THEME_KEY = 'dbclient-theme'
const theme = ref<'dark' | 'light'>(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light')

const AUDIT_LIMIT = 200
const audit = ref<AuditEntry[]>([])
const auditLoading = ref(false)
const auditError = ref<string | null>(null)

// ACTION_LABELS maps the backend audit action codes to Chinese labels; unknown
// actions fall back to their raw code so the trail stays readable.
const ACTION_LABELS: Record<string, string> = {
  create_connection: '新建连接',
  delete_connection: '删除连接',
  create_topic: '新建 Topic',
  delete_topic: '删除 Topic',
  delete_topics: '批量删除 Topic',
  delete_consumer_group: '删除消费组',
  alter_topic_config: '修改 Topic 配置',
  reset_group_offset: '重置消费组位移',
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

function apply(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem(THEME_KEY, theme)
}

function changeTheme(): void {
  apply(theme.value)
}

// loadAudit fetches the most recent operation audit trail. Failures surface in
// an error banner rather than silently hiding the section.
async function loadAudit(): Promise<void> {
  auditLoading.value = true
  auditError.value = null
  try {
    audit.value = await getApi().listAudit(AUDIT_LIMIT)
  } catch (e) {
    audit.value = []
    auditError.value = e instanceof Error ? e.message : String(e)
  } finally {
    auditLoading.value = false
  }
}

onMounted(() => {
  apply(theme.value)
  if (props.show) void loadAudit()
})

// Load the audit trail whenever the settings modal is opened so it reflects
// any operations performed since the last visit.
watch(
  () => props.show,
  (visible) => {
    if (visible) void loadAudit()
  },
)

function close(): void {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="modal-backdrop" data-test="settings-panel" @click.self="close">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">设置</span>
        <button class="modal-close" type="button" data-test="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">主题</label>
          <select v-model="theme" data-test="select-theme" class="input" @change="changeTheme">
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>
        <div class="info">
          <div class="info-row"><span class="info-label">数据目录</span><span class="info-value mono">~/.db-client/config.db</span></div>
          <div class="info-row"><span class="info-label">客户端</span><span class="info-value">Go + Wails + Vue 3</span></div>
          <div class="info-row"><span class="info-label">版本</span><span class="info-value">0.1.0</span></div>
        </div>

        <div class="audit-section">
          <div class="audit-header">
            <span class="audit-title">操作审计</span>
            <button class="audit-refresh" type="button" data-test="audit-refresh" @click="loadAudit">刷新</button>
          </div>
          <div v-if="auditLoading" class="audit-state" data-test="audit-loading">加载中…</div>
          <div v-else-if="auditError" class="audit-state err" data-test="audit-error">{{ auditError }}</div>
          <div v-else-if="audit.length === 0" class="audit-state" data-test="audit-empty">暂无操作记录</div>
          <table v-else class="audit-table" data-test="audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>对象</th>
                <th>结果</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in audit" :key="e.id ?? e.timestamp" class="audit-row" data-test="audit-row">
                <td class="mono" data-test="audit-time">{{ formatTime(e.timestamp) }}</td>
                <td>{{ actionLabel(e.action) }}</td>
                <td class="mono">{{ e.target }}</td>
                <td :class="e.result === 'ok' ? 'result-ok' : 'result-err'">{{ e.result === 'ok' ? '成功' : '失败' }}</td>
                <td class="detail">{{ e.detail || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center; z-index: 900;
}
.modal {
  width: 680px; max-width: 94vw; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  color: var(--text); font-family: var(--font);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.modal-title { font-weight: 600; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 6px; padding: 1px 6px; }
.modal-close:hover { background: var(--bg-hover); color: var(--text); }
.modal-body { padding: 16px 18px; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.input { background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 8px 10px; font-size: 13px; width: 100%; box-sizing: border-box; transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.info { border-top: 1px solid var(--border); padding-top: 12px; }
.info-row { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; }
.info-label { color: var(--text-secondary); }
.info-value { color: var(--text); }
.mono { font-family: var(--mono); }

.audit-section { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
.audit-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.audit-title { font-weight: 600; font-size: 13px; }
.audit-refresh { background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text-secondary); font-size: 12px; border-radius: 6px; padding: 3px 10px; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
.audit-refresh:hover { border-color: var(--accent); color: var(--text); }
.audit-state { color: var(--text-secondary); font-size: 12px; padding: 8px 0; }
.audit-state.err { color: var(--danger); }
.audit-table { width: 100%; border-collapse: collapse; font-size: 12px; max-height: 300px; overflow-y: auto; display: block; }
.audit-table th { position: sticky; top: 0; background: var(--bg-elevated); text-align: left; font-weight: 600; color: var(--text-secondary); padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.audit-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: top; white-space: nowrap; }
.audit-table td.detail { white-space: normal; min-width: 120px; word-break: break-all; }
.audit-table tr:last-child td { border-bottom: none; }
.audit-table tr:hover td { background: var(--bg-hover); }
.result-ok { color: var(--ok); }
.result-err { color: var(--danger); }
</style>
