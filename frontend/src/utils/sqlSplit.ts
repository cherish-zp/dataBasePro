// 前端 SQL 语句拆分:供 SQL 控制台的「执行该语句」gutter 按钮、语句执行状态标记
// 与光标语句高亮定位使用。纯函数,不依赖 CodeMirror,可全量单测。
//
// 拆分规则:
// - 顶层 `;` 为语句分隔符(尾句可无分号);
// - 跳过 `--` 行注释、`#` 行注释(MySQL 方言)、`/* */` 块注释——注释内的分号不拆分,
//   注释与字符串的状态互不误导(字符串里的 /* */ 不是注释,注释里的引号不开字符串);
// - 跳过单引号字符串(`''` 与反斜杠转义)、双引号字符串(同上)、反引号标识符(`` `` 转义);
// - 前导注释与前导空白不算语句内容:段起点(from/startLine)落在首个「实际 SQL」字符上,
//   保证 gutter ▶ 渲染在语句本体首行;
// - 纯注释/空白段不产出 segment。
//
// 产物语义:from/to 为文档 offset,to 含结尾分号(尾句无分号时 to 为末尾最后一个
// 非空白字符之后);text = 原文 slice(from, to);startLine 为 1 基行号。

export interface SqlSegment {
  text: string
  from: number
  to: number
  startLine: number
}

type ScanState = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'backtick'

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

// offset 之前(不含)的换行数 + 1,即 1 基行号。
function lineAtOffset(sql: string, offset: number): number {
  let line = 1
  for (let k = 0; k < offset; k += 1) {
    if (sql.charCodeAt(k) === 10) line += 1
  }
  return line
}

export function splitSqlStatements(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = []
  const n = sql.length
  // 当前语句段首个实际内容字符的下标;-1 表示尚未出现(纯注释/空白)。
  let firstContent = -1
  let state: ScanState = 'code'

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
        } else if (c === '#') {
          state = 'line-comment'
          i += 1
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
          if (c === "'") state = 'single'
          else if (c === '"') state = 'double'
          else if (c === '`') state = 'backtick'
          i += 1
        }
        break
      }
      case 'single': {
        // 反斜杠转义跳过下一字符;'' 为转义引号,仍在字符串内。
        if (c === '\\') i += 2
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
        if (c === '\\') i += 2
        else if (c === '"') {
          if (sql[i + 1] === '"') i += 2
          else {
            state = 'code'
            i += 1
          }
        } else i += 1
        break
      }
      case 'backtick': {
        // 标识符内无反斜杠转义,`` 为转义反引号。
        if (c === '`') {
          if (sql[i + 1] === '`') i += 2
          else state = 'code'
        }
        i += 1
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

  // 尾句(无分号):to 裁到末尾最后一个非空白字符之后。
  if (firstContent >= 0) {
    let end = n
    while (end > firstContent && isWs(sql[end - 1] as string)) end -= 1
    flush(end)
  }
  return segments
}

// 提取语句前置注释标签:from 为语句起始 offset(如 splitSqlStatements 的 segment.from)。
// 从该位置向上逐行找最近的非空行(trim 后非空):该行以 `--` 或 `#` 开头 → 返回去掉
// 注释前缀后的文本(trim);否则(上方是代码)返回 null。空文件/无上方行 → null。
// from 所在行内、语句之前若已有非空内容,视作「上方是代码」,不跨行找注释。
export function commentAbove(sql: string, from: number): string | null {
  const pos = Math.min(from, sql.length)
  if (pos <= 0) return null
  // from 所在行内、语句之前的部分(end 为所在行行首下标)。
  let end = sql.lastIndexOf('\n', pos - 1) + 1
  const before = sql.slice(end, pos).trim()
  if (before) return commentLabelOf(before)
  // 逐行向上:[start, end) 为上一行内容;end 递减到 0 即无更多上方行。
  while (end > 0) {
    const start = sql.lastIndexOf('\n', end - 1) + 1
    const text = sql.slice(start, end).trim()
    if (text) return commentLabelOf(text)
    end = start - 1
  }
  return null
}

// 已 trim 的行首是 `--` / `#` 注释 → 去掉前缀并 trim;否则 null。
function commentLabelOf(line: string): string | null {
  if (line.startsWith('--')) return line.slice(2).trim()
  if (line.startsWith('#')) return line.slice(1).trim()
  return null
}
