package service

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// 本地 ES SQL→DSL 翻译器:服务端没有任何 SQL 端点时(如 ES 6.1 OSS),
// Execute 用它把 SQL 在客户端翻译成 _search/_count 可执行的 DSL 再走 REST。
// 零新依赖,手写 tokenizer + 递归下降解析。支持子集:
//
//	SELECT *|字段列表 FROM 索引 [AS 别名] [WHERE 条件]
//	  [ORDER BY 字段 [ASC|DESC], ...] [LIMIT n [OFFSET m] | LIMIT m, n]
//	SELECT COUNT(*) FROM 索引 [WHERE 条件]
//	SHOW TABLES [LIKE '模式']
//	DESCRIBE|DESC 索引
//
// WHERE 谓词支持 =/!=/<>/比较/LIKE/IN/IS [NOT] NULL/BETWEEN/AND/OR/NOT 与
// 括号嵌套(优先级 NOT>AND>OR);字段名支持点路径并自动剥离 FROM 别名前缀;
// 值支持字符串('' 转义)、整数/浮点(含负号)与 TRUE/FALSE。JOIN、GROUP BY、
// HAVING、函数列(除 COUNT(*))、子查询、DISTINCT 报「本地翻译不支持」;
// 冒号(粘贴的 query_string)报「无法翻译的语法」。

// EsSqlStatement 是一条翻译后的语句:Kind 决定执行端点(select→_search、
// count→_count、show→_cat 索引列表、describe→_mapping),Where 携带翻译好
// 的 query 子句 JSON(nil 表示 match_all)。
type EsSqlStatement struct {
	Kind       string // "select" | "count" | "show" | "describe"
	Index      string
	Columns    []string // select 字段(* 表示全部);count 时 ["COUNT(*)"]
	Where      []byte   // 翻译好的 query 子句 JSON(nil=match_all)
	Sort       []map[string]map[string]string
	From, Size int
	Like       string // show 的 LIKE 模式(空=全部)
}

// esTranslatePageSize 是 SELECT 无 LIMIT 时的默认页大小(对齐同类工具 DBX
// 的自动分页粒度;单页执行,不做 cursor 续拉)。
const esTranslatePageSize = 100

// esUnsupported 报「超出支持子集」类翻译错误(SQL 合法但翻译器不支持)。
func esUnsupported(why string) error {
	return fmt.Errorf("本地翻译不支持:%s;请使用 DSL 模式或升级到含 SQL 的服务端", why)
}

// esUntranslatable 报「无法翻译的语法」类错误(tokenize/解析失败)。
func esUntranslatable(why string) error {
	return fmt.Errorf("无法翻译的语法:%s", why)
}

// TranslateEsSQL 把单条 SQL 翻译为 ES 请求描述;超出支持子集或语法无法
// 解析时返回错误。
func TranslateEsSQL(sql string) (*EsSqlStatement, error) {
	toks, err := esTokenizeSQL(sql)
	if err != nil {
		return nil, err
	}
	p := &esSQLParser{toks: toks}
	st, err := p.parseStatement()
	if err != nil {
		return nil, err
	}
	if p.eatPunct(";") && !p.atEOF() {
		return nil, esUnsupported("一次只允许一条语句")
	}
	if !p.atEOF() {
		return nil, esUnsupported("无法识别的子句「" + p.remainingText() + "」")
	}
	return st, nil
}

// --- tokenizer ---

type esSQLTokKind int

const (
	esTokEOF esSQLTokKind = iota
	esTokIdent
	esTokString
	esTokNumber
	esTokPunct
)

// esSQLToken 是一个词法单元:Text 对标识符/字符串是去引号后的内容(引号
// 双写已还原)、对数字是原文、对标点是原文;Quoted 标记带引号的标识符
// (不做关键字解释)。
type esSQLToken struct {
	Kind   esSQLTokKind
	Text   string
	Quoted bool
}

// esTokenizeSQL 把单条 SQL 切成 token:忽略 -- 行注释与 /* */ 块注释,
// 字符串 '...'(内部单引号靠双写转义),反引号/双引号标识符,大小写
// 原样保留;冒号按标点保留,由解析层报「不支持 query_string」。
func esTokenizeSQL(sql string) ([]esSQLToken, error) {
	var toks []esSQLToken
	n := len(sql)
	i := 0
	for i < n {
		c := sql[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
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
		case c == '\'':
			s, ni, ok := esScanQuoted(sql, i, '\'')
			if !ok {
				return nil, esUntranslatable("字符串未闭合")
			}
			toks = append(toks, esSQLToken{Kind: esTokString, Text: s})
			i = ni
		case c == '`' || c == '"':
			s, ni, ok := esScanQuoted(sql, i, c)
			if !ok {
				return nil, esUntranslatable("标识符引号未闭合")
			}
			toks = append(toks, esSQLToken{Kind: esTokIdent, Text: s, Quoted: true})
			i = ni
		case c >= '0' && c <= '9':
			j := i
			for j < n && sql[j] >= '0' && sql[j] <= '9' {
				j++
			}
			// 数字段的小数部分(logs.2026.01 这类索引名由解析层拼装)。
			if j+1 < n && sql[j] == '.' && sql[j+1] >= '0' && sql[j+1] <= '9' {
				j++
				for j < n && sql[j] >= '0' && sql[j] <= '9' {
					j++
				}
			}
			toks = append(toks, esSQLToken{Kind: esTokNumber, Text: sql[i:j]})
			i = j
		case isEsIdentStart(c):
			j := i
			for j < n && isEsIdentPart(sql[j]) {
				j++
			}
			toks = append(toks, esSQLToken{Kind: esTokIdent, Text: sql[i:j]})
			i = j
		default:
			// 两字标点优先(!= <> >= <=)。
			if i+1 < n {
				switch sql[i : i+2] {
				case "!=", "<>", ">=", "<=":
					toks = append(toks, esSQLToken{Kind: esTokPunct, Text: sql[i : i+2]})
					i += 2
					continue
				}
			}
			if strings.IndexByte("=<>(),.*-;:", c) >= 0 {
				toks = append(toks, esSQLToken{Kind: esTokPunct, Text: sql[i : i+1]})
				i++
				continue
			}
			return nil, esUntranslatable(fmt.Sprintf("无法识别的字符 %q", string(c)))
		}
	}
	toks = append(toks, esSQLToken{Kind: esTokEOF})
	return toks, nil
}

func isEsIdentStart(c byte) bool {
	return c == '_' || c == '$' || c == '#' || c == '@' ||
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isEsIdentPart(c byte) bool { return isEsIdentStart(c) || (c >= '0' && c <= '9') }

// esScanQuoted 从 start(指向开引号)扫描一段引号内容,” / “ / "" 双写
// 转义为单个引号,返回内容与结束后的位置;未闭合返回 ok=false。
func esScanQuoted(sql string, start int, q byte) (string, int, bool) {
	var b strings.Builder
	i := start + 1
	n := len(sql)
	for i < n {
		c := sql[i]
		if c == q {
			if i+1 < n && sql[i+1] == q { // 双写转义
				b.WriteByte(q)
				i += 2
				continue
			}
			return b.String(), i + 1, true
		}
		b.WriteByte(c)
		i++
	}
	return "", start, false
}

// --- 解析器 ---

type esSQLParser struct {
	toks  []esSQLToken
	pos   int
	alias string // FROM 子句的表别名,用于字段前缀剥离
}

func (p *esSQLParser) peek() esSQLToken { return p.toks[p.pos] }

func (p *esSQLParser) next() esSQLToken {
	t := p.toks[p.pos]
	if t.Kind != esTokEOF {
		p.pos++
	}
	return t
}

func (p *esSQLParser) atEOF() bool { return p.peek().Kind == esTokEOF }

// lookaheadPunct 展望下一个 token 是否为给定标点(当前 token 非 EOF 时
// pos+1 必然存在)。
func (p *esSQLParser) lookaheadPunct(s string) bool {
	nx := p.toks[p.pos+1]
	return nx.Kind == esTokPunct && nx.Text == s
}

// isKeyword 判断当前 token 是否为未加引号的给定关键字(大小写不敏感)。
func (p *esSQLParser) isKeyword(kw string) bool {
	t := p.peek()
	return t.Kind == esTokIdent && !t.Quoted && strings.EqualFold(t.Text, kw)
}

func (p *esSQLParser) eatKeyword(kw string) bool {
	if p.isKeyword(kw) {
		p.next()
		return true
	}
	return false
}

func (p *esSQLParser) isPunct(s string) bool {
	t := p.peek()
	return t.Kind == esTokPunct && t.Text == s
}

func (p *esSQLParser) eatPunct(s string) bool {
	if p.isPunct(s) {
		p.next()
		return true
	}
	return false
}

// remainingText 拼出当前未消费的 token 文本(截断到 60 字符)用于报错。
func (p *esSQLParser) remainingText() string {
	var parts []string
	for i := p.pos; i < len(p.toks) && p.toks[i].Kind != esTokEOF; i++ {
		parts = append(parts, p.toks[i].Text)
	}
	s := strings.Join(parts, " ")
	if len(s) > 60 {
		s = s[:60] + "…"
	}
	return s
}

// parseStatement 按首关键字分派四种语句形态。
func (p *esSQLParser) parseStatement() (*EsSqlStatement, error) {
	switch {
	case p.isKeyword("SELECT"):
		return p.parseSelect()
	case p.isKeyword("SHOW"):
		p.next()
		if !p.eatKeyword("TABLES") {
			return nil, esUnsupported("SHOW 仅支持 TABLES")
		}
		st := &EsSqlStatement{Kind: "show"}
		if p.eatKeyword("LIKE") {
			t := p.peek()
			if t.Kind != esTokString && !(t.Kind == esTokIdent && t.Quoted) {
				return nil, esUntranslatable("SHOW TABLES LIKE 需要带引号的字符串模式")
			}
			p.next()
			st.Like = t.Text
		}
		return st, nil
	case p.isKeyword("DESCRIBE"), p.isKeyword("DESC"):
		p.next()
		idx, ok := p.tryParseIndexName()
		if !ok {
			return nil, esUntranslatable("DESCRIBE 后必须是索引名")
		}
		return &EsSqlStatement{Kind: "describe", Index: idx}, nil
	default:
		return nil, esUnsupported(fmt.Sprintf("仅支持 SELECT/SHOW/DESCRIBE 语句,收到 %q", p.peek().Text))
	}
}

// parseSelect 解析 SELECT(含 COUNT(*) 特判)与 FROM/WHERE/ORDER BY/LIMIT。
func (p *esSQLParser) parseSelect() (*EsSqlStatement, error) {
	p.next() // SELECT
	if p.isKeyword("DISTINCT") {
		return nil, esUnsupported("DISTINCT")
	}
	// COUNT(*) → count 语句(字段恰好名为 count 时走普通列路径)。
	if p.isKeyword("COUNT") && p.lookaheadPunct("(") {
		p.next() // COUNT
		p.next() // (
		if !p.isPunct("*") {
			return nil, esUnsupported("COUNT 仅支持 COUNT(*) 形式")
		}
		p.next()
		if !p.eatPunct(")") {
			return nil, esUntranslatable("COUNT(*) 括号未闭合")
		}
		if p.eatKeyword("AS") {
			if t := p.peek(); t.Kind != esTokIdent {
				return nil, esUntranslatable("AS 后必须是别名")
			}
			p.next()
		}
		st := &EsSqlStatement{Kind: "count", Columns: []string{"COUNT(*)"}}
		if !p.eatKeyword("FROM") {
			return nil, esUnsupported("缺少 FROM 子句")
		}
		if err := p.parseIndexAndAlias(st); err != nil {
			return nil, err
		}
		if err := p.parseWhere(st); err != nil {
			return nil, err
		}
		return st, nil
	}

	var cols []string
	star := false
	for {
		switch {
		case p.isPunct("*"):
			p.next()
			star = true
			cols = append(cols, "*")
		case p.peek().Kind == esTokIdent:
			if p.lookaheadPunct("(") {
				return nil, esUnsupported(fmt.Sprintf("函数列「%s」(仅支持 COUNT(*))", p.peek().Text))
			}
			name, err := p.parseFieldName()
			if err != nil {
				return nil, err
			}
			cols = append(cols, name)
		default:
			return nil, esUnsupported(fmt.Sprintf(
				"SELECT 列表仅支持 * 或字段名,收到 %q(常量/表达式不支持)", p.peek().Text))
		}
		if !p.eatPunct(",") {
			break
		}
		if star {
			return nil, esUnsupported("* 不能与字段列表混用")
		}
	}
	if star && len(cols) > 1 {
		return nil, esUnsupported("* 不能与字段列表混用")
	}

	st := &EsSqlStatement{Kind: "select", Columns: cols}
	if !p.eatKeyword("FROM") {
		return nil, esUnsupported("缺少 FROM 子句")
	}
	if err := p.parseIndexAndAlias(st); err != nil {
		return nil, err
	}
	// 列名解析在 FROM 之前,别名此时才可知:这里统一剥离前缀。
	for i, c := range st.Columns {
		st.Columns[i] = p.stripAlias(c)
	}
	if err := p.parseWhere(st); err != nil {
		return nil, err
	}
	if p.eatKeyword("ORDER") {
		if !p.eatKeyword("BY") {
			return nil, esUntranslatable("ORDER 后必须是 BY")
		}
		for {
			f, err := p.parseFieldName()
			if err != nil {
				return nil, err
			}
			f = p.stripAlias(f)
			dir := "asc"
			if p.eatKeyword("DESC") {
				dir = "desc"
			} else {
				p.eatKeyword("ASC")
			}
			st.Sort = append(st.Sort, map[string]map[string]string{f: {"order": dir}})
			if !p.eatPunct(",") {
				break
			}
		}
	}
	limited := false
	if p.eatKeyword("LIMIT") {
		limited = true
		n, err := p.parseIntLiteral()
		if err != nil {
			return nil, err
		}
		if p.eatPunct(",") { // LIMIT m, n:偏移在前,条数在后
			m, err := p.parseIntLiteral()
			if err != nil {
				return nil, err
			}
			st.From, st.Size = n, m
		} else {
			st.Size = n
			if p.eatKeyword("OFFSET") {
				m, err := p.parseIntLiteral()
				if err != nil {
					return nil, err
				}
				st.From = m
			}
		}
	}
	if !limited {
		st.Size = esTranslatePageSize
	}
	return st, nil
}

// parseIndexAndAlias 解析 FROM 后的索引名与可选别名([AS] 别名)。
func (p *esSQLParser) parseIndexAndAlias(st *EsSqlStatement) error {
	idx, ok := p.tryParseIndexName()
	if !ok {
		return esUnsupported("FROM 后必须是单个索引名(不支持子查询/函数/多索引)")
	}
	st.Index = idx
	if p.eatKeyword("AS") {
		t := p.peek()
		if t.Kind != esTokIdent {
			return esUntranslatable("AS 后必须是别名")
		}
		p.next()
		p.alias = t.Text
		return nil
	}
	// 裸别名:未加引号且不是子句关键字的标识符。
	if t := p.peek(); t.Kind == esTokIdent && !t.Quoted && !isEsClauseKeyword(t.Text) {
		p.next()
		p.alias = t.Text
	}
	return nil
}

// tryParseIndexName 解析索引名:基础标识符后允许 . / - 连接的段(标识符或
// 数字)与通配 * (logs-2026.* / logs-* 等);不是标识符开头时返回 false。
func (p *esSQLParser) tryParseIndexName() (string, bool) {
	t := p.peek()
	if t.Kind != esTokIdent {
		return "", false
	}
	p.next()
	name := t.Text
	for {
		if p.isPunct(".") || p.isPunct("-") {
			sep := p.peek().Text
			nx := p.toks[p.pos+1]
			if nx.Kind == esTokIdent || nx.Kind == esTokNumber {
				p.next() // 分隔符
				name += sep + p.next().Text
				continue
			}
			if nx.Kind == esTokPunct && nx.Text == "*" {
				p.next() // 分隔符
				p.next() // *
				name += sep + "*"
				continue
			}
			break // 悬空分隔符:留给外层的尾随检查报错
		}
		break
	}
	return name, true
}

// isEsClauseKeyword 判断一个裸标识符是否为保留关键字(不能当作表别名)。
func isEsClauseKeyword(text string) bool {
	switch strings.ToUpper(text) {
	case "SELECT", "FROM", "WHERE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
		"OFFSET", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS",
		"ON", "UNION", "AS", "AND", "OR", "NOT", "LIKE", "IN", "IS", "NULL",
		"BETWEEN", "ASC", "DESC", "DISTINCT", "SHOW", "TABLES", "DESCRIBE",
		"COUNT", "TRUE", "FALSE":
		return true
	}
	return false
}

// parseFieldName 解析字段名:ident('.'ident)* 的点路径(保留原文,别名
// 前缀由调用方在 FROM 解析后用 stripAlias 剥离);遇到冒号直接报
// 「无法翻译的语法」(多半是粘贴了 query_string)。
func (p *esSQLParser) parseFieldName() (string, error) {
	t := p.peek()
	if t.Kind != esTokIdent {
		return "", esUntranslatable(fmt.Sprintf("字段名位置收到 %q", t.Text))
	}
	p.next()
	name := t.Text
	for {
		if p.isPunct(".") {
			if nx := p.toks[p.pos+1]; nx.Kind != esTokIdent {
				if nx.Kind == esTokPunct && nx.Text == "*" {
					return "", esUnsupported("不支持 t.* 形式的字段")
				}
				return "", esUntranslatable("字段路径 . 后必须是字段名")
			}
			p.next()
			name += "." + p.next().Text
			continue
		}
		if p.isPunct(":") {
			return "", esUntranslatable("字段名后出现 \":\":不支持 query_string 形式的条件,请改写为标准 SQL 谓词")
		}
		break
	}
	return name, nil
}

// stripAlias 剥离字段名首段与 FROM 别名(大小写不敏感)一致的前缀:
// t.field → field;无别名或不匹配时原样返回(host.ip 是合法文档路径)。
func (p *esSQLParser) stripAlias(name string) string {
	if p.alias == "" {
		return name
	}
	if i := strings.IndexByte(name, '.'); i > 0 && strings.EqualFold(name[:i], p.alias) {
		return name[i+1:]
	}
	return name
}

// parseWhere 解析可选 WHERE 子句并序列化为 query 子句 JSON。
func (p *esSQLParser) parseWhere(st *EsSqlStatement) error {
	if !p.eatKeyword("WHERE") {
		return nil
	}
	node, err := p.parseOr()
	if err != nil {
		return err
	}
	b, err := json.Marshal(node)
	if err != nil {
		return fmt.Errorf("翻译 WHERE 失败: %w", err)
	}
	st.Where = b
	return nil
}

// --- WHERE 表达式:优先级 OR < AND < NOT < 谓词/括号 ---

func (p *esSQLParser) parseOr() (any, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.eatKeyword("OR") {
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = esBoolCombine(left, "or", right)
	}
	return left, nil
}

func (p *esSQLParser) parseAnd() (any, error) {
	left, err := p.parseNot()
	if err != nil {
		return nil, err
	}
	for p.eatKeyword("AND") {
		right, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		left = esBoolCombine(left, "and", right)
	}
	return left, nil
}

func (p *esSQLParser) parseNot() (any, error) {
	if p.eatKeyword("NOT") {
		inner, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return esNegate(inner), nil
	}
	return p.parsePrimary()
}

func (p *esSQLParser) parsePrimary() (any, error) {
	if p.eatPunct("(") {
		node, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if !p.eatPunct(")") {
			return nil, esUntranslatable("括号未闭合")
		}
		return node, nil
	}
	return p.parsePredicate()
}

// parsePredicate 解析单个比较/LIKE/IN/IS NULL/BETWEEN 谓词(含 NOT 变体)。
func (p *esSQLParser) parsePredicate() (any, error) {
	raw, err := p.parseFieldName()
	if err != nil {
		return nil, err
	}
	field := p.stripAlias(raw)
	// 后缀 NOT:仅允许 NOT LIKE / NOT IN / NOT BETWEEN。
	negate := false
	if p.isKeyword("NOT") {
		if nx := p.toks[p.pos+1]; nx.Kind == esTokIdent && !nx.Quoted {
			switch strings.ToUpper(nx.Text) {
			case "LIKE", "IN", "BETWEEN":
				negate = true
				p.next()
			}
		}
		if !negate {
			return nil, esUntranslatable("字段后 NOT 只允许 LIKE/IN/BETWEEN(布尔 NOT 请放在条件前)")
		}
	}
	switch {
	case p.isKeyword("LIKE"):
		p.next()
		t := p.peek()
		if t.Kind != esTokString && !(t.Kind == esTokIdent && t.Quoted) {
			return nil, esUntranslatable("LIKE 需要带引号的字符串模式")
		}
		p.next()
		return esLikeClause(field, t.Text, negate), nil
	case p.isKeyword("IN"):
		p.next()
		if !p.eatPunct("(") {
			return nil, esUntranslatable("IN 后必须是 (")
		}
		var vals []any
		for {
			v, err := p.parseValueLiteral()
			if err != nil {
				return nil, err
			}
			vals = append(vals, v)
			if p.eatPunct(",") {
				continue
			}
			break
		}
		if !p.eatPunct(")") {
			return nil, esUntranslatable("IN 列表括号未闭合")
		}
		cl := any(map[string]any{"terms": map[string]any{field: vals}})
		if negate {
			cl = esNegate(cl)
		}
		return cl, nil
	case p.isKeyword("BETWEEN"):
		p.next()
		lo, err := p.parseValueLiteral()
		if err != nil {
			return nil, err
		}
		if !p.eatKeyword("AND") {
			return nil, esUntranslatable("BETWEEN 必须是 a AND b 形式")
		}
		hi, err := p.parseValueLiteral()
		if err != nil {
			return nil, err
		}
		cl := any(map[string]any{"range": map[string]any{field: map[string]any{"gte": lo, "lte": hi}}})
		if negate {
			cl = esNegate(cl)
		}
		return cl, nil
	case p.isKeyword("IS"):
		p.next()
		isNot := p.eatKeyword("NOT")
		if !p.eatKeyword("NULL") {
			return nil, esUntranslatable("IS 后必须是 [NOT] NULL")
		}
		exists := any(map[string]any{"exists": map[string]any{"field": field}})
		if isNot {
			return exists, nil
		}
		return esNegate(exists), nil
	case p.isPunct("="), p.isPunct("!="), p.isPunct("<>"),
		p.isPunct(">"), p.isPunct(">="), p.isPunct("<"), p.isPunct("<="):
		op := p.next().Text
		v, err := p.parseValueLiteral()
		if err != nil {
			return nil, err
		}
		switch op {
		case "=":
			return map[string]any{"term": map[string]any{field: v}}, nil
		case "!=", "<>":
			return esNegate(map[string]any{"term": map[string]any{field: v}}), nil
		default:
			key := map[string]string{">": "gt", ">=": "gte", "<": "lt", "<=": "lte"}[op]
			return map[string]any{"range": map[string]any{field: map[string]any{key: v}}}, nil
		}
	}
	return nil, esUntranslatable(fmt.Sprintf("字段 %q 后缺少可翻译的比较谓词", field))
}

// parseValueLiteral 解析谓词值:字符串字面量(保留原文)、整数/浮点
// (支持负号)、TRUE/FALSE;与 NULL 直接比较、裸标识符值均不支持。
func (p *esSQLParser) parseValueLiteral() (any, error) {
	t := p.peek()
	switch {
	case t.Kind == esTokString:
		p.next()
		return t.Text, nil
	case t.Kind == esTokNumber:
		p.next()
		return esNumberAny(t.Text), nil
	case t.Kind == esTokPunct && t.Text == "-":
		p.next()
		nx := p.peek()
		if nx.Kind != esTokNumber {
			return nil, esUntranslatable("- 后必须是数字")
		}
		p.next()
		switch n := esNumberAny(nx.Text).(type) {
		case int64:
			return -n, nil
		case float64:
			return -n, nil
		default:
			return nil, esUntranslatable(fmt.Sprintf("数字 %q 无法解析", nx.Text))
		}
	case t.Kind == esTokIdent && !t.Quoted:
		up := strings.ToUpper(t.Text)
		p.next()
		switch up {
		case "TRUE":
			return true, nil
		case "FALSE":
			return false, nil
		case "NULL":
			return nil, esUntranslatable("不支持与 NULL 直接比较,请使用 IS [NOT] NULL")
		}
		return nil, esUntranslatable(fmt.Sprintf("不支持的值 %q(字符串需要单引号)", t.Text))
	}
	return nil, esUntranslatable(fmt.Sprintf("不支持的值 %q(仅支持字符串/数字/布尔字面量)", t.Text))
}

// parseIntLiteral 解析 LIMIT/OFFSET 的整数。
func (p *esSQLParser) parseIntLiteral() (int, error) {
	t := p.peek()
	if t.Kind != esTokNumber {
		return 0, esUntranslatable(fmt.Sprintf("需要整数,收到 %q", t.Text))
	}
	n, err := strconv.Atoi(t.Text)
	if err != nil {
		return 0, esUntranslatable(fmt.Sprintf("整数 %q 超出范围", t.Text))
	}
	p.next()
	return n, nil
}

// --- DSL 节点构造与通配匹配(纯函数) ---

// esBoolCombine 按 op("and"|"or") 把 right 折入 left:同构 bool 子句展开
// 合并(and→filter 数组,or→should 数组),否则新建 bool 节点。
func esBoolCombine(left any, op string, right any) any {
	key := "filter"
	if op == "or" {
		key = "should"
	}
	if m, ok := left.(map[string]any); ok {
		if b, ok := m["bool"].(map[string]any); ok {
			if arr, ok := b[key].([]any); ok {
				// and 只可能产生 filter、or 只可能产生 should(带
				// minimum_should_match),按 key 判同构是安全的。
				b[key] = append(arr, right)
				return m
			}
		}
	}
	inner := map[string]any{key: []any{left, right}}
	if op == "or" {
		inner["minimum_should_match"] = 1
	}
	return map[string]any{"bool": inner}
}

// esNegate 把子句包一层 bool must_not。
func esNegate(inner any) any {
	return map[string]any{"bool": map[string]any{"must_not": []any{inner}}}
}

// esLikeClause 把 LIKE 模式翻译为 wildcard(%→*、_→?),不含通配符时退化
// 为 term 精确匹配;negate 时包一层 bool must_not。
func esLikeClause(field, pattern string, negate bool) any {
	var cl any
	if !strings.ContainsAny(pattern, "%_") {
		cl = map[string]any{"term": map[string]any{field: pattern}}
	} else {
		wc := strings.NewReplacer("%", "*", "_", "?").Replace(pattern)
		cl = map[string]any{"wildcard": map[string]any{field: wc}}
	}
	if negate {
		return esNegate(cl)
	}
	return cl
}

// esNumberAny 把数字原文转成 JSON 数值:优先整数,否则浮点。
func esNumberAny(text string) any {
	if i, err := strconv.ParseInt(text, 10, 64); err == nil {
		return i
	}
	f, _ := strconv.ParseFloat(text, 64)
	return f
}

// esLikeMatch 以大小写不敏感的 fnmatch 风格匹配 SQL LIKE 模式(%→*、_→?),
// 供 SHOW TABLES 回退过滤索引名。
func esLikeMatch(pattern, name string) bool {
	return esGlobMatch(strings.NewReplacer("%", "*", "_", "?").Replace(pattern), name)
}

// esGlobMatch 支持 * 与 ? 的大小写不敏感通配匹配(单点回溯实现)。
func esGlobMatch(pattern, s string) bool {
	p := strings.ToLower(pattern)
	t := strings.ToLower(s)
	pi, ti := 0, 0
	star, mark := -1, 0
	for ti < len(t) {
		switch {
		case pi < len(p) && (p[pi] == '?' || p[pi] == t[ti]):
			pi++
			ti++
		case pi < len(p) && p[pi] == '*':
			star, mark = pi, ti
			pi++
		case star >= 0:
			pi = star + 1
			mark++
			ti = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}
