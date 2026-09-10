// ClickHouse 单表 SELECT 判定:判断一条 SQL 是否为「单表查询」
// (SELECT <字段> FROM [db.]table,其后仅允许 WHERE/PREWHERE/ORDER BY/
// LIMIT 任意组合),供数据网格决定结果集能否按行定位发起单元格更新。
// 命中返回真实库名/表名(database 为 '' 表示连接默认库,反引号已剥离);
// 任何 JOIN、多表、FROM 子查询、分组/联合/导出等一律返回 null。
// 轻量 tokenizer 实现,零依赖。

export interface CHSingleTableQuery {
  database: string
  table: string
}

interface Token {
  kind: 'word' | 'quoted' | 'punct'
  text: string
}

// 尾部子句中出现即拒绝的关键字(改变结果集语义或引入多表)
const TAIL_BLACKLIST = new Set([
  'GROUP',
  'HAVING',
  'UNION',
  'WITH',
  'SETTINGS',
  'INTO',
  'JOIN',
  'FORMAT',
  'OFFSET',
  'FROM',
])
// 尾部允许开启的子句
const TAIL_CLAUSES = new Set(['WHERE', 'PREWHERE', 'ORDER', 'LIMIT'])
// 不能视作表别名的关键字
const RESERVED = new Set([
  ...TAIL_BLACKLIST,
  ...TAIL_CLAUSES,
  'BY',
  'AS',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'COLLATE',
  'ON',
  'USING',
  'INNER',
  'OUTER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'ANY',
  'ASOF',
  'SEMI',
  'ANTI',
  'GLOBAL',
  'FINAL',
  'SAMPLE',
  'DISTINCT',
])

// 词法分析:跳过空白、注释(--、#、/* */)与字符串字面量;
// 标识符/关键字为 word,反引号/双引号标识符为 quoted(剥离引号),
// 其余(数字、运算符、括号等)逐字符出 punct。
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    // 行注释:-- 与 #
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    // 块注释:/* ... */
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 字符串字面量:整段跳过,内容不参与结构判定
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    // 反引号 / 双引号标识符
    if (c === '`' || c === '"') {
      const q = c
      i++
      let buf = ''
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          buf += sql[i + 1]
          i += 2
          continue
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            buf += q
            i += 2
            continue
          }
          i++
          break
        }
        buf += sql[i]
        i++
      }
      tokens.push({ kind: 'quoted', text: buf })
      continue
    }
    // 关键字 / 标识符
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++
      tokens.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
      continue
    }
    tokens.push({ kind: 'punct', text: c })
    i++
  }
  return tokens
}

// 期望一个标识符(word 或 quoted),返回其文本
function expectIdent(tokens: Token[], i: number): string | null {
  const t = tokens[i]
  if (t && (t.kind === 'word' || t.kind === 'quoted')) return t.text
  return null
}

export function parseCHSingleTableSelect(sql: string): CHSingleTableQuery | null {
  const tokens = tokenize(sql)
  // 容忍尾部分号(可连续);中段分号意味着多语句,在尾部扫描中被拒绝
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1]
    if (last.kind === 'punct' && last.text === ';') tokens.pop()
    else break
  }
  if (tokens.length === 0) return null
  const head = tokens[0]
  if (head.kind !== 'word' || head.text.toUpperCase() !== 'SELECT') return null

  // 在 depth=0 上定位 FROM;组合语句(SELECT 1 UNION SELECT ...)提前拒绝
  let depth = 0
  let fromIdx = -1
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'punct') {
      if (t.text === '(') {
        depth++
        continue
      }
      if (t.text === ')') {
        depth--
        if (depth < 0) return null
        continue
      }
      // 中段分号即多语句(尾部分号已在 tokenize 后剥离)
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

  // 解析 [db.]table,FROM 后跟 "(" 即子查询,直接拒绝
  let idx = fromIdx + 1
  const firstPart = expectIdent(tokens, idx)
  if (firstPart === null) return null
  idx++
  let database = ''
  let table = firstPart
  const maybeDot = tokens[idx]
  if (maybeDot && maybeDot.kind === 'punct' && maybeDot.text === '.') {
    const secondPart = expectIdent(tokens, idx + 1)
    if (secondPart === null) return null
    database = firstPart
    table = secondPart
    idx += 2
  }

  // 可选别名(FROM t AS a / FROM t a / FROM t `a`),真实表名不受影响
  const afterTable = tokens[idx]
  if (afterTable && afterTable.kind === 'word' && afterTable.text.toUpperCase() === 'AS') {
    if (expectIdent(tokens, idx + 1) === null) return null
    idx += 2
  } else if (
    afterTable &&
    (afterTable.kind === 'quoted' ||
      (afterTable.kind === 'word' && !RESERVED.has(afterTable.text.toUpperCase())))
  ) {
    idx++
  }

  // 尾部扫描:depth=0 上仅允许 WHERE/PREWHERE/ORDER BY/LIMIT(任意顺序);
  // 括号内(WHERE 表达式、IN 子查询等)不再检查
  depth = 0
  let currentClause = ''
  let lastWord = ''
  for (; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === 'punct') {
      if (t.text === '(') {
        depth++
        continue
      }
      if (t.text === ')') {
        depth--
        if (depth < 0) return null
        continue
      }
      if (depth > 0) continue
      // 逗号仅在 ORDER BY / LIMIT 子句中合法(多键排序、LIMIT offset,n);
      // 出现在表名/别名之后即多表
      if (t.text === ',' && currentClause !== 'ORDER' && currentClause !== 'LIMIT') return null
      // 尾部分号已剥离,中段分号即多语句
      if (t.text === ';') return null
      continue
    }
    if (depth > 0) continue
    if (t.kind === 'quoted') continue
    const upper = t.text.toUpperCase()
    if (TAIL_BLACKLIST.has(upper)) return null
    if (upper === 'BY') {
      // BY 只跟随 ORDER/LIMIT(ORDER BY、LIMIT n BY)
      if (lastWord !== 'ORDER' && lastWord !== 'LIMIT' && lastWord !== 'BY') return null
    } else if (TAIL_CLAUSES.has(upper)) {
      currentClause = upper
    }
    lastWord = upper
  }
  if (depth !== 0) return null
  return { database, table }
}
