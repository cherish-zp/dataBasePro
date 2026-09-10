// CH 单元格更新流程状态机:预览(后端生成 UPDATE 语句 + 匹配行数)
// → 确认弹窗 → 执行。状态每个实例独立;消费方(如 CH 数据网格)按契约:
// await request(target) → 模板依据 confirmOpen 渲染 ConfirmDialog(message
// 展示 statement 全文 + 匹配行数,>1 警示)→ confirm() / cancel()。
import { ref } from 'vue'
import type { Ref } from 'vue'
import * as App from '../../wailsjs/go/backend/App'

export interface CHCellRef {
  column: string
  type: string
  value: string | null
}

export interface CHCellUpdateTarget {
  connection_id: string
  database: string // '' = 连接默认库
  table: string
  set: CHCellRef // 目标列 + 新值(null = 写 NULL)
  where: CHCellRef[] // 行定位(主键列或整行原值)
}

// CHPreviewCellUpdate / CHUpdateCell 绑定尚未由 wails generate module 生成,
// 这里按显式形状断言调用(req 为 CHCellUpdateTarget 原样,Wails 按字段名
// 序列化,snake_case 已对齐);生成后签名一致,无需改动本文件。
const api = App as unknown as {
  CHPreviewCellUpdate(req: CHCellUpdateTarget): Promise<{ statement: string; matched_rows: number }>
  CHUpdateCell(req: CHCellUpdateTarget): Promise<void>
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function useCHCellUpdate(): {
  previewing: Ref<boolean>
  executing: Ref<boolean>
  error: Ref<string | null>
  confirmOpen: Ref<boolean>
  statement: Ref<string>
  matchedRows: Ref<number>
  request(target: CHCellUpdateTarget): Promise<void>
  confirm(): Promise<void>
  cancel(): void
} {
  const previewing = ref(false)
  const executing = ref(false)
  const error = ref<string | null>(null)
  const confirmOpen = ref(false)
  const statement = ref('')
  const matchedRows = ref(0)
  // 预览通过后暂存的待执行目标,confirm 时原样发给执行
  let pending: CHCellUpdateTarget | null = null

  // 预览:成功 → 填充 statement/matchedRows 并打开确认弹窗;
  // 失败 → error 记录错误,不开弹窗、不残留待执行目标。
  async function request(target: CHCellUpdateTarget): Promise<void> {
    pending = target
    previewing.value = true
    error.value = null
    try {
      const res = await api.CHPreviewCellUpdate(target)
      statement.value = res.statement
      matchedRows.value = res.matched_rows
      confirmOpen.value = true
    } catch (e) {
      error.value = toErrorMessage(e)
      pending = null
    } finally {
      previewing.value = false
    }
  }

  // 执行:成功 → 关闭弹窗;失败 → error 记录错误,弹窗保持打开。
  async function confirm(): Promise<void> {
    if (!pending) {
      error.value = '没有待执行的单元格更新'
      return
    }
    executing.value = true
    error.value = null
    try {
      await api.CHUpdateCell(pending)
      confirmOpen.value = false
    } catch (e) {
      error.value = toErrorMessage(e)
    } finally {
      executing.value = false
    }
  }

  // 取消:关闭弹窗并清空全部状态(含待执行目标)。
  function cancel(): void {
    pending = null
    confirmOpen.value = false
    statement.value = ''
    matchedRows.value = 0
    error.value = null
  }

  return {
    previewing,
    executing,
    error,
    confirmOpen,
    statement,
    matchedRows,
    request,
    confirm,
    cancel,
  }
}
