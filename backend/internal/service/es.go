package service

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"dataBasePro/backend/internal/model"
)

// Elasticsearch 自实现 REST 客户端(零新依赖,net/http):索引浏览与文档
// 编辑走 REST(_search/_doc/_mapping/_update/_delete_by_query),SQL 控制台
// 走按服务端版本自动探测的 SQL 端点(OpenSearch /_plugins/_sql、ES 6.3+
// /_xpack/sql、ES 7+ /_sql);三端点全部探测失败时(ES 6.1 OSS 等)回退到
// 本地 SQL→DSL 翻译(essql_translate.go)。不发送任何 vendor compatible-with 头。

// esDialTimeout bounds the initial connect/ping of a new client.
const esDialTimeout = 5 * time.Second

// esHTTPTimeout bounds every single REST request.
const esHTTPTimeout = 30 * time.Second

// esFetchSize 是 SQL 查询固定携带的 fetch_size(cursor 翻页留待后续版本)。
const esFetchSize = 1000

// esCellMaxBytes 是结果单元格文本的截断阈值(与 CH 同风格)。
const esCellMaxBytes = 8192

// ES SQL 端点常量。
const (
	esSQLModern     = "/_sql"          // ES 7+/8.x
	esSQLXpack      = "/_xpack/sql"    // ES 6.3–6.8
	esSQLOpenSearch = "/_plugins/_sql" // OpenSearch
)

// EsClient 是 EsDataSource 的生产实现:纯 REST(net/http),多地址依次
// 尝试;GET / 的版本信息与 SQL 端点选择按连接缓存(客户端实例即连接)。
type EsClient struct {
	cfg    model.EsConfig
	scheme string // http | https(tls_mode 非 disabled → https)
	client *http.Client
	mu     sync.Mutex
	// versionNumber/distribution 来自构造后缓存的 GET /(infoCached 标记)。
	infoCached    bool
	versionNumber string
	distribution  string
	// sqlEndpoint 是探测并验证过的 SQL 端点(no-handler 回退后更新)。
	sqlEP string
	// docBases 缓存各索引的文档路径基段(""_doc" 或 5.x/6.x 的 type 名);
	// docBasesTyped 标记该基段必须走 typed 路径(6.x/5.6:/{index}/{type}/{id}...)。
	docBases      map[string]string
	docBasesTyped map[string]bool
}

// compile-time proof that EsClient implements the ES data source.
var _ EsDataSource = (*EsClient)(nil)

// NewEsClient builds the client over the given config and verifies
// reachability with a GET / ping before returning.
func NewEsClient(cfg model.EsConfig) (*EsClient, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	transport := &http.Transport{}
	if tlsCfg := buildEsTLSConfig(cfg.TLSMode); tlsCfg != nil {
		transport.TLSClientConfig = tlsCfg
	}
	c := &EsClient{
		cfg:           cfg,
		scheme:        "http",
		client:        &http.Client{Timeout: esHTTPTimeout, Transport: transport},
		docBases:      map[string]string{},
		docBasesTyped: map[string]bool{},
	}
	if cfg.TLSMode != model.EsTLSDisabled {
		c.scheme = "https"
	}
	ctx, cancel := context.WithTimeout(context.Background(), esDialTimeout)
	defer cancel()
	if err := c.Connect(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// buildEsTLSConfig derives the TLS config for the given mode: disabled → nil
// (plain http); skip-verify → https with certificate verification off;
// verify-full → https with the system root CA pool. ServerName is left empty
// so Go derives it from each request's host (correct for multi-host configs).
func buildEsTLSConfig(mode string) *tls.Config {
	switch mode {
	case model.EsTLSSkipVerify:
		return &tls.Config{InsecureSkipVerify: true} //nolint:gosec // 用户显式选择跳过校验
	case model.EsTLSVerifyFull:
		return &tls.Config{}
	default:
		return nil
	}
}

// GetName returns the connection name.
func (c *EsClient) GetName() string { return "elasticsearch" }

// GetType returns the connection type.
func (c *EsClient) GetType() string { return string(model.ConnectionTypeES) }

// Connect verifies the server is reachable (GET /, cached afterwards).
func (c *EsClient) Connect(ctx context.Context) error {
	return c.ensureInfo(ctx)
}

// Close releases resources (the HTTP client holds none that need closing).
func (c *EsClient) Close() error { return nil }

// --- HTTP 基建 ---

// applyAuth sets the Authorization header per auth_mode: basic → base64
// user:pass;apikey → the pre-encoded credential;none → no header.
func (c *EsClient) applyAuth(req *http.Request) {
	switch c.cfg.AuthMode {
	case model.EsAuthBasic:
		token := base64.StdEncoding.EncodeToString([]byte(c.cfg.Username + ":" + c.cfg.Password))
		req.Header.Set("Authorization", "Basic "+token)
	case model.EsAuthApikey:
		req.Header.Set("Authorization", "ApiKey "+c.cfg.ApiKey)
	}
}

// doRequest performs one REST call, trying the configured hosts in order
// (first responsive host wins for that request). A non-nil body is sent as
// application/json. Returns the status and body of the first server response
// (HTTP errors are responses, not transport failures).
func (c *EsClient) doRequest(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	var lastErr error
	for _, host := range c.cfg.Hosts {
		u := fmt.Sprintf("%s://%s%s", c.scheme, host, path)
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, rd)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		c.applyAuth(req)
		resp, err := c.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return resp.StatusCode, b, nil
	}
	if lastErr == nil {
		lastErr = errors.New("没有可用节点")
	}
	return 0, nil, fmt.Errorf("elasticsearch 请求失败: %w", lastErr)
}

// ensureInfo lazily fetches and caches GET / (version + distribution).
func (c *EsClient) ensureInfo(ctx context.Context) error {
	c.mu.Lock()
	cached := c.infoCached
	c.mu.Unlock()
	if cached {
		return nil
	}
	status, body, err := c.doRequest(ctx, http.MethodGet, "/", nil)
	if err != nil {
		return fmt.Errorf("elasticsearch ping: %w", err)
	}
	if status != http.StatusOK {
		return fmt.Errorf("elasticsearch ping: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var root struct {
		Version struct {
			Number       string `json:"number"`
			Distribution string `json:"distribution"`
		} `json:"version"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return fmt.Errorf("elasticsearch ping: 解析根信息失败: %w", err)
	}
	c.mu.Lock()
	c.versionNumber = root.Version.Number
	c.distribution = root.Version.Distribution
	c.infoCached = true
	c.mu.Unlock()
	return nil
}

// truncateBody bounds an error body for readability (defined in
// ch_http_driver.go and shared across the self-implemented HTTP clients).

// --- SQL 端点探测与执行 ---

// esSQLCandidates lists the SQL endpoints to probe, best candidate first:
// OpenSearch → /_plugins/_sql;ES 7+ → /_sql;ES 6.3–6.8 → /_xpack/sql.
// When the reported identity is suspicious (major < 6.3, or an unparseable/
// missing version — e.g. OpenSearch 2.x reporting "2.x" without a
// distribution field, cloud/proxy builds stripping fields), all three
// endpoints are probed anyway: the version string has proven unreliable,
// so the decision is made by actually executing a probe statement.
func esSQLCandidates(versionNumber, distribution string) []string {
	if strings.EqualFold(strings.TrimSpace(distribution), "opensearch") {
		return []string{esSQLOpenSearch, esSQLModern, esSQLXpack}
	}
	major, minor := parseEsVersion(versionNumber)
	switch {
	case major >= 7:
		return []string{esSQLModern, esSQLOpenSearch, esSQLXpack}
	case major == 6 && minor >= 3:
		return []string{esSQLXpack, esSQLModern, esSQLOpenSearch}
	default:
		return []string{esSQLOpenSearch, esSQLModern, esSQLXpack}
	}
}

// esProbeQuery returns the lightweight statement used to validate a candidate
// endpoint (OpenSearch's SQL grammar requires the LIKE form).
func esProbeQuery(endpoint string) string {
	if endpoint == esSQLOpenSearch {
		return "SHOW TABLES LIKE '%'"
	}
	return "SHOW TABLES"
}

// parseEsVersion extracts the major/minor numbers from a version string
// ("8.11.0" → 8, 11); unparseable parts fall back to 0.
func parseEsVersion(number string) (major, minor int) {
	parts := strings.SplitN(strings.TrimSpace(number), ".", 3)
	if len(parts) > 0 {
		major, _ = strconv.Atoi(parts[0])
	}
	if len(parts) > 1 {
		minor, _ = strconv.Atoi(parts[1])
	}
	return major, minor
}

// esIsNoHandler reports whether the response is ES's "no handler found"
// rejection (400/404) — the signal to fall back to the other SQL endpoint.
func esIsNoHandler(status int, body []byte) bool {
	return (status == http.StatusBadRequest || status == http.StatusNotFound) &&
		strings.Contains(strings.ToLower(string(body)), "no handler found")
}

// esIsInvalidTypeName reports ES 6.x's rejection of a typeless document path:
// POST /{index}/_update/{id} is parsed as index + mapping type `_update`,
// which is illegal (types can't start with "_"). The 400 body carries
// invalid_type_name_exception instead of "no handler found", so it must be
// recognized separately to trigger the typed-path fallback.
func esIsInvalidTypeName(status int, body []byte) bool {
	return status == http.StatusBadRequest &&
		strings.Contains(string(body), "invalid_type_name_exception")
}

// esIsLicenseBlocked reports whether the server rejected the request because
// SQL is not part of its license/plugin set (403, or a 400 mentioning license).
func esIsLicenseBlocked(status int, body []byte) bool {
	return status == http.StatusForbidden ||
		strings.Contains(strings.ToLower(string(body)), "license")
}

// esSQLError renders a failed SQL HTTP response: license/plugin gaps get the
// explicit 「该服务端未开放 SQL」 prefix; everything else surfaces verbatim.
func esSQLError(status int, body []byte) error {
	if esIsLicenseBlocked(status, body) {
		return fmt.Errorf("elasticsearch sql: 该服务端未开放 SQL: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return fmt.Errorf("elasticsearch sql: HTTP %d: %s", status, truncateBody(string(body), 300))
}

// sqlEndpoint resolves (once per connection) the SQL endpoint by probing the
// candidate endpoints with a real statement — the version string alone has
// proven unreliable (OpenSearch 2.x reports "2.x"; some builds omit the
// distribution field), so the first endpoint that actually answers a probe
// query wins.
func (c *EsClient) sqlEndpoint(ctx context.Context) (string, error) {
	c.mu.Lock()
	ep := c.sqlEP
	c.mu.Unlock()
	if ep != "" {
		return ep, nil
	}
	if err := c.ensureInfo(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	number, dist := c.versionNumber, c.distribution
	c.mu.Unlock()

	var failures []string
	for _, cand := range esSQLCandidates(number, dist) {
		status, body, perr := c.sqlPost(ctx, cand, esProbeQuery(cand))
		if perr != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", cand, perr))
			continue
		}
		if status == http.StatusOK && !esIsNoHandler(status, body) {
			c.mu.Lock()
			c.sqlEP = cand
			c.mu.Unlock()
			return cand, nil
		}
		if esIsLicenseBlocked(status, body) {
			// 端点存在但被许可证/插件挡住:立即给出明确错误(不缓存,
			// 许可证修复后重新探测)。
			return "", esSQLError(status, body)
		}
		failures = append(failures, fmt.Sprintf("%s: HTTP %d: %s", cand, status, truncateBody(string(body), 160)))
	}
	return "", &esNoSQLCapabilityError{msg: fmt.Sprintf(
		"该服务端无 SQL 能力(检测到 version=%s distribution=%q;SQL 需 ES 6.3+,OpenSearch 1.x+,或服务端安装 SQL 插件)。各端点探测结果: %s",
		number, dist, strings.Join(failures, "; "))}
}

// sqlPost posts one SQL statement (or the probe validation query) to the
// endpoint with format=json; no vendor compatible-with headers are sent.
func (c *EsClient) sqlPost(ctx context.Context, endpoint, stmt string) (int, []byte, error) {
	body, err := json.Marshal(map[string]any{"query": stmt, "fetch_size": esFetchSize})
	if err != nil {
		return 0, nil, err
	}
	return c.doRequest(ctx, http.MethodPost, endpoint+"?format=json", body)
}

// sqlQuery runs one SQL statement over the probed endpoint, falling back to
// the alternate endpoint (and remembering it) on a 400 no-handler response.
func (c *EsClient) sqlQuery(ctx context.Context, stmt string) ([]model.EsColumn, [][]*string, error) {
	ep, err := c.sqlEndpoint(ctx)
	if err != nil {
		return nil, nil, err
	}
	status, body, err := c.sqlPost(ctx, ep, stmt)
	if err != nil {
		return nil, nil, fmt.Errorf("elasticsearch sql: %w", err)
	}
	if esIsNoHandler(status, body) {
		var alt string
		for _, cand := range esSQLCandidates(c.versionNumber, c.distribution) {
			if cand != ep {
				alt = cand
				break
			}
		}
		s2, b2, err2 := c.sqlPost(ctx, alt, stmt)
		if err2 == nil && s2 == http.StatusOK && !esIsNoHandler(s2, b2) {
			c.mu.Lock()
			if c.sqlEP == ep {
				c.sqlEP = alt
			}
			c.mu.Unlock()
			return parseEsSQLResponse(b2)
		}
		return nil, nil, fmt.Errorf("elasticsearch sql: 端点 %s 不可用(HTTP %d): %s", ep, status, truncateBody(string(body), 300))
	}
	if status != http.StatusOK {
		return nil, nil, esSQLError(status, body)
	}
	return parseEsSQLResponse(body)
}

// parseEsSQLResponse decodes the SQL endpoint result set: columns[{name,type}]
// plus rows (cursor ignored — fetch_size 1000 already bounds the page).
func parseEsSQLResponse(body []byte) ([]model.EsColumn, [][]*string, error) {
	var resp struct {
		Columns []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"columns"`
		Rows [][]json.RawMessage `json:"rows"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, nil, fmt.Errorf("elasticsearch sql: 解析响应失败: %w", err)
	}
	cols := make([]model.EsColumn, 0, len(resp.Columns))
	for _, col := range resp.Columns {
		cols = append(cols, model.EsColumn{Name: col.Name, Type: col.Type})
	}
	rows := make([][]*string, 0, len(resp.Rows))
	for _, raw := range resp.Rows {
		row := make([]*string, len(raw))
		for i, cell := range raw {
			row[i] = esCellText(cell)
		}
		rows = append(rows, row)
	}
	return cols, rows, nil
}

// esCellText renders one JSON value as a display string: null → nil (SQL
// NULL), strings unquoted, numbers/booleans kept as raw text (no float
// round-trip), objects/arrays as compact JSON.
func esCellText(raw json.RawMessage) *string {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return nil
	}
	if s[0] == '"' {
		var v string
		if err := json.Unmarshal(raw, &v); err == nil {
			return &v
		}
	}
	if s[0] == '{' || s[0] == '[' {
		var buf bytes.Buffer
		if err := json.Compact(&buf, raw); err == nil {
			s = buf.String()
		}
	}
	if len(s) > esCellMaxBytes {
		s = s[:esCellMaxBytes] + CHCellTruncatedSuffix
	}
	return &s
}

// --- 本地 SQL→DSL 翻译回退(无 SQL 端点服务端,如 ES 6.1 OSS) ---

// esNoSQLCapabilityError 表示服务端没有任何可用的 SQL 端点(候选端点全部
// 探测失败)。Execute 据此回退到本地 SQL→DSL 翻译路径;许可证拦截错误不归
// 入此类(SQL 端点存在,原样透传,不走翻译)。
type esNoSQLCapabilityError struct{ msg string }

func (e *esNoSQLCapabilityError) Error() string { return e.msg }

// executeLocalSQL translates one statement locally (essql_translate.go) and
// runs it over plain REST endpoints (search/count/cat/mapping). A translation
// failure keeps both facts in the error: the server has no SQL endpoint, and
// the reason the statement cannot be translated locally.
func (c *EsClient) executeLocalSQL(ctx context.Context, stmt string) ([]model.EsColumn, [][]*string, error) {
	st, terr := TranslateEsSQL(stmt)
	if terr != nil {
		return nil, nil, fmt.Errorf("该服务端无 SQL 端点;%v", terr)
	}
	switch st.Kind {
	case "select":
		return c.execTranslatedSelect(ctx, st)
	case "count":
		return c.execTranslatedCount(ctx, st)
	case "show":
		return c.execTranslatedShow(ctx, st)
	default:
		return c.execTranslatedDescribe(ctx, st)
	}
}

// execTranslatedSelect runs a translated SELECT over POST /{index}/_search:
// "*" expands to the mapping fields (c.Mapping), explicit columns pass
// verbatim; rows align to _source by dotted path (missing → nil, objects/
// arrays rendered as compact JSON via esCellText).
func (c *EsClient) execTranslatedSelect(ctx context.Context, st *EsSqlStatement) ([]model.EsColumn, [][]*string, error) {
	cols := make([]model.EsColumn, 0, len(st.Columns))
	if len(st.Columns) == 1 && st.Columns[0] == "*" {
		mapping, err := c.Mapping(ctx, st.Index)
		if err != nil {
			return nil, nil, err
		}
		cols = append(cols, mapping...)
	} else {
		for _, name := range st.Columns {
			cols = append(cols, model.EsColumn{Name: name})
		}
	}
	body, err := json.Marshal(esSearchBody(st))
	if err != nil {
		return nil, nil, err
	}
	status, respBody, err := c.doRequest(ctx, http.MethodPost, "/"+url.PathEscape(st.Index)+"/_search", body)
	if err != nil {
		return nil, nil, fmt.Errorf("elasticsearch search: %w", err)
	}
	if status != http.StatusOK {
		return nil, nil, fmt.Errorf("elasticsearch search: HTTP %d: %s", status, truncateBody(string(respBody), 300))
	}
	var search struct {
		Hits struct {
			Hits []struct {
				Source json.RawMessage `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(respBody, &search); err != nil {
		return nil, nil, fmt.Errorf("elasticsearch search: 解析响应失败: %w", err)
	}
	rows := make([][]*string, 0, len(search.Hits.Hits))
	for _, hit := range search.Hits.Hits {
		var source map[string]json.RawMessage
		if len(hit.Source) > 0 {
			if err := json.Unmarshal(hit.Source, &source); err != nil {
				return nil, nil, fmt.Errorf("elasticsearch search: 解析 _source 失败: %w", err)
			}
		}
		row := make([]*string, len(cols))
		for i := range cols {
			if raw, ok := esSourceLookup(source, cols[i].Name); ok {
				row[i] = esCellText(raw)
			}
		}
		rows = append(rows, row)
	}
	return cols, rows, nil
}

// esSearchBody 组装翻译后 SELECT 的 _search 请求体:Where 已是 DSL JSON
// (nil → match_all),Sort 渲染为 [{field:{order}}]。
func esSearchBody(st *EsSqlStatement) map[string]any {
	var query any = map[string]any{"match_all": map[string]any{}}
	if st.Where != nil {
		query = json.RawMessage(st.Where)
	}
	body := map[string]any{"from": st.From, "size": st.Size, "query": query}
	if len(st.Sort) > 0 {
		body["sort"] = st.Sort
	}
	return body
}

// execTranslatedCount runs a translated COUNT(*) over POST /{index}/_count.
func (c *EsClient) execTranslatedCount(ctx context.Context, st *EsSqlStatement) ([]model.EsColumn, [][]*string, error) {
	var query any = map[string]any{"match_all": map[string]any{}}
	if st.Where != nil {
		query = json.RawMessage(st.Where)
	}
	body, err := json.Marshal(map[string]any{"query": query})
	if err != nil {
		return nil, nil, err
	}
	status, respBody, err := c.doRequest(ctx, http.MethodPost, "/"+url.PathEscape(st.Index)+"/_count", body)
	if err != nil {
		return nil, nil, fmt.Errorf("elasticsearch count: %w", err)
	}
	if status != http.StatusOK {
		return nil, nil, fmt.Errorf("elasticsearch count: HTTP %d: %s", status, truncateBody(string(respBody), 300))
	}
	var cnt struct {
		Count int64 `json:"count"`
	}
	if err := json.Unmarshal(respBody, &cnt); err != nil {
		return nil, nil, fmt.Errorf("elasticsearch count: 解析响应失败: %w", err)
	}
	n := strconv.FormatInt(cnt.Count, 10)
	return []model.EsColumn{{Name: "COUNT(*)", Type: "long"}}, [][]*string{{&n}}, nil
}

// execTranslatedShow runs SHOW TABLES via ListIndices filtered by the LIKE
// pattern (case-insensitive fnmatch style over * and ?).
func (c *EsClient) execTranslatedShow(ctx context.Context, st *EsSqlStatement) ([]model.EsColumn, [][]*string, error) {
	indices, err := c.ListIndices(ctx)
	if err != nil {
		return nil, nil, err
	}
	cols := []model.EsColumn{{Name: "name", Type: "keyword"}, {Name: "docs_count", Type: "long"}}
	rows := make([][]*string, 0, len(indices))
	for _, idx := range indices {
		if st.Like != "" && !esLikeMatch(st.Like, idx.Name) {
			continue
		}
		rows = append(rows, []*string{esStrPtr(idx.Name), esStrPtr(strconv.FormatInt(idx.DocsCount, 10))})
	}
	return cols, rows, nil
}

// execTranslatedDescribe runs DESCRIBE via Mapping (field/type pairs).
func (c *EsClient) execTranslatedDescribe(ctx context.Context, st *EsSqlStatement) ([]model.EsColumn, [][]*string, error) {
	mapping, err := c.Mapping(ctx, st.Index)
	if err != nil {
		return nil, nil, err
	}
	cols := []model.EsColumn{{Name: "field", Type: "keyword"}, {Name: "type", Type: "keyword"}}
	rows := make([][]*string, 0, len(mapping))
	for _, f := range mapping {
		rows = append(rows, []*string{esStrPtr(f.Name), esStrPtr(f.Type)})
	}
	return cols, rows, nil
}

func esStrPtr(s string) *string { return &s }

// esSourceLookup resolves a possibly dotted field path against a parsed
// _source object ("meta.created" → 逐层下钻);中途遇到数组/标量视为缺失
// (SQL 列与 mapping 拍平路径一一对应,不做数组展开)。
func esSourceLookup(source map[string]json.RawMessage, path string) (json.RawMessage, bool) {
	if !strings.Contains(path, ".") {
		raw, ok := source[path]
		return raw, ok
	}
	cur := source
	parts := strings.Split(path, ".")
	for _, part := range parts[:len(parts)-1] {
		raw, ok := cur[part]
		if !ok {
			return nil, false
		}
		var next map[string]json.RawMessage
		if err := json.Unmarshal(raw, &next); err != nil {
			return nil, false
		}
		cur = next
	}
	raw, ok := cur[parts[len(parts)-1]]
	return raw, ok
}

// Execute runs the script statement by statement over the probed SQL endpoint;
// when the server exposes no SQL endpoint at all (typed esNoSQLCapabilityError,
// e.g. ES 6.1 OSS) each statement transparently falls back to the local
// SQL→DSL translation path. Each result carries its duration and either
// columns+rows or an error text; a failing statement records its error and
// stops the run.
func (c *EsClient) Execute(ctx context.Context, sqlText string) ([]model.EsStatementResult, error) {
	statements := SplitSQLStatements(sqlText)
	if len(statements) == 0 {
		return nil, errors.New("没有可执行的 SQL 语句")
	}
	out := make([]model.EsStatementResult, 0, len(statements))
	for _, stmt := range statements {
		res := model.EsStatementResult{SQL: stmt}
		start := time.Now()
		cols, rows, err := c.sqlQuery(ctx, stmt)
		var noSQL *esNoSQLCapabilityError
		if err != nil && errors.As(err, &noSQL) {
			// 服务端无任何 SQL 端点:回退本地翻译,走普通 REST 端点执行。
			cols, rows, err = c.executeLocalSQL(ctx, stmt)
		}
		res.DurationMs = msSince(start)
		if err != nil {
			res.Error = err.Error()
			return append(out, res), nil
		}
		res.Columns, res.Rows = cols, rows
		out = append(out, res)
	}
	return out, nil
}

// --- 索引浏览 ---

// esCatNumber 容忍 _cat 的字符串/数字/null 三种数值形态(format=json 下
// docs.count/store.size 以字符串到达;缺失列为 null)。
type esCatNumber int64

func (n *esCatNumber) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		*n = esCatNumber(v)
		return nil
	}
	// 兜底:bytes=b 未生效时可能给人类可读大小,无法精确解析则按 0。
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		*n = 0
		return nil
	}
	*n = esCatNumber(f)
	return nil
}

// ListIndices lists user indices via GET /_cat/indices (format=json,
// bytes=b), filtering "."-prefixed system indices and sorting by name.
func (c *EsClient) ListIndices(ctx context.Context) ([]model.EsIndexInfo, error) {
	status, body, err := c.doRequest(ctx, http.MethodGet, "/_cat/indices?format=json&bytes=b", nil)
	if err != nil {
		return nil, fmt.Errorf("elasticsearch list indices: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("elasticsearch list indices: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var cat []struct {
		Index     string      `json:"index"`
		DocsCount esCatNumber `json:"docs.count"`
		StoreSize esCatNumber `json:"store.size"`
	}
	if err := json.Unmarshal(body, &cat); err != nil {
		return nil, fmt.Errorf("elasticsearch list indices: 解析响应失败: %w", err)
	}
	out := make([]model.EsIndexInfo, 0, len(cat))
	for _, row := range cat {
		if strings.HasPrefix(row.Index, ".") {
			continue // 系统索引
		}
		out = append(out, model.EsIndexInfo{
			Name:           row.Index,
			DocsCount:      int64(row.DocsCount),
			StoreSizeBytes: int64(row.StoreSize),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// --- Mapping ---

// esMappingField 是 mapping 字段节点(type/多字段 fields/嵌套 properties)。
type esMappingField struct {
	Type       string                    `json:"type"`
	Fields     map[string]esMappingField `json:"fields"`
	Properties map[string]esMappingField `json:"properties"`
}

// Mapping flattens GET /{index}/_mapping into sorted columns: nested objects
// become dotted paths and multi-fields (e.g. "title.keyword") are included.
func (c *EsClient) Mapping(ctx context.Context, index string) ([]model.EsColumn, error) {
	status, body, err := c.doRequest(ctx, http.MethodGet, "/"+url.PathEscape(index)+"/_mapping", nil)
	if err != nil {
		return nil, fmt.Errorf("elasticsearch mapping: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("elasticsearch mapping: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return nil, fmt.Errorf("elasticsearch mapping: 解析响应失败: %w", err)
	}
	var cols []model.EsColumn
	// 顶层可能是一个索引(单索引查询)或多个(别名);全部合并拍平。
	indexNames := make([]string, 0, len(top))
	for name := range top {
		indexNames = append(indexNames, name)
	}
	sort.Strings(indexNames)
	for _, name := range indexNames {
		var entry struct {
			Mappings json.RawMessage `json:"mappings"`
		}
		if err := json.Unmarshal(top[name], &entry); err != nil {
			return nil, fmt.Errorf("elasticsearch mapping: 解析 %s 失败: %w", name, err)
		}
		if len(entry.Mappings) == 0 {
			continue
		}
		var mappings map[string]json.RawMessage
		if err := json.Unmarshal(entry.Mappings, &mappings); err != nil {
			return nil, fmt.Errorf("elasticsearch mapping: 解析 %s mappings 失败: %w", name, err)
		}
		if props, ok := mappings["properties"]; ok {
			var fields map[string]esMappingField
			if err := json.Unmarshal(props, &fields); err != nil {
				return nil, fmt.Errorf("elasticsearch mapping: 解析 %s properties 失败: %w", name, err)
			}
			esFlattenProperties(fields, "", &cols)
			continue
		}
		// 5.x/6.x 类型化 mappings:{"<type>":{"properties":{...}}}(可能多 type,合并)。
		typeNames := make([]string, 0, len(mappings))
		for t := range mappings {
			typeNames = append(typeNames, t)
		}
		sort.Strings(typeNames)
		for _, t := range typeNames {
			var typed struct {
				Properties map[string]esMappingField `json:"properties"`
			}
			if err := json.Unmarshal(mappings[t], &typed); err != nil {
				return nil, fmt.Errorf("elasticsearch mapping: 解析 %s/%s 失败: %w", name, t, err)
			}
			esFlattenProperties(typed.Properties, "", &cols)
		}
	}
	sort.Slice(cols, func(i, j int) bool { return cols[i].Name < cols[j].Name })
	return cols, nil
}

// esFlattenProperties walks mapping properties recursively: typed fields (and
// their multi-fields) become columns; object/nested fields recurse with a
// dotted prefix.
func esFlattenProperties(props map[string]esMappingField, prefix string, out *[]model.EsColumn) {
	for name, f := range props {
		full := prefix + name
		if f.Type != "" {
			*out = append(*out, model.EsColumn{Name: full, Type: f.Type})
			subNames := make([]string, 0, len(f.Fields))
			for sub := range f.Fields {
				subNames = append(subNames, sub)
			}
			sort.Strings(subNames)
			for _, sub := range subNames {
				*out = append(*out, model.EsColumn{Name: full + "." + sub, Type: f.Fields[sub].Type})
			}
		}
		if len(f.Properties) > 0 {
			esFlattenProperties(f.Properties, full+".", out)
		}
	}
}

// --- 文档分页(_search) ---

// PageRows returns one page of an index's documents: columns are the
// read-only "_id" sentinel followed by the mapping fields; rows align to the
// columns (nil = field absent from _source). where uses two-level semantics:
// a value containing ":" is treated as a hand-written query_string fragment
// (field:value, AND/OR, wildcards); anything else is a plain keyword searched
// across all fields via lenient multi_match — query_string would otherwise
// mangle values like `2026-08-21` or `abc-def` with its operator syntax.
// orderBy/asc render the sort clause.
func (c *EsClient) PageRows(ctx context.Context, index, where, orderBy string, asc bool, limit, offset int) (model.EsPageRowsResult, error) {
	var res model.EsPageRowsResult

	mapping, err := c.Mapping(ctx, index)
	if err != nil {
		return res, err
	}
	cols := make([]model.EsColumn, 0, len(mapping)+1)
	cols = append(cols, model.EsColumn{Name: "_id", Type: "_id"})
	cols = append(cols, mapping...)
	res.Columns = cols

	query := map[string]any{"match_all": map[string]any{}}
	if w := strings.TrimSpace(where); w != "" {
		if strings.Contains(w, ":") {
			query = map[string]any{"query_string": map[string]any{"query": w}}
		} else {
			query = map[string]any{"multi_match": map[string]any{"query": w, "lenient": true}}
		}
	}
	bodyMap := map[string]any{"from": offset, "size": limit, "query": query}
	if o := strings.TrimSpace(orderBy); o != "" {
		direction := "asc"
		if !asc {
			direction = "desc"
		}
		bodyMap["sort"] = []map[string]map[string]string{{o: {"order": direction}}}
	}
	body, err := json.Marshal(bodyMap)
	if err != nil {
		return res, err
	}
	status, respBody, err := c.doRequest(ctx, http.MethodPost, "/"+url.PathEscape(index)+"/_search", body)
	if err != nil {
		return res, fmt.Errorf("elasticsearch search: %w", err)
	}
	if status != http.StatusOK {
		return res, fmt.Errorf("elasticsearch search: HTTP %d: %s", status, truncateBody(string(respBody), 300))
	}

	var search struct {
		Hits struct {
			Total json.RawMessage `json:"total"`
			Hits  []struct {
				ID     string          `json:"_id"`
				Source json.RawMessage `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(respBody, &search); err != nil {
		return res, fmt.Errorf("elasticsearch search: 解析响应失败: %w", err)
	}
	res.TotalRows = esTotalRows(search.Hits.Total)

	var source map[string]json.RawMessage
	for _, hit := range search.Hits.Hits {
		id := hit.ID
		row := make([]*string, len(cols))
		row[0] = &id
		source = nil
		if len(hit.Source) > 0 {
			if err := json.Unmarshal(hit.Source, &source); err != nil {
				return res, fmt.Errorf("elasticsearch search: 解析 _source 失败: %w", err)
			}
		}
		for i, col := 1, len(cols); i < col; i++ {
			if raw, ok := source[cols[i].Name]; ok {
				row[i] = esCellText(raw)
			}
		}
		res.Rows = append(res.Rows, row)
	}
	res.PrimaryKey = []string{"_id"}
	res.Engine = index

	// wire 形状防御:空结果归一为非 nil 空数组(前端按数组渲染)。
	if res.Rows == nil {
		res.Rows = [][]*string{}
	}
	if res.PrimaryKey == nil {
		res.PrimaryKey = []string{}
	}
	return res, nil
}

// esTotalRows unwraps hits.total in both shapes: 7.x/8.x object
// {"value":N,...} and 6.x/5.x bare number.
func esTotalRows(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var anyVal any
	if err := json.Unmarshal(raw, &anyVal); err != nil {
		return 0
	}
	switch v := anyVal.(type) {
	case float64:
		return int64(v)
	case map[string]any:
		if f, ok := v["value"].(float64); ok {
			return int64(f)
		}
	}
	return 0
}

// --- 文档 CRUD(_doc / _update / _delete_by_query) ---

// esDocPath renders the document path for base ("_doc" or a 5.x type name):
// plain doc ops → /{index}/{base}/{id}; updates → /{index}/_update/{id}
// (6.x+) or /{index}/{type}/{id}/_update (5.x).
func esDocPath(index, base, id, action string, typed bool) string {
	esc := url.PathEscape
	if action == "_update" {
		if base == "_doc" && !typed {
			// 7.x+ 无 type 更新路径;6.x/5.6 必须走 typed 形态(typed=true)。
			return "/" + esc(index) + "/_update/" + esc(id)
		}
		return "/" + esc(index) + "/" + esc(base) + "/" + esc(id) + "/_update"
	}
	return "/" + esc(index) + "/" + esc(base) + "/" + esc(id)
}

// docBase returns the cached path base for the index ("_doc" until a 5.x
// typed fallback resolves and remembers the real type name).
func (c *EsClient) docBase(index string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if base, ok := c.docBases[index]; ok && base != "" {
		return base, c.docBasesTyped[index]
	}
	return "_doc", false
}

// resolveDocType extracts the (first, sorted) mapping type name for typed
// indices (5.x/6.x with include_type_name); untyped mappings return "".
func (c *EsClient) resolveDocType(ctx context.Context, index string) (string, error) {
	status, body, err := c.doRequest(ctx, http.MethodGet, "/"+url.PathEscape(index)+"/_mapping", nil)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("elasticsearch mapping: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return "", err
	}
	for _, raw := range top {
		var entry struct {
			Mappings json.RawMessage `json:"mappings"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			continue
		}
		var mappings map[string]json.RawMessage
		if err := json.Unmarshal(entry.Mappings, &mappings); err != nil {
			continue
		}
		if _, ok := mappings["properties"]; ok {
			return "", nil // 无类型化映射,_doc 即唯一路径
		}
		typeNames := make([]string, 0, len(mappings))
		for t := range mappings {
			typeNames = append(typeNames, t)
		}
		sort.Strings(typeNames)
		if len(typeNames) > 0 {
			return typeNames[0], nil
		}
	}
	return "", nil
}

// docRequest performs a document operation, transparently falling back to the
// typed 5.x path (/{index}/{type}/{id}) when "_doc" meets a no-handler
// response; the resolved base is remembered per index.
func (c *EsClient) docRequest(ctx context.Context, method, index, id, action string, body []byte) (int, []byte, error) {
	base, typed := c.docBase(index)
	status, respBody, err := c.doRequest(ctx, method, esDocPath(index, base, id, action, typed), body)
	if err != nil {
		return 0, nil, err
	}
	// 无 type 路径在 6.x/5.6 上有两种拒绝形态:400 no handler found(路由
	// 不存在)与 400 invalid_type_name_exception(_update 被当成映射类型名,
	// 实测 6.1 OSS)。两者都必须触发 typed 回退。
	if (esIsNoHandler(status, respBody) || esIsInvalidTypeName(status, respBody)) && base == "_doc" {
		typ, terr := c.resolveDocType(ctx, index)
		if terr == nil && typ != "" {
			// 重试必须走强制 typed 路径:解析出的 type 可能就叫 "_doc"
			// (6.x 默认),普通构造会退回 7.x 无 type 形态,再次 400。
			s2, b2, err2 := c.doRequest(ctx, method, esDocPath(index, typ, id, action, true), body)
			if err2 != nil {
				return 0, nil, err2
			}
			if !esIsNoHandler(s2, b2) {
				c.mu.Lock()
				c.docBases[index] = typ
				c.docBasesTyped[index] = true
				c.mu.Unlock()
			}
			return s2, b2, nil
		}
	}
	return status, respBody, nil
}

// GetDoc returns the document's _source JSON text.
func (c *EsClient) GetDoc(ctx context.Context, index, id string) (string, error) {
	status, body, err := c.docRequest(ctx, http.MethodGet, index, id, "", nil)
	if err != nil {
		return "", fmt.Errorf("elasticsearch get doc: %w", err)
	}
	if status == http.StatusNotFound {
		if strings.Contains(strings.ReplaceAll(string(body), " ", ""), `"found":false`) {
			return "", fmt.Errorf("elasticsearch get doc: 文档 %s 不存在(索引 %s)", id, index)
		}
		return "", fmt.Errorf("elasticsearch get doc: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("elasticsearch get doc: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var doc struct {
		Found  bool            `json:"found"`
		Source json.RawMessage `json:"_source"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return "", fmt.Errorf("elasticsearch get doc: 解析响应失败: %w", err)
	}
	if !doc.Found {
		return "", fmt.Errorf("elasticsearch get doc: 文档 %s 不存在(索引 %s)", id, index)
	}
	return string(doc.Source), nil
}

// PutDoc replaces the document identified by id with docJSON (must be a JSON
// object; sent verbatim).
func (c *EsClient) PutDoc(ctx context.Context, index, id, docJSON string) error {
	trimmed := strings.TrimSpace(docJSON)
	if trimmed == "" {
		return errors.New("文档内容不能为空")
	}
	if !json.Valid([]byte(trimmed)) {
		return errors.New("文档内容不是合法 JSON")
	}
	if !strings.HasPrefix(trimmed, "{") {
		return errors.New("文档内容必须是 JSON 对象")
	}
	status, body, err := c.docRequest(ctx, http.MethodPut, index, id, "", []byte(trimmed))
	if err != nil {
		return fmt.Errorf("elasticsearch put doc: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch put doc: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// UpdateCell patches one field via POST /{index}/_update/{id} with
// {"doc":{"col":val}}; a nil value writes JSON null. Fields prefixed with "_"
// are document metadata and rejected.
func (c *EsClient) UpdateCell(ctx context.Context, index, id, column string, value *string) error {
	if strings.TrimSpace(column) == "" {
		return errors.New("列名不能为空")
	}
	if strings.HasPrefix(column, "_") {
		return fmt.Errorf("列 %q 是以 _ 开头的系统字段,不允许编辑", column)
	}
	key, err := json.Marshal(column)
	if err != nil {
		return err
	}
	var val string
	if value == nil {
		val = "null"
	} else {
		vb, merr := json.Marshal(*value)
		if merr != nil {
			return merr
		}
		val = string(vb)
	}
	body := []byte(`{"doc":{` + string(key) + `:` + val + `}}`)
	status, respBody, err := c.docRequest(ctx, http.MethodPost, index, id, "_update", body)
	if err != nil {
		return fmt.Errorf("elasticsearch update: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch update: HTTP %d: %s", status, truncateBody(string(respBody), 300))
	}
	return nil
}

// DeleteDoc removes one document.
func (c *EsClient) DeleteDoc(ctx context.Context, index, id string) error {
	status, body, err := c.docRequest(ctx, http.MethodDelete, index, id, "", nil)
	if err != nil {
		return fmt.Errorf("elasticsearch delete doc: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch delete doc: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// DeleteByQuery deletes documents matching the given DSL query(JSON 文本,
// 以 {"query":<query>} 转发)并返回删除数;query 必须是合法 JSON 对象。
func (c *EsClient) DeleteByQuery(ctx context.Context, index, query string) (int64, error) {
	q := strings.TrimSpace(query)
	if !json.Valid([]byte(q)) {
		return 0, errors.New("查询 DSL 不是合法 JSON")
	}
	if !strings.HasPrefix(q, "{") {
		return 0, errors.New("查询 DSL 必须是 JSON 对象")
	}
	body, err := json.Marshal(map[string]json.RawMessage{"query": json.RawMessage(q)})
	if err != nil {
		return 0, err
	}
	status, respBody, err := c.doRequest(ctx, http.MethodPost, "/"+url.PathEscape(index)+"/_delete_by_query", body)
	if err != nil {
		return 0, fmt.Errorf("elasticsearch delete_by_query: %w", err)
	}
	if status < 200 || status > 299 {
		return 0, fmt.Errorf("elasticsearch delete_by_query: HTTP %d: %s", status, truncateBody(string(respBody), 300))
	}
	var resp struct {
		Deleted int64 `json:"deleted"`
	}
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return 0, fmt.Errorf("elasticsearch delete_by_query: 解析响应失败: %w", err)
	}
	return resp.Deleted, nil
}

// --- 索引生命周期(创建/删除/改设置) ---

// esValidateIndexName enforces the ES index naming rules: non-empty, lowercase,
// and free of \ / * ? " < > | space , # and control characters, with no
// leading - _ +.
func esValidateIndexName(name string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("索引名不能为空")
	}
	if name != strings.ToLower(name) {
		return fmt.Errorf("索引名 %q 必须为小写", name)
	}
	const forbidden = `\/*?"<>| ,#`
	for _, r := range name {
		if strings.ContainsRune(forbidden, r) || unicode.IsControl(r) {
			return fmt.Errorf("索引名 %q 含有非法字符 %q", name, string(r))
		}
	}
	if strings.HasPrefix(name, "-") || strings.HasPrefix(name, "_") || strings.HasPrefix(name, "+") {
		return fmt.Errorf("索引名 %q 不能以 - _ + 开头", name)
	}
	return nil
}

// CreateIndex creates the index with the given shard/replica counts
// (PUT /{index} {"settings":{...}}); the name is validated locally against the
// ES index naming rules before any request is sent.
func (c *EsClient) CreateIndex(ctx context.Context, index string, shards, replicas int64) error {
	if err := esValidateIndexName(index); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{
		"settings": map[string]any{
			"number_of_shards":   shards,
			"number_of_replicas": replicas,
		},
	})
	if err != nil {
		return err
	}
	status, respBody, err := c.doRequest(ctx, http.MethodPut, "/"+url.PathEscape(index), body)
	if err != nil {
		return fmt.Errorf("elasticsearch create index: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch create index: HTTP %d: %s", status, truncateBody(string(respBody), 300))
	}
	return nil
}

// DeleteIndex removes the index (DELETE /{index}).
func (c *EsClient) DeleteIndex(ctx context.Context, index string) error {
	if strings.TrimSpace(index) == "" {
		return errors.New("索引名不能为空")
	}
	status, body, err := c.doRequest(ctx, http.MethodDelete, "/"+url.PathEscape(index), nil)
	if err != nil {
		return fmt.Errorf("elasticsearch delete index: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch delete index: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// UpdateIndexSettings applies index-level settings (PUT /{index}/_settings);
// settingsJSON must be a valid JSON object and is forwarded verbatim.
func (c *EsClient) UpdateIndexSettings(ctx context.Context, index, settingsJSON string) error {
	if strings.TrimSpace(index) == "" {
		return errors.New("索引名不能为空")
	}
	trimmed := strings.TrimSpace(settingsJSON)
	if !json.Valid([]byte(trimmed)) {
		return errors.New("设置 JSON 不合法")
	}
	if !strings.HasPrefix(trimmed, "{") {
		return errors.New("设置必须是 JSON 对象")
	}
	status, body, err := c.doRequest(ctx, http.MethodPut, "/"+url.PathEscape(index)+"/_settings", []byte(trimmed))
	if err != nil {
		return fmt.Errorf("elasticsearch update settings: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch update settings: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// --- 索引刷新与索引模板(legacy /_template,6.x OSS 可用,无 X-Pack 依赖) ---

// RefreshIndex forces a refresh of the index's shards (POST
// /{index}/_refresh) so freshly indexed documents become searchable.
func (c *EsClient) RefreshIndex(ctx context.Context, index string) error {
	if strings.TrimSpace(index) == "" {
		return errors.New("索引名不能为空")
	}
	status, body, err := c.doRequest(ctx, http.MethodPost, "/"+url.PathEscape(index)+"/_refresh", nil)
	if err != nil {
		return fmt.Errorf("elasticsearch refresh: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch refresh: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// ListTemplates lists the legacy index templates via GET /_template: name plus
// the template's declared order (0 when absent), sorted by name for a stable
// listing.
func (c *EsClient) ListTemplates(ctx context.Context) ([]model.EsTemplateInfo, error) {
	status, body, err := c.doRequest(ctx, http.MethodGet, "/_template", nil)
	if err != nil {
		return nil, fmt.Errorf("elasticsearch list templates: %w", err)
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("elasticsearch list templates: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var raw map[string]struct {
		Order int64 `json:"order"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("elasticsearch list templates: 解析响应失败: %w", err)
	}
	out := make([]model.EsTemplateInfo, 0, len(raw))
	for name, tpl := range raw {
		out = append(out, model.EsTemplateInfo{Name: name, Order: tpl.Order})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// GetTemplate returns the raw response text of GET /_template/{name} — the
// {"<名称>":{...}} envelope is passed through verbatim (the frontend parses
// and round-trips it).
func (c *EsClient) GetTemplate(ctx context.Context, name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", errors.New("模板名称不能为空")
	}
	status, body, err := c.doRequest(ctx, http.MethodGet, "/_template/"+url.PathEscape(name), nil)
	if err != nil {
		return "", fmt.Errorf("elasticsearch get template: %w", err)
	}
	if status != http.StatusOK {
		return "", fmt.Errorf("elasticsearch get template: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return string(body), nil
}

// PutTemplate creates or replaces the legacy index template: templateJSON is
// validated locally (json.Valid) and forwarded verbatim.
func (c *EsClient) PutTemplate(ctx context.Context, name, templateJSON string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("模板名称不能为空")
	}
	trimmed := strings.TrimSpace(templateJSON)
	if !json.Valid([]byte(trimmed)) {
		return errors.New("模板 JSON 不合法")
	}
	status, body, err := c.doRequest(ctx, http.MethodPut, "/_template/"+url.PathEscape(name), []byte(trimmed))
	if err != nil {
		return fmt.Errorf("elasticsearch put template: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch put template: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// DeleteTemplate removes the legacy index template.
func (c *EsClient) DeleteTemplate(ctx context.Context, name string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("模板名称不能为空")
	}
	status, body, err := c.doRequest(ctx, http.MethodDelete, "/_template/"+url.PathEscape(name), nil)
	if err != nil {
		return fmt.Errorf("elasticsearch delete template: %w", err)
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("elasticsearch delete template: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	return nil
}

// --- 集群监控聚合统计(一次调用返回全部指标) ---

// esCatString 容忍 _cat 的字符串/null 两种形态(null → 空串;数字/布尔按
// 原始文本透传)。
type esCatString string

func (s *esCatString) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*s = ""
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var v string
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*s = esCatString(v)
		return nil
	}
	*s = esCatString(b)
	return nil
}

// ClusterStats aggregates the cluster monitoring metrics in one call from
// free endpoints only (6.1 OSS compatible): /_cluster/health (cluster status
// and shard counts), /_cat/indices?format=json&bytes=b (index/doc/store sums,
// system indices included), /_cat/nodes?format=json&h=name,ip,heap.percent,
// disk.used_percent,node.role (per-node overview) and /_template (legacy
// template count). Any failing core request (health/indices/nodes) fails the
// whole call with a zero struct; a failing /_template only zeroes
// templates_count and never fails the call.
//
// bytes=b 让 6.x–8.x 的 store.size 输出精确字节数(否则是人类可读的 "4.9kb",
// 无法还原);部分新版服务端会直接给 store.size_in_bytes/docs 嵌套对象,存在
// 时优先采用。docs.count/store.size 可能为 null(关闭的索引等),按 0 计入。
func (c *EsClient) ClusterStats(ctx context.Context) (model.EsClusterStats, error) {
	var stats model.EsClusterStats

	// 1) 集群健康(状态与分片计数)。
	status, body, err := c.doRequest(ctx, http.MethodGet, "/_cluster/health", nil)
	if err != nil {
		return stats, fmt.Errorf("elasticsearch cluster health: %w", err)
	}
	if status != http.StatusOK {
		return stats, fmt.Errorf("elasticsearch cluster health: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var health struct {
		ClusterName         string `json:"cluster_name"`
		Status              string `json:"status"`
		NumberOfNodes       int64  `json:"number_of_nodes"`
		NumberOfDataNodes   int64  `json:"number_of_data_nodes"`
		ActiveShards        int64  `json:"active_shards"`
		ActivePrimaryShards int64  `json:"active_primary_shards"`
		RelocatingShards    int64  `json:"relocating_shards"`
		UnassignedShards    int64  `json:"unassigned_shards"`
	}
	if err := json.Unmarshal(body, &health); err != nil {
		return stats, fmt.Errorf("elasticsearch cluster health: 解析响应失败: %w", err)
	}
	stats.ClusterName = health.ClusterName
	stats.Status = health.Status
	stats.NumberOfNodes = health.NumberOfNodes
	stats.NumberOfDataNodes = health.NumberOfDataNodes
	stats.ActiveShards = health.ActiveShards
	stats.ActivePrimaryShards = health.ActivePrimaryShards
	stats.RelocatingShards = health.RelocatingShards
	stats.UnassignedShards = health.UnassignedShards

	// 2) 索引汇总(条目数含系统索引;docs.count/store.size 缺失或 null → 0)。
	status, body, err = c.doRequest(ctx, http.MethodGet, "/_cat/indices?format=json&bytes=b", nil)
	if err != nil {
		return stats, fmt.Errorf("elasticsearch cluster stats indices: %w", err)
	}
	if status != http.StatusOK {
		return stats, fmt.Errorf("elasticsearch cluster stats indices: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var cat []struct {
		// 6.x–9.x 的扁平键 "docs.count"(_cat JSON 的键名自带点)。
		DocsCount esCatNumber `json:"docs.count"`
		// 个别新形态把 docs 拆成嵌套对象 {"count":N}:存在时优先。
		Docs *struct {
			Count esCatNumber `json:"count"`
		} `json:"docs"`
		// 新版可能直接给字节数字段:存在时优先于 bytes=b 的 store.size。
		StoreSizeInBytes *esCatNumber `json:"store.size_in_bytes"`
		StoreSize        esCatNumber  `json:"store.size"`
	}
	if err := json.Unmarshal(body, &cat); err != nil {
		return stats, fmt.Errorf("elasticsearch cluster stats indices: 解析响应失败: %w", err)
	}
	stats.IndicesCount = int64(len(cat))
	for _, row := range cat {
		if row.Docs != nil {
			stats.DocsCount += int64(row.Docs.Count)
		} else {
			stats.DocsCount += int64(row.DocsCount)
		}
		if row.StoreSizeInBytes != nil {
			stats.StoreSizeBytes += int64(*row.StoreSizeInBytes)
		} else {
			stats.StoreSizeBytes += int64(row.StoreSize)
		}
	}

	// 3) 节点概要(百分比 "17"→17,非数字→0;角色串原样透传)。
	status, body, err = c.doRequest(ctx, http.MethodGet,
		"/_cat/nodes?format=json&h=name,ip,heap.percent,disk.used_percent,node.role", nil)
	if err != nil {
		return stats, fmt.Errorf("elasticsearch cluster stats nodes: %w", err)
	}
	if status != http.StatusOK {
		return stats, fmt.Errorf("elasticsearch cluster stats nodes: HTTP %d: %s", status, truncateBody(string(body), 300))
	}
	var catNodes []struct {
		Name  esCatString `json:"name"`
		IP    esCatString `json:"ip"`
		Heap  esCatNumber `json:"heap.percent"`
		Disk  esCatNumber `json:"disk.used_percent"`
		Roles esCatString `json:"node.role"`
	}
	if err := json.Unmarshal(body, &catNodes); err != nil {
		return stats, fmt.Errorf("elasticsearch cluster stats nodes: 解析响应失败: %w", err)
	}
	stats.Nodes = make([]model.EsNodeInfo, 0, len(catNodes))
	for _, n := range catNodes {
		stats.Nodes = append(stats.Nodes, model.EsNodeInfo{
			Name:        string(n.Name),
			IP:          string(n.IP),
			Roles:       string(n.Roles),
			HeapPercent: int64(n.Heap),
			DiskPercent: int64(n.Disk),
		})
	}

	// 4) legacy 模板数(失败仅置 0,不影响整体)。
	status, body, err = c.doRequest(ctx, http.MethodGet, "/_template", nil)
	if err == nil && status == http.StatusOK {
		var raw map[string]json.RawMessage
		if json.Unmarshal(body, &raw) == nil {
			stats.TemplatesCount = int64(len(raw))
		}
	}
	return stats, nil
}

// --- DSL 透传(DSL 控制台,Kibana Dev Tools 风格) ---

// esDslMaxBodyBytes 是 DSL 透传响应体回传前端的截断上限(64KB,远宽于错误体
// 的 300 字节——DSL 控制台需要完整的查询结果)。
const esDslMaxBodyBytes = 64 * 1024

// esDslValidateMethod normalizes the method to upper-case and enforces the
// whitelist (GET/POST/PUT/DELETE/HEAD).
func esDslValidateMethod(method string) (string, error) {
	m := strings.ToUpper(strings.TrimSpace(method))
	switch m {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead:
		return m, nil
	default:
		return "", fmt.Errorf("不支持的 HTTP 方法 %q(仅支持 GET/POST/PUT/DELETE/HEAD)", method)
	}
}

// esDslValidatePath enforces the path safety rules: a leading "/", no
// whitespace/control characters (CRLF injection) and no "://" (absolute URLs
// must never ride along as the path). Query strings are allowed.
func esDslValidatePath(path string) error {
	if path == "" || path[0] != '/' {
		return errors.New("path 必须以 / 开头")
	}
	if strings.Contains(path, "://") {
		return errors.New(`path 不能包含 "://"(禁止以绝对 URL 作为路径)`)
	}
	for _, r := range path {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return errors.New("path 不能包含空白或控制字符")
		}
	}
	return nil
}

// DSL executes one raw REST request for the DSL console: method+path+body go
// through the same request channel as every other call (auth headers / TLS /
// host rotation / timeout), the path is appended to the base verbatim, and any
// HTTP response — 4xx/5xx included — returns as status+body (the frontend
// renders by status; only local validation and transport failures are Go
// errors). A non-blank body must be valid JSON.
func (c *EsClient) DSL(ctx context.Context, method, path, body string) (model.EsDslResult, error) {
	m, err := esDslValidateMethod(method)
	if err != nil {
		return model.EsDslResult{}, err
	}
	if err := esDslValidatePath(path); err != nil {
		return model.EsDslResult{}, err
	}
	var payload []byte
	if strings.TrimSpace(body) != "" {
		if !json.Valid([]byte(body)) {
			return model.EsDslResult{}, errors.New("请求体 JSON 不合法")
		}
		payload = []byte(body)
	}
	status, respBody, err := c.doRequest(ctx, m, path, payload)
	if err != nil {
		return model.EsDslResult{}, fmt.Errorf("elasticsearch dsl: %w", err)
	}
	return model.EsDslResult{Status: status, Body: truncateBody(string(respBody), esDslMaxBodyBytes)}, nil
}

// EsDsl runs one raw DSL console request over the pooled Elasticsearch client
// (same pool/auto-connect path as EsExecute; audited by the app layer).
func (s *Service) EsDsl(ctx context.Context, id, method, path, body string) (model.EsDslResult, error) {
	e, err := s.es(ctx, id)
	if err != nil {
		return model.EsDslResult{}, err
	}
	return e.DSL(ctx, method, path, body)
}
