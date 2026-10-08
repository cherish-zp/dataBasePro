// 内置使用文档篇章清单:Markdown 内容随版本打包(?raw 导入,不依赖外部文件),
// 新增篇章时在 docEntries 追加条目即可,弹窗目录自动跟随。
import { renderMarkdown } from '@/utils/markdown'
import shortcutsMd from './shortcuts.md?raw'
import quickStartMd from './quick-start.md?raw'

export interface DocEntry {
  id: string
  title: string
  markdown: string
}

export const docEntries: DocEntry[] = [
  { id: 'shortcuts', title: '快捷键', markdown: shortcutsMd },
  { id: 'quick-start', title: '快速上手', markdown: quickStartMd },
]

// 记住上次看过的篇章的 localStorage key(读写均容错)。
export const DOCS_LAST_KEY = 'dbclient-docs-last'

export function readLastDocId(): string {
  try {
    return localStorage.getItem(DOCS_LAST_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeLastDocId(id: string): void {
  try {
    localStorage.setItem(DOCS_LAST_KEY, id)
  } catch {
    // 存储不可用时静默跳过,不影响浏览。
  }
}

export function renderDoc(md: string): string {
  return renderMarkdown(md)
}
