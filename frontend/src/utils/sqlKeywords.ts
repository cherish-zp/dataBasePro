/**
 * lang-sql 默认方言(StandardSQL)关键词补全缺失的常用语句关键词清单。
 *
 * 来源:与 @codemirror/lang-sql@6.10.0 dist 内置 SQLKeywords 基础词表逐词比对得出——
 * SqlEditor.vue 调用 `sql({ schema, upperCaseKeywords })` 未指定 dialect 时,
 * lang-sql 使用 StandardSQL 方言,其关键词补全不含 TRUNCATE/SHOW/EXPLAIN/USE/
 * RENAME/OPTIMIZE/ANALYZE/KILL 等常用 MySQL 语句关键词,导致所有 SQL 控制台
 * 均无法联想这些词。本清单仅收录默认词表没有的词(SELECT/FROM/ALTER 等已有词
 * 不在此列,避免补全重复),供 SqlEditor 的额外补全源与测试引用。
 */
export const SQL_EXTRA_KEYWORDS: readonly string[] = [
  'TRUNCATE',
  'SHOW',
  'EXPLAIN',
  'USE',
  'RENAME',
  'OPTIMIZE',
  'ANALYZE',
  'KILL',
]

/**
 * 关键词去重:大写归一(Trim + toUpperCase)后按首次出现顺序去重,
 * 过滤空串。供 SqlEditor 构建额外关键词补全项时使用。
 */
export function dedupeSqlKeywords(words: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const word of words) {
    const kw = word.trim().toUpperCase()
    if (kw && !seen.has(kw)) {
      seen.add(kw)
      out.push(kw)
    }
  }
  return out
}
