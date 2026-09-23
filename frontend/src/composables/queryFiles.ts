// SQL 查询文件全局化:控制台编辑器里的 SQL 以 .sql 文件保存到查询目录
// (getQueryDir(),可在设置页配置)。文件列表为模块级共享,所有消费者
// (各 SQL 控制台、右侧文件面板)看到同一份;其余状态每个实例独立。
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import * as App from '../../wailsjs/go/backend/App'
import { store } from '../../wailsjs/go/models'
import { getQueryDir, withSqlExt } from '@/utils/queryDir'
import { useToastStore } from '@/store/toast'

// 查询文件条目类型(wailsjs 生成模型的别名,供组件层复用)。
export type QueryFileInfo = store.QueryFileInfo

export interface QueryFilesOptions {
  connectionId: () => string
  getContent?: () => string // 列表-only 消费者(右侧面板)可不传
  setContent?: (s: string) => void
  // 当前库(可选):提供后保存 payload 携带 database,由后端写入文件头;
  // 未提供时 payload 不带该字段(CH/Kafka 控制台零影响)。
  getDatabase?: () => string
  // 载入文件后回传文件头记录的库;空串也回调,表示文件未关联库(由
  // 消费者自行决定是否恢复,例如 MySQL 控制台空串保持当前库不动)。
  setDatabase?: (db: string) => void
  // PG 控制台:保存把当前 schema 写入文件头;载入按文件头回传(空串 =
  // 文件未关联 schema,消费者保持当前 schema 不动)。
  getSchema?: () => string
  setSchema?: (schema: string) => void
}

// 模块级共享:所有 useQueryFiles 消费者共用同一份文件列表(新→旧)。
const files = ref<QueryFileInfo[]>([])

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function useQueryFiles(opts: QueryFilesOptions): {
  files: Ref<QueryFileInfo[]>
  fileError: Ref<string | null>
  currentFile: Ref<string | null>
  refreshFiles(): Promise<void>
  loadQueryFile(name: string): Promise<void>
  saveToFile(name: string): Promise<void>
  requestSave(): void
  requestSaveAs(): void
  confirmName(name: string): void
  askRemoveCurrentFile(): void
  removeCurrentFile(): Promise<void>
  nameDialog: { open: Ref<boolean>; mode: Ref<'save' | 'save-as'>; cancel(): void }
  overwriteConfirm: { open: Ref<boolean>; target: Ref<string>; confirm(): void; cancel(): void }
  deleteConfirm: { open: Ref<boolean>; message: ComputedRef<string>; confirm(): void; cancel(): void }
} {
  const fileError = ref<string | null>(null)
  const currentFile = ref<string | null>(null)

  const nameOpen = ref(false)
  const nameMode = ref<'save' | 'save-as'>('save')
  const overwriteOpen = ref(false)
  const overwriteTarget = ref('')
  const deleteOpen = ref(false)

  async function refreshFiles(): Promise<void> {
    try {
      files.value = await App.ListQueryFiles({ dir: getQueryDir() })
      fileError.value = null
    } catch (e) {
      fileError.value = toErrorMessage(e)
    }
  }

  async function loadQueryFile(name: string): Promise<void> {
    const target = withSqlExt(name)
    try {
      const res = await App.ReadQueryFile({ dir: getQueryDir(), name: target })
      // 响应已扩展 database 字段(文件头记录的库);绑定模型待 wails generate
      // 对齐,这里按契约形状读取,旧后端缺省时视为未关联库。
      const { content, database, schema } = res as unknown as { content: string; database?: string; schema?: string }
      opts.setContent?.(content)
      opts.setDatabase?.(database ?? '')
      opts.setSchema?.(schema ?? '')
      currentFile.value = target
      fileError.value = null
    } catch (e) {
      fileError.value = toErrorMessage(e)
    }
  }

  async function saveToFile(name: string): Promise<void> {
    const target = withSqlExt(name)
    try {
      const payload: {
        dir: string
        name: string
        content: string
        connection_id?: string
        database?: string
        schema?: string
      } = {
        dir: getQueryDir(),
        name: target,
        content: opts.getContent?.() ?? '',
        connection_id: opts.connectionId(),
      }
      if (opts.getDatabase) payload.database = opts.getDatabase()
      if (opts.getSchema) payload.schema = opts.getSchema()
      // QueryFileWriteRequest 绑定模型尚未含 database,待 wails generate 后对齐。
      await App.WriteQueryFile(payload as unknown as Parameters<typeof App.WriteQueryFile>[0])
      currentFile.value = target
      fileError.value = null
      await refreshFiles()
      try {
        useToastStore().show(`已保存到 SQL文件:${target}`)
      } catch {
        // pinia 未激活时忽略提示,不能中断保存流程
      }
    } catch (e) {
      fileError.value = toErrorMessage(e)
    }
  }

  // 已关联文件直接覆盖保存;否则打开名称弹窗(mode='save')。
  function requestSave(): void {
    if (currentFile.value) {
      void saveToFile(currentFile.value)
      return
    }
    nameMode.value = 'save'
    nameOpen.value = true
  }

  // 强制打开名称弹窗(另存为)。
  function requestSaveAs(): void {
    nameMode.value = 'save-as'
    nameOpen.value = true
  }

  // 名称弹窗确认:目标名(规范化后)已存在且 ≠ 当前文件时打开覆盖确认,
  // 否则直接保存。脏检查等确认逻辑由组件层在打开弹窗前处理。
  function confirmName(name: string): void {
    nameOpen.value = false
    const target = withSqlExt(name)
    const exists = files.value.some((f) => f.name === target)
    if (exists && target !== currentFile.value) {
      overwriteTarget.value = target
      overwriteOpen.value = true
      return
    }
    void saveToFile(target)
  }

  // 仅在已关联文件时打开删除确认。
  function askRemoveCurrentFile(): void {
    if (!currentFile.value) return
    deleteOpen.value = true
  }

  async function removeCurrentFile(): Promise<void> {
    if (!currentFile.value) return
    const target = currentFile.value
    try {
      await App.DeleteQueryFile({ dir: getQueryDir(), name: target })
      currentFile.value = null
      opts.setContent?.('')
      fileError.value = null
      await refreshFiles()
    } catch (e) {
      fileError.value = toErrorMessage(e)
    }
  }

  const nameDialog = {
    open: nameOpen,
    mode: nameMode,
    cancel(): void {
      nameOpen.value = false
    },
  }

  const overwriteConfirm = {
    open: overwriteOpen,
    target: overwriteTarget,
    confirm(): void {
      overwriteOpen.value = false
      if (overwriteTarget.value !== '') void saveToFile(overwriteTarget.value)
    },
    cancel(): void {
      overwriteOpen.value = false
    },
  }

  const deleteConfirm = {
    open: deleteOpen,
    message: computed(() =>
      currentFile.value ? `确定删除 SQL 文件「${currentFile.value}」吗?该操作不可恢复。` : '',
    ),
    confirm(): void {
      deleteOpen.value = false
      void removeCurrentFile()
    },
    cancel(): void {
      deleteOpen.value = false
    },
  }

  return {
    files,
    fileError,
    currentFile,
    refreshFiles,
    loadQueryFile,
    saveToFile,
    requestSave,
    requestSaveAs,
    confirmName,
    askRemoveCurrentFile,
    removeCurrentFile,
    nameDialog,
    overwriteConfirm,
    deleteConfirm,
  }
}
