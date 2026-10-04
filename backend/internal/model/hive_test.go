package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHiveConfigValidate_NoSASL(t *testing.T) {
	cfg := HiveConfig{Host: " hs2.example.com ", Port: 0, AuthMode: "nosasl", Database: ""}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid nosasl config, got %v", err)
	}
	if cfg.Port != 10000 {
		t.Fatalf("empty port must default to 10000, got %d", cfg.Port)
	}
	if cfg.Host != "hs2.example.com" {
		t.Fatalf("host must be trimmed, got %q", cfg.Host)
	}
	if cfg.Database != "default" {
		t.Fatalf("empty database must normalize to default, got %q", cfg.Database)
	}
}

func TestHiveConfigValidate_LDAPRequiresUsername(t *testing.T) {
	cfg := HiveConfig{Host: "h", Port: 10000, AuthMode: "ldap"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "用户名") {
		t.Fatalf("ldap without username must fail, got %v", err)
	}
	cfg.Username = "hiveuser"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid ldap config, got %v", err)
	}
}

func TestHiveConfigValidate_KerberosTriplet(t *testing.T) {
	cfg := HiveConfig{Host: "h", Port: 10000, AuthMode: "kerberos"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("kerberos without kerberos config must fail")
	}
	cfg.Kerberos = &HiveKerberosConfig{Principal: "hive/_HOST@EXAMPLE.COM"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "keytab") {
		t.Fatalf("kerberos without keytab must fail, got %v", err)
	}
	cfg.Kerberos.Keytab = "/etc/security/keytabs/hive.keytab"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid kerberos config, got %v", err)
	}
	// principal 无 realm 拒绝。
	bad := HiveConfig{Host: "h", Port: 10000, AuthMode: "kerberos", Kerberos: &HiveKerberosConfig{
		Principal: "hive/_HOST", Keytab: "/k.keytab",
	}}
	if err := bad.Validate(); err == nil || !strings.Contains(err.Error(), "realm") {
		t.Fatalf("principal without realm must fail, got %v", err)
	}
}

func TestHiveKerberosServiceComponent(t *testing.T) {
	k := &HiveKerberosConfig{Principal: "hive/_HOST@EXAMPLE.COM"}
	if got := k.ServiceComponent(); got != "hive" {
		t.Fatalf("service component = %q, want hive", got)
	}
	if got := (&HiveKerberosConfig{Principal: "user@REALM"}).ServiceComponent(); got != "hive" {
		t.Fatalf("service component fallback = %q, want hive", got)
	}
}

func TestHiveConfigValidate_UnknownAuthMode(t *testing.T) {
	cfg := HiveConfig{Host: "h", Port: 10000, AuthMode: "saml"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("unknown auth mode must fail")
	}
}

// JSON 形状锁定:与前端 HiveConfigShape(snake_case、kerberos 嵌套对象)逐字段一致。
func TestHiveConfigJSONShape(t *testing.T) {
	b, err := json.Marshal(HiveConfig{
		Host: "hs2", Port: 10000, AuthMode: "ldap", Username: "u", Password: "p", Database: "dw",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"host", "port", "auth_mode", "username", "password", "database"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HiveConfig JSON must expose %q, got %s", key, b)
		}
	}
	if _, ok := m["kerberos"]; ok {
		t.Fatalf("nil kerberos must be omitted, got %s", b)
	}
	b, err = json.Marshal(HiveConfig{Host: "h", Port: 10000, AuthMode: "kerberos",
		Kerberos: &HiveKerberosConfig{Principal: "p@R", Keytab: "/k", Krb5Conf: ""}})
	if err != nil {
		t.Fatalf("marshal kerberos: %v", err)
	}
	m = map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal kerberos: %v", err)
	}
	ker, ok := m["kerberos"].(map[string]any)
	if !ok {
		t.Fatalf("kerberos must be a nested object, got %s", b)
	}
	for _, key := range []string{"principal", "keytab"} {
		if _, ok := ker[key]; !ok {
			t.Fatalf("kerberos JSON must expose %q, got %s", key, b)
		}
	}
	if _, ok := ker["krb5_conf"]; ok {
		t.Fatalf("empty krb5_conf must be omitted, got %s", b)
	}
}

// 结果类型 JSON 形状锁定(对齐前端 HiveColumn/HivePageRowsResult/
// HiveStatementResult/HiveTableColumnsResult)。
func TestHiveResultJSONShapes(t *testing.T) {
	b, err := json.Marshal(HiveColumn{Name: "id", Type: "int", Comment: "主键"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"comment":"主键"`) {
		t.Fatalf("HiveColumn must expose comment, got %s", b)
	}
	b, _ = json.Marshal(HiveColumn{Name: "id", Type: "int"})
	if strings.Contains(string(b), "comment") {
		t.Fatalf("empty comment must be omitted, got %s", b)
	}

	total := int64(42)
	b, _ = json.Marshal(HivePageRowsResult{
		Columns:   []HiveColumn{{Name: "id", Type: "int"}},
		Rows:      [][]*string{{nil, strPtr("x")}},
		TotalRows: total,
	})
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"columns", "rows", "total_rows"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HivePageRowsResult JSON must expose %q, got %s", key, b)
		}
	}

	b, _ = json.Marshal(HiveStatementResult{SQL: "SELECT 1", DurationMs: 3})
	if strings.Contains(string(b), "total_rows") || strings.Contains(string(b), "error") {
		t.Fatalf("omittable fields must be absent, got %s", b)
	}
	b, _ = json.Marshal(HiveStatementResult{SQL: "bad", DurationMs: 1, Error: "boom",
		TotalRows: &total})
	m = map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"sql", "duration_ms", "error", "total_rows"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HiveStatementResult JSON must expose %q, got %s", key, b)
		}
	}

	b, _ = json.Marshal(HiveTableColumnsResult{
		Columns:          []HiveColumn{{Name: "id", Type: "int"}},
		PartitionColumns: []HiveColumn{},
		Transactional:    true,
		PrimaryKey:       []string{"id"},
		DDL:              "CREATE TABLE ...",
		TableType:        HiveTableTypeManaged,
	})
	m = map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"columns", "partition_columns", "transactional", "primary_key", "ddl", "table_type"} {
		if _, ok := m[key]; !ok {
			t.Fatalf("HiveTableColumnsResult JSON must expose %q, got %s", key, b)
		}
	}

	b, _ = json.Marshal(HiveCellRef{Column: "id", Type: "int", Value: nil})
	if !strings.Contains(string(b), `"value":null`) {
		t.Fatalf("HiveCellRef nil value must render as null, got %s", b)
	}
}

// Connection.Validate 分发与 HiveConfig 访问器。(strPtr 复用同包 ch_test.go)
func TestConnectionValidate_Hive(t *testing.T) {
	if !(ConnectionType("hive")).Valid() {
		t.Fatal("hive type must be valid")
	}
	c := Connection{
		Name: "hive-local",
		Type: ConnectionTypeHive,
		Config: MustConfigJSON(HiveConfig{
			Host: "hs2", Port: 10000, AuthMode: HiveAuthLDAP, Username: "u", Database: "dw",
		}),
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("expected valid hive connection, got %v", err)
	}
	cfg, err := c.HiveConfig()
	if err != nil {
		t.Fatalf("HiveConfig: %v", err)
	}
	if cfg.Host != "hs2" || cfg.Username != "u" || cfg.Database != "dw" {
		t.Fatalf("unexpected config: %+v", cfg)
	}
	bad := Connection{Name: "h2", Type: ConnectionTypeHive,
		Config: MustConfigJSON(HiveConfig{Host: "hs2", AuthMode: "ldap"})}
	if err := bad.Validate(); err == nil {
		t.Fatal("ldap config without username must fail validation")
	}
}
