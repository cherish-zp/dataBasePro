package model

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// Elasticsearch 支持的认证模式。auth_mode 为空时归一为 none(不发认证头)。
const (
	EsAuthNone   = "none"
	EsAuthBasic  = "basic"
	EsAuthApikey = "apikey"
)

// Elasticsearch 支持的 TLS 模式(与 MySQL/TiDB 命名一致):
// disabled → http;skip-verify → https 且跳过证书校验;verify-full → https
// 且用系统根证书校验。空值归一为 disabled。
const (
	EsTLSDisabled   = "disabled"
	EsTLSSkipVerify = "skip-verify"
	EsTLSVerifyFull = "verify-full"
)

// EsDefaultPort 是 Elasticsearch REST API 的默认端口。
const EsDefaultPort = 9200

// EsConfig holds the connection settings for an Elasticsearch/OpenSearch
// cluster. Hosts are "host:port" addresses (default port 9200 is filled in
// during Validate); every request tries them in order. ApiKey carries an
// already base64-encoded "id:secret" credential (auth_mode=apikey only).
type EsConfig struct {
	Hosts    []string `json:"hosts"`
	Username string   `json:"username"`
	Password string   `json:"password,omitempty"`
	ApiKey   string   `json:"api_key,omitempty"`
	AuthMode string   `json:"auth_mode,omitempty"`
	TLSMode  string   `json:"tls_mode,omitempty"`
}

// Validate checks the Elasticsearch configuration and normalizes it in place:
// hosts are trimmed, a leading http(s):// scheme is stripped, a missing port
// becomes 9200; auth_mode normalizes to none/basic/apikey (empty → none, with
// basic requiring a username and apikey requiring a key) and tls_mode
// normalizes to disabled/skip-verify/verify-full (empty → disabled).
func (c *EsConfig) Validate() error {
	if len(c.Hosts) == 0 {
		return errors.New("elasticsearch hosts 不能为空")
	}
	hosts := make([]string, 0, len(c.Hosts))
	for _, h := range c.Hosts {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if i := strings.Index(h, "://"); i >= 0 {
			h = h[i+3:]
		}
		if h = strings.TrimSpace(h); h == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(h); err != nil {
			h = net.JoinHostPort(strings.Trim(h, "[]"), fmt.Sprint(EsDefaultPort))
		}
		hosts = append(hosts, h)
	}
	if len(hosts) == 0 {
		return errors.New("elasticsearch hosts 不能为空")
	}
	c.Hosts = hosts

	switch m := strings.ToLower(strings.TrimSpace(c.AuthMode)); m {
	case "":
		c.AuthMode = EsAuthNone
	case EsAuthNone, EsAuthBasic, EsAuthApikey:
		c.AuthMode = m
	default:
		return fmt.Errorf("不支持的 auth_mode %q(仅支持 none/basic/apikey)", c.AuthMode)
	}
	switch c.AuthMode {
	case EsAuthBasic:
		if strings.TrimSpace(c.Username) == "" {
			return errors.New("basic 认证需要用户名(auth_mode=basic 时 username 必填)")
		}
	case EsAuthApikey:
		if strings.TrimSpace(c.ApiKey) == "" {
			return errors.New("apikey 认证需要 api_key(已 base64 编码的 id:secret)")
		}
	}

	switch m := strings.ToLower(strings.TrimSpace(c.TLSMode)); m {
	case "":
		c.TLSMode = EsTLSDisabled
	case EsTLSDisabled, EsTLSSkipVerify, EsTLSVerifyFull:
		c.TLSMode = m
	default:
		return fmt.Errorf("不支持的 TLS 模式 %q(仅支持 disabled/skip-verify/verify-full)", c.TLSMode)
	}
	return nil
}

// EsColumn is one result column: name plus the mapping/SQL type string
// (e.g. "text", "long", "_id"). The read-only document id column carries the
// sentinel type "_id". Comment is always empty for Elasticsearch (kept for
// wire-shape parity with the other data sources; omitted when empty).
type EsColumn struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Comment string `json:"comment,omitempty"`
}

// EsIndexInfo is one row of the index listing. System indices (".kibana" etc.)
// are filtered client-side; counts come from GET /_cat/indices (bytes=b).
type EsIndexInfo struct {
	Name           string `json:"name"`
	DocsCount      int64  `json:"docs_count"`
	StoreSizeBytes int64  `json:"store_size_bytes"`
}

// EsPageRowsResult is one page of an index's documents. Columns are the
// read-only "_id" sentinel column followed by the mapping fields; Rows align
// with Columns (nil cell = field absent from the document's _source).
// TotalRows mirrors hits.total (7.x/8.x object value or 6.x/5.x number);
// PrimaryKey is always ["_id"]; Engine carries the index name.
type EsPageRowsResult struct {
	Columns    []EsColumn  `json:"columns"`
	Rows       [][]*string `json:"rows"`
	TotalRows  int64       `json:"total_rows"`
	PrimaryKey []string    `json:"primary_key"`
	Engine     string      `json:"engine"`
}

// EsStatementResult is the per-statement outcome of a multi-statement SQL
// script: duration in ms, and either columns+rows (statements returning a
// result set) or an error text (failed statement; execution stops there).
type EsStatementResult struct {
	SQL        string      `json:"sql"`
	DurationMs int64       `json:"duration_ms"`
	Error      string      `json:"error,omitempty"`
	Columns    []EsColumn  `json:"columns,omitempty"`
	Rows       [][]*string `json:"rows,omitempty"`
}

// EsDoc 是单个文档的读取结果:id 为文档 _id,source 为 _source 的 JSON 文本
// (文档级编辑以 JSON 文本在前后端间往返)。
type EsDoc struct {
	ID     string `json:"id"`
	Source string `json:"source"`
}

// EsDslResult 是 DSL 控制台一次原始 REST 透传的结果:status 为原始 HTTP 状态
// 码(4xx/5xx 同样原样返回,不是 Go 层错误,由前端按状态展示),body 为响应
// 体文本(超过 64KB 截断)。
type EsDslResult struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// EsTemplateInfo 是一条 legacy 索引模板(GET /_template)的概要:名称与模板
// 内声明的 order(缺失为 0;数值越大合并优先级越高)。
type EsTemplateInfo struct {
	Name  string `json:"name"`
	Order int64  `json:"order"`
}

// EsTemplateContent 是模板的原始 JSON 文本(GET /_template/{name} 的响应体
// 原文,形如 {"<名称>":{...}}),前端负责解析与编辑往返。
type EsTemplateContent struct {
	TemplateJSON string `json:"template_json"`
}

// EsNodeInfo 是集群监控里单个节点的概要(GET /_cat/nodes):roles 为服务端
// 给的角色串(如 "cdhilstw"),原样透传;百分比字段解析失败为 0。
type EsNodeInfo struct {
	Name        string `json:"name"`
	IP          string `json:"ip"`
	Roles       string `json:"roles"`
	HeapPercent int64  `json:"heap_percent"`
	DiskPercent int64  `json:"disk_percent"`
}

// EsClusterStats 是 ES 集群监控的聚合统计(一次调用返回全部指标,全部来自
// 免费端点,6.1 OSS 可用):health 字段来自 /_cluster/health,indices/docs/
// store 汇总来自 /_cat/indices(含系统索引;docs.count/store.size 为 null 或
// 缺失时按 0 计入),nodes 来自 /_cat/nodes,templates_count 来自 /_template。
// 容错约定:health/indices/nodes 任一核心请求失败时整体返回 error(结果保持
// 零值);templates 失败不影响整体,仅 templates_count 置 0。
type EsClusterStats struct {
	ClusterName         string       `json:"cluster_name"`
	Status              string       `json:"status"` // green | yellow | red
	NumberOfNodes       int64        `json:"number_of_nodes"`
	NumberOfDataNodes   int64        `json:"number_of_data_nodes"`
	ActiveShards        int64        `json:"active_shards"`
	ActivePrimaryShards int64        `json:"active_primary_shards"`
	RelocatingShards    int64        `json:"relocating_shards"`
	UnassignedShards    int64        `json:"unassigned_shards"`
	IndicesCount        int64        `json:"indices_count"`
	DocsCount           int64        `json:"docs_count"`
	StoreSizeBytes      int64        `json:"store_size_bytes"`
	TemplatesCount      int64        `json:"templates_count"`
	Nodes               []EsNodeInfo `json:"nodes"`
}
