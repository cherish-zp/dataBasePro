package backend

import (
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"testing"

	"sheng-shou-yun-he/backend/internal/model"
	"sheng-shou-yun-he/backend/internal/service"
)

// pkThenCountRespond 路由 information_schema 主键查询与 COUNT(*) 预览查询。
func pkThenCountRespond(query string) (driver.Rows, error) {
	if strings.Contains(query, "information_schema.columns") {
		return &appDdlRows{
			cols: []string{"column_name", "column_type", "column_comment", "column_key"},
			vals: [][]driver.Value{{"id", "bigint", "", "PRI"}},
		}, nil
	}
	if strings.Contains(strings.ToUpper(query), "COUNT(*)") {
		return &appDdlRows{cols: []string{"COUNT(*)"}, vals: [][]driver.Value{{int64(1)}}}, nil
	}
	return nil, fmt.Errorf("unexpected query: %s", query)
}

// pkOnlyRespond 只应答主键元数据(执行路径不再需要 COUNT)。
func pkOnlyRespond(query string) (driver.Rows, error) {
	if strings.Contains(query, "information_schema.columns") {
		return &appDdlRows{
			cols: []string{"column_name", "column_type", "column_comment", "column_key"},
			vals: [][]driver.Value{{"id", "bigint", "", "PRI"}},
		}, nil
	}
	return nil, fmt.Errorf("unexpected query: %s", query)
}

// TestMysqlDeleteRowAppPreviewNotAudited 预览只读:透传请求、不执行、不落审计。
func TestMysqlDeleteRowAppPreviewNotAudited(t *testing.T) {
	routed := &appDdlConn{respond: pkThenCountRespond}
	app, connID := newMysqlDdlApp(t, routed)
	preview, err := app.MysqlPreviewDeleteRow(service.MysqlDeleteRowRequest{
		ConnectionID: connID, Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("1")}},
	})
	if err != nil {
		t.Fatalf("MysqlPreviewDeleteRow: %v", err)
	}
	if preview.Statement != "DELETE FROM `app`.`users` WHERE `id` = '1'" || preview.MatchedRows != 1 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if len(routed.execs) != 0 {
		t.Fatalf("preview must not execute, got %+v", routed.execs)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	for _, e := range list {
		if strings.Contains(e.Action, "delete") {
			t.Fatalf("read-only preview must not be audited, got %+v", list)
		}
	}
}

// TestMysqlDeleteRowAppAudited 执行走审计:成功 ok,失败 error + 详情,
// 与 drop/truncate 同风格(action mysql_delete_row,target 为 db.table;
// 详情只含错误文本,绝不含 WHERE 定位值与语句文本)。
func TestMysqlDeleteRowAppAudited(t *testing.T) {
	conn := &appDdlConn{respond: pkOnlyRespond}
	app, connID := newMysqlDdlApp(t, conn)

	err := app.MysqlDeleteRow(service.MysqlDeleteRowRequest{
		ConnectionID: connID, Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("row-42")}},
	})
	if err != nil {
		t.Fatalf("MysqlDeleteRow: %v", err)
	}
	if len(conn.execs) != 1 || conn.execs[0] != "DELETE FROM `app`.`users` WHERE `id` = 'row-42'" {
		t.Fatalf("unexpected execs: %+v", conn.execs)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_delete_row" || list[0].Target != "app.users" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出),且详情不携带定位值。
	failConn := &appDdlConn{execErr: errors.New("boom"), respond: pkOnlyRespond}
	failApp, failID := newMysqlDdlApp(t, failConn)
	err = failApp.MysqlDeleteRow(service.MysqlDeleteRowRequest{
		ConnectionID: failID, Database: "app", Table: "users",
		Where: []model.MysqlCellValue{{Column: "id", Value: strPtrOf("row-42")}},
	})
	if err == nil {
		t.Fatal("delete failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "mysql_delete_row" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed delete must be audited: %+v", list[0])
	}
	if strings.Contains(list[0].Detail, "row-42") || strings.Contains(list[0].Detail, "DELETE") {
		t.Fatalf("audit detail must not carry where values or statement text: %+v", list[0])
	}
}
