package service

import (
	"strings"
)

// SplitPostgresStatements is PostgreSQL's statement splitter. It is separate
// from the shared splitter because PostgreSQL adds dollar-quoted strings
// ($$...$$ and $tag$...$tag$) and uses standard string escaping: a backslash
// is only significant in E'...' strings. Comments, double-quoted identifiers,
// ordinary strings and dollar bodies therefore cannot terminate a statement.
func SplitPostgresStatements(sqlText string) []string {
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
		case c == '\'':
			hasContent = true
			i = consumePostgresString(sqlText, i, &buf)
		case c == '"':
			hasContent = true
			i = consumePostgresDoubleQuotedIdentifier(sqlText, i, &buf)
		case c == '$':
			if end, ok := postgresDollarQuotedEnd(sqlText, i); ok {
				hasContent = true
				buf.WriteString(sqlText[i:end])
				i = end
			} else {
				hasContent = true
				buf.WriteByte(c)
				i++
			}
		case c == '-' && i+1 < n && sqlText[i+1] == '-':
			for i < n && sqlText[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && sqlText[i+1] == '*':
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
		default:
			if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
				hasContent = true
			}
			buf.WriteByte(c)
			i++
		}
	}
	flush()
	return out
}

// postgresDollarQuotedEnd returns the exclusive end of a dollar-quoted string
// starting at i, and reports false when i is an ordinary dollar character.
func postgresDollarQuotedEnd(s string, i int) (int, bool) {
	if i >= len(s) || s[i] != '$' {
		return i, false
	}
	close := i + 1
	for close < len(s) && s[close] != '$' {
		close++
	}
	if close >= len(s) {
		return i, false
	}
	tag := s[i+1 : close]
	if tag != "" && !isValidPostgresDollarTag(tag) {
		return i, false
	}
	terminator := s[i : close+1]
	end := strings.Index(s[close+1:], terminator)
	if end < 0 {
		return len(s), true
	}
	return close + 1 + end + len(terminator), true
}

// isValidPostgresDollarTag rejects parameter placeholders such as $1 while
// accepting the common $tag$ / $function$ openers.
func isValidPostgresDollarTag(tag string) bool {
	if tag == "" {
		return false
	}
	for i := 0; i < len(tag); i++ {
		c := tag[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '_':
		case i > 0 && c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return true
}

func isPostgresEscapeStringStart(s string, i int) bool {
	if i == 0 || s[i] != '\'' {
		return false
	}
	if i == 0 {
		return false
	}
	if c := s[i-1]; c != 'E' && c != 'e' {
		return false
	}
	// Reject identifier endings such as `value'` while accepting SQL whitespace
	// or an expression boundary before E.
	if i >= 2 {
		p := s[i-2]
		if p >= 'a' && p <= 'z' || p >= 'A' && p <= 'Z' || p >= '0' && p <= '9' || p == '_' || p == '$' {
			return false
		}
	}
	return true
}

// consumePostgresString consumes one PostgreSQL string. For standard strings
// only doubled quotes are escapes; for E'...' backslashes also escape the next
// byte. The returned position is just after the closing quote.
func consumePostgresString(s string, i int, buf *strings.Builder) int {
	escape := isPostgresEscapeStringStart(s, i)
	buf.WriteByte(s[i])
	i++
	for i < len(s) {
		if escape && s[i] == '\\' && i+1 < len(s) {
			buf.WriteString(s[i : i+2])
			i += 2
			continue
		}
		if s[i] == '\'' {
			if i+1 < len(s) && s[i+1] == '\'' {
				buf.WriteString(`''`)
				i += 2
				continue
			}
			buf.WriteByte('\'')
			return i + 1
		}
		buf.WriteByte(s[i])
		i++
	}
	return i
}

func consumePostgresDoubleQuotedIdentifier(s string, i int, buf *strings.Builder) int {
	buf.WriteByte('"')
	i++
	for i < len(s) {
		if s[i] == '"' {
			if i+1 < len(s) && s[i+1] == '"' {
				buf.WriteString(`""`)
				i += 2
				continue
			}
			buf.WriteByte('"')
			return i + 1
		}
		buf.WriteByte(s[i])
		i++
	}
	return i
}
