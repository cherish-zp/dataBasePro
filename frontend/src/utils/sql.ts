import type { Message } from '@/api/types'

export interface WhereClause {
  field: 'key' | 'value'
  op: 'eq' | 'like'
  value: string
}

export interface ParsedSelect {
  topic: string | null
  where: WhereClause[]
  limit: number | null
  error: string | null
}

const VALUE_RE = /^'([^']*)'$/

export function parseSelect(sql: string): ParsedSelect {
  const trimmed = sql.trim()
  if (!trimmed) {
    return { topic: null, where: [], limit: null, error: 'SQL 不能为空' }
  }

  const fromMatch = /^select\s+\*\s+from\s+([a-zA-Z0-9_.-]+)(.*)$/i.exec(trimmed)
  if (!fromMatch) {
    return { topic: null, where: [], limit: null, error: '仅支持 SELECT * FROM <topic> 形式的查询' }
  }

  const topic = fromMatch[1]
  const rest = fromMatch[2].trim()

  const limitMatch = /\blimit\s+(\d+)\s*$/i.exec(rest)
  const limit = limitMatch ? Number(limitMatch[1]) : null
  const body = limitMatch ? rest.slice(0, limitMatch.index).trim() : rest

  const where: WhereClause[] = []
  if (body) {
    const whereMatch = /^where\s+(.+)$/i.exec(body)
    if (!whereMatch) {
      return { topic: null, where: [], limit: null, error: '无法解析 WHERE 子句' }
    }
    const conditions = whereMatch[1].split(/\s+and\s+/i)
    for (const cond of conditions) {
      const eq = /^([a-zA-Z_]+)\s*=\s*(.+)$/.exec(cond.trim())
      const like = /^([a-zA-Z_]+)\s+like\s+(.+)$/i.exec(cond.trim())
      const m = eq ?? like
      if (!m) {
        return { topic: null, where: [], limit: null, error: `无法解析条件: ${cond.trim()}` }
      }
      const field = m[1].toLowerCase()
      if (field !== 'key' && field !== 'value') {
        return { topic: null, where: [], limit: null, error: `不支持的字段: ${m[1]}（仅支持 key / value）` }
      }
      const valMatch = VALUE_RE.exec(m[2].trim())
      if (!valMatch) {
        return { topic: null, where: [], limit: null, error: `条件值需用单引号包裹: ${m[2].trim()}` }
      }
      where.push({ field, op: eq ? 'eq' : 'like', value: valMatch[1] })
    }
  }

  return { topic, where, limit, error: null }
}

export function matchesWhere(message: Message, clauses: WhereClause[]): boolean {
  return clauses.every((c) => {
    const actual = c.field === 'key' ? message.key : message.value
    if (c.op === 'eq') return actual === c.value
    const pattern = c.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
    return new RegExp(`^${pattern}$`).test(actual)
  })
}
