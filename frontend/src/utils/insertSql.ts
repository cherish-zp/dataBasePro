// 结果集 → INSERT 语句构造:供结果卡片「复制为 INSERT」使用。纯函数,可全量单测。
//
// 输出形如:
//   INSERT INTO `db`.`table` (`c1`, `c2`) VALUES
//   (1, 'a'), (NULL, 'b');
// 多行数据默认合并为一个语句;行数超过 maxRows 时只生成前 maxRows 行,
// 并在语句后追加一行中文注释说明截断。
// opts.perRow = true 时改为每行一条完整 INSERT(各自分号结尾,\n 连接),
// 截断注释逻辑不变(按行数截断)。
//
// 值规则:
// - null → NULL(数值类型列的空串同样输出 NULL,避免生成非法 SQL);
// - 列 type 以数值族前缀开头(int/uint/float/double/decimal/bool,大小写不敏感,
//   如 Int32 / UInt64 / Float64 / Decimal(10,2))→ 值原样输出、不加引号;
// - 其余类型或 type 缺失/为空 → 单引号字符串,`'` → `''`、`\` → `\\`。

export interface InsertTarget {
  database: string
  table: string
}

export interface InsertColumn {
  name: string
  type?: string
}

/** INSERT 生成选项:perRow=true 时每行一条独立语句;默认 false 为单条批量。 */
export interface InsertOptions {
  perRow?: boolean
}

// 数值族类型前缀(小写比较):覆盖 ClickHouse 的 Int/UInt/Float/Decimal/Bool 系列与
// MySQL 的 int/double/decimal/bool 等。
const NUMERIC_TYPE_PREFIXES = ['int', 'uint', 'float', 'double', 'decimal', 'bool']

function isNumericType(type: string | undefined): boolean {
  if (!type) return false
  const lower = type.toLowerCase()
  return NUMERIC_TYPE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function sqlValue(type: string | undefined, value: string | null): string {
  if (value == null) return 'NULL'
  if (isNumericType(type)) return value === '' ? 'NULL' : value
  return quoteString(value)
}

export function buildInsertStatement(
  target: InsertTarget,
  columns: InsertColumn[],
  rows: (string | null)[][],
  maxRows = 1000,
  opts?: InsertOptions,
): string {
  const columnList = columns.map((col) => `\`${col.name}\``).join(', ')
  const used = rows.slice(0, maxRows)
  const tuple = (row: (string | null)[]) =>
    `(${columns.map((col, i) => sqlValue(col.type, row[i] ?? null)).join(', ')})`

  let out: string
  if (opts?.perRow) {
    // 每行一条完整 INSERT,各自分号结尾,\n 连接。
    out = used
      .map((row) => `INSERT INTO \`${target.database}\`.\`${target.table}\` (${columnList}) VALUES ${tuple(row)};`)
      .join('\n')
  } else {
    out = `INSERT INTO \`${target.database}\`.\`${target.table}\` (${columnList}) VALUES\n${used.map(tuple).join(', ')};`
  }
  if (rows.length > maxRows) {
    out += `\n-- 已截断:共 ${rows.length} 行,仅复制前 ${maxRows} 行`
  }
  return out
}
