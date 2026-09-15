package service

import (
	"reflect"
	"strings"
	"testing"
)

// --- 翻译器:TranslateEsSQL(纯函数) ---

// mustTranslate 封装 TranslateEsSQL:翻译失败立即 Fatal。
func mustTranslate(t *testing.T, sql string) *EsSqlStatement {
	t.Helper()
	st, err := TranslateEsSQL(sql)
	if err != nil {
		t.Fatalf("TranslateEsSQL(%q): %v", sql, err)
	}
	return st
}

// wantWhere 断言翻译出的 query 子句 JSON 与期望串一致(节点用 map 构造,
// 序列化按字母序,期望串按同构书写)。
func wantWhere(t *testing.T, st *EsSqlStatement, label, want string) {
	t.Helper()
	got := ""
	if st.Where != nil {
		got = string(st.Where)
	}
	if got != want {
		t.Fatalf("%s: where = %s, want %s", label, got, want)
	}
}

func TestTranslateEsSQLSelectBasics(t *testing.T) {
	// SELECT *:默认页大小、无 where/sort。
	st := mustTranslate(t, "SELECT * FROM logs")
	if st.Kind != "select" || st.Index != "logs" {
		t.Fatalf("kind/index = %q/%q", st.Kind, st.Index)
	}
	if len(st.Columns) != 1 || st.Columns[0] != "*" {
		t.Fatalf("columns = %v, want [ * ]", st.Columns)
	}
	if st.Where != nil || st.Sort != nil {
		t.Fatalf("no where/sort expected, got %+v", st)
	}
	if st.From != 0 || st.Size != esTranslatePageSize {
		t.Fatalf("default page = %d/%d, want 0/%d", st.From, st.Size, esTranslatePageSize)
	}

	// 显式列 + 日期数学风格的索引名(点分数字段)。
	st = mustTranslate(t, "SELECT title, level FROM logs-2026.01.08")
	if st.Index != "logs-2026.01.08" || strings.Join(st.Columns, ",") != "title,level" {
		t.Fatalf("index/columns = %q/%v", st.Index, st.Columns)
	}

	// 别名剥离:AS 与裸别名两种形态,点路径列同样剥离。
	st = mustTranslate(t, "SELECT l.level, l.meta.created FROM logs AS l")
	if strings.Join(st.Columns, ",") != "level,meta.created" {
		t.Fatalf("AS alias must be stripped: %v", st.Columns)
	}
	st = mustTranslate(t, "SELECT l.level FROM logs l WHERE l.level = 'ERROR'")
	wantWhere(t, st, "bare alias", `{"term":{"level":"ERROR"}}`)

	// 无别名的点路径字段保持原样(ES 合法文档路径)。
	st = mustTranslate(t, "SELECT host.ip FROM logs WHERE host.ip = '1.2.3.4'")
	if st.Columns[0] != "host.ip" {
		t.Fatalf("dotted column without alias must stay: %v", st.Columns)
	}
	wantWhere(t, st, "dotted field", `{"term":{"host.ip":"1.2.3.4"}}`)

	// 索引通配符与引号标识符(反引号/双引号)。
	st = mustTranslate(t, "SELECT * FROM `logs-*`")
	if st.Index != "logs-*" {
		t.Fatalf("backquoted pattern index = %q", st.Index)
	}
	st = mustTranslate(t, "SELECT `title` FROM \"my-index\"")
	if st.Index != "my-index" || st.Columns[0] != "title" {
		t.Fatalf("quoted identifiers: %q/%v", st.Index, st.Columns)
	}

	// 注释容忍(-- 行注释与 /* */ 块注释)。
	st = mustTranslate(t, "SELECT * /* block */ FROM logs -- trailing")
	if st.Index != "logs" {
		t.Fatalf("comments must be ignored, index = %q", st.Index)
	}

	// 尾部分号容忍(语句已由外层切分,这里仅兜底)。
	st = mustTranslate(t, "SELECT * FROM logs;")
	if st.Index != "logs" {
		t.Fatalf("trailing semicolon must be tolerated, index = %q", st.Index)
	}

	// 值字面量:字符串 '' 转义、布尔、负数,AND 折叠为 filter 数组。
	st = mustTranslate(t, "SELECT * FROM logs WHERE msg = 'it''s' AND flag = TRUE AND n = -5")
	wantWhere(t, st, "literals",
		`{"bool":{"filter":[{"term":{"msg":"it's"}},{"term":{"flag":true}},{"term":{"n":-5}}]}}`)
}

func TestTranslateEsSQLWherePredicates(t *testing.T) {
	cases := []struct {
		name  string
		where string
		want  string
	}{
		{"eq", "level = 'ERROR'", `{"term":{"level":"ERROR"}}`},
		{"not eq bang", "level != 'INFO'", `{"bool":{"must_not":[{"term":{"level":"INFO"}}]}}`},
		{"not eq angle", "level <> 'INFO'", `{"bool":{"must_not":[{"term":{"level":"INFO"}}]}}`},
		{"gt", "ts > 100", `{"range":{"ts":{"gt":100}}}`},
		{"gte float", "ts >= 1.5", `{"range":{"ts":{"gte":1.5}}}`},
		{"lt", "ts < 10", `{"range":{"ts":{"lt":10}}}`},
		{"lte", "ts <= 10", `{"range":{"ts":{"lte":10}}}`},
		{"like percent", "msg LIKE 'err%'", `{"wildcard":{"msg":"err*"}}`},
		{"like underscore", "msg LIKE 'a_b'", `{"wildcard":{"msg":"a?b"}}`},
		{"like no wildcard degrades to term", "msg LIKE 'exact'", `{"term":{"msg":"exact"}}`},
		{"not like", "msg NOT LIKE 'x%'", `{"bool":{"must_not":[{"wildcard":{"msg":"x*"}}]}}`},
		{"prefix not like", "NOT msg LIKE 'x%'", `{"bool":{"must_not":[{"wildcard":{"msg":"x*"}}]}}`},
		{"in strings", "level IN ('a', 'b')", `{"terms":{"level":["a","b"]}}`},
		{"in numbers", "n IN (1, 2, 3)", `{"terms":{"n":[1,2,3]}}`},
		{"not in", "level NOT IN ('a', 'b')", `{"bool":{"must_not":[{"terms":{"level":["a","b"]}}]}}`},
		{"is null", "note IS NULL", `{"bool":{"must_not":[{"exists":{"field":"note"}}]}}`},
		{"is not null", "note IS NOT NULL", `{"exists":{"field":"note"}}`},
		{"between", "n BETWEEN 1 AND 10", `{"range":{"n":{"gte":1,"lte":10}}}`},
		{"not between", "n NOT BETWEEN 1 AND 10", `{"bool":{"must_not":[{"range":{"n":{"gte":1,"lte":10}}}]}}`},
		{"and folds into filter", "a = 1 AND b = 2 AND c = 3",
			`{"bool":{"filter":[{"term":{"a":1}},{"term":{"b":2}},{"term":{"c":3}}]}}`},
		{"or with minimum_should_match", "a = 1 OR b = 2",
			`{"bool":{"minimum_should_match":1,"should":[{"term":{"a":1}},{"term":{"b":2}}]}}`},
		{"and binds tighter than or", "a = 1 OR b = 2 AND c = 3",
			`{"bool":{"minimum_should_match":1,"should":[{"term":{"a":1}},{"bool":{"filter":[{"term":{"b":2}},{"term":{"c":3}}]}}]}}`},
		{"parens override precedence", "(a = 1 OR b = 2) AND c = 3",
			`{"bool":{"filter":[{"bool":{"minimum_should_match":1,"should":[{"term":{"a":1}},{"term":{"b":2}}]}},{"term":{"c":3}}]}}`},
		{"not", "NOT a = 1", `{"bool":{"must_not":[{"term":{"a":1}}]}}`},
		{"not over parens", "NOT (a = 1 AND b = 2)",
			`{"bool":{"must_not":[{"bool":{"filter":[{"term":{"a":1}},{"term":{"b":2}}]}}]}}`},
		{"mixed and/or/not", "a = 1 AND NOT (b = 2 OR c = 3)",
			`{"bool":{"filter":[{"term":{"a":1}},{"bool":{"must_not":[{"bool":{"minimum_should_match":1,"should":[{"term":{"b":2}},{"term":{"c":3}}]}}]}}]}}`},
	}
	for _, tc := range cases {
		st := mustTranslate(t, "SELECT * FROM logs WHERE "+tc.where)
		if st.Kind != "select" {
			t.Fatalf("%s: kind = %q", tc.name, st.Kind)
		}
		wantWhere(t, st, tc.name, tc.want)
	}
}

func TestTranslateEsSQLOrderLimit(t *testing.T) {
	st := mustTranslate(t, "SELECT * FROM logs ORDER BY a ASC, b DESC, c")
	want := []map[string]map[string]string{
		{"a": {"order": "asc"}},
		{"b": {"order": "desc"}},
		{"c": {"order": "asc"}},
	}
	if !reflect.DeepEqual(st.Sort, want) {
		t.Fatalf("sort = %+v, want %+v", st.Sort, want)
	}

	// LIMIT n / LIMIT n OFFSET m / LIMIT m,n(MySQL 风格)三种形态。
	st = mustTranslate(t, "SELECT * FROM logs LIMIT 10")
	if st.From != 0 || st.Size != 10 {
		t.Fatalf("LIMIT 10 = %d/%d", st.From, st.Size)
	}
	st = mustTranslate(t, "SELECT * FROM logs LIMIT 5 OFFSET 20")
	if st.From != 20 || st.Size != 5 {
		t.Fatalf("LIMIT 5 OFFSET 20 = %d/%d", st.From, st.Size)
	}
	st = mustTranslate(t, "SELECT * FROM logs LIMIT 20, 10")
	if st.From != 20 || st.Size != 10 {
		t.Fatalf("LIMIT 20, 10 = %d/%d", st.From, st.Size)
	}

	// 完整管道:where + order + limit 一次到位。
	st = mustTranslate(t, "SELECT title FROM logs WHERE level = 'error' ORDER BY ts DESC LIMIT 10 OFFSET 5")
	if st.From != 5 || st.Size != 10 || len(st.Sort) != 1 || st.Sort[0]["ts"]["order"] != "desc" {
		t.Fatalf("full pipeline: %+v", st)
	}
	wantWhere(t, st, "full pipeline", `{"term":{"level":"error"}}`)
}

func TestTranslateEsSQLCountShowDescribe(t *testing.T) {
	st := mustTranslate(t, "SELECT COUNT(*) FROM logs")
	if st.Kind != "count" || st.Index != "logs" || strings.Join(st.Columns, ",") != "COUNT(*)" {
		t.Fatalf("count shape: %+v", st)
	}
	if st.Where != nil {
		t.Fatalf("count without where must leave Where nil")
	}

	// 小写关键字 + where 透传 + COUNT(*) 别名容忍。
	st = mustTranslate(t, "select count(*) as total from logs where level = 'ERROR'")
	if st.Kind != "count" {
		t.Fatalf("lowercase count kind = %q", st.Kind)
	}
	wantWhere(t, st, "count where", `{"term":{"level":"ERROR"}}`)

	st = mustTranslate(t, "SHOW TABLES")
	if st.Kind != "show" || st.Like != "" {
		t.Fatalf("show tables: %+v", st)
	}

	st = mustTranslate(t, "SHOW TABLES LIKE 'logs%'")
	if st.Kind != "show" || st.Like != "logs%" {
		t.Fatalf("show tables like: %+v", st)
	}

	st = mustTranslate(t, "DESCRIBE logs")
	if st.Kind != "describe" || st.Index != "logs" {
		t.Fatalf("describe: %+v", st)
	}
	st = mustTranslate(t, "DESC logs-2026")
	if st.Kind != "describe" || st.Index != "logs-2026" {
		t.Fatalf("desc: %+v", st)
	}
	st = mustTranslate(t, `DESC "my-index"`)
	if st.Kind != "describe" || st.Index != "my-index" {
		t.Fatalf("desc quoted: %+v", st)
	}
}

func TestTranslateEsSQLUnsupported(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want string
	}{
		{"join", "SELECT * FROM a JOIN b ON a.id = b.id", "本地翻译不支持"},
		{"group by", "SELECT level FROM logs GROUP BY level", "本地翻译不支持"},
		{"having", "SELECT * FROM logs HAVING COUNT(*) > 1", "本地翻译不支持"},
		{"function column", "SELECT SUM(n) FROM logs", "函数列"},
		{"mixed count column", "SELECT level, COUNT(*) FROM logs", "本地翻译不支持"},
		{"count(field)", "SELECT COUNT(id) FROM logs", "COUNT 仅支持 COUNT(*)"},
		{"subquery", "SELECT * FROM (SELECT 1) x", "本地翻译不支持"},
		{"distinct", "SELECT DISTINCT level FROM logs", "DISTINCT"},
		{"missing from", "SELECT *", "缺少 FROM"},
		{"constant column", "SELECT 1", "本地翻译不支持"},
		{"non select verb", "DELETE FROM logs", "本地翻译不支持"},
		{"second statement", "SELECT * FROM logs; SELECT * FROM users", "本地翻译不支持"},
		{"trailing garbage", "SELECT * FROM logs WHERE a = 1 extra", "本地翻译不支持"},
		{"query_string paste", "SELECT * FROM logs WHERE level:ERROR", "无法翻译的语法"},
		{"null comparison", "SELECT * FROM logs WHERE a = NULL", "无法翻译的语法"},
		{"bare ident value", "SELECT * FROM logs WHERE level = ERROR", "无法翻译的语法"},
		{"non integer limit", "SELECT * FROM logs LIMIT 'x'", "无法翻译的语法"},
		{"unterminated string", "SELECT * FROM logs WHERE a = 'x", "无法翻译的语法"},
		{"empty statement", "", "本地翻译不支持"},
	}
	for _, tc := range cases {
		st, err := TranslateEsSQL(tc.sql)
		if err == nil {
			t.Fatalf("%s: must fail, got %+v", tc.name, st)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error = %q, want it to contain %q", tc.name, err.Error(), tc.want)
		}
	}

	// 不支持类错误必须带上后续指引文案。
	_, err := TranslateEsSQL("SELECT * FROM a JOIN b ON a.id = b.id")
	if err == nil || !strings.Contains(err.Error(), "请使用 DSL 模式或升级到含 SQL 的服务端") {
		t.Fatalf("unsupported error must carry the guidance, got %v", err)
	}
}

// --- LIKE 通配过滤(show 回退用):大小写不敏感 fnmatch 风格 ---

func TestEsLikeMatch(t *testing.T) {
	cases := []struct {
		pattern string
		name    string
		want    bool
	}{
		{"%", "logs", true},
		{"*", "logs", true},
		{"logs%", "logs-2026", true},
		{"LOGS%", "logs-2026", true},
		{"log_", "logs", true},
		{"log_", "logs-2026", false},
		{"%-2026", "app-2026", true},
		{"%-2026", "app-2025", false},
		{"users", "users", true},
		{"users", "users2", false},
	}
	for _, tc := range cases {
		if got := esLikeMatch(tc.pattern, tc.name); got != tc.want {
			t.Fatalf("esLikeMatch(%q, %q) = %v, want %v", tc.pattern, tc.name, got, tc.want)
		}
	}
}
