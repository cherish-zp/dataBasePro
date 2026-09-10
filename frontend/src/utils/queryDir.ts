// 查询文件目录:可在设置页配置,默认 ~/.db-client/queries。
// 目录值经后端展开(~ → 用户主目录),空值 = 使用默认目录。
export const QUERY_DIR_KEY = 'dbclient-query-dir'
export const DEFAULT_QUERY_DIR = '~/.db-client/queries'

export function getQueryDir(): string {
  const v = localStorage.getItem(QUERY_DIR_KEY)
  return v && v.trim() !== '' ? v : DEFAULT_QUERY_DIR
}

// 把名称规范为磁盘文件名:缺 .sql 后缀时补上(大小写不敏感,与后端
// queryFileName 一致)。保存与「当前打开文件」统一走它,保证高亮条目名
// 与刷新后列表里的真实文件名一致。
export function withSqlExt(name: string): string {
  return name.toLowerCase().endsWith('.sql') ? name : `${name}.sql`
}

// 持久化查询文件目录:输入变更即写;空/纯空白视为恢复默认,移除键回退默认值。
export function setQueryDir(dir: string): void {
  if (dir.trim() === '') {
    localStorage.removeItem(QUERY_DIR_KEY)
    return
  }
  localStorage.setItem(QUERY_DIR_KEY, dir)
}
