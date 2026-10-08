package model

import (
	"errors"
	"fmt"
	"strings"
)

// ConnectionTypeHive identifies an Apache Hive (HiveServer2) data source.
const ConnectionTypeHive ConnectionType = "hive"

// Supported HiveServer2 authentication modes (stored verbatim in configs and
// mirrored by the frontend's HiveAuthMode union).
const (
	HiveAuthNoSASL   = "nosasl"
	HiveAuthLDAP     = "ldap"
	HiveAuthKerberos = "kerberos"
)

// hiveDefaultPort 是 HiveServer2 的默认 thrift 端口:配置省略端口时兜底。
const hiveDefaultPort = 10000

// HiveKerberosConfig holds the Kerberos settings used when AuthMode is
// "kerberos". gohive 的 GSSAPI 传输依赖 OS 级凭据缓存:后端在拨号前用
// kinit -kt <keytab> <principal> 预置票据,krb5_conf 通过 KRB5_CONFIG
// 环境变量注入该 kinit 子进程(可选)。
type HiveKerberosConfig struct {
	Principal string `json:"principal"`
	Keytab    string `json:"keytab"`
	Krb5Conf  string `json:"krb5_conf,omitempty"`
}

// HiveConfig stores the details required to connect to a HiveServer2
// endpoint. Username/Password serve the ldap mode (nosasl may omit both);
// Kerberos carries the keytab triplet for the kerberos mode; Database is the
// connection's default database (empty → "default", normalized in Validate).
type HiveConfig struct {
	Host     string              `json:"host"`
	Port     int                 `json:"port"`
	AuthMode string              `json:"auth_mode"`
	Username string              `json:"username,omitempty"`
	Password string              `json:"password,omitempty"`
	Database string              `json:"database,omitempty"`
	Kerberos *HiveKerberosConfig `json:"kerberos,omitempty"`
}

// Validate checks the Hive configuration and normalizes it in place: an empty
// port becomes 10000, an empty database becomes "default". ldap 模式要求
// username;kerberos 模式要求 principal(带 realm)+ keytab。
func (c *HiveConfig) Validate() error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("hive host must not be empty")
	}
	c.Host = strings.TrimSpace(c.Host)
	if c.Port == 0 {
		c.Port = hiveDefaultPort
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("invalid hive port %d", c.Port)
	}
	switch strings.ToLower(strings.TrimSpace(c.AuthMode)) {
	case HiveAuthNoSASL:
		c.AuthMode = HiveAuthNoSASL
	case HiveAuthLDAP:
		c.AuthMode = HiveAuthLDAP
		if strings.TrimSpace(c.Username) == "" {
			return errors.New("ldap 认证必须提供用户名")
		}
	case HiveAuthKerberos:
		c.AuthMode = HiveAuthKerberos
		if c.Kerberos == nil {
			return errors.New("kerberos 认证必须提供 kerberos 配置")
		}
		if err := c.Kerberos.Validate(); err != nil {
			return err
		}
	default:
		return fmt.Errorf("不支持的认证方式 %q(仅支持 nosasl/ldap/kerberos)", c.AuthMode)
	}
	if d := strings.TrimSpace(c.Database); d == "" {
		c.Database = "default"
	} else {
		c.Database = d
	}
	return nil
}

// Validate checks the Kerberos triplet: principal must include a realm,
// keytab must be present; krb5.conf is optional.
func (k *HiveKerberosConfig) Validate() error {
	p := strings.TrimSpace(k.Principal)
	if p == "" {
		return errors.New("Kerberos principal must not be empty")
	}
	if !strings.Contains(p, "@") || strings.TrimSpace(strings.SplitN(p, "@", 2)[1]) == "" {
		return fmt.Errorf("Kerberos principal %q must include a realm (user/host@REALM)", k.Principal)
	}
	if strings.TrimSpace(k.Keytab) == "" {
		return errors.New("Kerberos keytab path must not be empty")
	}
	k.Principal = p
	k.Keytab = strings.TrimSpace(k.Keytab)
	k.Krb5Conf = strings.TrimSpace(k.Krb5Conf)
	return nil
}

// ServiceComponent returns the GSSAPI service name for the connection: the
// principal's component before the first "/" (hive/_HOST@REALM → "hive"),
// falling back to "hive" when the principal has no service part.
func (k *HiveKerberosConfig) ServiceComponent() string {
	p := strings.TrimSpace(k.Principal)
	if i := strings.IndexByte(p, '/'); i > 0 {
		if s := strings.TrimSpace(p[:i]); s != "" {
			return s
		}
	}
	return "hive"
}

// HiveColumn is one result column: name plus the Hive type string
// (e.g. "int", "string", "decimal(10,2)"). Comment 来自 DESCRIBE 元数据
// (empty string = 无注释;omitempty 省略)。
type HiveColumn struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Comment string `json:"comment,omitempty"`
}

// HiveTableInfo is one entry of SHOW TABLES;表类型(内部/外部/视图)经
// TableColumns 探测。
type HiveTableInfo struct {
	Name string `json:"name"`
}

// HivePageRowsResult is one page of a table's rows. Cells are pre-formatted
// strings; a nil cell means SQL NULL. TotalRows 为全表 COUNT(*)(Hive 不支持
// OFFSET,分页经 ROW_NUMBER() OVER() 窗口包装实现)。
type HivePageRowsResult struct {
	Columns   []HiveColumn `json:"columns"`
	Rows      [][]*string  `json:"rows"`
	TotalRows int64        `json:"total_rows"`
}

// HiveCellRef binds one column to a typed value: Type carries the Hive type
// string (驱动 ACID 字面量的构造分派),a nil Value means SQL NULL。
type HiveCellRef struct {
	Column string  `json:"column"`
	Type   string  `json:"type"`
	Value  *string `json:"value"`
}

// HiveCellUpdateRequest locates ACID rows by Where and rewrites Set.Column
// in them (table detail / SQL result grid single-cell edit).
type HiveCellUpdateRequest struct {
	ConnectionID string        `json:"connection_id"`
	Database     string        `json:"database"`
	Table        string        `json:"table"`
	Set          HiveCellRef   `json:"set"`
	Where        []HiveCellRef `json:"where"`
}

// HiveCellUpdatePreview is the read-only outcome of a cell-update preview:
// the exact statement the backend would run plus the number of rows matched
// by the same WHERE conditions.
type HiveCellUpdatePreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// HiveDeleteRowRequest deletes the ACID rows located by Where.
type HiveDeleteRowRequest struct {
	ConnectionID string        `json:"connection_id"`
	Database     string        `json:"database"`
	Table        string        `json:"table"`
	Where        []HiveCellRef `json:"where"`
}

// HiveDeleteRowPreview is the delete preview's read-only result.
type HiveDeleteRowPreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// HiveStatementResult is the per-statement outcome of a multi-statement
// script: duration in ms, and either columns+rows (statements returning a
// result set) or an error text (failed statement; execution stops there).
// TotalRows 仅在请求启用服务端分页时出现:nil=未启用;≥0=精确总数(包装
// COUNT 查询);-1=无法计数(SHOW 类语句取满一页)。
type HiveStatementResult struct {
	SQL        string       `json:"sql"`
	DurationMs int64        `json:"duration_ms"`
	Error      string       `json:"error,omitempty"`
	Columns    []HiveColumn `json:"columns,omitempty"`
	Rows       [][]*string  `json:"rows,omitempty"`
	TotalRows  *int64       `json:"total_rows,omitempty"`
}

// HiveTableColumnsResult is one table's metadata bundle:普通列、分区列、
// transactional(ACID 标记,行级更新/删除的前提)、primary key 约束列
// (Hive 3,可能为空)、SHOW CREATE TABLE 原文与表类型(DESCRIBE FORMATTED)。
type HiveTableColumnsResult struct {
	Columns          []HiveColumn `json:"columns"`
	PartitionColumns []HiveColumn `json:"partition_columns"`
	Transactional    bool         `json:"transactional"`
	PrimaryKey       []string     `json:"primary_key"`
	DDL              string       `json:"ddl"`
	TableType        string       `json:"table_type"`
}

// hiveTableTypes 判定截断与 REPLACE COLUMNS 降级的表类型集合。
const (
	HiveTableTypeManaged  = "MANAGED_TABLE"
	HiveTableTypeExternal = "EXTERNAL_TABLE"
	HiveTableTypeView     = "VIRTUAL_VIEW"
)
