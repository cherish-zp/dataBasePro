// ES 新增文档骨架:按索引映射字段生成一份可直接编辑、保存的文档 JSON 草稿。
// 数值族 → 0(大小写不敏感前缀匹配,覆盖 unsigned_long/half_float/scaled_float
// 及 integer_range 等 *_range 衍生);boolean → false;object 或空类型(无叶
// 子类型)跳过——其结构由点路径子字段决定;其余(keyword/text/date/...)一律
// null。字段名点路径(a.b)生成嵌套对象,输出键按传入顺序、2 空格缩进。

// 数值族前缀:ES 核心数值类型;前缀匹配可顺带覆盖 integer_range/long_range/
// double_range/short_range/byte_range/float_range 等 range 衍生。
const NUMERIC_PREFIXES = [
  'long',
  'integer',
  'short',
  'byte',
  'double',
  'float',
  'half_float',
  'scaled_float',
  'unsigned_long',
] as const

function isNumericType(t: string): boolean {
  return NUMERIC_PREFIXES.some((p) => t.startsWith(p))
}

// setPath 沿点路径写入叶子值:中间节点缺失则创建对象;遇到已存在的标量
// (非法映射:同一路径既是叶子又有子路径)时放弃该字段,不抛错、不覆盖。
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    const child = node[parts[i]]
    if (child !== undefined && (typeof child !== 'object' || child === null || Array.isArray(child))) {
      return
    }
    if (child === undefined) {
      const next: Record<string, unknown> = {}
      node[parts[i]] = next
      node = next
    } else {
      node = child as Record<string, unknown>
    }
  }
  const leaf = parts[parts.length - 1]
  const existing = node[leaf]
  // 叶子位置已是嵌套对象(更深的点路径先到)时不覆盖为标量。
  if (existing !== undefined && typeof existing === 'object' && existing !== null) return
  node[leaf] = value
}

// buildDocSkeleton 由映射字段列表生成新增文档的 JSON 草稿文本(2 空格缩进)。
export function buildDocSkeleton(fields: Array<{ name: string; type: string }>): string {
  const root: Record<string, unknown> = {}
  for (const f of fields) {
    const type = (f.type ?? '').toLowerCase()
    // object/空类型跳过:不生成叶子,由点路径子字段决定嵌套结构。
    if (type === '' || type === 'object') continue
    let value: unknown
    if (isNumericType(type)) value = 0
    else if (type === 'boolean') value = false
    else value = null
    setPath(root, f.name, value)
  }
  return JSON.stringify(root, null, 2)
}
