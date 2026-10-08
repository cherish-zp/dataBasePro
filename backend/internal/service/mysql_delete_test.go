package service

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"strings"
	"testing"

	"sheng-shou-yun-he/backend/internal/model"
)

// --- 纯函数:DELETE 语句文本与 WHERE 校验 ---

func TestMysqlDeleteRowStatementDisplayText(t *testing.T) {
	stmt, err := buildMysqlDeleteStatement("app", "users", []model.MysqlCellValue{
		{Column: "id", Value: strPtrOf("1")},
		{Column: "tenant", Value: strPtrOf("it's")},
	})
	if err != nil {
		t.Fatalf("buildMysqlDeleteStatement: %v", err)
	}
	want := "DELETE FROM `app`.`users` WHERE `id` = '1' AND `tenant` = 'it''s'"
	if stmt != want {
		t.Fatalf("unexpected statement:\n got %s\nwant %s", stmt, want)
	}
}

func TestMysqlDeleteRowStatementValidation(t *testing.T) {
	if _, err := buildMysqlDeleteStatement("app", "", []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}}); err == nil {
		t.Fatal("empty table must fail")
	}
	// where 空报中文错:拒绝无定位的全表 DELETE。
	if _, err := buildMysqlDeleteStatement("app", "users", nil); err == nil || !strings.Contains(err.Error(), "缺少定位主键") {
		t.Fatalf("empty where must fail in Chinese, got %v", err)
	}
	// 主键值 nil 报「值不能为 NULL」。
	_, err := buildMysqlDeleteStatement("app", "users", []model.MysqlCellValue{{Column: "id"}})
	if err == nil || !strings.Contains(err.Error(), "值不能为 NULL") {
		t.Fatalf("nil pk value must fail, got %v", err)
	}
	if _, err := buildMysqlDeleteStatement("app", "users", []model.MysqlCellValue{{Column: "  ", Value: strPtrOf("1")}}); err == nil {
		t.Fatal("blank column name must fail")
	}
}

// TestMysqlDeleteRowJSONContract 锁定按行删除的 wire 契约:字段全部
// snake_case,与前端 api/types.ts 严格一致。
func TestMysqlDeleteRowJSONContract(t *testing.T) {
	b, err := json.Marshal(MysqlDeleteRowRequest{
		ConnectionID: "c", Database: "d", Table: "t",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	for _, key := range []string{`"connection_id"`, `"database"`, `"table"`, `"where"`, `"column"`, `"value"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("MysqlDeleteRowRequest JSON must expose %s, got %s", key, b)
		}
	}
	b, err = json.Marshal(MysqlDeleteRowPreview{Statement: "DELETE", MatchedRows: 1})
	if err != nil {
		t.Fatalf("marshal preview: %v", err)
	}
	for _, key := range []string{`"statement"`, `"matched_rows"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("MysqlDeleteRowPreview JSON must expose %s, got %s", key, b)
		}
	}
}

// --- 客户端:fake 驱动离线验证 ---

// newDeleteTestConn 供给主键为 (id) 的 app.users 与 COUNT(*) 应答。
func newDeleteTestConn(count int64) *fakeMysqlDrvConn {
	return &fakeMysqlDrvConn{
		pkByTable: map[string][]string{"app.users": {"id"}},
		countRows: &fakeMysqlDrvRows{cols: []string{"COUNT(*)"}, vals: [][]driver.Value{{count}}},
	}
}

func TestMysqlDeleteRowPreviewReadOnly(t *testing.T) {
	conn := newDeleteTestConn(1)
	c, _ := newFakeMysqlClient(t, conn)
	preview, err := c.PreviewDeleteRow(context.Background(), MysqlDeleteRowRequest{
		Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}},
	})
	if err != nil {
		t.Fatalf("PreviewDeleteRow: %v", err)
	}
	if preview.Statement != "DELETE FROM `app`.`users` WHERE `id` = '1'" {
		t.Fatalf("unexpected statement %q", preview.Statement)
	}
	if preview.MatchedRows != 1 {
		t.Fatalf("matched_rows = %d, want 1", preview.MatchedRows)
	}
	// 预览只跑同 WHERE 的 COUNT(*),绝不执行 DELETE。
	if len(conn.execs) != 0 {
		t.Fatalf("preview must not execute anything, got execs %+v", conn.execs)
	}
	if len(conn.queries) != 1 || !strings.Contains(conn.queries[0], "SELECT COUNT(*) FROM `app`.`users` WHERE") {
		t.Fatalf("preview must count with the same WHERE, got %+v", conn.queries)
	}
}

func TestMysqlDeleteRowExecutesStatement(t *testing.T) {
	conn := newDeleteTestConn(1)
	c, _ := newFakeMysqlClient(t, conn)
	err := c.DeleteRow(context.Background(), MysqlDeleteRowRequest{
		Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("7")}},
	})
	if err != nil {
		t.Fatalf("DeleteRow: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DELETE FROM `app`.`users` WHERE `id` = '7'" {
		t.Fatalf("unexpected execs: %+v", conn.execs)
	}
}

func TestMysqlDeleteRowRejectsBadWhere(t *testing.T) {
	c, _ := newFakeMysqlClient(t, newDeleteTestConn(0))
	base := MysqlDeleteRowRequest{Database: "app", Table: "users"}

	cases := []struct {
		name  string
		where []model.MysqlCellValue
		want  string
	}{
		{"empty where", nil, "缺少定位主键"},
		{"nil pk value", []model.MysqlCellValue{{Column: "id"}}, "值不能为 NULL"},
		{"non-pk column", []model.MysqlCellValue{{Column: "name", Value: strPtrOf("x")}}, "不是主键列"},
		{"blank column", []model.MysqlCellValue{{Column: " ", Value: strPtrOf("x")}}, "条件列名不能为空"},
	}
	for _, tc := range cases {
		if _, err := c.PreviewDeleteRow(context.Background(), MysqlDeleteRowRequest{
			Database: base.Database, Table: base.Table, Where: tc.where,
		}); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: preview must fail with %q, got %v", tc.name, tc.want, err)
		}
	}
}

// 无主键表拒绝删除,且报错文案是删除语境(而非单元格编辑的「不支持编辑」)。
func TestMysqlDeleteRowRejectsPkLessTable(t *testing.T) {
	c, _ := newFakeMysqlClient(t, &fakeMysqlDrvConn{})
	err := c.DeleteRow(context.Background(), MysqlDeleteRowRequest{
		Database: "app", Table: "logs",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}},
	})
	if err == nil || !strings.Contains(err.Error(), "表无主键,不支持按行删除") {
		t.Fatalf("pk-less table must be rejected in delete wording, got %v", err)
	}
}

// --- Service 层委托:断言池中 *MysqlClient(而非接口 fake) ---

func TestMysqlDeleteRowServiceDelegation(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, &model.Connection{
		Name:   "mysql-local",
		Type:   model.ConnectionTypeMySQL,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1"}),
	})
	conn := newDeleteTestConn(2)
	client, _ := newFakeMysqlClient(t, conn)
	if err := svc.PutPooledForTest(c.ID, client); err != nil {
		t.Fatalf("pool client: %v", err)
	}
	req := MysqlDeleteRowRequest{
		ConnectionID: c.ID, Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("2")}},
	}

	preview, err := svc.MysqlPreviewDeleteRow(ctx, req)
	if err != nil {
		t.Fatalf("MysqlPreviewDeleteRow: %v", err)
	}
	if preview.MatchedRows != 2 || preview.Statement != "DELETE FROM `app`.`users` WHERE `id` = '2'" {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if err := svc.MysqlDeleteRow(ctx, req); err != nil {
		t.Fatalf("MysqlDeleteRow: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DELETE FROM `app`.`users` WHERE `id` = '2'" {
		t.Fatalf("delete must reach the pooled client, got %+v", conn.execs)
	}
}

func TestMysqlDeleteRowServiceRejectsNonMysqlClient(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, &model.Connection{
		Name:   "mysql-local",
		Type:   model.ConnectionTypeMySQL,
		Config: model.MustConfigJSON(model.MysqlConfig{Host: "127.0.0.1"}),
	})
	if err := svc.PutPooledForTest(c.ID, &fakeDataSource{}); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	err := svc.MysqlDeleteRow(ctx, MysqlDeleteRowRequest{
		ConnectionID: c.ID, Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}},
	})
	if err == nil || !strings.Contains(err.Error(), "not a MySQL/TiDB source") {
		t.Fatalf("non-mysql pooled client must be rejected, got %v", err)
	}
}
