// PostgreSQL 专用前端 SQL 工具:语句拆分 + 单表 SELECT 解析。
// 语义与后端 SplitPostgresStatements / postgresSingleTableSelect 保持一致:
// - 拆分:$$ / $tag$ 美元引号体整体跳过($1 占位符不是引号)、标准单引号字符串
//   只处理 '' 转义(standard_conforming_strings=on)、E'...' 反斜杠转义、
//   双引号标识符("" 转义)、行注释 / 块注释——以上内部的分号都不拆分语句。
// - 解析:单表 SELECT 且尾部仅 WHERE/ORDER BY/LIMIT/OFFSET;CTE / JOIN /
//   多表逗号 / 子查询 / GROUP BY / HAVING / UNION / FOR UPDATE 一律只读。
// 纯函数、零依赖,可全量单测。

import type { SqlSegment } from './sqlSplit'

export interface PgSingleTableQuery {
  database: string
  schema: string
  table: string
}

type ScanState = 'code' | 'line-comment' | 'block-comment' | 'single' | 'escape' | 'double' | 'dollar'

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

function lineAtOffset(sql: string, offset: number): number {
  let line = 1
  for (let k = 0; k < offset; k += 1) {
    if (sql.charCodeAt(k) === 10) line += 1
  }
  return line
}

// $tag$ 标签校验:空标签($$)合法;非空标签须为 [A-Za-z_][A-Za-z0-9_]*,
// 拒绝 $1 之类的参数占位符(与后端 isValidPostgresDollarTag 一致)。
function isValidDollarTag(tag: string): boolean {
  if (tag === '') return true
  if (!/[A-Za-z_]/.test(tag[0])) return false
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)
}

// 从 offset 的 '$' 开始读取美元引号开启符;返回 { tag, start, end },
// end 指向开启符结尾(含闭合 '$')。非美元引号时返回 null。
function dollarQuoteOpen(sql: string, i: number): { tag: string; start: number; end: number } | null {
  if (sql[i] !== '$') return null
  let close = i + 1
  while (close < sql.length && sql[close] !== '$') close += 1
  if (close >= sql.length) return null
  const tag = sql.slice(i + 1, close)
  if (!isValidDollarTag(tag)) return null
  return { tag, start: i, end: close + 1 }
}

export function splitPostgresStatements(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = []
  const n = sql.length
  let firstContent = -1
  let state: ScanState = 'code'
  // dollar 状态下缓存开启符文本($$ 或 $tag$),用于匹配闭合。
  let dollarTerm = ''

  const flush = (to: number): void => {
    if (firstContent < 0) return
    segments.push({
      text: sql.slice(firstContent, to),
      from: firstContent,
      to,
      startLine: lineAtOffset(sql, firstContent),
    })
    firstContent = -1
  }

  let i = 0
  while (i < n) {
    const c = sql[i] as string
    switch (state) {
      case 'code': {
        if (c === '-' && sql[i + 1] === '-') {
          state = 'line-comment'
          i += 2
        } else if (c === '/' && sql[i + 1] === '*') {
          state = 'block-comment'
          i += 2
        } else if (c === ';') {
          flush(i + 1) // to 含分号
          i += 1
        } else if (isWs(c)) {
          i += 1
        } else {
          if (firstContent < 0) firstContent = i
          if (c === "'") {
            // E'...' 转义字符串:E/e 紧邻引号且 E 之前不是标识符字符。
            const prev = i >= 1 ? sql[i - 1] : ''
            const prev2 = i >= 2 ? sql[i - 2] : ''
            const isEscape =
              (prev === 'E' || prev === 'e') &&
              !(/[A-Za-z0-9_$]/.test(prev2))
            state = isEscape ? 'escape' : 'single'
          } else if (c === '"') {
            state = 'double'
          } else if (c === '$') {
            const open = dollarQuoteOpen(sql, i)
            if (open) {
              dollarTerm = sql.slice(open.start, open.end)
              state = 'dollar'
              i = open.end
              break
            }
          }
          i += 1
        }
        break
      }
      case 'single': {
        // standard_conforming_strings=on:只处理 '' 转义。
        if (c === "'") {
          if (sql[i + 1] === "'") i += 2
          else {
            state = 'code'
            i += 1
          }
        } else i += 1
        break
      }
      case 'escape': {
        // E'...' 里反斜杠转义下一字符。
        if (c === '\\' && i + 1 < n) i += 2
        else if (c === "'") {
          if (sql[i + 1] === "'") i += 2
          else {
            state = 'code'
            i += 1
          }
        } else i += 1
        break
      }
      case 'double': {
        if (c === '"') {
          if (sql[i + 1] === '"') i += 2
          else {
            state = 'code'
            i += 1
          }
        } else i += 1
        break
      }
      case 'dollar': {
        // 找闭合 $tag$;找不到则美元体吞到文末(与后端一致)。
        const end = sql.indexOf(dollarTerm, i)
        if (end < 0) {
          i = n
        } else {
          state = 'code'
          i = end + dollarTerm.length
        }
        break
      }
      case 'line-comment': {
        if (c === '\n') state = 'code'
        i += 1
        break
      }
      case 'block-comment': {
        if (c === '*' && sql[i + 1] === '/') {
          state = 'code'
          i += 2
        } else {
          i += 1
        }
        break
      }
    }
  }

  if (firstContent >= 0) {
    let end = n
    while (end > firstContent && isWs(sql[end - 1] as string)) end -= 1
    flush(end)
  }
  return segments
}

// --- 单表 SELECT 解析 ---------------------------------------------------------
// 轻量 tokenizer + 状态扫描,与后端 postgresSingleTableSelect 的正则语义对齐。

interface PgToken {
  kind: 'word' | 'quoted' | 'punct' | 'string'
  text: string
}

// PG 词法:word / "quoted"(含 "" 转义)/ 单引号与 E'' 字符串 / $tag$ 美元串 /
// -- 注释与 /* */ 注释(跳过)/ 其余单字符视为 punct。
function tokenizePg(sql: string): PgToken[] {
  const tokens: PgToken[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i] as string
    if (isWs(c)) {
      i += 1
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i = Math.min(i + 2, n)
      continue
    }
    if (c === "'") {
      // E'...' / 标准字符串,扫描到闭合引号。
      const prev = i >= 1 ? sql[i - 1] : ''
      const prev2 = i >= 2 ? sql[i - 2] : ''
      const escape = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_$]/.test(prev2)
      // E 字符已作为 word 产出,这里从引号开始扫描。
      const start = i
      i += 1
      while (i < n) {
        if (escape && sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i) })
      continue
    }
    if (c === '"') {
      let text = ''
      i += 1
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            text += '"'
            i += 2
            continue
          }
          i += 1
          break
        }
        text += sql[i]
        i += 1
      }
      tokens.push({ kind: 'quoted', text })
      continue
    }
    if (c === '$') {
      const open = dollarQuoteOpen(sql, i)
      if (open) {
        const close = sql.indexOf(sql.slice(open.start, open.end), open.end)
        const end = close < 0 ? n : close + (open.end - open.start)
        tokens.push({ kind: 'string', text: sql.slice(open.start, end) })
        i = end
        continue
      }
      tokens.push({ kind: 'punct', text: c })
      i += 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j] as string)) j += 1
      tokens.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
      continue
    }
    tokens.push({ kind: 'punct', text: c })
    i += 1
  }
  return tokens
}

function isIdent(t: PgToken | undefined): t is PgToken {
  return !!t && (t.kind === 'word' || t.kind === 'quoted')
}

// 解析 FROM 之后的限定关系名,最多 3 段(schema.relation / db.schema.relation /
// relation)。返回各段文本;失败返回 null。idx 指向关系名首段。
function parseQualified(tokens: PgToken[], idx: number): { parts: string[]; next: number } | null {
  const first = tokens[idx]
  if (!isIdent(first)) return null
  const parts = [first.text]
  let cur = idx + 1
  while (cur + 1 < tokens.length + 1 && tokens[cur]?.kind === 'punct' && tokens[cur]?.text === '.') {
    const part = tokens[cur + 1]
    if (!isIdent(part)) return null
    parts.push(part.text)
    cur += 2
    if (parts.length > 3) return null
  }
  return { parts, next: cur }
}

export function parsePgSingleTableSelect(
  sql: string,
  defaultSchema = '',
): PgSingleTableQuery | null {
  const tokens = tokenizePg(sql)
  // 容忍尾部分号(可连续);中段分号即多语句。
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1]
    if (last.kind === 'punct' && last.text === ';') tokens.pop()
    else break
  }
  if (tokens.length === 0) return null
  const head = tokens[0]
  if (head.kind !== 'word' || head.text.toUpperCase() !== 'SELECT') return null

  // depth=0 上定位 FROM;组合语句(UNION / WITH)提前拒绝。
  let depth = 0
  let fromIdx = -1
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'punct') {
      if (t.text === '(') {
        depth += 1
        continue
      }
      if (t.text === ')') {
        depth -= 1
        if (depth < 0) return null
        continue
      }
      if (depth === 0 && t.text === ';') return null
      continue
    }
    if (depth > 0 || t.kind !== 'word') continue
    const upper = t.text.toUpperCase()
    if (upper === 'FROM') {
      fromIdx = i
      break
    }
    if (upper === 'UNION' || upper === 'WITH') return null
  }
  if (fromIdx < 0) return null

  // FROM 后跟 "(" 即子查询,拒绝;否则解析最多 3 段的限定关系名。
  const after = tokens[fromIdx + 1]
  if (after && after.kind === 'punct' && after.text === '(') return null
  const qualified = parseQualified(tokens, fromIdx + 1)
  if (!qualified) return null
  const { parts, next } = qualified

  // 尾部:紧跟 WHERE / ORDER BY / LIMIT / OFFSET 之一,或直接结束;
  // 别名(JOIN、逗号、GROUP 等)与后端正则一致地拒绝。
  const tail = tokens[next]
  if (tail === undefined) {
    // 尾句结束,合法。
  } else if (tail.kind === 'word') {
    const upper = tail.text.toUpperCase()
    if (upper === 'ORDER') {
      const by = tokens[next + 1]
      if (!by || by.kind !== 'word' || by.text.toUpperCase() !== 'BY') return null
    } else if (upper !== 'WHERE' && upper !== 'LIMIT' && upper !== 'OFFSET') {
      return null
    }
  } else {
    return null
  }

  const out: PgSingleTableQuery = { database: '', schema: '', table: '' }
  if (parts.length === 1) {
    out.schema = defaultSchema
    out.table = parts[0]
  } else if (parts.length === 2) {
    out.schema = parts[0]
    out.table = parts[1]
  } else {
    out.database = parts[0]
    out.schema = parts[1]
    out.table = parts[2]
  }
  return out
}
