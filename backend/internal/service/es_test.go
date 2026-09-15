package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

// --- 测试基建:httptest fake ES server ---

// esRequest 记录一次收到的请求(method/path/认证头/body)。
type esRequest struct {
	Method        string
	Path          string
	Authorization string
	ContentType   string
	Body          string
}

// esRecorder 线程安全地收集请求。
type esRecorder struct {
	mu sync.Mutex
	rs []esRequest
}

func (r *esRecorder) add(req esRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rs = append(r.rs, req)
}

func (r *esRecorder) all() []esRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]esRequest, len(r.rs))
	copy(out, r.rs)
	return out
}

func (r *esRecorder) paths() string {
	var b strings.Builder
	for i, req := range r.all() {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(req.Method + " " + req.Path)
	}
	return b.String()
}

// esRootInfo 是 GET / 的根信息响应模板。
func esRootInfo(number, distribution string) string {
	dist := ""
	if distribution != "" {
		dist = `,"distribution":"` + distribution + `"`
	}
	return `{"name":"node-1","version":{"number":"` + number + `"` + dist + `}}`
}

// newEsTestClient 起一个 fake ES server(根路径返回 infoJSON,其余交给
// handle;body 先被记录再回填,内部 handler 可重复读取),并基于它构建
// 已通过构造 ping 的 EsClient。
func newEsTestClient(t *testing.T, infoJSON string, handle func(w http.ResponseWriter, r *http.Request)) (*EsClient, *esRecorder) {
	t.Helper()
	rec := &esRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		rec.add(esRequest{Method: r.Method, Path: r.URL.RequestURI(), Authorization: r.Header.Get("Authorization"), ContentType: r.Header.Get("Content-Type"), Body: string(body)})
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(infoJSON))
			return
		}
		handle(w, r)
	}))
	t.Cleanup(srv.Close)
	cfg := model.EsConfig{Hosts: []string{strings.TrimPrefix(srv.URL, "http://")}}
	cl, err := NewEsClient(cfg)
	if err != nil {
		t.Fatalf("NewEsClient: %v", err)
	}
	t.Cleanup(func() { _ = cl.Close() })
	return cl, rec
}

// writeJSON 以 200 输出 JSON 文本。
func writeJSON(w http.ResponseWriter, s string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(s))
}

// readAllString 读取请求 body(测试内多处需要重复读取,包装器已回填)。
func readAllString(r *http.Request) string {
	b, _ := io.ReadAll(r.Body)
	return string(b)
}

// sqlResp 构造 SQL 端点的标准响应(rows 参数已含外层数组,如 `[["x"]]`)。
func sqlResp(cols string, rows string) string {
	return `{"columns":[` + cols + `],"rows":` + rows + `}`
}

// --- 纯函数:esSQLEndpointFor ---

func TestEsSQLCandidates(t *testing.T) {
	cases := []struct {
		name         string
		number       string
		distribution string
		want         []string
	}{
		{"opensearch starts at plugin endpoint", "2.11.0", "opensearch", []string{"/_plugins/_sql", "/_sql", "/_xpack/sql"}},
		{"8.x starts at /_sql", "8.11.0", "", []string{"/_sql", "/_plugins/_sql", "/_xpack/sql"}},
		{"7.x starts at /_sql", "7.17.0", "", []string{"/_sql", "/_plugins/_sql", "/_xpack/sql"}},
		{"6.8 starts at /_xpack/sql", "6.8.0", "", []string{"/_xpack/sql", "/_sql", "/_plugins/_sql"}},
		{"6.3 starts at /_xpack/sql", "6.3.0", "", []string{"/_xpack/sql", "/_sql", "/_plugins/_sql"}},
		// 版本身份可疑(OpenSearch 2.x 只报 2.x、version 缺失、5.x/6.0–6.2):
		// 三个端点仍全部进入探测,由真实语句执行结果决定,而不是版本号判死。
		{"suspicious 2.x probes all", "2.11.0", "", []string{"/_plugins/_sql", "/_sql", "/_xpack/sql"}},
		{"suspicious 5.6 probes all", "5.6.16", "", []string{"/_plugins/_sql", "/_sql", "/_xpack/sql"}},
		{"missing version probes all", "", "", []string{"/_plugins/_sql", "/_sql", "/_xpack/sql"}},
	}
	for _, tc := range cases {
		got := esSQLCandidates(tc.number, tc.distribution)
		if len(got) != len(tc.want) {
			t.Fatalf("%s: candidates = %v, want %v", tc.name, got, tc.want)
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Fatalf("%s: candidates = %v, want %v", tc.name, got, tc.want)
			}
		}
	}
}

// --- 纯函数:buildEsTLSConfig ---

func TestBuildEsTLSConfig(t *testing.T) {
	if cfg := buildEsTLSConfig(model.EsTLSDisabled); cfg != nil {
		t.Fatalf("disabled must not carry a TLS config, got %+v", cfg)
	}
	cfg := buildEsTLSConfig(model.EsTLSSkipVerify)
	if cfg == nil || !cfg.InsecureSkipVerify {
		t.Fatalf("skip-verify must skip certificate verification, got %+v", cfg)
	}
	cfg = buildEsTLSConfig(model.EsTLSVerifyFull)
	if cfg == nil {
		t.Fatal("verify-full must carry a TLS config")
	}
	if cfg.InsecureSkipVerify {
		t.Fatal("verify-full must not skip certificate verification")
	}
	if cfg.RootCAs != nil {
		t.Fatal("verify-full must use the system root CA pool (RootCAs nil)")
	}
}

// --- 认证头 ---

func TestEsClientAuthHeaders(t *testing.T) {
	cases := []struct {
		name string
		cfg  model.EsConfig
		want string
	}{
		{"none sends no header", model.EsConfig{}, ""},
		{
			"basic sends base64 user:pass",
			model.EsConfig{Username: "elastic", Password: "s3cret", AuthMode: model.EsAuthBasic},
			"Basic " + base64.StdEncoding.EncodeToString([]byte("elastic:s3cret")),
		},
		{
			"apikey sends the provided credential",
			model.EsConfig{ApiKey: "abc123", AuthMode: model.EsAuthApikey},
			"ApiKey abc123",
		},
	}
	for _, tc := range cases {
		cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, `[]`)
		})
		// 构造 ping 之后、首个业务请求之前注入认证配置(hosts 保留)。
		cl.cfg.AuthMode = tc.cfg.AuthMode
		cl.cfg.Username = tc.cfg.Username
		cl.cfg.Password = tc.cfg.Password
		cl.cfg.ApiKey = tc.cfg.ApiKey
		if _, err := cl.ListIndices(context.Background()); err != nil {
			t.Fatalf("%s: ListIndices: %v", tc.name, err)
		}
		reqs := rec.all()
		if len(reqs) == 0 {
			t.Fatalf("%s: no requests captured", tc.name)
		}
		if got := reqs[len(reqs)-1].Authorization; got != tc.want {
			t.Fatalf("%s: Authorization = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// --- TLS:skip-verify 走 https ---

func TestEsClientHTTPSWithSkipVerify(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			writeJSON(w, esRootInfo("8.11.0", ""))
			return
		}
		writeJSON(w, `[]`)
	}))
	t.Cleanup(srv.Close)
	cfg := model.EsConfig{
		Hosts:   []string{strings.TrimPrefix(srv.URL, "https://")},
		TLSMode: model.EsTLSSkipVerify,
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	cl, err := NewEsClient(cfg)
	if err != nil {
		t.Fatalf("NewEsClient over https: %v", err)
	}
	t.Cleanup(func() { _ = cl.Close() })
	if cl.scheme != "https" {
		t.Fatalf("skip-verify must use https, got %q", cl.scheme)
	}
	if _, err := cl.ListIndices(context.Background()); err != nil {
		t.Fatalf("ListIndices over https: %v", err)
	}
}

// --- SQL 端点探测顺序 ---

func TestEsSQLProbeEndpoints(t *testing.T) {
	t.Run("8.x posts to /_sql with fetch_size", func(t *testing.T) {
		cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/_sql" {
				writeJSON(w, sqlResp(`{"name":"a","type":"keyword"}`, `[["x"]]`))
				return
			}
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		})
		res, err := cl.Execute(context.Background(), "SELECT a FROM t")
		if err != nil || len(res) != 1 || res[0].Error != "" {
			t.Fatalf("Execute: %v %+v", err, res)
		}
		if res[0].Columns[0].Name != "a" || res[0].Rows[0][0] == nil || *res[0].Rows[0][0] != "x" {
			t.Fatalf("unexpected result: %+v", res[0])
		}
		if got := rec.paths(); !strings.Contains(got, "POST /_sql?format=json") {
			t.Fatalf("8.x must POST /_sql?format=json, got %v", got)
		}
		last := rec.all()[len(rec.all())-1]
		if !strings.Contains(last.Body, `"fetch_size":1000`) || !strings.Contains(last.Body, `"query":"SELECT a FROM t"`) {
			t.Fatalf("sql body must carry query + fetch_size 1000, got %q", last.Body)
		}
	})

	t.Run("6.6 posts to /_xpack/sql", func(t *testing.T) {
		cl, rec := newEsTestClient(t, esRootInfo("6.6.0", ""), func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/_xpack/sql" {
				writeJSON(w, sqlResp(`{"name":"a","type":"long"}`, `[[1]]`))
				return
			}
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		})
		if _, err := cl.Execute(context.Background(), "SELECT 1"); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got := rec.paths(); !strings.Contains(got, "POST /_xpack/sql?format=json") {
			t.Fatalf("6.6 must POST /_xpack/sql, got %v", got)
		}
	})

	t.Run("opensearch probes plugin endpoint and validates with SHOW TABLES", func(t *testing.T) {
		var validations int
		cl, rec := newEsTestClient(t, esRootInfo("2.11.0", "opensearch"), func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && r.URL.Path == "/_plugins/_sql" {
				if strings.Contains(strings.ToUpper(readAllString(r)), "SHOW TABLES") {
					validations++
					writeJSON(w, sqlResp(`{"name":"TABLE_NAME","type":"keyword"}`, `[["t"]]`))
					return
				}
				writeJSON(w, sqlResp(`{"name":"a","type":"keyword"}`, `[["x"]]`))
				return
			}
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		})
		res, err := cl.Execute(context.Background(), "SELECT a FROM t")
		if err != nil || len(res) != 1 {
			t.Fatalf("Execute: %v %+v", err, res)
		}
		if validations != 1 {
			t.Fatalf("probe must validate with SHOW TABLES once, got %d", validations)
		}
		if got := rec.paths(); !strings.Contains(got, "POST /_plugins/_sql?format=json") {
			t.Fatalf("opensearch must POST /_plugins/_sql, got %v", got)
		}
	})

	t.Run("5.6 falls back to local SQL translation over _search", func(t *testing.T) {
		runEsLocalTranslateCase(t, "5.6.16")
	})

	t.Run("6.1 falls back to local SQL translation over _search", func(t *testing.T) {
		runEsLocalTranslateCase(t, "6.1.0")
	})

	t.Run("opensearch 2.x without distribution field falls back to the plugin endpoint", func(t *testing.T) {
		// 用户实际踩到的场景:服务端是 OpenSearch 2.x,但 GET / 不带
		// distribution 字段 → 版本号 2.x 不能判死,需探测到 /_plugins/_sql。
		cl, rec := newEsTestClient(t, esRootInfo("2.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == "/_sql",
				r.Method == http.MethodPost && r.URL.Path == "/_xpack/sql":
				w.WriteHeader(http.StatusBadRequest)
				writeJSON(w, `{"error":"no handler found for uri [/_sql] and method [post]"}`)
			case r.Method == http.MethodPost && r.URL.Path == "/_plugins/_sql":
				if strings.Contains(strings.ToUpper(readAllString(r)), "SHOW TABLES") {
					writeJSON(w, sqlResp(`{"name":"TABLE_NAME","type":"keyword"}`, `[["t"]]`))
					return
				}
				writeJSON(w, sqlResp(`{"name":"a","type":"keyword"}`, `[["x"]]`))
			default:
				http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
			}
		})
		res, err := cl.Execute(context.Background(), "SELECT a FROM t")
		if err != nil || len(res) != 1 || res[0].Error != "" {
			t.Fatalf("Execute: %v %+v", err, res)
		}
		if got := rec.paths(); !strings.Contains(got, "POST /_plugins/_sql?format=json") {
			t.Fatalf("must fall back to /_plugins/_sql, got %v", got)
		}
	})
}

// --- 无 SQL 端点时的本地 SQL→DSL 翻译回退 ---

// esSQLAllMissing 让三个候选 SQL 端点全部 404(no handler),模拟 ES 5.x /
// 6.1 OSS 这类没有任何 SQL 端点的服务端;命中时返回 true。
func esSQLAllMissing(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	switch r.URL.Path {
	case "/_sql", "/_xpack/sql", "/_plugins/_sql":
		w.WriteHeader(http.StatusNotFound)
		writeJSON(w, `{"error":"no handler found for uri [`+r.URL.Path+`] and method [post]"}`)
		return true
	}
	return false
}

// runEsLocalTranslateCase 端到端锁定用户场景:无 SQL 端点的服务端上
// SELECT * FROM logs WHERE level='ERROR' 自动回退本地 SQL→DSL 翻译,
// 经 /_mapping(展开 * 列)+ /_search 返回真实行。
func runEsLocalTranslateCase(t *testing.T, version string) {
	t.Helper()
	var searchBody string
	cl, rec := newEsTestClient(t, esRootInfo(version, ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case esSQLAllMissing(w, r):
			return
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, `{"logs":{"mappings":{"properties":{"level":{"type":"keyword"},"msg":{"type":"text"}}}}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_search":
			searchBody = readAllString(r)
			writeJSON(w, `{"hits":{"total":{"value":2},"hits":[
				{"_index":"logs","_id":"1","_source":{"level":"ERROR","msg":"boom"}},
				{"_index":"logs","_id":"2","_source":{"level":"ERROR"}}
			]}}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	res, err := cl.Execute(context.Background(), "SELECT * FROM logs WHERE level = 'ERROR'")
	if err != nil || len(res) != 1 || res[0].Error != "" {
		t.Fatalf("translation fallback must answer the select, got err=%v res=%+v", err, res)
	}
	if len(res[0].Columns) != 2 || res[0].Columns[0].Name != "level" || res[0].Columns[1].Name != "msg" {
		t.Fatalf("* must expand to mapping columns, got %+v", res[0].Columns)
	}
	if len(res[0].Rows) != 2 ||
		res[0].Rows[0][0] == nil || *res[0].Rows[0][0] != "ERROR" ||
		res[0].Rows[0][1] == nil || *res[0].Rows[0][1] != "boom" ||
		res[0].Rows[1][1] != nil {
		t.Fatalf("rows must align to _source (missing → nil), got %+v", res[0].Rows)
	}
	if !strings.Contains(searchBody, `"query":{"term":{"level":"ERROR"}}`) {
		t.Fatalf("where must be translated to a term query, got %s", searchBody)
	}
	if !strings.Contains(searchBody, `"from":0`) || !strings.Contains(searchBody, `"size":100`) {
		t.Fatalf("default page must be from=0/size=100, got %s", searchBody)
	}
	if got := rec.paths(); !strings.Contains(got, "POST /logs/_search") {
		t.Fatalf("must execute via POST /logs/_search, got %v", got)
	}
}

// 无法翻译的语句:错误必须同时保留「无 SQL 端点」与翻译失败原因,且不打到
// 任何业务端点。
func TestEsExecuteLocalTranslationUntranslatable(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if esSQLAllMissing(w, r) {
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
	})
	res, err := cl.Execute(context.Background(), "SELECT 1")
	if err != nil || len(res) != 1 || res[0].Error == "" {
		t.Fatalf("untranslatable statement must record an error, got err=%v res=%+v", err, res)
	}
	if !strings.Contains(res[0].Error, "该服务端无 SQL 端点") || !strings.Contains(res[0].Error, "本地翻译不支持") {
		t.Fatalf("error must carry both endpoint and translation reasons, got %q", res[0].Error)
	}
	if got := rec.paths(); strings.Contains(got, "_search") {
		t.Fatalf("translation failure must not reach _search, got %v", got)
	}
}

// count/show/describe 三种语句同样走翻译路径:count→_count(带翻译后的
// query)、show→_cat+LIKE 过滤、describe→_mapping。
func TestEsExecuteLocalTranslationOtherKinds(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case esSQLAllMissing(w, r):
			return
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, `{"logs":{"mappings":{"properties":{"level":{"type":"keyword"}}}}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_count":
			if b := readAllString(r); !strings.Contains(b, `{"query":{"term":{"level":"ERROR"}}}`) {
				http.Error(w, "count must carry the translated query: "+b, http.StatusBadRequest)
				return
			}
			writeJSON(w, `{"count":7,"_shards":{"total":5,"successful":5}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/_cat/indices":
			writeJSON(w, `[
				{"index":"logs","docs.count":"3","store.size":"100"},
				{"index":"users","docs.count":"9","store.size":"200"}
			]`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	res, err := cl.Execute(context.Background(),
		"SELECT COUNT(*) FROM logs WHERE level = 'ERROR'; SHOW TABLES LIKE 'log%'; DESCRIBE logs")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(res) != 3 || res[0].Error != "" || res[1].Error != "" || res[2].Error != "" {
		t.Fatalf("all three statements must translate, got %+v", res)
	}
	if res[0].Columns[0].Name != "COUNT(*)" || res[0].Rows[0][0] == nil || *res[0].Rows[0][0] != "7" {
		t.Fatalf("count must come from _count, got %+v", res[0])
	}
	if res[1].Columns[0].Name != "name" || res[1].Columns[1].Name != "docs_count" ||
		len(res[1].Rows) != 1 || res[1].Rows[0][0] == nil || *res[1].Rows[0][0] != "logs" {
		t.Fatalf("show must filter indices by LIKE, got %+v", res[1])
	}
	if len(res[2].Rows) != 1 || res[2].Rows[0][0] == nil || *res[2].Rows[0][0] != "level" ||
		res[2].Rows[0][1] == nil || *res[2].Rows[0][1] != "keyword" {
		t.Fatalf("describe must list mapping fields, got %+v", res[2])
	}
	if got := rec.paths(); !strings.Contains(got, "POST /logs/_count") || !strings.Contains(got, "GET /_cat/indices") {
		t.Fatalf("unexpected request paths: %v", got)
	}
}

// --- no-handler 回退并记住 ---

func TestEsSQLFallbackOnNoHandler(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/_sql" {
			http.Error(w, `{"error":"no handler found for uri [/_sql] and method [POST]"}`, http.StatusBadRequest)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/_xpack/sql" {
			writeJSON(w, sqlResp(`{"name":"a","type":"long"}`, `[[1]]`))
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	if _, err := cl.Execute(context.Background(), "SELECT 1"); err != nil {
		t.Fatalf("first execute must fall back successfully: %v", err)
	}
	if _, err := cl.Execute(context.Background(), "SELECT 2"); err != nil {
		t.Fatalf("second execute: %v", err)
	}
	// /_sql 只允许被尝试一次(记住回退结果),之后直接走 /_xpack/sql。
	var sqlCount, xpackCount int
	for _, req := range rec.all() {
		if req.Method != http.MethodPost {
			continue
		}
		switch req.Path {
		case "/_sql?format=json":
			sqlCount++
		case "/_xpack/sql?format=json":
			xpackCount++
		}
	}
	// 探测阶段:/_sql 尝试一次即被淘汰(记住探测结果),之后全部语句直接
	// 走 /_xpack/sql;/_plugins/_sql 作为候选也会被探测一次(500 淘汰)。
	pluginsCount := 0
	for _, req := range rec.all() {
		if req.Method == http.MethodPost && req.Path == "/_plugins/_sql?format=json" {
			pluginsCount++
		}
	}
	if sqlCount != 1 || xpackCount != 3 || pluginsCount != 1 {
		t.Fatalf("probe must be remembered: sql=%d xpack=%d plugins=%d", sqlCount, xpackCount, pluginsCount)
	}
}

// --- 许可证缺失 ---

func TestEsSQLLicenseBlocked(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("7.17.0", ""), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		writeJSON(w, `{"error":{"root_cause":[{"type":"illegal_argument_exception","reason":"current license is non-compliant for [sql]"}]}}`)
	})
	res, err := cl.Execute(context.Background(), "SELECT 1")
	if err != nil || len(res) != 1 || !strings.Contains(res[0].Error, "该服务端未开放 SQL") {
		t.Fatalf("license failure must surface the not-open prefix, got err=%v res=%+v", err, res)
	}
	if !strings.Contains(res[0].Error, "license") {
		t.Fatalf("license failure must carry the server detail, got %v", res[0].Error)
	}
}

// --- Execute 多语句 ---

func TestEsExecuteMultiStatement(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		body := readAllString(r)
		if strings.Contains(body, "SELECT 1") {
			writeJSON(w, sqlResp(`{"name":"1","type":"integer"}`, `[[1]]`))
			return
		}
		if strings.Contains(body, "boom") {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, `{"error":"bad query"}`)
			return
		}
		writeJSON(w, sqlResp(`{"name":"2","type":"integer"}`, `[[2]]`))
	})
	res, err := cl.Execute(context.Background(), "SELECT 1; SELECT 2")
	if err != nil || len(res) != 2 || res[0].Rows[0][0] == nil || *res[0].Rows[0][0] != "1" || *res[1].Rows[0][0] != "2" {
		t.Fatalf("Execute: %v %+v", err, res)
	}
	if res[0].DurationMs < 0 {
		t.Fatal("duration must be recorded")
	}

	res, err = cl.Execute(context.Background(), "SELECT 1; SELECT boom")
	if err != nil {
		t.Fatalf("per-statement error must not fail the call: %v", err)
	}
	if len(res) != 2 || res[1].Error == "" || !strings.Contains(res[1].Error, "bad query") {
		t.Fatalf("failing statement must record its error and stop: %+v", res)
	}
}

// --- ListIndices ---

func TestEsListIndicesFiltersSystem(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/_cat/indices" {
			if !strings.Contains(r.URL.RawQuery, "format=json") || !strings.Contains(r.URL.RawQuery, "bytes=b") {
				http.Error(w, "missing format/bytes params", http.StatusBadRequest)
				return
			}
			writeJSON(w, `[
				{"health":"yellow","status":"open","index":"logs","docs.count":"3","store.size":"2048"},
				{"health":"green","status":"open","index":".kibana_8.11","docs.count":"12","store.size":"4096"},
				{"health":"green","status":"open","index":"users","docs.count":7,"store.size":"8192"}
			]`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	out, err := cl.ListIndices(context.Background())
	if err != nil {
		t.Fatalf("ListIndices: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("system indices must be filtered, got %+v", out)
	}
	if out[0].Name != "logs" || out[1].Name != "users" {
		t.Fatalf("indices must be sorted by name, got %+v", out)
	}
	if out[0].DocsCount != 3 || out[0].StoreSizeBytes != 2048 {
		t.Fatalf("string counts must parse, got %+v", out[0])
	}
	if out[1].DocsCount != 7 {
		t.Fatalf("numeric counts must parse, got %+v", out[1])
	}
	if got := rec.paths(); !strings.Contains(got, "GET /_cat/indices?format=json&bytes=b") {
		t.Fatalf("unexpected cat request: %v", got)
	}
}

// --- Mapping ---

func TestEsMappingFlattens(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping" {
			writeJSON(w, `{"logs":{"mappings":{"properties":{"title":{"type":"text","fields":{"keyword":{"type":"keyword"}}},"meta":{"properties":{"created":{"type":"date"}}},"count":{"type":"long"}}}}}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	cols, err := cl.Mapping(context.Background(), "logs")
	if err != nil {
		t.Fatalf("Mapping: %v", err)
	}
	var names []string
	for _, c := range cols {
		names = append(names, c.Name+"("+c.Type+")")
	}
	want := []string{"count(long)", "meta.created(date)", "title(text)", "title.keyword(keyword)"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("flattened columns = %v, want %v", names, want)
	}
}

// 6.x 带 type 的 mappings 同样要能拍平。
func TestEsMappingFlattensTypedMappings(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("6.6.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping" {
			writeJSON(w, `{"logs":{"mappings":{"doc":{"properties":{"name":{"type":"text"}}}}}}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	cols, err := cl.Mapping(context.Background(), "logs")
	if err != nil || len(cols) != 1 || cols[0].Name != "name" || cols[0].Type != "text" {
		t.Fatalf("typed mapping must flatten: %v %+v", err, cols)
	}
}

// --- PageRows ---

const esPageMappingJSON = `{"logs":{"mappings":{"properties":{"title":{"type":"text"},"level":{"type":"keyword"}}}}}`

func TestEsPageRowsTotalObjectShape7x(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, esPageMappingJSON)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_search":
			body := readAllString(r)
			if !strings.Contains(body, `"from":20`) || !strings.Contains(body, `"size":10`) {
				http.Error(w, "bad paging: "+body, http.StatusBadRequest)
				return
			}
			writeJSON(w, `{"took":1,"hits":{"total":{"value":42,"relation":"eq"},"hits":[
				{"_index":"logs","_id":"1","_source":{"title":"a","level":"info"}},
				{"_index":"logs","_id":"2","_source":{"title":"b"}}
			]}}`)
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	res, err := cl.PageRows(context.Background(), "logs", "", "", true, 10, 20)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if res.TotalRows != 42 {
		t.Fatalf("7.x total object must be unwrapped, got %d", res.TotalRows)
	}
	if len(res.Columns) != 3 || res.Columns[0].Name != "_id" || res.Columns[0].Type != "_id" ||
		res.Columns[1].Name != "level" || res.Columns[2].Name != "title" {
		t.Fatalf("columns must lead with the read-only _id then mapping fields: %+v", res.Columns)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("unexpected rows: %+v", res.Rows)
	}
	if res.Rows[0][0] == nil || *res.Rows[0][0] != "1" {
		t.Fatalf("_id must align to the first column: %+v", res.Rows[0])
	}
	if res.Rows[0][1] == nil || *res.Rows[0][1] != "info" {
		t.Fatalf("level value must align: %+v", res.Rows[0])
	}
	if res.Rows[1][1] != nil {
		t.Fatalf("missing field must be nil, got %+v", res.Rows[1])
	}
	if len(res.PrimaryKey) != 1 || res.PrimaryKey[0] != "_id" {
		t.Fatalf("primary_key must be [_id], got %#v", res.PrimaryKey)
	}
	if res.Engine != "logs" {
		t.Fatalf("engine must be the index name, got %q", res.Engine)
	}
}

func TestEsPageRowsTotalNumberShape6x(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("6.8.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, esPageMappingJSON)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_search":
			writeJSON(w, `{"hits":{"total":7,"hits":[{"_index":"logs","_id":"9","_source":{"title":"z"}}]}}`)
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	res, err := cl.PageRows(context.Background(), "logs", "", "", true, 10, 0)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if res.TotalRows != 7 {
		t.Fatalf("6.x numeric total must parse, got %d", res.TotalRows)
	}
}

func TestEsPageRowsWhereAndSort(t *testing.T) {
	var body string
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, esPageMappingJSON)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_search":
			body = readAllString(r)
			writeJSON(w, `{"hits":{"total":0,"hits":[]}}`)
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	res, err := cl.PageRows(context.Background(), "logs", "level:ERROR", "ts", false, 10, 0)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	// 0 行结果的 rows/columns 必须是非 nil 空数组(wire 防御)。
	if res.Rows == nil || res.Columns == nil {
		t.Fatalf("empty page must keep non-nil arrays: %+v", res)
	}
	if !strings.Contains(body, `"query_string":{"query":"level:ERROR"}`) {
		t.Fatalf("where must become a query_string query, got %s", body)
	}
	if !strings.Contains(body, `"sort":[{"ts":{"order":"desc"}}]`) {
		t.Fatalf("order_by+asc=false must render desc sort, got %s", body)
	}
}

// 不含冒号的过滤条件按「普通关键词」走 multi_match(lenient),避免
// query_string 把 `2026-08-21`、`abc-def` 这类值按语法拆解导致结果错乱。
func TestEsPageRowsPlainKeywordUsesMultiMatch(t *testing.T) {
	var body string
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, esPageMappingJSON)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_search":
			body = readAllString(r)
			writeJSON(w, `{"hits":{"total":0,"hits":[]}}`)
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	if _, err := cl.PageRows(context.Background(), "logs", "2026-08-21", "", true, 10, 0); err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if !strings.Contains(body, `"multi_match":`) || !strings.Contains(body, `"query":"2026-08-21"`) || !strings.Contains(body, `"lenient":true`) {
		t.Fatalf("plain keyword must become multi_match lenient, got %s", body)
	}
	if strings.Contains(body, "query_string") {
		t.Fatalf("plain keyword must not use query_string, got %s", body)
	}
}

// --- 文档操作 ---

func TestEsGetDocReturnsSource(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/logs/_doc/1" {
			writeJSON(w, `{"_index":"logs","_id":"1","found":true,"_source":{"title":"a","count":3}}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	doc, err := cl.GetDoc(context.Background(), "logs", "1")
	if err != nil {
		t.Fatalf("GetDoc: %v", err)
	}
	if doc != `{"title":"a","count":3}` {
		t.Fatalf("GetDoc must return the _source JSON text, got %q", doc)
	}
	if got := rec.paths(); !strings.Contains(got, "GET /logs/_doc/1") {
		t.Fatalf("unexpected request path: %v", got)
	}
}

func TestEsGetDocMissing(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(w, `{"_id":"1","found":false}`)
	})
	if _, err := cl.GetDoc(context.Background(), "logs", "1"); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("missing doc must surface a friendly error, got %v", err)
	}
}

func TestEsPutDocReplaces(t *testing.T) {
	var putBody string
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.URL.Path == "/logs/_doc/1" {
			putBody = readAllString(r)
			writeJSON(w, `{"_index":"logs","_id":"1","result":"updated"}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	if err := cl.PutDoc(context.Background(), "logs", "1", `{"title":"new","tags":["x"]}`); err != nil {
		t.Fatalf("PutDoc: %v", err)
	}
	if putBody != `{"title":"new","tags":["x"]}` {
		t.Fatalf("PutDoc must send the doc verbatim, got %q", putBody)
	}
	if got := rec.paths(); !strings.Contains(got, "PUT /logs/_doc/1") {
		t.Fatalf("unexpected request path: %v", got)
	}

	// 非 JSON / 非对象必须在本地拒绝(不发请求)。
	before := len(rec.all())
	if err := cl.PutDoc(context.Background(), "logs", "1", "not json"); err == nil {
		t.Fatal("invalid JSON must be rejected")
	}
	if err := cl.PutDoc(context.Background(), "logs", "1", "[1,2]"); err == nil {
		t.Fatal("non-object JSON must be rejected")
	}
	if len(rec.all()) != before {
		t.Fatal("local validation failures must not hit the server")
	}
}

func TestEsUpdateCellPostsPartialDoc(t *testing.T) {
	var bodies []string
	cl, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/logs/_update/1" {
			bodies = append(bodies, readAllString(r))
			writeJSON(w, `{"result":"updated"}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	if err := cl.UpdateCell(context.Background(), "logs", "1", "note", strP("it's")); err != nil {
		t.Fatalf("UpdateCell: %v", err)
	}
	if len(bodies) != 1 || bodies[0] != `{"doc":{"note":"it's"}}` {
		t.Fatalf("update body = %v", bodies)
	}
	if err := cl.UpdateCell(context.Background(), "logs", "1", "note", nil); err != nil {
		t.Fatalf("UpdateCell nil: %v", err)
	}
	if bodies[1] != `{"doc":{"note":null}}` {
		t.Fatalf("nil value must marshal as JSON null, got %q", bodies[1])
	}

	// _ 开头的系统字段禁止编辑。
	if err := cl.UpdateCell(context.Background(), "logs", "1", "_id", strP("x")); err == nil || !strings.Contains(err.Error(), "系统字段") {
		t.Fatalf("system fields must be rejected, got %v", err)
	}
}

func TestEsDeleteDocAndDeleteByQuery(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/logs/_doc/1":
			writeJSON(w, `{"result":"deleted"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_delete_by_query":
			if b := readAllString(r); !strings.Contains(b, `{"query":{"term":{"level":"error"}}}`) {
				http.Error(w, "query must be forwarded under the query key: "+b, http.StatusBadRequest)
				return
			}
			writeJSON(w, `{"deleted":5}`)
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	if err := cl.DeleteDoc(context.Background(), "logs", "1"); err != nil {
		t.Fatalf("DeleteDoc: %v", err)
	}
	n, err := cl.DeleteByQuery(context.Background(), "logs", `{"term":{"level":"error"}}`)
	if err != nil {
		t.Fatalf("DeleteByQuery: %v", err)
	}
	if n != 5 {
		t.Fatalf("DeleteByQuery must parse the deleted count, got %d", n)
	}
	got := rec.paths()
	if !strings.Contains(got, "DELETE /logs/_doc/1") || !strings.Contains(got, "POST /logs/_delete_by_query") {
		t.Fatalf("unexpected request paths: %v", got)
	}

	// 非法 query 必须在本地拒绝(不发请求)。
	before := len(rec.all())
	if _, err := cl.DeleteByQuery(context.Background(), "logs", "not json"); err == nil {
		t.Fatal("invalid query DSL must be rejected")
	}
	if _, err := cl.DeleteByQuery(context.Background(), "logs", "[1,2]"); err == nil {
		t.Fatal("non-object query must be rejected")
	}
	if len(rec.all()) != before {
		t.Fatal("local validation failures must not hit the server")
	}
}

// --- DSL 透传 ---

// 本地校验(method 白名单/path 安全/body JSON)必须在发请求之前拒绝。
func TestEsDslValidationRejects(t *testing.T) {
	cases := []struct {
		name    string
		method  string
		path    string
		body    string
		wantErr string
	}{
		{"method outside whitelist", "TRACE", "/idx/_search", "", "GET/POST/PUT/DELETE/HEAD"},
		{"empty method", "", "/idx/_search", "", "GET/POST/PUT/DELETE/HEAD"},
		{"path without leading slash", "GET", "idx/_search", "", "/ 开头"},
		{"empty path", "GET", "", "", "/ 开头"},
		{"crlf injection", "GET", "/idx/_search\r\nX-Injected: 1", "", "空白"},
		{"tab in path", "GET", "/idx/_search\t?x=1", "", "空白"},
		{"space in path", "GET", "/idx /_search", "", "空白"},
		{"absolute url in query string", "GET", "/idx/_search?u=http://evil.example", "", "://"},
		{"invalid json body", "POST", "/idx/_search", `{"query":`, "JSON 不合法"},
	}
	for _, tc := range cases {
		cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, `{}`)
		})
		before := len(rec.all())
		if _, err := cl.DSL(context.Background(), tc.method, tc.path, tc.body); err == nil {
			t.Fatalf("%s: must be rejected", tc.name)
		} else if !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: error = %q, want it to contain %q", tc.name, err.Error(), tc.wantErr)
		}
		if len(rec.all()) != before {
			t.Fatalf("%s: rejected requests must not hit the server", tc.name)
		}
	}
}

// GET 透传:小写 method 归一为大写,path(含 query string)原样拼接,
// 响应原样返回 status+body。
func TestEsDslGetPassthrough(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.RequestURI() == "/logs-*/_search?size=10" {
			writeJSON(w, `{"took":1,"hits":{"total":3}}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	res, err := cl.DSL(context.Background(), "get", "/logs-*/_search?size=10", "")
	if err != nil {
		t.Fatalf("DSL: %v", err)
	}
	if res.Status != http.StatusOK || res.Body != `{"took":1,"hits":{"total":3}}` {
		t.Fatalf("unexpected result: %+v", res)
	}
	last := rec.all()[len(rec.all())-1]
	if last.Method != http.MethodGet || last.Path != "/logs-*/_search?size=10" {
		t.Fatalf("method must normalize to GET and path pass verbatim, got %s %s", last.Method, last.Path)
	}
}

// POST 带 body 透传:body 原样送达,走既有通道(application/json)。
func TestEsDslPostBodyPassthrough(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/logs/_search" {
			writeJSON(w, `{"hits":{"hits":[]}}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
	})
	body := `{"query":{"match_all":{}}}`
	res, err := cl.DSL(context.Background(), "POST", "/logs/_search?size=5", body)
	if err != nil || res.Status != http.StatusOK {
		t.Fatalf("DSL: %v %+v", err, res)
	}
	last := rec.all()[len(rec.all())-1]
	if last.Body != body {
		t.Fatalf("body must be forwarded verbatim, got %q", last.Body)
	}
	if last.ContentType != "application/json" {
		t.Fatalf("body requests must carry application/json, got %q", last.ContentType)
	}
}

// 4xx/5xx 是「响应」而不是 Go 层错误:原样返回 status+body 由前端按状态展示。
func TestEsDslReturnsHTTPErrorsAsResults(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(w, `{"error":"index_not_found_exception"}`)
	})
	res, err := cl.DSL(context.Background(), "GET", "/missing/_search", "")
	if err != nil {
		t.Fatalf("4xx must not surface as a Go error, got %v", err)
	}
	if res.Status != http.StatusNotFound || !strings.Contains(res.Body, "index_not_found_exception") {
		t.Fatalf("unexpected result: %+v", res)
	}
}

// 超大响应体按 64KB 截断(远宽于错误体的 300 字节)。
func TestEsDslTruncatesHugeBody(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", 70_000)))
	})
	res, err := cl.DSL(context.Background(), "GET", "/_cat/indices", "")
	if err != nil || res.Status != http.StatusOK {
		t.Fatalf("DSL: %v %+v", err, res)
	}
	// 64KB 截断 + "…"(3 字节)后缀。
	if len(res.Body) != 64*1024+3 || !strings.HasSuffix(res.Body, "…") {
		t.Fatalf("body must be truncated to 64KB, got %d bytes", len(res.Body))
	}
}

// --- 5.x 类型化文档路径回退 ---

func TestEsDocOpsFallbackToTypedPath(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("5.6.16", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_doc/1":
			http.Error(w, `{"error":"no handler found for uri [/logs/_doc/1] and method [GET]"}`, http.StatusBadRequest)
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, `{"logs":{"mappings":{"mytype":{"properties":{"title":{"type":"text"}}}}}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/logs/mytype/1":
			writeJSON(w, `{"_index":"logs","_type":"mytype","_id":"1","found":true,"_source":{"title":"a"}}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	doc, err := cl.GetDoc(context.Background(), "logs", "1")
	if err != nil {
		t.Fatalf("GetDoc on 5.6: %v", err)
	}
	if doc != `{"title":"a"}` {
		t.Fatalf("unexpected doc %q", doc)
	}
	// 回退结果被记住:第二次 GET 不再尝试 _doc。
	if _, err := cl.GetDoc(context.Background(), "logs", "1"); err != nil {
		t.Fatalf("second GetDoc: %v", err)
	}
	got := rec.paths()
	if strings.Count(got, "GET /logs/_doc/1") != 1 {
		t.Fatalf("fallback must be remembered per index: %v", got)
	}
	if !strings.Contains(got, "GET /logs/mytype/1") {
		t.Fatalf("typed path must be used: %v", got)
	}
}

func TestEsUpdateCellFallbackToTypedUpdateOn56(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("5.6.16", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_update/1":
			http.Error(w, `{"error":"no handler found for uri [/logs/_update/1] and method [POST]"}`, http.StatusBadRequest)
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, `{"logs":{"mappings":{"mytype":{"properties":{"title":{"type":"text"}}}}}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/mytype/1/_update":
			writeJSON(w, `{"result":"updated"}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	if err := cl.UpdateCell(context.Background(), "logs", "1", "title", strP("x")); err != nil {
		t.Fatalf("UpdateCell on 5.6: %v", err)
	}
	if got := rec.paths(); !strings.Contains(got, "POST /logs/mytype/1/_update") {
		t.Fatalf("typed update path must be used: %v", got)
	}
}

// 回归:ES 6.1(实测,用户环境)对无 type 的 _update 路径返回
// 400 invalid_type_name_exception(不是 no handler found),必须同样
// 触发 typed 回退。
func TestEsUpdateCellFallbackToTypedUpdateOn61(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_update/1":
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, `{"error":{"root_cause":[{"type":"invalid_type_name_exception","reason":"Document mapping type name can't start with '_', found: [_update]"}],"type":"invalid_type_name_exception","reason":"Document mapping type name can't start with '_', found: [_update]"},"status":400}`)
		case r.Method == http.MethodGet && r.URL.Path == "/logs/_mapping":
			writeJSON(w, `{"logs":{"mappings":{"_doc":{"properties":{"appName":{"type":"keyword"}}}}}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/logs/_doc/1/_update":
			writeJSON(w, `{"result":"updated"}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
		}
	})
	if err := cl.UpdateCell(context.Background(), "logs", "1", "appName", strP("analysislApp1")); err != nil {
		t.Fatalf("UpdateCell on 6.1: %v", err)
	}
	if got := rec.paths(); !strings.Contains(got, "POST /logs/_doc/1/_update") {
		t.Logf("DEBUG paths: %v", got)
		t.Fatalf("typed update path must be used on 6.1: %v", got)
	}
}

// --- 多节点:首个可用节点生效 ---

func TestEsClientTriesHostsInOrder(t *testing.T) {
	dead := "127.0.0.1:1" // 必然拒绝连接
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			writeJSON(w, esRootInfo("8.11.0", ""))
			return
		}
		writeJSON(w, `[]`)
	}))
	t.Cleanup(srv.Close)
	cfg := model.EsConfig{Hosts: []string{dead, strings.TrimPrefix(srv.URL, "http://")}}
	cl, err := NewEsClient(cfg)
	if err != nil {
		t.Fatalf("NewEsClient: %v", err)
	}
	t.Cleanup(func() { _ = cl.Close() })
	if _, err := cl.ListIndices(context.Background()); err != nil {
		t.Fatalf("ListIndices: %v", err)
	}
}

// --- 构造校验 ---

func TestNewEsClientRejectsInvalidConfig(t *testing.T) {
	if _, err := NewEsClient(model.EsConfig{}); err == nil {
		t.Fatal("empty hosts must be rejected before dialing")
	}
	if _, err := NewEsClient(model.EsConfig{Hosts: []string{"es-a"}, AuthMode: "basic"}); err == nil {
		t.Fatal("basic auth without username must be rejected before dialing")
	}
}

// --- Service 层:池化 + 委托(fake 注入,不触网) ---

// fakeES implements EsDataSource for service/app-layer tests.
type fakeES struct {
	fakeDataSource
	indices      []model.EsIndexInfo
	page         model.EsPageRowsResult
	pageTarget   string
	mapping      []model.EsColumn
	mappingIndex string
	docJSON      string
	docTarget    string
	putTarget    string
	putBody      string
	updateTarget string
	updateCol    string
	updateVal    *string
	deleteTarget string
	deleted      int64
	deletedQuery string
	execSQL      string
	execResult   []model.EsStatementResult
	dslMethod    string
	dslPath      string
	dslBody      string
	dsl          model.EsDslResult
	dslErr       error
	// 索引刷新与模板。
	refreshIndex       string
	listTemplates      []model.EsTemplateInfo
	getTemplateName    string
	templateJSON       string
	putTemplateName    string
	putTemplateBody    string
	deleteTemplateName string
	// 索引生命周期(创建/删除/改设置)。
	createIndexName string
	createShards    int64
	createReplicas  int64
	deleteIndexName string
	settingsIndex   string
	settingsJSON    string
	// 集群监控聚合。
	clusterStats      model.EsClusterStats
	clusterStatsCalls int
}

func (f *fakeES) Connect(context.Context) error { return nil }
func (f *fakeES) Close() error                  { return nil }
func (f *fakeES) GetName() string               { return "fake-es" }
func (f *fakeES) GetType() string               { return string(model.ConnectionTypeES) }
func (f *fakeES) ListIndices(context.Context) ([]model.EsIndexInfo, error) {
	return f.indices, nil
}
func (f *fakeES) PageRows(_ context.Context, index, _, _ string, _ bool, _, _ int) (model.EsPageRowsResult, error) {
	f.pageTarget = index
	return f.page, nil
}
func (f *fakeES) Mapping(_ context.Context, index string) ([]model.EsColumn, error) {
	f.mappingIndex = index
	return f.mapping, nil
}
func (f *fakeES) GetDoc(_ context.Context, index, id string) (string, error) {
	f.docTarget = index + "/" + id
	return f.docJSON, nil
}
func (f *fakeES) PutDoc(_ context.Context, index, id, docJSON string) error {
	f.putTarget = index + "/" + id
	f.putBody = docJSON
	return nil
}
func (f *fakeES) UpdateCell(_ context.Context, index, id, column string, value *string) error {
	f.updateTarget = index + "/" + id
	f.updateCol = column
	f.updateVal = value
	return nil
}
func (f *fakeES) DeleteDoc(_ context.Context, index, id string) error {
	f.deleteTarget = index + "/" + id
	return nil
}
func (f *fakeES) DeleteByQuery(_ context.Context, index, query string) (int64, error) {
	f.deletedQuery = index + "\x00" + query
	return f.deleted, nil
}
func (f *fakeES) Execute(_ context.Context, sqlText string) ([]model.EsStatementResult, error) {
	f.execSQL = sqlText
	return f.execResult, nil
}
func (f *fakeES) DSL(_ context.Context, method, path, body string) (model.EsDslResult, error) {
	f.dslMethod, f.dslPath, f.dslBody = method, path, body
	return f.dsl, f.dslErr
}
func (f *fakeES) RefreshIndex(_ context.Context, index string) error {
	f.refreshIndex = index
	return nil
}
func (f *fakeES) ListTemplates(context.Context) ([]model.EsTemplateInfo, error) {
	return f.listTemplates, nil
}
func (f *fakeES) GetTemplate(_ context.Context, name string) (string, error) {
	f.getTemplateName = name
	return f.templateJSON, nil
}
func (f *fakeES) PutTemplate(_ context.Context, name, templateJSON string) error {
	f.putTemplateName = name
	f.putTemplateBody = templateJSON
	return nil
}
func (f *fakeES) DeleteTemplate(_ context.Context, name string) error {
	f.deleteTemplateName = name
	return nil
}
func (f *fakeES) CreateIndex(_ context.Context, index string, shards, replicas int64) error {
	f.createIndexName, f.createShards, f.createReplicas = index, shards, replicas
	return nil
}
func (f *fakeES) DeleteIndex(_ context.Context, index string) error {
	f.deleteIndexName = index
	return nil
}
func (f *fakeES) UpdateIndexSettings(_ context.Context, index, settingsJSON string) error {
	f.settingsIndex, f.settingsJSON = index, settingsJSON
	return nil
}
func (f *fakeES) ClusterStats(context.Context) (model.EsClusterStats, error) {
	f.clusterStatsCalls++
	return f.clusterStats, nil
}

var _ EsDataSource = (*fakeES)(nil)

// newTestServiceWithES wires a service against a store holding one es
// connection whose pooled client is the given fake (no network involved).
func newTestServiceWithES(t *testing.T, fake *fakeES) (*Service, string) {
	t.Helper()
	st, err := store.Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	svc := NewService(st, &fakeFactory{k: &fakeKafka{}})
	ctx := context.Background()
	c := &model.Connection{
		ID:     "conn-es",
		Name:   "es-local",
		Type:   model.ConnectionTypeES,
		Config: model.MustConfigJSON(model.EsConfig{Hosts: []string{"127.0.0.1:9200"}}),
	}
	if _, err := svc.CreateConnection(ctx, c); err != nil {
		t.Fatalf("create es connection: %v", err)
	}
	if err := svc.pool.Put(c.ID, fake); err != nil {
		t.Fatalf("pool put fake: %v", err)
	}
	return svc, c.ID
}

func TestServiceESDelegates(t *testing.T) {
	fake := &fakeES{
		indices: []model.EsIndexInfo{{Name: "logs", DocsCount: 3, StoreSizeBytes: 128}},
		page: model.EsPageRowsResult{
			Columns:    []model.EsColumn{{Name: "_id", Type: "_id"}, {Name: "title", Type: "text"}},
			Rows:       [][]*string{{strP("1"), strP("a")}},
			TotalRows:  1,
			PrimaryKey: []string{"_id"},
			Engine:     "logs",
		},
		mapping:    []model.EsColumn{{Name: "title", Type: "text"}},
		docJSON:    `{"title":"a"}`,
		deleted:    5,
		execResult: []model.EsStatementResult{{SQL: "SELECT 1", DurationMs: 1}},
	}
	svc, id := newTestServiceWithES(t, fake)
	ctx := context.Background()

	indices, err := svc.EsListIndices(ctx, id)
	if err != nil || len(indices) != 1 || indices[0].Name != "logs" || indices[0].DocsCount != 3 {
		t.Fatalf("EsListIndices: %v %+v", err, indices)
	}

	page, err := svc.EsPageRows(ctx, id, "logs", "level:info", "ts", true, 10, 5)
	if err != nil || page.TotalRows != 1 || page.Engine != "logs" {
		t.Fatalf("EsPageRows: %v %+v", err, page)
	}
	if fake.pageTarget != "logs" {
		t.Fatalf("page must target the index, got %q", fake.pageTarget)
	}

	if _, err := svc.EsMapping(ctx, id, "logs"); err != nil || len(fake.mapping) != 1 {
		t.Fatalf("EsMapping: %v", err)
	}
	if fake.mappingIndex != "logs" {
		t.Fatalf("mapping must target the index, got %q", fake.mappingIndex)
	}

	doc, err := svc.EsGetDoc(ctx, id, "logs", "1")
	if err != nil || doc != `{"title":"a"}` || fake.docTarget != "logs/1" {
		t.Fatalf("EsGetDoc: %v %q %q", err, doc, fake.docTarget)
	}

	if err := svc.EsPutDoc(ctx, id, "logs", "1", `{"title":"b"}`); err != nil || fake.putTarget != "logs/1" || fake.putBody != `{"title":"b"}` {
		t.Fatalf("EsPutDoc: %v %+v", err, fake)
	}

	if err := svc.EsUpdateCell(ctx, id, "logs", "1", "note", strP("x")); err != nil ||
		fake.updateTarget != "logs/1" || fake.updateCol != "note" || fake.updateVal == nil || *fake.updateVal != "x" {
		t.Fatalf("EsUpdateCell: %v %+v", err, fake)
	}
	if err := svc.EsUpdateCell(ctx, id, "logs", "1", "note", nil); err != nil || fake.updateVal != nil {
		t.Fatalf("EsUpdateCell nil value must pass through: %v %+v", err, fake)
	}

	if err := svc.EsDeleteDoc(ctx, id, "logs", "1"); err != nil || fake.deleteTarget != "logs/1" {
		t.Fatalf("EsDeleteDoc: %v %q", err, fake.deleteTarget)
	}
	if n, err := svc.EsDeleteByQuery(ctx, id, "logs", `{"term":{"level":"error"}}`); err != nil || n != 5 ||
		fake.deletedQuery != "logs\x00"+`{"term":{"level":"error"}}` {
		t.Fatalf("EsDeleteByQuery: %v n=%d query=%q", err, n, fake.deletedQuery)
	}

	if _, err := svc.EsExecute(ctx, id, "SELECT 1"); err != nil || len(fake.execResult) != 1 {
		t.Fatalf("EsExecute: %v", err)
	}
	if fake.execSQL != "SELECT 1" {
		t.Fatalf("execute must delegate verbatim, got %q", fake.execSQL)
	}

	// 池化:再次调用复用同一 fake。
	if _, err := svc.EsListIndices(ctx, id); err != nil {
		t.Fatalf("second call: %v", err)
	}
}

// DSL 控制台同样走池取用(fake 注入):参数原样送达数据源,结果原样返回。
func TestServiceESDslDelegates(t *testing.T) {
	fake := &fakeES{dsl: model.EsDslResult{Status: 200, Body: `{"ok":true}`}}
	svc, id := newTestServiceWithES(t, fake)
	res, err := svc.EsDsl(context.Background(), id, "GET", "/logs/_search", `{"query":{"match_all":{}}}`)
	if err != nil || res.Status != 200 || res.Body != `{"ok":true}` {
		t.Fatalf("EsDsl: %v %+v", err, res)
	}
	if fake.dslMethod != "GET" || fake.dslPath != "/logs/_search" || fake.dslBody != `{"query":{"match_all":{}}}` {
		t.Fatalf("dsl args must pass through verbatim: %+v", fake)
	}
	// 池化复用:再次调用命中同一 fake。
	if _, err := svc.EsDsl(context.Background(), id, "HEAD", "/", ""); err != nil {
		t.Fatalf("second EsDsl: %v", err)
	}
	if fake.dslMethod != "HEAD" || fake.dslPath != "/" {
		t.Fatalf("second call must hit the pooled client, got %s %s", fake.dslMethod, fake.dslPath)
	}
}

func TestServiceESWrongTypeInPool(t *testing.T) {
	svc, id := newTestServiceWithES(t, &fakeES{})
	_ = svc.pool.Put(id, &fakeKafka{})
	if _, err := svc.EsListIndices(context.Background(), id); err == nil {
		t.Fatal("a non-ES pooled client must be rejected")
	}
}

func TestServiceESAutoConnectUnknownConnection(t *testing.T) {
	svc, _ := newTestServiceWithES(t, &fakeES{})
	if _, err := svc.EsListIndices(context.Background(), "nope"); err == nil {
		t.Fatal("unknown connection must fail")
	}
}

func TestServiceESTestConnectionValidates(t *testing.T) {
	svc, _ := newTestServiceWithES(t, &fakeES{})
	if err := svc.EsTestConnection(context.Background(), model.EsConfig{}); err == nil {
		t.Fatal("invalid config must fail before dialing")
	}
}

// --- 分发:ConnectConnection 走 buildEsClient ---

func TestServiceESConnectDispatch(t *testing.T) {
	svc, _ := newTestServiceWithES(t, &fakeES{})
	// 专门建一个指向必然拒绝端口(127.0.0.1:1)的 ES 连接再连:错误必须是
	// ES 客户端的拨号失败,而不是分发到了其他类型。
	ctx := context.Background()
	c := &model.Connection{
		ID:     "conn-es-dead",
		Name:   "es-dead",
		Type:   model.ConnectionTypeES,
		Config: model.MustConfigJSON(model.EsConfig{Hosts: []string{"127.0.0.1:1"}}),
	}
	if _, err := svc.CreateConnection(ctx, c); err != nil {
		t.Fatalf("create dead es connection: %v", err)
	}
	err := svc.ConnectConnection(ctx, c.ID)
	if err == nil {
		t.Fatal("dialing a dead address must fail")
	}
	if !strings.Contains(err.Error(), "elasticsearch") {
		t.Fatalf("es connection must dispatch to the es client, got %v", err)
	}
}

// --- 索引刷新(POST /{index}/_refresh) ---

// POST /{index}/_refresh:方法与路径固定,索引名转义照抄既有写法
// (url.PathEscape);空索引名本地拒绝,不发请求。
func TestEsRefreshIndexPostsIndexRefresh(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.RequestURI() == "/logs/_refresh" {
			writeJSON(w, `{"_shards":{"total":2,"successful":2,"failed":0}}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if err := cl.RefreshIndex(context.Background(), "logs"); err != nil {
		t.Fatalf("RefreshIndex: %v", err)
	}
	if got := rec.paths(); !strings.Contains(got, "POST /logs/_refresh") {
		t.Fatalf("refresh must POST /{index}/_refresh, got %v", got)
	}

	// 索引名含特殊字符:路径必须转义。
	cl2, rec2 := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.RequestURI() == "/logs%2F2026/_refresh" {
			writeJSON(w, `{"_shards":{}}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if err := cl2.RefreshIndex(context.Background(), "logs/2026"); err != nil {
		t.Fatalf("RefreshIndex escaped: %v", err)
	}
	if got := rec2.paths(); !strings.Contains(got, "POST /logs%2F2026/_refresh") {
		t.Fatalf("index name must be URL-escaped, got %v", got)
	}

	// 空索引名在本地拒绝(不触网)。
	before := len(rec.all())
	if err := cl.RefreshIndex(context.Background(), "  "); err == nil {
		t.Fatal("empty index name must be rejected")
	}
	if len(rec.all()) != before {
		t.Fatal("local validation failures must not hit the server")
	}
}

// --- 索引模板(legacy /_template,6.x OSS 可用) ---

// GET /_template:解析名称列表;order 取模板内 "order"(缺失为 0),按名称
// 排序稳定输出。
func TestEsListTemplatesParsesNamesAndOrder(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/_template" {
			writeJSON(w, `{
				"tpl_b":{"order":2,"template":"b*","settings":{}},
				"tpl_a":{"index_patterns":["a*"],"settings":{}}
			}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
	})
	out, err := cl.ListTemplates(context.Background())
	if err != nil {
		t.Fatalf("ListTemplates: %v", err)
	}
	if len(out) != 2 || out[0].Name != "tpl_a" || out[1].Name != "tpl_b" {
		t.Fatalf("templates must be sorted by name, got %+v", out)
	}
	if out[0].Order != 0 {
		t.Fatalf("missing order must default to 0, got %+v", out[0])
	}
	if out[1].Order != 2 {
		t.Fatalf("order must be read from the template body, got %+v", out[1])
	}
	if got := rec.paths(); !strings.Contains(got, "GET /_template") {
		t.Fatalf("must GET /_template, got %v", got)
	}
}

// GET /_template/{name}:原始 JSON 文本原样回传;name 路径转义。
func TestEsGetTemplateReturnsRawText(t *testing.T) {
	const body = `{"logs_tpl":{"order":0,"index_patterns":["logs-*"],"settings":{"number_of_shards":1}}}`
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.RequestURI() == "/_template/logs_tpl" {
			writeJSON(w, body)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	text, err := cl.GetTemplate(context.Background(), "logs_tpl")
	if err != nil {
		t.Fatalf("GetTemplate: %v", err)
	}
	if text != body {
		t.Fatalf("template must round-trip verbatim, got %q", text)
	}
	if got := rec.paths(); !strings.Contains(got, "GET /_template/logs_tpl") {
		t.Fatalf("unexpected request: %v", got)
	}

	// name 含空格:路径必须转义。
	cl2, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.RequestURI() == "/_template/tpl%20x" {
			writeJSON(w, `{"tpl x":{}}`)
			return
		}
		http.Error(w, "unexpected "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if _, err := cl2.GetTemplate(context.Background(), "tpl x"); err != nil {
		t.Fatalf("GetTemplate escaped: %v", err)
	}
}

// PUT /_template/{name}:合法 JSON 原样透传;非法 JSON 本地拒绝(不发请求)。
func TestEsPutTemplateValidatesAndForwards(t *testing.T) {
	var putBody string
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.URL.Path == "/_template/logs_tpl" {
			putBody = readAllString(r)
			writeJSON(w, `{"acknowledged":true}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
	})
	const tpl = `{"template":"logs-*","settings":{"number_of_shards":1}}`
	if err := cl.PutTemplate(context.Background(), "logs_tpl", tpl); err != nil {
		t.Fatalf("PutTemplate: %v", err)
	}
	if putBody != tpl {
		t.Fatalf("template must be forwarded verbatim, got %q", putBody)
	}

	// 非法 JSON 必须在本地拒绝,错误信息为「模板 JSON 不合法」。
	before := len(rec.all())
	if err := cl.PutTemplate(context.Background(), "logs_tpl", `{"template":`); err == nil ||
		!strings.Contains(err.Error(), "模板 JSON 不合法") {
		t.Fatalf("invalid JSON must be rejected locally, got %v", err)
	}
	if err := cl.PutTemplate(context.Background(), "logs_tpl", ""); err == nil {
		t.Fatal("empty template must be rejected")
	}
	if len(rec.all()) != before {
		t.Fatal("local validation failures must not hit the server")
	}
}

// DELETE /_template/{name}:name 路径转义;服务端 4xx 原样成为错误。
func TestEsDeleteTemplateRemoves(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && r.URL.RequestURI() == "/_template/tpl%20x" {
			writeJSON(w, `{"acknowledged":true}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if err := cl.DeleteTemplate(context.Background(), "tpl x"); err != nil {
		t.Fatalf("DeleteTemplate: %v", err)
	}
	if got := rec.paths(); !strings.Contains(got, "DELETE /_template/tpl%20x") {
		t.Fatalf("name must be URL-escaped in the path, got %v", got)
	}

	cl2, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(w, `{"error":"index_template_missing_exception"}`)
	})
	if err := cl2.DeleteTemplate(context.Background(), "missing"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("missing template must surface the HTTP error, got %v", err)
	}
}

// Service 层:刷新与模板方法走池取用(fake 注入),参数原样透传。
func TestServiceESRefreshAndTemplatesDelegate(t *testing.T) {
	fake := &fakeES{
		listTemplates: []model.EsTemplateInfo{{Name: "logs_tpl", Order: 1}},
		templateJSON:  `{"logs_tpl":{"order":1}}`,
	}
	svc, id := newTestServiceWithES(t, fake)
	ctx := context.Background()

	if err := svc.EsRefreshIndex(ctx, id, "logs"); err != nil || fake.refreshIndex != "logs" {
		t.Fatalf("EsRefreshIndex: %v target=%q", err, fake.refreshIndex)
	}
	list, err := svc.EsListTemplates(ctx, id)
	if err != nil || len(list) != 1 || list[0].Name != "logs_tpl" || list[0].Order != 1 {
		t.Fatalf("EsListTemplates: %v %+v", err, list)
	}
	text, err := svc.EsGetTemplate(ctx, id, "logs_tpl")
	if err != nil || text != `{"logs_tpl":{"order":1}}` || fake.getTemplateName != "logs_tpl" {
		t.Fatalf("EsGetTemplate: %v %q %q", err, text, fake.getTemplateName)
	}
	if err := svc.EsPutTemplate(ctx, id, "logs_tpl", `{"order":1}`); err != nil ||
		fake.putTemplateName != "logs_tpl" || fake.putTemplateBody != `{"order":1}` {
		t.Fatalf("EsPutTemplate: %v %+v", err, fake)
	}
	if err := svc.EsDeleteTemplate(ctx, id, "logs_tpl"); err != nil || fake.deleteTemplateName != "logs_tpl" {
		t.Fatalf("EsDeleteTemplate: %v %q", err, fake.deleteTemplateName)
	}
}

// --- 索引生命周期(创建/删除/改设置) ---

// PUT /{index}:请求体携带 settings{number_of_shards,number_of_replicas};
// 服务端 4xx/5xx 原样成为错误(HTTP 状态+body)。
func TestEsCreateIndexBuildsPutRequest(t *testing.T) {
	var putBody string
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.URL.RequestURI() == "/logs-2026" {
			putBody = readAllString(r)
			writeJSON(w, `{"acknowledged":true,"index":"logs-2026"}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if err := cl.CreateIndex(context.Background(), "logs-2026", 3, 1); err != nil {
		t.Fatalf("CreateIndex: %v", err)
	}
	var body struct {
		Settings struct {
			Shards   int64 `json:"number_of_shards"`
			Replicas int64 `json:"number_of_replicas"`
		} `json:"settings"`
	}
	if err := json.Unmarshal([]byte(putBody), &body); err != nil {
		t.Fatalf("create body must be JSON: %v (%q)", err, putBody)
	}
	if body.Settings.Shards != 3 || body.Settings.Replicas != 1 {
		t.Fatalf("settings must carry shards/replicas, got %q", putBody)
	}
	if got := rec.paths(); !strings.Contains(got, "PUT /logs-2026") {
		t.Fatalf("must PUT /{index}, got %v", got)
	}

	cl2, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		writeJSON(w, `{"error":{"type":"resource_already_exists_exception"}}`)
	})
	err := cl2.CreateIndex(context.Background(), "logs-2026", 1, 1)
	if err == nil || !strings.Contains(err.Error(), "400") || !strings.Contains(err.Error(), "resource_already_exists") {
		t.Fatalf("server rejection must surface HTTP status and body, got %v", err)
	}
}

// 索引名校验表用例:非法名称本地拒绝且不触网;合法名称照常请求。
func TestEsCreateIndexNameValidation(t *testing.T) {
	hits := 0
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		hits++
		writeJSON(w, `{"acknowledged":true}`)
	})
	cases := []struct {
		name  string
		index string
		ok    bool
	}{
		{"lowercase", "logs-2026", true},
		{"digits dot underscore", "logs_2026.01", true},
		{"empty", "", false},
		{"blank", "   ", false},
		{"uppercase", "Logs", false},
		{"slash", "logs/2026", false},
		{"hash", "logs#1", false},
		{"dash prefix", "-logs", false},
		{"underscore prefix", "_logs", false},
		{"plus prefix", "+logs", false},
		{"space inside", "lo gs", false},
		{"comma", "lo,gs", false},
		{"star", "lo*gs", false},
		{"question", "lo?gs", false},
		{"quote", `lo"gs`, false},
		{"angle", "lo<gs", false},
		{"pipe", "lo|gs", false},
		{"backslash", `lo\gs`, false},
		{"tab", "lo\tgs", false},
		{"newline", "lo\ngs", false},
	}
	before := len(rec.all())
	for _, tc := range cases {
		err := cl.CreateIndex(context.Background(), tc.index, 1, 1)
		if tc.ok && err != nil {
			t.Fatalf("%s: CreateIndex(%q): %v", tc.name, tc.index, err)
		}
		if !tc.ok && err == nil {
			t.Fatalf("%s: CreateIndex(%q) must be rejected", tc.name, tc.index)
		}
	}
	if got := len(rec.all()) - before; got != 2 || hits != 2 {
		t.Fatalf("only the two valid names may hit the server, got %d requests (%d handler hits)", got, hits)
	}
}

// DELETE /{index}:路径转义;非 2xx 成为错误;空索引名本地拒绝不触网。
func TestEsDeleteIndexRemoves(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && r.URL.RequestURI() == "/logs-2026" {
			writeJSON(w, `{"acknowledged":true}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if err := cl.DeleteIndex(context.Background(), "logs-2026"); err != nil {
		t.Fatalf("DeleteIndex: %v", err)
	}
	if got := rec.paths(); !strings.Contains(got, "DELETE /logs-2026") {
		t.Fatalf("must DELETE /{index}, got %v", got)
	}

	cl2, _ := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && r.URL.RequestURI() == "/lo%2Fgs" {
			writeJSON(w, `{"acknowledged":true}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	if err := cl2.DeleteIndex(context.Background(), "lo/gs"); err != nil {
		t.Fatalf("DeleteIndex escaped: %v", err)
	}

	cl3, rec3 := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		writeJSON(w, `{"error":{"type":"index_not_found_exception"}}`)
	})
	if err := cl3.DeleteIndex(context.Background(), "missing"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("missing index must surface the HTTP error, got %v", err)
	}
	before := len(rec3.all())
	if err := cl3.DeleteIndex(context.Background(), "  "); err == nil {
		t.Fatal("empty index name must be rejected")
	}
	if len(rec3.all()) != before {
		t.Fatal("local validation failures must not hit the server")
	}
}

// PUT /{index}/_settings:合法 JSON 对象原样透传;非法 JSON 与非 JSON 对象
// (如数组)本地拒绝且不触网。
func TestEsUpdateIndexSettingsValidatesAndForwards(t *testing.T) {
	var putBody string
	cl, rec := newEsTestClient(t, esRootInfo("8.11.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.URL.RequestURI() == "/logs/_settings" {
			putBody = readAllString(r)
			writeJSON(w, `{"acknowledged":true}`)
			return
		}
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	})
	const settings = `{"index.refresh_interval":"30s","number_of_replicas":2}`
	if err := cl.UpdateIndexSettings(context.Background(), "logs", settings); err != nil {
		t.Fatalf("UpdateIndexSettings: %v", err)
	}
	if putBody != settings {
		t.Fatalf("settings must be forwarded verbatim, got %q", putBody)
	}
	if got := rec.paths(); !strings.Contains(got, "PUT /logs/_settings") {
		t.Fatalf("must PUT /{index}/_settings, got %v", got)
	}

	before := len(rec.all())
	if err := cl.UpdateIndexSettings(context.Background(), "logs", `{"index":`); err == nil ||
		!strings.Contains(err.Error(), "不合法") {
		t.Fatalf("invalid JSON must be rejected locally, got %v", err)
	}
	if err := cl.UpdateIndexSettings(context.Background(), "logs", `[1,2]`); err == nil ||
		strings.Contains(err.Error(), "HTTP") {
		t.Fatalf("non-object JSON (array) must be rejected locally, got %v", err)
	}
	if err := cl.UpdateIndexSettings(context.Background(), "logs", ""); err == nil {
		t.Fatal("empty settings must be rejected")
	}
	if len(rec.all()) != before {
		t.Fatal("local validation failures must not hit the server")
	}
}

// Service 层:索引生命周期方法走池取用(fake 注入),参数原样透传。
func TestServiceESIndexLifecycleDelegates(t *testing.T) {
	fake := &fakeES{}
	svc, id := newTestServiceWithES(t, fake)
	ctx := context.Background()

	if err := svc.EsCreateIndex(ctx, id, "logs-2026", 3, 1); err != nil ||
		fake.createIndexName != "logs-2026" || fake.createShards != 3 || fake.createReplicas != 1 {
		t.Fatalf("EsCreateIndex: %v %+v", err, fake)
	}
	if err := svc.EsDeleteIndex(ctx, id, "logs-2026"); err != nil || fake.deleteIndexName != "logs-2026" {
		t.Fatalf("EsDeleteIndex: %v %q", err, fake.deleteIndexName)
	}
	const settings = `{"number_of_replicas":2}`
	if err := svc.EsUpdateIndexSettings(ctx, id, "logs", settings); err != nil ||
		fake.settingsIndex != "logs" || fake.settingsJSON != settings {
		t.Fatalf("EsUpdateIndexSettings: %v %+v", err, fake)
	}
}

// --- 集群监控聚合统计(ClusterStats,一次调用返回全部指标) ---

// esClusterStatsOKHandler 是四个监控端点的标准 fake 响应(异常用例在命中
// 特定 URI 时先行短路)。
func esClusterStatsOKHandler(w http.ResponseWriter, r *http.Request) {
	switch r.URL.RequestURI() {
	case "/_cluster/health":
		writeJSON(w, `{"cluster_name":"es-prod","status":"yellow","number_of_nodes":3,"number_of_data_nodes":2,
			"active_shards":42,"active_primary_shards":21,"relocating_shards":1,"unassigned_shards":5,"timed_out":false}`)
	case "/_cat/indices?format=json&bytes=b":
		writeJSON(w, `[
			{"health":"yellow","status":"open","index":"logs","docs.count":"120","store.size":"2048"},
			{"health":"yellow","status":"open","index":".kibana","docs.count":null,"store.size":"512"},
			{"health":"green","status":"open","index":"users","docs.count":"7","store.size":null},
			{"health":"green","status":"open","index":"metrics","docs.count":99,"store.size":4096}
		]`)
	case "/_cat/nodes?format=json&h=name,ip,heap.percent,disk.used_percent,node.role":
		writeJSON(w, `[
			{"name":"node-a","ip":"10.0.0.1","heap.percent":"17","disk.used_percent":"63","node.role":"cdhilstw"},
			{"name":"node-b","ip":"10.0.0.2","heap.percent":41,"disk.used_percent":"n/a","node.role":"di"},
			{"name":null,"ip":"10.0.0.3","heap.percent":"0","disk.used_percent":null,"node.role":"-"}
		]`)
	case "/_template":
		writeJSON(w, `{"tpl_a":{"order":1},"tpl_b":{},"tpl_c":{"index_patterns":["c*"]}}`)
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.RequestURI(), http.StatusInternalServerError)
	}
}

// 全链路聚合:health 字段映射、indices 汇总(含系统索引,null docs/size→0)、
// nodes 百分比与角色透传(非数字/null→0)、templates 计数,以及四个端点的
// 请求路径与方法。
func TestEsClusterStatsAggregatesAllMetrics(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), esClusterStatsOKHandler)
	stats, err := cl.ClusterStats(context.Background())
	if err != nil {
		t.Fatalf("ClusterStats: %v", err)
	}
	if stats.ClusterName != "es-prod" || stats.Status != "yellow" ||
		stats.NumberOfNodes != 3 || stats.NumberOfDataNodes != 2 ||
		stats.ActiveShards != 42 || stats.ActivePrimaryShards != 21 ||
		stats.RelocatingShards != 1 || stats.UnassignedShards != 5 {
		t.Fatalf("health fields must map, got %+v", stats)
	}
	// 汇总含系统索引(.kibana);null docs/size 按 0 计:
	// docs=120+0+7+99=226,size=2048+512+0+4096=6656。
	if stats.IndicesCount != 4 || stats.DocsCount != 226 || stats.StoreSizeBytes != 6656 {
		t.Fatalf("indices sums must count every cat row (null→0), got %+v", stats)
	}
	if len(stats.Nodes) != 3 {
		t.Fatalf("nodes must list every cat row, got %+v", stats.Nodes)
	}
	a, b, c := stats.Nodes[0], stats.Nodes[1], stats.Nodes[2]
	if a.Name != "node-a" || a.IP != "10.0.0.1" || a.HeapPercent != 17 || a.DiskPercent != 63 || a.Roles != "cdhilstw" {
		t.Fatalf("node-a must map name/ip/percents/roles, got %+v", a)
	}
	// 非数字百分比("n/a")→ 0;数字串与裸数字都能解析;角色串原样透传。
	if b.Name != "node-b" || b.HeapPercent != 41 || b.DiskPercent != 0 || b.Roles != "di" {
		t.Fatalf("node-b must parse numeric percent and zero the junk one, got %+v", b)
	}
	// null 单元格必须容忍为空串/0,而不是让整个聚合失败。
	if c.Name != "" || c.IP != "10.0.0.3" || c.HeapPercent != 0 || c.DiskPercent != 0 || c.Roles != "-" {
		t.Fatalf("null cells must tolerate, got %+v", c)
	}
	if stats.TemplatesCount != 3 {
		t.Fatalf("templates_count = %d, want 3", stats.TemplatesCount)
	}
	got := rec.paths()
	for _, want := range []string{
		"GET /_cluster/health",
		"GET /_cat/indices?format=json&bytes=b",
		"GET /_cat/nodes?format=json&h=name,ip,heap.percent,disk.used_percent,node.role",
		"GET /_template",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing request %q, got %v", want, got)
		}
	}
}

// /_template 失败仅置 0,不影响整体(核心指标照常返回,无 error)。
func TestEsClusterStatsTemplatesFailureZeroesCount(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() == "/_template" {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		if r.URL.RequestURI() == "/_cat/nodes?format=json&h=name,ip,heap.percent,disk.used_percent,node.role" {
			writeJSON(w, `[]`)
			return
		}
		esClusterStatsOKHandler(w, r)
	})
	stats, err := cl.ClusterStats(context.Background())
	if err != nil {
		t.Fatalf("templates failure must not fail the call: %v", err)
	}
	if stats.TemplatesCount != 0 {
		t.Fatalf("templates failure must zero templates_count, got %d", stats.TemplatesCount)
	}
	if stats.ClusterName != "es-prod" || stats.IndicesCount != 4 || stats.DocsCount != 226 || stats.StoreSizeBytes != 6656 {
		t.Fatalf("other metrics must stay intact: %+v", stats)
	}
	// wire 防御:空节点列表必须是非 nil 空数组。
	if stats.Nodes == nil || len(stats.Nodes) != 0 {
		t.Fatalf("empty nodes must stay a non-nil array, got %#v", stats.Nodes)
	}
}

// 任一核心请求(health/indices/nodes)失败 → 整体返回 error(对应字段零值)。
func TestEsClusterStatsCoreRequestFailure(t *testing.T) {
	cases := []struct {
		name     string
		breakURI string
	}{
		{"health fails", "/_cluster/health"},
		{"indices fail", "/_cat/indices?format=json&bytes=b"},
		{"nodes fail", "/_cat/nodes?format=json&h=name,ip,heap.percent,disk.used_percent,node.role"},
	}
	for _, tc := range cases {
		cl, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
			if r.URL.RequestURI() == tc.breakURI {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			esClusterStatsOKHandler(w, r)
		})
		stats, err := cl.ClusterStats(context.Background())
		if err == nil {
			t.Fatalf("%s: core failure must fail the call, got %+v", tc.name, stats)
		}
		if !strings.Contains(err.Error(), "500") {
			t.Fatalf("%s: error must carry the HTTP status, got %v", tc.name, err)
		}
	}
}

// 核心端点响应不是合法 JSON 同样整体失败(解析错误),不静默给零值。
func TestEsClusterStatsHealthBadJSONFails(t *testing.T) {
	cl, _ := newEsTestClient(t, esRootInfo("6.1.0", ""), func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() == "/_cluster/health" {
			writeJSON(w, `not-json`)
			return
		}
		esClusterStatsOKHandler(w, r)
	})
	if _, err := cl.ClusterStats(context.Background()); err == nil {
		t.Fatal("bad health JSON must fail the call")
	}
}

// 集群监控的四个端点与其它业务请求走同一带认证的请求通道:basic 模式下
// 每个监控请求都必须携带 Authorization 头(构造 ping 之后、聚合之前注入,
// 与 TestEsClientAuthHeaders 同套路)。
func TestEsClusterStatsSendsAuthHeaders(t *testing.T) {
	cl, rec := newEsTestClient(t, esRootInfo("6.1.0", ""), esClusterStatsOKHandler)
	cl.cfg.AuthMode = model.EsAuthBasic
	cl.cfg.Username = "elastic"
	cl.cfg.Password = "s3cret"
	if _, err := cl.ClusterStats(context.Background()); err != nil {
		t.Fatalf("ClusterStats: %v", err)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("elastic:s3cret"))
	monitored := map[string]bool{
		"/_cluster/health": false,
		"/_cat/indices?format=json&bytes=b": false,
		"/_cat/nodes?format=json&h=name,ip,heap.percent,disk.used_percent,node.role": false,
		"/_template": false,
	}
	for _, req := range rec.all() {
		if _, ok := monitored[req.Path]; !ok {
			continue // 构造期的 ping(GET /)不带业务认证,跳过
		}
		if req.Authorization != want {
			t.Fatalf("%s %s must carry the auth header, got %q", req.Method, req.Path, req.Authorization)
		}
		monitored[req.Path] = true
	}
	for path, seen := range monitored {
		if !seen {
			t.Fatalf("monitoring request %s was not issued", path)
		}
	}
}

// Service 层:聚合统计走池取用(fake 注入)。
func TestServiceEsClusterStatsDelegates(t *testing.T) {
	fake := &fakeES{clusterStats: model.EsClusterStats{
		ClusterName:   "es-prod",
		Status:        "green",
		NumberOfNodes: 3,
		IndicesCount:  12,
	}}
	svc, id := newTestServiceWithES(t, fake)
	stats, err := svc.EsClusterStats(context.Background(), id)
	if err != nil || stats.ClusterName != "es-prod" || stats.Status != "green" ||
		stats.NumberOfNodes != 3 || stats.IndicesCount != 12 {
		t.Fatalf("EsClusterStats: %v %+v", err, stats)
	}
	if fake.clusterStatsCalls != 1 {
		t.Fatalf("must delegate to the pooled client once, got %d calls", fake.clusterStatsCalls)
	}
}
