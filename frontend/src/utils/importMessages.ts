// 本地文件导入（JSON 数组 / JSONL / CSV）的纯解析逻辑。
// 复用 batchProduce 的 BatchProduceItem 与 COUNT_MAX 语义，解析结果直接走批量发送。

import { COUNT_MAX, type BatchProduceItem } from './batchProduce'

const MAX_IMPORT_CHARS = 2_000_000

// 对象行里的 partition/timestamp 字段一律忽略：分区走面板级 form.partition，
// timestamp 后端不设置。
function stripIgnoredFields(json: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return json
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return json
  const obj = parsed as Record<string, unknown>
  if (!('partition' in obj) && !('timestamp' in obj)) return json
  const { partition: _p, timestamp: _t, ...rest } = obj
  return JSON.stringify(rest)
}

function parseJsonArray(text: string): BatchProduceItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('JSON 解析失败')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('文件为空或无有效消息')
  }
  return parsed.slice(0, COUNT_MAX).map((item) => ({
    key: '',
    value: typeof item === 'string' ? item : stripIgnoredFields(JSON.stringify(item)),
  }))
}

function parseJsonl(text: string): BatchProduceItem[] {
  const items: BatchProduceItem[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`第 ${i + 1} 行 JSON 解析失败`)
    }
    items.push({
      key: '',
      value: typeof parsed === 'string' ? parsed : stripIgnoredFields(JSON.stringify(parsed)),
    })
  }
  if (items.length === 0) throw new Error('文件为空或无有效消息')
  return items
}

// splitCsvRecords：RFC4180 风格的整文本解析，支持引号包裹字段（字段内逗号、
// 转义引号 "" 与字段内换行）。
function splitCsvRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i += 1
        }
      } else {
        field += ch
        i += 1
      }
    } else if (ch === '"') {
      inQuotes = true
      i += 1
    } else if (ch === ',') {
      record.push(field)
      field = ''
      i += 1
    } else if (ch === '\n' || ch === '\r') {
      record.push(field)
      field = ''
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      i += 1
      if (record.some((f) => f !== '')) records.push(record)
      record = []
    } else {
      field += ch
      i += 1
    }
  }
  record.push(field)
  if (record.some((f) => f !== '')) records.push(record)
  return records
}

function parseCsv(text: string): BatchProduceItem[] {
  const records = splitCsvRecords(text)
  if (records.length === 0) throw new Error('文件为空或无有效消息')
  const header = records[0].map((h) => h.trim().toLowerCase())
  const data = records.slice(1)
  if (data.length === 0) throw new Error('文件为空或无有效消息')
  let keyIdx = -1
  let valueIdx: number
  if (header.length === 1) {
    // 单列 CSV：整列即 value。
    valueIdx = 0
  } else {
    valueIdx = header.indexOf('value')
    if (valueIdx === -1) throw new Error('CSV 缺少 value 列')
    keyIdx = header.indexOf('key')
  }
  return data.slice(0, COUNT_MAX).map((row) => ({
    key: keyIdx >= 0 ? (row[keyIdx] ?? '') : '',
    value: valueIdx >= 0 ? (row[valueIdx] ?? '') : '',
  }))
}

// parseImportFile 把本地文本解析为批量发送消息：JSON 数组（trim 后以 [ 开头）、
// JSONL/NDJSON（扩展名或 { 开头）、CSV（首行为表头）。解析失败 fail-fast 抛错。
export function parseImportFile(text: string, filename: string): BatchProduceItem[] {
  if (text.length > MAX_IMPORT_CHARS) {
    throw new Error('文件过大（>2MB），请分批导入')
  }
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('文件为空或无有效消息')
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jsonl' || ext === 'ndjson') return parseJsonl(text)
  if (trimmed.startsWith('[')) return parseJsonArray(text)
  if (trimmed.startsWith('{')) return parseJsonl(text)
  return parseCsv(text)
}
