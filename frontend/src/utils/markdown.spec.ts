import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('渲染一/二/三级标题', () => {
    const md = '# 一级\n## 二级\n### 三级'
    expect(renderMarkdown(md)).toBe('<h1>一级</h1>\n<h2>二级</h2>\n<h3>三级</h3>')
  })

  it('渲染段落,段内换行转为 <br>', () => {
    const md = '第一行\n第二行'
    expect(renderMarkdown(md)).toBe('<p>第一行<br>第二行</p>')
  })

  it('空行分隔多个段落', () => {
    const md = '段落一\n\n段落二'
    expect(renderMarkdown(md)).toBe('<p>段落一</p>\n<p>段落二</p>')
  })

  it('渲染带表头分隔行的表格', () => {
    const md = '| macOS | Windows/Linux | 功能 |\n| --- | --- | --- |\n| ⌘K | Ctrl+K | 命令面板 |\n| ⌘R | Ctrl+R | 刷新 |'
    expect(renderMarkdown(md)).toBe(
      '<table><thead><tr><th>macOS</th><th>Windows/Linux</th><th>功能</th></tr></thead>' +
        '<tbody><tr><td>⌘K</td><td>Ctrl+K</td><td>命令面板</td></tr>' +
        '<tr><td>⌘R</td><td>Ctrl+R</td><td>刷新</td></tr></tbody></table>',
    )
  })

  it('表格分隔行容忍对齐冒号与首尾空格', () => {
    const md = '| a | b |\n| :--- | ---: |\n| 1 | 2 |'
    const html = renderMarkdown(md)
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('表格单元格内支持行内代码与粗体', () => {
    const md = '| 键 | 说明 |\n| --- | --- |\n| `⌘D` | **新增** 复制行 |'
    const html = renderMarkdown(md)
    expect(html).toContain('<td><code>⌘D</code></td>')
    expect(html).toContain('<td><strong>新增</strong> 复制行</td>')
  })

  it('渲染无序列表', () => {
    const md = '- 甲\n- 乙\n* 丙'
    expect(renderMarkdown(md)).toBe('<ul><li>甲</li><li>乙</li><li>丙</li></ul>')
  })

  it('渲染有序列表', () => {
    const md = '1. 第一步\n2. 第二步'
    expect(renderMarkdown(md)).toBe('<ol><li>第一步</li><li>第二步</li></ol>')
  })

  it('渲染行内代码', () => {
    const md = '按 `Ctrl+S` 保存'
    expect(renderMarkdown(md)).toBe('<p>按 <code>Ctrl+S</code> 保存</p>')
  })

  it('渲染粗体', () => {
    const md = '这是**重点**内容'
    expect(renderMarkdown(md)).toBe('<p>这是<strong>重点</strong>内容</p>')
  })

  it('粗体不进入行内代码内部', () => {
    const md = '`a**b**c`'
    expect(renderMarkdown(md)).toBe('<p><code>a**b**c</code></p>')
  })

  it('渲染围栏代码块并原样转义内容', () => {
    const md = '```sql\nSELECT 1 < 2\n```'
    expect(renderMarkdown(md)).toBe('<pre><code>SELECT 1 &lt; 2</code></pre>')
  })

  it('HTML 特殊字符被转义,<script> 不产生标签', () => {
    const md = '<script>alert(1)</script> & "引号"'
    const html = renderMarkdown(md)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;引号&quot;')
  })

  it('标题与列表内容同样经过转义', () => {
    const md = '# <b>标题</b>\n- <i>项</i>'
    const html = renderMarkdown(md)
    expect(html).toBe('<h1>&lt;b&gt;标题&lt;/b&gt;</h1>\n<ul><li>&lt;i&gt;项&lt;/i&gt;</li></ul>')
  })
})
