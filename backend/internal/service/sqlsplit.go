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

// --- SQL 控制台服务端分页共享辅助(MySQL/ClickHouse/PostgreSQL/ES 共用) ---

// sqlStatementWrappable 报告语句首关键字是否为 SELECT/WITH:这类语句可以
// 安全地被子查询包装做服务端分页。SHOW/DESC/EXPLAIN 等返回行但不能包装的
// 语句由调用方走「消费 offset+limit 行」的客户端截断回退。
func sqlStatementWrappable(stmt string) bool {
	first := stmt
	if i := strings.IndexAny(stmt, " \t\n\r("); i >= 0 {
		first = stmt[:i]
	}
	switch strings.ToUpper(first) {
	case "SELECT", "WITH":
		return true
	}
	return false
}

// stripTrailingSemicolon 去掉语句尾部残留的分号与空白(包装为子查询时,
// 分号会破坏语法;SplitSQLStatements 拆出的语句通常已无尾分号,防御性兜底)。
func stripTrailingSemicolon(stmt string) string {
	return strings.TrimRight(stmt, " \t\r\n;")
}

// slicePageRows 对已在内存中的行集做客户端分页截断:返回 offset 起至多
// limit 行的本页,以及是否取满 limit 行(full=true 表示结果可能未耗尽)。
func slicePageRows(rows [][]*string, limit, offset int) ([][]*string, bool) {
	if offset > len(rows) {
		offset = len(rows)
	}
	end := offset + limit
	if limit <= 0 || end > len(rows) {
		end = len(rows)
	}
	page := rows[offset:end]
	return page, limit > 0 && len(page) == limit
}

// fallbackTotalRows 计算截断回退路径的 total_rows:取满 limit 行说明结果集
// 可能还有更多数据,总数未知(-1);未取满说明已耗尽,总数=offset+本页行数。
func fallbackTotalRows(full bool, offset, pageLen int) *int64 {
	if full {
		v := int64(-1)
		return &v
	}
	v := int64(offset + pageLen)
	return &v
}

// isSQLWordByte 报告 c 是否属于 SQL 单词字符(字母/数字/下划线/美元)。
func isSQLWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' ||
		c >= '0' && c <= '9' || c == '_' || c == '$'
}

// skipGenericQuoted 跳过一个引号包裹的 token(单引号字符串/双引号标识符/
// 反引号标识符),返回结束引号之后的下标:双写引号仍在串内,单引号字符串
// 另支持反斜杠转义(MySQL/CH 语义;PostgreSQL 标准串中反斜杠是普通字符,
// 误吞只会让扫描更保守,不影响正确性)。i 应指向引号起始字节。
func skipGenericQuoted(s string, i int) int {
	q := s[i]
	i++
	for i < len(s) {
		if q != '`' && s[i] == '\\' && i+1 < len(s) {
			i += 2
			continue
		}
		if s[i] == q {
			i++
			if i < len(s) && s[i] == q {
				continue // 双写引号仍在串内
			}
			return i
		}
		i++
	}
	return i
}

// sqlNextWord 返回 from 起跳过空白与注释后的下一个单词(大写);紧邻字符
// 不是单词起始或已到结尾时返回空串。
func sqlNextWord(s string, from int) string {
	n := len(s)
	i := from
	for i < n {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '-' && i+1 < n && s[i+1] == '-':
			for i < n && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && s[i+1] == '*':
			i += 2
			for i+1 < n && !(s[i] == '*' && s[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
		case isSQLWordByte(c):
			j := i
			for j < n && isSQLWordByte(s[j]) {
				j++
			}
			return strings.ToUpper(s[i:j])
		default:
			return ""
		}
	}
	return ""
}

// splitTrailingTopLevelOrderBy 尝试从语句顶层安全外提位于结尾的 ORDER BY
// 子句。派生表(MySQL 8/PostgreSQL)不保证保留子查询内的 ORDER BY,包装
// 分页后跨页顺序可能不稳;因此在包装前,若语句顶层(括号深度 0,引号/注释
// /美元体之外)以 ORDER BY 结尾、且其后没有 LIMIT/OFFSET/FETCH/FOR 等
// 尾巴子句,就把该 ORDER BY 原样外提交给包装外层执行。返回 head(去尾后的
// 语句前段)与 order(以 ORDER BY 开头的原文片段);不满足安全条件时
// ok=false,调用方保持原样整句包装。调用前应已去除尾分号;扫描中遇到顶层
// 分号同样视为语句结束(外提片段截止于分号之前)。
func splitTrailingTopLevelOrderBy(sql string) (head, order string, ok bool) {
	var (
		n                   = len(sql)
		i, depth            = 0, 0
		lastOrder, lastDeny = -1, -1
		end                 = n
	)
	for i < n {
		c := sql[i]
		switch {
		case c == '\'' || c == '"' || c == '`':
			i = skipGenericQuoted(sql, i)
		case c == '$':
			if e, dollar := postgresDollarQuotedEnd(sql, i); dollar {
				i = e
			} else {
				i++
			}
		case c == '-' && i+1 < n && sql[i+1] == '-':
			for i < n && sql[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && sql[i+1] == '*':
			i += 2
			for i+1 < n && !(sql[i] == '*' && sql[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
		case c == '(':
			depth++
			i++
		case c == ')':
			depth--
			if depth < 0 {
				return "", "", false // 括号不配对,保守放弃外提
			}
			i++
		case c == ';':
			// 顶层分号即语句结束;其后内容不属于本语句。
			end = i
			i = n
		case isSQLWordByte(c) && (i == 0 || !isSQLWordByte(sql[i-1])):
			j := i
			for j < n && isSQLWordByte(sql[j]) {
				j++
			}
			if depth == 0 {
				switch strings.ToUpper(sql[i:j]) {
				case "ORDER":
					if sqlNextWord(sql, j) == "BY" {
						lastOrder = i
					}
				case "LIMIT", "OFFSET", "FETCH", "FOR", "INTO", "PROCEDURE",
					"WINDOW", "UNION", "INTERSECT", "EXCEPT":
					lastDeny = i
				}
			}
			i = j
		default:
			i++
		}
	}
	if lastOrder < 0 || lastDeny > lastOrder || depth != 0 {
		return "", "", false
	}
	head = strings.TrimRight(sql[:lastOrder], " \t\r\n")
	order = strings.TrimRight(sql[lastOrder:end], " \t\r\n")
	if head == "" || order == "" {
		return "", "", false
	}
	return head, order, true
}

// skipPostgresQuoted 跳过一个 PostgreSQL 引号 token(E” 转义串/标准串/
// 双引号标识符),返回结束引号之后的下标。E” 串按反斜杠转义处理,标准串
// 与双引号标识符仅双写引号转义。i 应指向引号起始字节。
func skipPostgresQuoted(s string, i int) int {
	if isPostgresEscapeStringStart(s, i) {
		i++
		for i < len(s) {
			if s[i] == '\\' && i+1 < len(s) {
				i += 2
				continue
			}
			if s[i] == '\'' {
				return i + 1
			}
			i++
		}
		return i
	}
	q := s[i]
	i++
	for i < len(s) {
		if s[i] == q {
			i++
			if i < len(s) && s[i] == q {
				continue // 双写引号仍在串/标识符内
			}
			return i
		}
		i++
	}
	return i
}

// postgresStatementContainsDML 报告语句顶层(括号深度 0)或 WITH 之后第一层
// CTE 子查询(深度 1)中是否出现数据修改关键字(INSERT/UPDATE/DELETE/
// MERGE,引号、注释与美元体之外)。PostgreSQL 的数据修改 CTE
// (`WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d`)与
// `WITH ... DELETE` 形态若被子查询包装分页,包装执行一次、COUNT 计数再执行
// 一次会让 DML 生效两次;检测命中时调用方禁用包装与计数,改走客户端截断
// 回退。更深层(子查询内部)的数据修改在 PostgreSQL 语法上不可达,不扫描。
func postgresStatementContainsDML(stmt string) bool {
	n := len(stmt)
	i, depth := 0, 0
	for i < n {
		c := stmt[i]
		switch {
		case c == '\'' || c == '"':
			i = skipPostgresQuoted(stmt, i)
		case c == '$':
			if e, dollar := postgresDollarQuotedEnd(stmt, i); dollar {
				i = e
			} else {
				i++
			}
		case c == '-' && i+1 < n && stmt[i+1] == '-':
			for i < n && stmt[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && stmt[i+1] == '*':
			i += 2
			for i+1 < n && !(stmt[i] == '*' && stmt[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
		case c == '(':
			depth++
			i++
		case c == ')':
			depth--
			i++
		case isSQLWordByte(c) && (i == 0 || !isSQLWordByte(stmt[i-1])):
			j := i
			for j < n && isSQLWordByte(stmt[j]) {
				j++
			}
			if depth <= 1 {
				switch strings.ToUpper(stmt[i:j]) {
				case "INSERT", "UPDATE", "DELETE", "MERGE":
					return true
				}
			}
			i = j
		default:
			i++
		}
	}
	return false
}

// --- MySQL 方言:语句目标库名解析 ---

// skipMySQLSpacesAndComments 跳过空白与注释(-- 行注释、# 行注释、/* */ 块
// 注释),返回剩余串;注释未闭合时返回空串(语句非法,调用方按无限定处理)。
func skipMySQLSpacesAndComments(s string) string {
	for {
		s = strings.TrimLeft(s, " \t\r\n")
		switch {
		case strings.HasPrefix(s, "--"), strings.HasPrefix(s, "#"):
			i := strings.IndexAny(s, "\r\n")
			if i < 0 {
				return ""
			}
			s = s[i+1:]
		case strings.HasPrefix(s, "/*"):
			i := strings.Index(s, "*/")
			if i < 0 {
				return ""
			}
			s = s[i+2:]
		default:
			return s
		}
	}
}

// isMysqlIdentByte 报告裸标识符字符(字母/数字/_/$,未加引号的 MySQL 标识符
// 允许数字开头)。
func isMysqlIdentByte(c byte) bool {
	return c == '_' || c == '$' ||
		(c >= '0' && c <= '9') ||
		(c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z')
}

// takeMysqlQuotedIdent 解析反引号标识符(内部反引号双写转义),i 应指向起始
// 反引号;返回标识符原文与结束后的下标。未正确闭合时 ok=false。
func takeMysqlQuotedIdent(s string, i int) (ident string, next int, ok bool) {
	i++ // 跳过起始反引号
	var b strings.Builder
	for i < len(s) {
		if s[i] == '`' {
			if i+1 < len(s) && s[i+1] == '`' {
				b.WriteByte('`')
				i += 2
				continue
			}
			return b.String(), i + 1, true
		}
		b.WriteByte(s[i])
		i++
	}
	return "", len(s), false
}

// takeMysqlTargetObject 解析目标对象:一个标识符,可选 `. 标识符` 后缀。
// 返回限定库名(无限定返回空串)与剩余串。解析失败 ok=false(调用方按
// 无限定处理,回退选中库)。
func takeMysqlTargetObject(s string) (schema, rest string, ok bool) {
	s = skipMySQLSpacesAndComments(s)
	if s == "" {
		return "", "", false
	}
	var first string
	if s[0] == '`' {
		ident, next, ok2 := takeMysqlQuotedIdent(s, 0)
		if !ok2 {
			return "", "", false
		}
		first, s = ident, s[next:]
	} else if isMysqlIdentByte(s[0]) {
		j := 0
		for j < len(s) && isMysqlIdentByte(s[j]) {
			j++
		}
		first, s = s[:j], s[j:]
	} else {
		return "", "", false
	}
	s = skipMySQLSpacesAndComments(s)
	if !strings.HasPrefix(s, ".") {
		return "", s, true // 目标无限定
	}
	return first, s[1:], true
}

// mysqlStatementTargetSchema 解析 DML/DDL 语句目标对象携带的显式库名限定
// (引号与注释感知):INSERT/REPLACE/UPDATE/DELETE 与 TRUNCATE/DROP/ALTER/
// CREATE TABLE 的目标写作 `db`.`tbl`、db.tbl 时返回 db,无限定或无法可靠
// 解析时返回空串(调用方回退控制台选中库)。只认目标位置——语句体中后续
// 出现的 x.y(表别名.列、字符串字面量)不参与,避免误提取。
func mysqlStatementTargetSchema(stmt string) string {
	rest := skipMySQLSpacesAndComments(stmt)
	if rest == "" {
		return ""
	}
	// 首关键词。
	i := 0
	for i < len(rest) && isMysqlIdentByte(rest[i]) {
		i++
	}
	if i == 0 {
		return ""
	}
	keyword := strings.ToUpper(rest[:i])
	rest = rest[i:]

	switch keyword {
	case "INSERT", "REPLACE":
		// 消费修饰词:INSERT [IGNORE|DELAYED|HIGH_PRIORITY|LOW_PRIORITY] INTO
		for {
			rest = skipMySQLSpacesAndComments(rest)
			j := 0
			for j < len(rest) && isMysqlIdentByte(rest[j]) {
				j++
			}
			w := strings.ToUpper(rest[:j])
			if j == 0 || w == "INTO" {
				rest = rest[j:]
				break
			}
			switch w {
			case "IGNORE", "DELAYED", "HIGH_PRIORITY", "LOW_PRIORITY":
				rest = rest[j:]
				continue
			default:
				return ""
			}
		}
	case "UPDATE":
		// 目标紧跟 UPDATE。
	case "DELETE":
		rest = skipMySQLSpacesAndComments(rest)
		if !strings.HasPrefix(strings.ToUpper(rest[:minMysqlWordLen(rest)]), "FROM") || minMysqlWordLen(rest) != 4 {
			return ""
		}
		rest = rest[4:]
	case "TRUNCATE":
		rest = skipMySQLSpacesAndComments(rest)
		if strings.HasPrefix(strings.ToUpper(rest), "TABLE") && minMysqlWordLen(rest) == 5 {
			rest = rest[5:]
		}
	case "DROP", "ALTER", "CREATE":
		rest = skipMySQLSpacesAndComments(rest)
		// CREATE/DROP TEMPORARY TABLE;IF NOT EXISTS / DROP IF EXISTS。
		for {
			w := strings.ToUpper(rest[:minMysqlWordLen(rest)])
			switch w {
			case "TEMPORARY":
				rest = rest[minMysqlWordLen(rest):]
				rest = skipMySQLSpacesAndComments(rest)
				continue
			case "TABLE":
				rest = rest[minMysqlWordLen(rest):]
				rest = skipMySQLSpacesAndComments(rest)
				if strings.HasPrefix(strings.ToUpper(rest), "IF") && minMysqlWordLen(rest) == 2 {
					rest = rest[2:]
					rest = skipMySQLSpacesAndComments(rest)
					if strings.HasPrefix(strings.ToUpper(rest), "NOT") && minMysqlWordLen(rest) == 3 {
						rest = rest[3:]
						rest = skipMySQLSpacesAndComments(rest)
					}
					if strings.HasPrefix(strings.ToUpper(rest), "EXISTS") && minMysqlWordLen(rest) == 6 {
						rest = rest[6:]
					}
				}
			default:
				return ""
			}
			break
		}
	default:
		return ""
	}
	schema, _, ok := takeMysqlTargetObject(rest)
	if !ok {
		return ""
	}
	return schema
}

// minMysqlWordLen 返回 s 前导标识符词的长度(0 = 非标识符开头),供关键词
// 匹配前判断词边界。
func minMysqlWordLen(s string) int {
	n := 0
	for n < len(s) && isMysqlIdentByte(s[n]) {
		n++
	}
	return n
}
