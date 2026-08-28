// 批量生产消息的纯逻辑：展开消息数组、随机 key、最近模板（localStorage）。

export interface BatchProduceItem {
  key: string
  value: string
}

export interface BatchProduceOptions {
  value: string
  key: string
  count: number
  randomKey: boolean
  loop: boolean
}

export const TEMPLATE_LIMIT = 5
export const COUNT_MIN = 1
export const COUNT_MAX = 1000
const TEMPLATE_STORAGE_KEY = 'dbclient.produce-templates.v1'

export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return COUNT_MIN
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.floor(n)))
}

// 随机 key：key-<base36>，无加密需求，Math.random 足够。
export function randomKey(): string {
  return `key-${Math.random().toString(36).slice(2, 10)}`
}

// buildBatchMessages 展开批量发送的消息数组：
// - 循环发送：同一条 value 重复 N 次；
// - 行数 > 1：把 value 解析为 JSON 数组（「JSON 数组批量」），每个元素作为一条消息；
// - 行数 = 1（仅勾选随机 key）：单条消息，key 仍走随机逻辑。
export function buildBatchMessages(opts: BatchProduceOptions): BatchProduceItem[] {
  const keyOf = (): string => (opts.randomKey ? randomKey() : opts.key)
  if (opts.loop) {
    return Array.from({ length: clampCount(opts.count) }, () => ({ key: keyOf(), value: opts.value }))
  }
  if (clampCount(opts.count) > 1) {
    return parseArrayMessages(opts.value, keyOf)
  }
  return [{ key: keyOf(), value: opts.value }]
}

function parseArrayMessages(value: string, keyOf: () => string): BatchProduceItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('值需为 JSON 数组，或勾选「循环发送」重复发送')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('值需为 JSON 数组，或勾选「循环发送」重复发送')
  }
  if (parsed.length === 0) {
    throw new Error('JSON 数组不能为空')
  }
  return parsed.map((item) => ({
    key: keyOf(),
    value: typeof item === 'string' ? item : JSON.stringify(item),
  }))
}

export function loadTemplates(storage: Storage = localStorage): string[] {
  try {
    const raw = storage.getItem(TEMPLATE_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

// saveTemplate 把成功发送的 value 记为最近模板：去重、MRU、最多 5 条。
export function saveTemplate(templates: string[], value: string, storage: Storage = localStorage): string[] {
  const next = [value, ...templates.filter((t) => t !== value)].slice(0, TEMPLATE_LIMIT)
  try {
    storage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用时仅保留内存列表。
  }
  return next
}
