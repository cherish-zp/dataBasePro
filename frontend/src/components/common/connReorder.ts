// 侧栏连接排序的纯计算函数:↑↓ 微调按钮、右键菜单上移/下移与原生拖拽
// 共用同一套语义,抽成无副作用的导出函数便于单测与组件解耦。
// 所有函数接收并返回「重排后完整顺序的 id 数组」的副本,与后端
// ReorderConnections(ids) 的契约一致;入参不合法时原样返回副本。

// 把 id 上移/下移一位(delta -1 = 上移,1 = 下移);id 不存在或越界时
// 返回原顺序副本(调用侧另有 disabled 按钮/省略菜单项兜底)。
export function moveId(ids: string[], id: string, delta: -1 | 1): string[] {
  const i = ids.indexOf(id)
  const j = i + delta
  if (i === -1 || j < 0 || j >= ids.length) return [...ids]
  const next = [...ids]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

// 把 fromId 移动到 toId 的 before/after 位置(拖拽语义:悬停在目标行
// 上半部 = before,下半部 = after)。fromId/toId 不存在或相同则原样返回。
export function reorderIds(ids: string[], fromId: string, toId: string, place: 'before' | 'after'): string[] {
  if (fromId === toId || !ids.includes(fromId) || !ids.includes(toId)) return [...ids]
  const next = ids.filter((x) => x !== fromId)
  // 移除源元素后按目标的新下标插入;after 落在目标右侧一格。
  let idx = next.indexOf(toId)
  if (place === 'after') idx += 1
  next.splice(idx, 0, fromId)
  return next
}
