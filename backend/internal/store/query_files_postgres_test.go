package store

import (
	"testing"
	"time"
)

func TestQueryFileHeaderSupportsSchemaAndLegacyFiles(t *testing.T) {
	content := "-- connection: conn-1\n-- database: app\n-- schema: billing\nSELECT 1"
	connID, database, schema, body := ParseQueryFileHeader(content)
	if connID != "conn-1" || database != "app" || schema != "billing" || body != "SELECT 1" {
		t.Fatalf("parsed conn=%q db=%q schema=%q body=%q", connID, database, schema, body)
	}

	legacy := "-- connection: old\nSELECT 2"
	connID, database, schema, body = ParseQueryFileHeader(legacy)
	if connID != "old" || database != "" || schema != "" || body != "SELECT 2" {
		t.Fatalf("legacy parsed conn=%q db=%q schema=%q body=%q", connID, database, schema, body)
	}
}

func TestQueryFileStoreReadWriteHeaderSchema(t *testing.T) {
	s := NewQueryFileStore(t.TempDir())
	if err := s.Write("orders.sql", "SELECT *\nFROM invoices;", "conn-pg", "app", "billing"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	content, connID, database, schema, err := s.Read("orders.sql")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if connID != "conn-pg" || database != "app" || schema != "billing" {
		t.Fatalf("header conn=%q db=%q schema=%q", connID, database, schema)
	}
	// Read 剥离元数据行,编辑器只见纯 SQL;元数据经结构化字段返回。
	if content != "SELECT *\nFROM invoices;" {
		t.Fatalf("content mismatch: %q", content)
	}
	// 旧文件兼容:磁盘上存在只有 connection/database 行(无 schema 行)的文件,
	// 解析出 conn/db 而 schema 为空;Read 剥离元数据后正文原样返回。
	writeQueryFileRaw(t, s.Dir, "legacy.sql", "-- connection: x\n-- database: y\nSELECT 1", time.Now())
	legacy, connID, database, schema, err := s.Read("legacy.sql")
	if err != nil || connID != "x" || database != "y" || schema != "" {
		t.Fatalf("legacy Read: err=%v conn=%q db=%q schema=%q", err, connID, database, schema)
	}
	if legacy != "SELECT 1" {
		t.Fatalf("legacy content mismatch: %q", legacy)
	}
}
