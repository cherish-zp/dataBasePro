package service

import (
	"strings"
)

// SplitSQLStatements splits a script on statement-terminating semicolons while
// respecting single quotes (backslash and doubled-quote escapes), double
// quotes, backtick identifiers, `--` line comments and `/* */` block comments.
// Chunks that hold no content beyond comments and whitespace are dropped;
// surviving statements are trimmed. Shared by every SQL console (ClickHouse,
// MySQL/TiDB, ...).
func SplitSQLStatements(sqlText string) []string {
	var (
		out        []string
		buf        strings.Builder
		hasContent bool
		flush      = func() {
			if s := strings.TrimSpace(buf.String()); hasContent && s != "" {
				out = append(out, s)
			}
			buf.Reset()
			hasContent = false
		}
	)
	n := len(sqlText)
	i := 0
	for i < n {
		c := sqlText[i]
		switch {
		case c == '\'' || c == '"' || c == '`':
			buf.WriteByte(c)
			i++
			for i < n {
				ch := sqlText[i]
				// 反斜杠转义仅存在于引号字符串;标识符反引号靠双写转义。
				if c != '`' && ch == '\\' && i+1 < n {
					buf.WriteString(sqlText[i : i+2])
					i += 2
					continue
				}
				if ch == c {
					buf.WriteByte(ch)
					i++
					// 双写引号仍在字符串内(''、" "、``)。
					if i < n && sqlText[i] == c {
						buf.WriteByte(c)
						i++
						continue
					}
					break
				}
				buf.WriteByte(ch)
				i++
			}
		case c == '-' && i+1 < n && sqlText[i+1] == '-':
			// 行注释:吞到换行前,不写入缓冲。
			for i < n && sqlText[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && sqlText[i+1] == '*':
			// 块注释:折叠为单个空格,保留词法边界。
			i += 2
			for i+1 < n && !(sqlText[i] == '*' && sqlText[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
			buf.WriteByte(' ')
		case c == ';':
			i++
			flush()
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			buf.WriteByte(c)
			i++
		default:
			hasContent = true
			buf.WriteByte(c)
			i++
		}
	}
	flush()
	return out
}
