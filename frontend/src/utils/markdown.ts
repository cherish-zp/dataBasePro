// renderMarkdown:零依赖的受限 Markdown 渲染器,仅支持「使用文档」用到的语法:
// 标题(#/##/###)、段落与换行、表格(含表头分隔行)、无序/有序列表、行内代码、
// 围栏代码块与粗体。所有文本先做 HTML 转义(&<>")再做语法替换,因此内置文档
// 即便手滑写出尖括号也不会产生真实标签,渲染结果可安全交给 v-html。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// inline 渲染行内内容:先转义,再依次处理行内代码(占位保护,粗体不进 code)
// 与粗体,最后还原行内代码。
function renderInline(raw: string): string {
  const codes: string[] = []
  let s = escapeHtml(raw).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => codes[Number(n)])
  return s
}

// splitRow 拆一行表格行:去掉首尾的 | 后按 | 切分并 trim 每格。
function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function isTableDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

// isTableHeader 判断当前行是否为表格首行:本行含 | 且下一行是 |---|---| 分隔行。
function isTableHeader(line: string, next: string | undefined): boolean {
  return (
    line.includes('|') &&
    next !== undefined &&
    next.includes('|') &&
    isTableDelimiterRow(next)
  )
}

const UL_RE = /^\s*[-*]\s+/
const OL_RE = /^\s*\d+\.\s+/
const HEADING_RE = /^(#{1,3})\s+(.+)$/

// isBlockBoundary 判断某行是否为块级结构起点(段落收集的终止条件)。
function isBlockBoundary(line: string, next: string | undefined): boolean {
  if (line.trim() === '') return true
  if (line.startsWith('```')) return true
  if (HEADING_RE.test(line)) return true
  if (isTableHeader(line, next)) return true
  if (UL_RE.test(line)) return true
  if (OL_RE.test(line)) return true
  return false
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const next = lines[i + 1]

    // 空行:块间分隔,不产出内容。
    if (line.trim() === '') {
      i++
      continue
    }

    // 围栏代码块:``` 到 ``` 之间的内容整体转义,不做任何行内语法。
    if (line.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过结束围栏(缺失时循环自然终止)
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`)
      continue
    }

    // 标题 #/##/###。
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }

    // 表格:首行(表头)+ 分隔行 + 若干数据行。
    if (isTableHeader(line, next)) {
      const header = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      const head = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`
      const body = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
      out.push(`<table>${head}${body}</table>`)
      continue
    }

    // 无序/有序列表:收集连续同类行。
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line)
      const itemRe = ordered ? OL_RE : UL_RE
      const items: string[] = []
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(lines[i].replace(itemRe, ''))
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(t)}</li>`).join('')}</${tag}>`)
      continue
    }

    // 段落:收集到下一个块级边界,段内换行渲染为 <br>。
    const buf: string[] = []
    while (i < lines.length && !isBlockBoundary(lines[i], lines[i + 1])) {
      buf.push(lines[i])
      i++
    }
    if (buf.length > 0) {
      out.push(`<p>${buf.map(renderInline).join('<br>')}</p>`)
    }
  }
  return out.join('\n')
}
