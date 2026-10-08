# 快捷键

应用内快捷键在 **macOS** 与 **Windows / Linux** 上修饰键不同:macOS 使用 ⌘(Cmd),Windows / Linux 使用 Ctrl。下文表格两列并列对照,功能一致。

## 全局快捷键

在编辑器与输入框之外生效,聚焦编辑器或输入框时不会抢按键。

| macOS | Windows/Linux | 功能 |
| --- | --- | --- |
| ⌘K | Ctrl+K | 打开命令面板 |
| ⌘R | Ctrl+R | 刷新当前标签(编辑器或输入框聚焦时除外) |
| ⌘D | Ctrl+D | 关闭当前标签(编辑器或输入框聚焦时除外) |
| Esc | Esc | 关闭右键菜单 / 弹窗 |

## SQL 控制台

编辑器聚焦时生效,适用于 Kafka / ClickHouse / MySQL / PostgreSQL / ES 各 SQL 控制台。

| macOS | Windows/Linux | 功能 |
| --- | --- | --- |
| ⌘S | Ctrl+S | 保存 SQL 文件(未关联文件时弹名称输入,已关联直接覆盖,重名需确认) |
| ⌘Enter | Ctrl+Enter | 执行当前语句(有选区时执行选中部分) |
| ⌘Shift+Enter | Ctrl+Shift+Enter | 运行全部语句 |
| ⌘D | Ctrl+D | **新增** 复制当前行到下一行,光标移至新行,支持多光标 |

## 编辑器通用

CodeMirror 默认常用项,在 SQL 编辑器聚焦时生效。

| macOS | Windows/Linux | 功能 |
| --- | --- | --- |
| ⌘Z | Ctrl+Z | 撤销 |
| ⌘Shift+Z | Ctrl+Y | 重做 |
| ⌘F | Ctrl+F | 查找 |
| ⌘A | Ctrl+A | 全选 |
| ⌘/ | Ctrl+/ | 注释当前行 |

## 提示

- 全局快捷键在编辑器之外生效;SQL 控制台快捷键在编辑器聚焦时生效。
- ⌘D / Ctrl+D 具有双语义:编辑器内是**复制当前行**,编辑器之外是**关闭当前标签**。
