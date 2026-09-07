// formatBytes 把字节数格式化为人类可读的大小:B/KB/MB/GB,一位小数、
// 去尾零(1024 进制)。0 与负数渲染为 "0 B" / 原值。
export function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  if (u === 0) return `${v} B`
  const trimmed = String(parseFloat(v.toFixed(1)))
  return `${trimmed} ${units[u]}`
}
