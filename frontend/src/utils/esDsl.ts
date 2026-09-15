// 前端 ES DSL 请求解析:Kibana Dev Tools 风格 —— `VERB /path` 行 + 可选 JSON body,
// 请求之间以空行分隔。供 EsSqlConsole 的 DSL 模式拆分请求,逐条透传后端执行。
// 纯函数,不依赖 CodeMirror,可全量单测。
//
// 解析规则:
// - 每个请求的首个「非空、非注释」行必须是 `VERB /path`:VERB ∈
//   GET/POST/PUT/DELETE/HEAD(大小写不敏感,统一转大写);path 必须以 / 开头,
//   可带 query string;
// - method 行之后到空行/文末为 body,原样保留(不校验 JSON 语法,由后端校验);
// - 纯注释行(# 或 // 开头)整行跳过,不计入 body;纯注释/空白块不产出请求;
// - 块内解析不出 method+path → 抛 EsDslParseError(带 1 基行号与块原文),
//   由控制台转为错误卡展示;
// - startLine 为 1 基,指向 method 行(块内前导注释不占 startLine)。

export interface EsDslRequestPart {
  method: string
  path: string
  body: string
  /** method 行的 1 基行号(供 ⌘Enter 光标定位与 gutter 状态标记)。 */
  startLine: number
}

/** 解析失败:line 为出错块的 method 行候选行号(1 基),block 为块原始文本。 */
export class EsDslParseError extends Error {
  line: number
  block: string

  constructor(message: string, line: number, block: string) {
    super(message)
    this.name = 'EsDslParseError'
    this.line = line
    this.block = block
  }
}

const VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'])

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('#') || t.startsWith('//')
}

function parseBlock(block: string[], blockStartLine: number): EsDslRequestPart | null {
  // 块内首个非注释行即 method 行候选;整块纯注释 → 不产出请求。
  let headIdx = -1
  for (let i = 0; i < block.length; i += 1) {
    if (!isComment(block[i] as string)) {
      headIdx = i
      break
    }
  }
  if (headIdx === -1) return null

  const headLine = blockStartLine + headIdx
  const head = (block[headIdx] as string).trim()
  const matched = /^(\S+)\s+(\/\S*)$/.exec(head)
  if (!matched) {
    throw new EsDslParseError(
      `第 ${headLine} 行解析不出 DSL 请求,应为「VERB /path」(GET/POST/PUT/DELETE/HEAD,path 以 / 开头)`,
      headLine,
      block.join('\n'),
    )
  }
  const method = matched[1]!.toUpperCase()
  if (!VERBS.has(method)) {
    throw new EsDslParseError(
      `第 ${headLine} 行的 VERB「${matched[1]}」不支持,应为 GET/POST/PUT/DELETE/HEAD`,
      headLine,
      block.join('\n'),
    )
  }
  // body = method 行之后到块尾的非注释行,原样保留(仅去掉行尾 \r)。
  const body = block
    .slice(headIdx + 1)
    .filter((l) => !isComment(l))
    .join('\n')
  return { method, path: matched[2]!, body, startLine: headLine }
}

export function parseEsDslRequests(text: string): EsDslRequestPart[] {
  // CRLF 按 LF 处理(桌面编辑器正常产出 LF,容忍粘贴来源的 \r)。
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const requests: EsDslRequestPart[] = []
  let block: string[] = []
  let blockStartLine = 1

  const flush = (): void => {
    if (block.length === 0) return
    const req = parseBlock(block, blockStartLine)
    if (req) requests.push(req)
    block = []
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (isBlank(line)) {
      flush()
      continue
    }
    if (block.length === 0) blockStartLine = i + 1
    block.push(line)
  }
  flush()
  return requests
}

/** 响应正文美化:合法 JSON 缩进 2 空格,非法/空原文返回。 */
export function prettyJson(text: string): string {
  if (!text.trim()) return text
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}
