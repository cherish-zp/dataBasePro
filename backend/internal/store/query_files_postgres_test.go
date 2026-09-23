package store

import (
	"strings"
	"testing"
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
	if !strings.Contains(content, "-- schema: billing") || !strings.Contains(content, "FROM invoices;") {
		t.Fatalf("content mismatch: %q", content)
	}
	// 旧文件兼容：没有 schema 行时解析为空，内容原样返回。
	if err := s.Write("legacy.sql", "-- connection: x\n-- database: y\nSELECT 1", "", "", ""); err != nil {
		t.Fatalf("Write legacy: %v", err)
	}
	if _, connID, database, schema, err = s.Read("legacy.sql"); err != nil || connID != "x" || database != "y" || schema != "" {
		t.Fatalf("legacy Read: err=%v conn=%q db=%q schema=%q", err, connID, database, schema)
	}
}
