<script lang="ts">
// 激活的 SQL 控制台(Kafka 或 ClickHouse)暴露给 SQL文件面板的操作集合。
// 面板只负责触发:确认弹窗与保存/删除逻辑都由控制台内部实现。
export interface SqlConsoleApi {
  requestSave(): void // 保存(未关联文件→弹名称;已关联→覆盖)
  requestSaveAs(): void // 另存为
  loadQueryFile(name: string): void // 载入(组件内部处理未保存确认)
  askRemoveCurrentFile(): void // 删除当前关联文件(内部弹确认)
  currentFile(): string | null // 当前关联文件名(含 .sql)
}
</script>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getApi } from '@/api/client'
import type { Connection, ConnectionType } from '@/api/types'
import { useQueryFiles } from '@/composables/queryFiles'

const props = defineProps<{ consoleApi: SqlConsoleApi | null }>()

// 点击条目统一上报 open(由 Layout 按文件归属自动打开/切换 SQL 控制台并载入,
// 无控制台也不例外);面板自身不决定能否打开。
const emit = defineEmits<{
  (e: 'open', name: string, connectionId: string): void
}>()
// 列表-only 用法:面板只消费共享 files/fileError,不需要 getContent/setContent。
const { files, fileError, refreshFiles } = useQueryFiles({ connectionId: () => '' })

// 连接 id → 「类型 · 名称」归属:条目上直观显示 SQL 文件属于哪个数据源。
const connections = ref<Connection[]>([])

const TYPE_LABELS: Record<ConnectionType, string> = {
  kafka: 'Kafka',
  mysql: 'MySQL',
  tidb: 'TiDB',
  es: 'ES',
  redis: 'Redis',
  clickhouse: 'ClickHouse',
}

async function loadConnections(): Promise<void> {
  try {
    connections.value = await getApi().listConnections()
  } catch {
    connections.value = []
  }
}

function connLabel(connectionId: string): string {
  if (!connectionId) return '未关联连接'
  const c = connections.value.find((x) => x.id === connectionId)
  return c ? `${TYPE_LABELS[c.type] ?? c.type} · ${c.name}` : '未知连接'
}

onMounted(() => {
  void refreshFiles()
  void loadConnections()
})

// 暴露给 Layout:面板展开(含首次展开)时主动刷新文件列表与连接列表。
// 连接列表也必须重拉,否则面板常开期间新建的连接解析不出归属(未知连接)。
function refresh(): void {
  void refreshFiles()
  void loadConnections()
}
defineExpose({ refresh })

function onItemSelect(name: string, connectionId: string): void {
  emit('open', name, connectionId)
}

function onSave(): void {
  props.consoleApi?.requestSave()
}

function onSaveAs(): void {
  props.consoleApi?.requestSaveAs()
}

function onDelete(): void {
  props.consoleApi?.askRemoveCurrentFile()
}
</script>

<template>
  <div class="files-panel" data-test="files-panel">
    <div class="panel-head">SQL文件</div>

    <div class="toolbar">
      <button class="tool-btn" type="button" data-test="files-save" :disabled="!consoleApi" @click="onSave">
        保存
      </button>
      <button class="tool-btn" type="button" data-test="files-save-as" :disabled="!consoleApi" @click="onSaveAs">
        另存为
      </button>
      <button
        class="tool-btn"
        type="button"
        data-test="files-file-delete"
        :disabled="!consoleApi"
        @click="onDelete"
      >
        删除
      </button>
    </div>

    <div v-if="fileError" class="error" data-test="files-error">{{ fileError }}</div>

    <div class="list">
      <button
        v-for="(f, i) in files"
        :key="f.name"
        class="file-item"
        :class="{ active: consoleApi?.currentFile() === f.name }"
        type="button"
        :data-test="`files-item-${i}`"
        :title="connLabel(f.connection_id)"
        @click="onItemSelect(f.name, f.connection_id)"
      >
        <span class="file-name">{{ f.name }}</span>
        <span class="file-meta" :data-test="`files-meta-${i}`">{{ connLabel(f.connection_id) }}</span>
      </button>
      <div v-if="!files.length" class="empty" data-test="files-empty">暂无查询文件</div>
    </div>
  </div>
</template>

<style scoped>
.files-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 13px;
}
.panel-head {
  padding: 10px 12px 6px;
  font-weight: 600;
  color: var(--text);
}
.toolbar {
  display: flex;
  gap: 6px;
  padding: 0 12px 8px;
}
.tool-btn {
  flex: 1;
  padding: 4px 0;
  font-size: 12px;
  font-family: var(--font);
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.tool-btn:hover:not(:disabled) { background: var(--bg-hover); }
.tool-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.error {
  margin: 0 12px 8px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 6px;
  word-break: break-all;
}
.hint {
  margin: 0 12px 8px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-radius: 6px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px 10px;
}
.file-item {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: var(--font);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease;
}
.file-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-meta {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-item:hover { background: var(--bg-hover); color: var(--text); }
.file-item:hover .file-meta { color: var(--text-secondary); }
.file-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
}
.file-item.active .file-meta { color: var(--accent); opacity: 0.75; }
.empty {
  padding: 14px 8px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
}
</style>
