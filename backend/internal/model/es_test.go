package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEsConfigValidate_HostsRequired(t *testing.T) {
	var cfg EsConfig
	if err := cfg.Validate(); err == nil {
		t.Fatal("empty hosts must be rejected")
	}
	cfg = EsConfig{Hosts: []string{"   "}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("blank-only hosts must be rejected")
	}
}

func TestEsConfigValidate_FillsDefaultPort(t *testing.T) {
	cfg := EsConfig{Hosts: []string{" es-a ", "es-b:9300"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Hosts[0] != "es-a:9200" {
		t.Fatalf("host without port must default to 9200, got %q", cfg.Hosts[0])
	}
	if cfg.Hosts[1] != "es-b:9300" {
		t.Fatalf("explicit port must be kept, got %q", cfg.Hosts[1])
	}
}

func TestEsConfigValidate_StripsScheme(t *testing.T) {
	cfg := EsConfig{Hosts: []string{"https://es-a:9200", "http://es-b"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.Hosts[0] != "es-a:9200" {
		t.Fatalf("scheme must be stripped, got %q", cfg.Hosts[0])
	}
	if cfg.Hosts[1] != "es-b:9200" {
		t.Fatalf("scheme stripped then default port added, got %q", cfg.Hosts[1])
	}
}

func TestEsConfigValidate_AuthNormalization(t *testing.T) {
	// 空 auth_mode → none;空 tls_mode → disabled。
	cfg := EsConfig{Hosts: []string{"es-a"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.AuthMode != EsAuthNone {
		t.Fatalf("empty auth_mode must normalize to none, got %q", cfg.AuthMode)
	}
	if cfg.TLSMode != EsTLSDisabled {
		t.Fatalf("empty tls_mode must normalize to disabled, got %q", cfg.TLSMode)
	}

	// 大小写归一。
	cfg = EsConfig{Hosts: []string{"es-a"}, Username: "u", AuthMode: " Basic ", TLSMode: "SKIP-VERIFY"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.AuthMode != EsAuthBasic || cfg.TLSMode != EsTLSSkipVerify {
		t.Fatalf("auth/tls must be lower-cased, got %q/%q", cfg.AuthMode, cfg.TLSMode)
	}
}

func TestEsConfigValidate_AuthErrors(t *testing.T) {
	cases := []struct {
		name    string
		cfg     EsConfig
		wantErr string
	}{
		{
			"unsupported auth mode",
			EsConfig{Hosts: []string{"es-a"}, AuthMode: "kerberos"},
			"auth_mode",
		},
		{
			"basic without username",
			EsConfig{Hosts: []string{"es-a"}, AuthMode: EsAuthBasic, Password: "p"},
			"用户名",
		},
		{
			"apikey without key",
			EsConfig{Hosts: []string{"es-a"}, AuthMode: EsAuthApikey},
			"api_key",
		},
	}
	for _, tc := range cases {
		if err := tc.cfg.Validate(); err == nil {
			t.Fatalf("%s: expected error", tc.name)
		} else if !strings.Contains(err.Error(), tc.wantErr) {
			t.Fatalf("%s: error %q must mention %q", tc.name, err, tc.wantErr)
		}
	}
}

func TestEsConfigValidate_TLSErrors(t *testing.T) {
	cfg := EsConfig{Hosts: []string{"es-a"}, TLSMode: "strict"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "TLS") {
		t.Fatalf("unsupported TLS mode must be rejected, got %v", err)
	}
}

func TestEsConfigJSONShape(t *testing.T) {
	b, err := json.Marshal(EsConfig{
		Hosts:    []string{"es-a:9200"},
		Username: "u",
		Password: "p",
		ApiKey:   "k",
		AuthMode: "basic",
		TLSMode:  "skip-verify",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"hosts", "username", "password", "api_key", "auth_mode", "tls_mode"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsConfig JSON must expose %q, got %s", key, b)
		}
	}
	// 值为空的凭据字段必须省略,避免把空串写成明文字段。
	b, err = json.Marshal(EsConfig{Hosts: []string{"es-a:9200"}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"password", "api_key"} {
		if strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("empty secret %q must be omitted, got %s", key, b)
		}
	}
}

func TestEsWireShapes(t *testing.T) {
	// EsIndexInfo:snake_case。
	b, err := json.Marshal(EsIndexInfo{Name: "logs", DocsCount: 3, StoreSizeBytes: 4096})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"name", "docs_count", "store_size_bytes"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsIndexInfo JSON must expose %q, got %s", key, b)
		}
	}

	// EsPageRowsResult:total_rows/primary_key/engine。
	b, err = json.Marshal(EsPageRowsResult{
		Columns:    []EsColumn{{Name: "_id", Type: "_id"}},
		Rows:       [][]*string{{strPtrForEs("1")}},
		TotalRows:  7,
		PrimaryKey: []string{"_id"},
		Engine:     "logs",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"columns", "rows", "total_rows", "primary_key", "engine"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsPageRowsResult JSON must expose %q, got %s", key, b)
		}
	}

	// EsStatementResult:sql/duration_ms,错误与列行可选省略。
	b, err = json.Marshal(EsStatementResult{SQL: "SELECT 1", DurationMs: 3})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"sql", "duration_ms"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsStatementResult JSON must expose %q, got %s", key, b)
		}
	}

	// EsColumn:comment 空时省略。
	b, err = json.Marshal(EsColumn{Name: "title", Type: "text"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "comment") {
		t.Fatalf("empty comment must be omitted, got %s", b)
	}

	// EsDoc:snake_case(id/source),往返解析。
	b, err = json.Marshal(EsDoc{ID: "1", Source: `{"title":"a"}`})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"id", "source"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDoc JSON must expose %q, got %s", key, b)
		}
	}
	var doc EsDoc
	if err := json.Unmarshal(json.RawMessage(`{"id":"9","source":"{}"}`), &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if doc.ID != "9" || doc.Source != "{}" {
		t.Fatalf("EsDoc round trip failed, got %+v", doc)
	}
}

func strPtrForEs(s string) *string { return &s }

// --- Connection 级分发:Validate 走 EsConfig、EsConfig() 解码 ---

func TestConnectionValidate_ESDispatch(t *testing.T) {
	// 合法 ES 连接。
	c := Connection{
		Name: "es-local",
		Type: ConnectionTypeES,
		Config: MustConfigJSON(EsConfig{
			Hosts:    []string{"es-a"},
			Username: "u",
			AuthMode: EsAuthBasic,
		}),
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("valid es connection rejected: %v", err)
	}
	got, err := c.EsConfig()
	if err != nil {
		t.Fatalf("EsConfig: %v", err)
	}
	// 解码层不做归一(与 CH 一致):归一发生在 cfg.Validate()/客户端构造时。
	if len(got.Hosts) != 1 || got.Hosts[0] != "es-a" {
		t.Fatalf("decode must yield raw hosts, got %+v", got.Hosts)
	}
	if got.AuthMode != EsAuthBasic {
		t.Fatalf("auth_mode must survive round trip, got %q", got.AuthMode)
	}
	if err := got.Validate(); err != nil {
		t.Fatalf("decoded config validate: %v", err)
	}
	if got.Hosts[0] != "es-a:9200" {
		t.Fatalf("Validate must fill the default port, got %q", got.Hosts[0])
	}

	// ES 连接的非法配置必须被拒绝(hosts 缺失)。
	bad := Connection{Name: "es-bad", Type: ConnectionTypeES, Config: MustConfigJSON(EsConfig{})}
	if err := bad.Validate(); err == nil {
		t.Fatal("es connection without hosts must be rejected")
	}
	// 坏 JSON 必须报 invalid es config。
	badJSON := Connection{Name: "es-bad", Type: ConnectionTypeES, Config: json.RawMessage("{oops")}
	if err := badJSON.Validate(); err == nil || !strings.Contains(err.Error(), "es config") {
		t.Fatalf("malformed es config must be rejected with es config error, got %v", err)
	}
	// 空配置同样拒绝。
	if err := (Connection{Name: "es-bad", Type: ConnectionTypeES}).Validate(); err == nil {
		t.Fatal("es connection without config must be rejected")
	}
}
