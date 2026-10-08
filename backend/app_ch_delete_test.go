package backend

import (
	"context"
	"errors"
	"strings"
	"testing"

	"sheng-shou-yun-he/backend/internal/model"
	"sheng-shou-yun-he/backend/internal/service"
)

// deleteRecordingCHApp 在既有 fakeCHApp 上补按行删除能力,记录委托参数并
// 回放预设结果(方法可在同包任意文件定义,不改既有测试脚手架)。
type deleteRecordingCHApp struct {
	*fakeCHApp
	deleteDB    string
	deleteTable string
	deleteWhere []model.CHCellValue
	deleteOut   service.CHDeleteRowPreview
	deleteErr   error
}

func (f *deleteRecordingCHApp) PreviewDeleteRow(_ context.Context, database, table string, where []model.CHCellValue) (service.CHDeleteRowPreview, error) {
	f.deleteDB, f.deleteTable, f.deleteWhere = database, table, where
	return f.deleteOut, f.deleteErr
}

func (f *deleteRecordingCHApp) DeleteRow(_ context.Context, database, table string, where []model.CHCellValue) error {
	f.deleteDB, f.deleteTable, f.deleteWhere = database, table, where
	return f.deleteErr
}

// newCHDeleteApp 注册 clickhouse 连接并把带删除能力的 fake 入池。
func newCHDeleteApp(t *testing.T, fake *deleteRecordingCHApp) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "ch-local",
		Type:   model.ConnectionTypeClickHouse,
		Config: model.MustConfigJSON(model.ClickHouseConfig{Hosts: []string{"127.0.0.1:9000"}}),
	})
	if err != nil {
		t.Fatalf("create clickhouse connection: %v", err)
	}
	if err := app.svc.PutPooledForTest(conn.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	return app, conn.ID
}

// TestCHDeleteRowAppPreviewNotAudited 预览只读:透传请求、不落审计。
func TestCHDeleteRowAppPreviewNotAudited(t *testing.T) {
	fake := &deleteRecordingCHApp{fakeCHApp: &fakeCHApp{}}
	app, connID := newCHDeleteApp(t, fake)

	preview, err := app.CHPreviewDeleteRow(service.CHDeleteRowRequest{
		ConnectionID: connID, Database: "logs", Table: "events",
		Where: []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strPtrOf("1")}},
	})
	if err != nil {
		t.Fatalf("CHPreviewDeleteRow: %v", err)
	}
	if preview.MatchedRows != 0 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if fake.deleteDB != "logs" || fake.deleteTable != "events" || len(fake.deleteWhere) != 1 {
		t.Fatalf("preview args must pass through: %s %s %+v", fake.deleteDB, fake.deleteTable, fake.deleteWhere)
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

// TestCHDeleteRowAppAudited 执行走审计:成功 ok,失败 error + 详情,与
// truncate/update_cell 同风格(action ch_delete_row,target 为 db.table;
// 详情只含错误文本,绝不含 WHERE 定位值与语句文本)。
func TestCHDeleteRowAppAudited(t *testing.T) {
	fake := &deleteRecordingCHApp{fakeCHApp: &fakeCHApp{}}
	app, connID := newCHDeleteApp(t, fake)

	req := service.CHDeleteRowRequest{
		ConnectionID: connID, Database: "logs", Table: "events",
		Where: []model.CHCellValue{{Column: "id", Type: "UInt64", Value: strPtrOf("row-42")}},
	}
	if err := app.CHDeleteRow(req); err != nil {
		t.Fatalf("CHDeleteRow: %v", err)
	}
	if fake.deleteTable != "events" || len(fake.deleteWhere) != 1 {
		t.Fatalf("delete args must pass through: %s %s %+v", fake.deleteDB, fake.deleteTable, fake.deleteWhere)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "ch_delete_row" || list[0].Target != "logs.events" ||
		list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败也要落审计(错误详情透出),且详情不携带定位值。
	failApp, failID := newCHDeleteApp(t, &deleteRecordingCHApp{
		fakeCHApp: &fakeCHApp{},
		deleteErr: errors.New("boom"),
	})
	req.ConnectionID = failID
	if err := failApp.CHDeleteRow(req); err == nil {
		t.Fatal("delete failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "ch_delete_row" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed delete must be audited: %+v", list[0])
	}
	if strings.Contains(list[0].Detail, "row-42") || strings.Contains(list[0].Detail, "ALTER") {
		t.Fatalf("audit detail must not carry where values or statement text: %+v", list[0])
	}
}
