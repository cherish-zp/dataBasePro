package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

// fakeESApp implements service.EsDataSource for app-layer tests; the ES client
// hits real HTTP, so pooling bypasses the network.
type fakeESApp struct {
	indices        []model.EsIndexInfo
	page           model.EsPageRowsResult
	pageTarget     string
	mapping        []model.EsColumn
	mappingTarget  string
	docSource      string
	docTarget      string
	putErr         error
	putTarget      string
	updateErr      error
	updateTarget   string
	updateCol      string
	updateVal      *string
	deleteErr      error
	deleteTarget   string
	deleteByQuery  int64
	deleteByQueryQ string
	deleteQueryErr error
	execResult     []model.EsStatementResult
	execErr        error
	execSQL        string
	dslMethod      string
	dslPath        string
	dslBody        string
	dslResult      model.EsDslResult
	dslErr         error
	// 索引刷新与模板。
	refreshIndex       string
	listTemplates      []model.EsTemplateInfo
	getTemplateName    string
	templateJSON       string
	putTemplateName    string
	putTemplateBody    string
	putTemplateErr     error
	deleteTemplateName string
	deleteTemplateErr  error
	// 索引生命周期(创建/删除/改设置)。
	createIndexName   string
	createShards      int64
	createReplicas    int64
	createIndexErr    error
	deleteIndexName   string
	deleteIndexErr    error
	settingsIndex     string
	settingsJSON      string
	updateSettingsErr error
	// 集群监控聚合。
	clusterStats model.EsClusterStats
}

func (f *fakeESApp) Connect(context.Context) error { return nil }
func (f *fakeESApp) Close() error                  { return nil }
func (f *fakeESApp) GetName() string               { return "fake-es" }
func (f *fakeESApp) GetType() string               { return string(model.ConnectionTypeES) }
func (f *fakeESApp) ListIndices(context.Context) ([]model.EsIndexInfo, error) {
	return f.indices, nil
}
func (f *fakeESApp) PageRows(_ context.Context, index, _, _ string, _ bool, _, _ int) (model.EsPageRowsResult, error) {
	f.pageTarget = index
	return f.page, nil
}
func (f *fakeESApp) Mapping(_ context.Context, index string) ([]model.EsColumn, error) {
	f.mappingTarget = index
	return f.mapping, nil
}
func (f *fakeESApp) GetDoc(_ context.Context, index, id string) (string, error) {
	f.docTarget = index + "/" + id
	return f.docSource, nil
}
func (f *fakeESApp) PutDoc(_ context.Context, index, id, _ string) error {
	f.putTarget = index + "/" + id
	return f.putErr
}
func (f *fakeESApp) UpdateCell(_ context.Context, index, id, column string, value *string) error {
	f.updateTarget = index + "/" + id
	f.updateCol = column
	f.updateVal = value
	return f.updateErr
}
func (f *fakeESApp) DeleteDoc(_ context.Context, index, id string) error {
	f.deleteTarget = index + "/" + id
	return f.deleteErr
}
func (f *fakeESApp) DeleteByQuery(_ context.Context, index, query string) (int64, error) {
	f.deleteByQueryQ = index + "\x00" + query
	return f.deleteByQuery, f.deleteQueryErr
}
func (f *fakeESApp) Execute(_ context.Context, sqlText string) ([]model.EsStatementResult, error) {
	f.execSQL = sqlText
	return f.execResult, f.execErr
}
func (f *fakeESApp) DSL(_ context.Context, method, path, body string) (model.EsDslResult, error) {
	f.dslMethod, f.dslPath, f.dslBody = method, path, body
	return f.dslResult, f.dslErr
}
func (f *fakeESApp) RefreshIndex(_ context.Context, index string) error {
	f.refreshIndex = index
	return nil
}
func (f *fakeESApp) ListTemplates(context.Context) ([]model.EsTemplateInfo, error) {
	return f.listTemplates, nil
}
func (f *fakeESApp) GetTemplate(_ context.Context, name string) (string, error) {
	f.getTemplateName = name
	return f.templateJSON, nil
}
func (f *fakeESApp) PutTemplate(_ context.Context, name, templateJSON string) error {
	f.putTemplateName = name
	f.putTemplateBody = templateJSON
	return f.putTemplateErr
}
func (f *fakeESApp) DeleteTemplate(_ context.Context, name string) error {
	f.deleteTemplateName = name
	return f.deleteTemplateErr
}
func (f *fakeESApp) CreateIndex(_ context.Context, index string, shards, replicas int64) error {
	f.createIndexName, f.createShards, f.createReplicas = index, shards, replicas
	return f.createIndexErr
}
func (f *fakeESApp) DeleteIndex(_ context.Context, index string) error {
	f.deleteIndexName = index
	return f.deleteIndexErr
}
func (f *fakeESApp) UpdateIndexSettings(_ context.Context, index, settingsJSON string) error {
	f.settingsIndex, f.settingsJSON = index, settingsJSON
	return f.updateSettingsErr
}
func (f *fakeESApp) ClusterStats(context.Context) (model.EsClusterStats, error) {
	return f.clusterStats, nil
}

var _ service.EsDataSource = (*fakeESApp)(nil)

// newESApp registers one es connection in the store and pools the given fake
// as its client (no network involved).
func newESApp(t *testing.T, fake *fakeESApp) (*App, string) {
	t.Helper()
	app := newTestApp(t)
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "es-local",
		Type:   model.ConnectionTypeES,
		Config: model.MustConfigJSON(model.EsConfig{Hosts: []string{"127.0.0.1:9200"}}),
	})
	if err != nil {
		t.Fatalf("create es connection: %v", err)
	}
	if err := app.svc.PutPooledForTest(conn.ID, fake); err != nil {
		t.Fatalf("pool fake: %v", err)
	}
	return app, conn.ID
}

func TestAppESBrowseFlow(t *testing.T) {
	fake := &fakeESApp{
		indices: []model.EsIndexInfo{{Name: "logs", DocsCount: 3, StoreSizeBytes: 2048}},
		page: model.EsPageRowsResult{
			Columns:    []model.EsColumn{{Name: "_id", Type: "_id"}, {Name: "title", Type: "text"}},
			Rows:       [][]*string{{strPtrOf("1"), strPtrOf("a")}},
			TotalRows:  42,
			PrimaryKey: []string{"_id"},
			Engine:     "logs",
		},
		mapping:   []model.EsColumn{{Name: "title", Type: "text"}},
		docSource: `{"title":"a"}`,
	}
	app, connID := newESApp(t, fake)

	indices, err := app.ListESIndices(connID)
	if err != nil || len(indices) != 1 || indices[0].Name != "logs" || indices[0].DocsCount != 3 {
		t.Fatalf("ListESIndices: %v %+v", err, indices)
	}

	mapping, err := app.ESMapping(EsMappingRequest{ConnectionID: connID, Index: "logs"})
	if err != nil || len(mapping) != 1 || mapping[0].Name != "title" {
		t.Fatalf("ESMapping: %v %+v", err, mapping)
	}
	if fake.mappingTarget != "logs" {
		t.Fatalf("mapping must target the index, got %q", fake.mappingTarget)
	}

	page, err := app.ESPageRows(EsPageRowsRequest{
		ConnectionID: connID, Index: "logs", Where: "level:info", OrderBy: "ts", Asc: true, Limit: 10, Offset: 5,
	})
	if err != nil {
		t.Fatalf("ESPageRows: %v", err)
	}
	if len(page.Columns) != 2 || page.TotalRows != 42 || page.Engine != "logs" ||
		len(page.Rows) != 1 || page.Rows[0][0] == nil || *page.Rows[0][0] != "1" ||
		len(page.PrimaryKey) != 1 || page.PrimaryKey[0] != "_id" {
		t.Fatalf("unexpected page: %+v", page)
	}
	if fake.pageTarget != "logs" {
		t.Fatalf("page must target the index, got %q", fake.pageTarget)
	}

	doc, err := app.ESGetDoc(EsGetDocRequest{ConnectionID: connID, Index: "logs", ID: "1"})
	if err != nil || doc.ID != "1" || doc.Source != `{"title":"a"}` || fake.docTarget != "logs/1" {
		t.Fatalf("ESGetDoc: %v %+v", err, doc)
	}
}

// TestAppESRequestJSONShapes 锁定 wire 契约:请求字段全部 snake_case。
func TestAppESRequestJSONShapes(t *testing.T) {
	val := "x"
	b, err := json.Marshal(EsMappingRequest{ConnectionID: "c", Index: "i"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsMappingRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsPageRowsRequest{ConnectionID: "c", Index: "i", Where: "w", OrderBy: "o", Asc: true, Limit: 1, Offset: 2})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "where", "order_by", "asc", "limit", "offset"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsPageRowsRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsGetDocRequest{ConnectionID: "c", Index: "i", ID: "1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "id"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsGetDocRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsPutDocRequest{ConnectionID: "c", Index: "i", ID: "1", Doc: "{}"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "id", "doc"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsPutDocRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsCellUpdateRequest{ConnectionID: "c", Index: "i", ID: "1", Column: "col", Value: &val})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "id", "column", "value"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsCellUpdateRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsDeleteDocRequest{ConnectionID: "c", Index: "i", ID: "1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "id"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDeleteDocRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsDeleteByQueryRequest{ConnectionID: "c", Index: "i", Query: `{"match_all":{}}`})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "query"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDeleteByQueryRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsExecuteRequest{ConnectionID: "c", SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "sql"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsExecuteRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsDslRequest{ConnectionID: "c", Method: "GET", Path: "/idx/_search", Body: "{}"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "method", "path", "body"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDslRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(model.EsDslResult{Status: 200, Body: "{}"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"status", "body"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDslResult JSON must expose %q, got %s", key, b)
		}
	}
}

func TestAppTestESConnectionValidates(t *testing.T) {
	app := newTestApp(t)
	if err := app.TestESConnection(model.EsConfig{}); err == nil {
		t.Fatal("empty hosts must fail before dialing")
	}
	if err := app.TestESConnection(model.EsConfig{Hosts: []string{"h:9200"}, AuthMode: "basic"}); err == nil {
		t.Fatal("basic auth without username must fail before dialing")
	}
	if err := app.TestESConnection(model.EsConfig{Hosts: []string{"h:9200"}, TLSMode: "bogus"}); err == nil {
		t.Fatal("unknown tls mode must fail before dialing")
	}
}

func TestAppESPutDocDelegatesAndAudits(t *testing.T) {
	fake := &fakeESApp{}
	app, connID := newESApp(t, fake)
	if err := app.ESPutDoc(EsPutDocRequest{ConnectionID: connID, Index: "logs", ID: "1", Doc: `{"title":"b"}`}); err != nil {
		t.Fatalf("ESPutDoc: %v", err)
	}
	if fake.putTarget != "logs/1" {
		t.Fatalf("put must target index/id, got %q", fake.putTarget)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_put_doc" || list[0].Target != "logs/1" || list[0].Result != "ok" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	failApp, failID := newESApp(t, &fakeESApp{putErr: errors.New("boom")})
	if err := failApp.ESPutDoc(EsPutDocRequest{ConnectionID: failID, Index: "logs", ID: "1", Doc: "{}"}); err == nil {
		t.Fatal("put failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_put_doc" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed put must be audited: %+v", list[0])
	}
}

func TestAppESUpdateCellDelegatesAndAudits(t *testing.T) {
	fake := &fakeESApp{}
	app, connID := newESApp(t, fake)
	val := "x"
	if err := app.ESUpdateCell(EsCellUpdateRequest{ConnectionID: connID, Index: "logs", ID: "1", Column: "note", Value: &val}); err != nil {
		t.Fatalf("ESUpdateCell: %v", err)
	}
	if fake.updateTarget != "logs/1" || fake.updateCol != "note" || fake.updateVal == nil || *fake.updateVal != "x" {
		t.Fatalf("update args must pass through: %+v", fake)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_update_cell" || list[0].Target != "logs/1" || list[0].Result != "ok" {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// nil value(清空字段)同样透传并通过。
	if err := app.ESUpdateCell(EsCellUpdateRequest{ConnectionID: connID, Index: "logs", ID: "1", Column: "note", Value: nil}); err != nil {
		t.Fatalf("ESUpdateCell nil: %v", err)
	}
	if fake.updateVal != nil {
		t.Fatalf("nil value must pass through, got %+v", fake.updateVal)
	}

	failApp, failID := newESApp(t, &fakeESApp{updateErr: errors.New("boom")})
	if err := failApp.ESUpdateCell(EsCellUpdateRequest{ConnectionID: failID, Index: "logs", ID: "1", Column: "note", Value: &val}); err == nil {
		t.Fatal("update failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_update_cell" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed update must be audited: %+v", list[0])
	}
}

func TestAppESDeleteDocDelegatesAndAudits(t *testing.T) {
	fake := &fakeESApp{}
	app, connID := newESApp(t, fake)
	if err := app.ESDeleteDoc(EsDeleteDocRequest{ConnectionID: connID, Index: "logs", ID: "1"}); err != nil {
		t.Fatalf("ESDeleteDoc: %v", err)
	}
	if fake.deleteTarget != "logs/1" {
		t.Fatalf("delete must target index/id, got %q", fake.deleteTarget)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_delete_doc" || list[0].Target != "logs/1" || list[0].Result != "ok" {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	failApp, failID := newESApp(t, &fakeESApp{deleteErr: errors.New("boom")})
	if err := failApp.ESDeleteDoc(EsDeleteDocRequest{ConnectionID: failID, Index: "logs", ID: "1"}); err == nil {
		t.Fatal("delete failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_delete_doc" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed delete must be audited: %+v", list[0])
	}
}

func TestAppESDeleteByQueryDelegatesAndAudits(t *testing.T) {
	query := `{"term":{"level":"error"}}`
	fake := &fakeESApp{deleteByQuery: 7}
	app, connID := newESApp(t, fake)
	deleted, err := app.ESDeleteByQuery(EsDeleteByQueryRequest{ConnectionID: connID, Index: "logs", Query: query})
	if err != nil || deleted != 7 {
		t.Fatalf("ESDeleteByQuery: err=%v deleted=%d", err, deleted)
	}
	if fake.deleteByQueryQ != "logs\x00"+query {
		t.Fatalf("query must reach the data source verbatim, got %q", fake.deleteByQueryQ)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_delete_by_query" || list[0].Target != "logs" || list[0].Result != "ok" || list[0].Detail != "" {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	failApp, failID := newESApp(t, &fakeESApp{deleteQueryErr: errors.New("boom")})
	if _, err := failApp.ESDeleteByQuery(EsDeleteByQueryRequest{ConnectionID: failID, Index: "logs", Query: query}); err == nil {
		t.Fatal("delete-by-query failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_delete_by_query" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed delete-by-query must be audited: %+v", list[0])
	}
}

func TestAppESExecuteAuditedWithCappedTarget(t *testing.T) {
	fake := &fakeESApp{execResult: []model.EsStatementResult{
		{SQL: "SELECT 1", DurationMs: 2, Columns: []model.EsColumn{{Name: "1", Type: "keyword"}}, Rows: [][]*string{{strPtrOf("1")}}},
	}}
	app, connID := newESApp(t, fake)

	long := "SELECT " + strings.Repeat("x", 80)
	results, err := app.ESExecute(EsExecuteRequest{ConnectionID: connID, SQL: long})
	if err != nil || len(results) != 1 || results[0].SQL != "SELECT 1" {
		t.Fatalf("ESExecute: %v %+v", err, results)
	}
	if fake.execSQL != long {
		t.Fatalf("sql must be delegated verbatim")
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	e := list[0]
	if e.Action != "es_execute" || e.Result != "ok" {
		t.Fatalf("unexpected audit: %+v", e)
	}
	if e.Target != long[:60] {
		t.Fatalf("target must be the first 60 chars, got %q want %q", e.Target, long[:60])
	}

	failApp, failID := newESApp(t, &fakeESApp{execErr: errors.New("boom")})
	if _, err := failApp.ESExecute(EsExecuteRequest{ConnectionID: failID, SQL: "SELECT 1"}); err == nil {
		t.Fatal("execute failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_execute" || list[0].Result != "error" || list[0].Detail == "" {
		t.Fatalf("failed execute must be audited: %+v", list[0])
	}
}

// ESDsl:参数原样透传,审计 target 为归一化后的 "METHOD PATH"(不含 body)。
func TestAppESDslDelegatesAndAudits(t *testing.T) {
	fake := &fakeESApp{dslResult: model.EsDslResult{Status: 200, Body: `{"ok":true}`}}
	app, connID := newESApp(t, fake)
	res, err := app.ESDsl(EsDslRequest{ConnectionID: connID, Method: "delete", Path: "/logs/_doc/1"})
	if err != nil || res.Status != 200 || res.Body != `{"ok":true}` {
		t.Fatalf("ESDsl: %v %+v", err, res)
	}
	if fake.dslMethod != "delete" || fake.dslPath != "/logs/_doc/1" || fake.dslBody != "" {
		t.Fatalf("dsl args must pass through verbatim: %+v", fake)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_dsl" || list[0].Target != "DELETE /logs/_doc/1" || list[0].Result != "ok" ||
		list[0].Detail != "" || list[0].ConnectionID != connID {
		t.Fatalf("unexpected audit: %+v", list[0])
	}

	// 失败(本地校验/网络层)同样审计为 error,target 仍为 METHOD PATH。
	failApp, failID := newESApp(t, &fakeESApp{dslErr: errors.New("请求体 JSON 不合法")})
	if _, err := failApp.ESDsl(EsDslRequest{ConnectionID: failID, Method: "POST", Path: "/logs/_search", Body: "{bad"}); err == nil {
		t.Fatal("dsl failure must surface")
	}
	list, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if list[0].Action != "es_dsl" || list[0].Result != "error" || list[0].Detail == "" ||
		list[0].Target != "POST /logs/_search" {
		t.Fatalf("failed dsl must be audited with METHOD PATH target: %+v", list[0])
	}
}

// TestAppListDriversIncludesElasticsearch 驱动注册表必须登记 Elasticsearch,
// 默认端口 9200。
func TestAppListDriversIncludesElasticsearch(t *testing.T) {
	app := newTestApp(t)
	drivers, err := app.ListDrivers()
	if err != nil {
		t.Fatalf("ListDrivers: %v", err)
	}
	for _, d := range drivers {
		if d.Name != "Elasticsearch" {
			continue
		}
		if d.DefaultPort != 9200 || d.Library == "" || d.Version == "" || d.Description == "" {
			t.Fatalf("unexpected es driver fields: %+v", d)
		}
		return
	}
	t.Fatalf("Elasticsearch must be registered, got %+v", drivers)
}

// EsRefreshIndex:参数透传;刷新不属于危险操作,不审计。
func TestAppEsRefreshIndexDelegates(t *testing.T) {
	fake := &fakeESApp{}
	app, connID := newESApp(t, fake)
	if err := app.EsRefreshIndex(EsRefreshIndexRequest{ConnectionID: connID, Index: "logs"}); err != nil {
		t.Fatalf("EsRefreshIndex: %v", err)
	}
	if fake.refreshIndex != "logs" {
		t.Fatalf("refresh must target the index, got %q", fake.refreshIndex)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// 仅有建连时的一条 create_connection:刷新本身不审计。
	if len(list) != 1 || list[0].Action != "create_connection" {
		t.Fatalf("refresh must not be audited, got %+v", list)
	}
}

// 模板:list/get 委托且不审计;put/delete 委托并审计(target=模板名,
// 失败审计为 error)。
func TestAppEsTemplatesDelegateAndAudit(t *testing.T) {
	const tpl = `{"template":"logs-*","settings":{}}`
	fake := &fakeESApp{
		listTemplates: []model.EsTemplateInfo{{Name: "logs_tpl", Order: 1}},
		templateJSON:  `{"logs_tpl":{"order":1}}`,
	}
	app, connID := newESApp(t, fake)

	list, err := app.ListEsTemplates(connID)
	if err != nil || len(list) != 1 || list[0].Name != "logs_tpl" || list[0].Order != 1 {
		t.Fatalf("ListEsTemplates: %v %+v", err, list)
	}
	content, err := app.GetEsTemplate(EsGetTemplateRequest{ConnectionID: connID, Name: "logs_tpl"})
	if err != nil || content.TemplateJSON != `{"logs_tpl":{"order":1}}` || fake.getTemplateName != "logs_tpl" {
		t.Fatalf("GetEsTemplate: %v %+v", err, content)
	}
	audits, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// 仅有建连时的一条 create_connection:list/get 不审计。
	if len(audits) != 1 || audits[0].Action != "create_connection" {
		t.Fatalf("list/get must not be audited, got %+v", audits)
	}

	if err := app.PutEsTemplate(EsPutTemplateRequest{ConnectionID: connID, Name: "logs_tpl", TemplateJSON: tpl}); err != nil {
		t.Fatalf("PutEsTemplate: %v", err)
	}
	if fake.putTemplateName != "logs_tpl" || fake.putTemplateBody != tpl {
		t.Fatalf("put args must pass through: %+v", fake)
	}
	audits, err = app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if audits[0].Action != "es_put_template" || audits[0].Target != "logs_tpl" || audits[0].Result != "ok" ||
		audits[0].ConnectionID != connID {
		t.Fatalf("unexpected put audit: %+v", audits[0])
	}

	if err := app.DeleteEsTemplate(EsDeleteTemplateRequest{ConnectionID: connID, Name: "logs_tpl"}); err != nil {
		t.Fatalf("DeleteEsTemplate: %v", err)
	}
	if fake.deleteTemplateName != "logs_tpl" {
		t.Fatalf("delete must target the template name, got %q", fake.deleteTemplateName)
	}
	audits, err = app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if audits[0].Action != "es_delete_template" || audits[0].Target != "logs_tpl" || audits[0].Result != "ok" {
		t.Fatalf("unexpected delete audit: %+v", audits[0])
	}

	// 失败路径同样审计为 error(另有一条建连时的 create_connection)。
	failApp, failID := newESApp(t, &fakeESApp{putTemplateErr: errors.New("boom"), deleteTemplateErr: errors.New("boom")})
	if err := failApp.PutEsTemplate(EsPutTemplateRequest{ConnectionID: failID, Name: "t", TemplateJSON: "{}"}); err == nil {
		t.Fatal("put failure must surface")
	}
	if err := failApp.DeleteEsTemplate(EsDeleteTemplateRequest{ConnectionID: failID, Name: "t"}); err == nil {
		t.Fatal("delete failure must surface")
	}
	audits, err = failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(audits) != 3 ||
		audits[0].Action != "es_delete_template" || audits[0].Result != "error" || audits[0].Detail == "" ||
		audits[1].Action != "es_put_template" || audits[1].Result != "error" || audits[1].Detail == "" {
		t.Fatalf("failed put/delete must be audited: %+v", audits)
	}
}

// TestAppEsTemplateRequestJSONShapes 锁定新增请求/响应模型的 wire 契约:
// 字段全部 snake_case。
func TestAppEsTemplateRequestJSONShapes(t *testing.T) {
	b, err := json.Marshal(EsRefreshIndexRequest{ConnectionID: "c", Index: "i"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsRefreshIndexRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsGetTemplateRequest{ConnectionID: "c", Name: "n"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "name"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsGetTemplateRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsPutTemplateRequest{ConnectionID: "c", Name: "n", TemplateJSON: "{}"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "name", "template_json"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsPutTemplateRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsDeleteTemplateRequest{ConnectionID: "c", Name: "n"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "name"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDeleteTemplateRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(model.EsTemplateInfo{Name: "n", Order: 1})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"name", "order"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsTemplateInfo JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(model.EsTemplateContent{TemplateJSON: "{}"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"template_json"`) {
		t.Fatalf("EsTemplateContent JSON must expose \"template_json\", got %s", b)
	}
}

// --- ES 索引生命周期(新建/删除/改设置) ---

// 三个生命周期方法委托到池内客户端,并按契约写入审计
// (es_create_index / es_delete_index / es_update_settings,target=index)。
func TestAppEsIndexLifecycleDelegatesAndAudits(t *testing.T) {
	fake := &fakeESApp{}
	app, connID := newESApp(t, fake)

	if err := app.EsCreateIndex(EsCreateIndexRequest{ConnectionID: connID, Index: "logs-2026", Shards: 3, Replicas: 1}); err != nil {
		t.Fatalf("EsCreateIndex: %v", err)
	}
	if fake.createIndexName != "logs-2026" || fake.createShards != 3 || fake.createReplicas != 1 {
		t.Fatalf("create args must pass through: %+v", fake)
	}
	audits, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if audits[0].Action != "es_create_index" || audits[0].Target != "logs-2026" ||
		audits[0].Result != "ok" || audits[0].ConnectionID != connID {
		t.Fatalf("unexpected create audit: %+v", audits[0])
	}

	if err := app.EsDeleteIndex(EsDeleteIndexRequest{ConnectionID: connID, Index: "logs-2026"}); err != nil {
		t.Fatalf("EsDeleteIndex: %v", err)
	}
	if fake.deleteIndexName != "logs-2026" {
		t.Fatalf("delete must target the index, got %q", fake.deleteIndexName)
	}
	audits, err = app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if audits[0].Action != "es_delete_index" || audits[0].Target != "logs-2026" || audits[0].Result != "ok" {
		t.Fatalf("unexpected delete audit: %+v", audits[0])
	}

	const settings = `{"index.refresh_interval":"30s"}`
	if err := app.EsUpdateIndexSettings(EsUpdateIndexSettingsRequest{ConnectionID: connID, Index: "logs", SettingsJSON: settings}); err != nil {
		t.Fatalf("EsUpdateIndexSettings: %v", err)
	}
	if fake.settingsIndex != "logs" || fake.settingsJSON != settings {
		t.Fatalf("settings must pass through: %+v", fake)
	}
	audits, err = app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if audits[0].Action != "es_update_settings" || audits[0].Target != "logs" || audits[0].Result != "ok" {
		t.Fatalf("unexpected settings audit: %+v", audits[0])
	}
}

// 三路失败同样必须留下审计(result=error,detail 非空)。
func TestAppEsIndexLifecycleFailuresAudited(t *testing.T) {
	failApp, failID := newESApp(t, &fakeESApp{
		createIndexErr:    errors.New("boom"),
		deleteIndexErr:    errors.New("boom"),
		updateSettingsErr: errors.New("boom"),
	})
	if err := failApp.EsCreateIndex(EsCreateIndexRequest{ConnectionID: failID, Index: "logs", Shards: 1, Replicas: 1}); err == nil {
		t.Fatal("create failure must surface")
	}
	if err := failApp.EsDeleteIndex(EsDeleteIndexRequest{ConnectionID: failID, Index: "logs"}); err == nil {
		t.Fatal("delete failure must surface")
	}
	if err := failApp.EsUpdateIndexSettings(EsUpdateIndexSettingsRequest{ConnectionID: failID, Index: "logs", SettingsJSON: "{}"}); err == nil {
		t.Fatal("settings failure must surface")
	}
	audits, err := failApp.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// ListAudit 最新在前:前三条是本次操作,最后一条是建连审计
	// (create_connection)。
	dump := make([]string, 0, len(audits))
	for _, e := range audits {
		dump = append(dump, fmt.Sprintf("{action=%s target=%s result=%s detail=%q}", e.Action, e.Target, e.Result, e.Detail))
	}
	if len(audits) != 4 || audits[3].Action != "create_connection" ||
		audits[0].Action != "es_update_settings" || audits[0].Result != "error" || audits[0].Detail == "" ||
		audits[1].Action != "es_delete_index" || audits[1].Result != "error" || audits[1].Detail == "" ||
		audits[2].Action != "es_create_index" || audits[2].Result != "error" || audits[2].Detail == "" {
		t.Fatalf("all three failures must be audited: %v", strings.Join(dump, " | "))
	}
}

// TestAppEsIndexLifecycleRequestJSONShapes 锁定生命周期请求模型的 wire 契约:
// 字段全部 snake_case。
func TestAppEsIndexLifecycleRequestJSONShapes(t *testing.T) {
	b, err := json.Marshal(EsCreateIndexRequest{ConnectionID: "c", Index: "i", Shards: 3, Replicas: 1})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "shards", "replicas"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsCreateIndexRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsDeleteIndexRequest{ConnectionID: "c", Index: "i"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsDeleteIndexRequest JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(EsUpdateIndexSettingsRequest{ConnectionID: "c", Index: "i", SettingsJSON: "{}"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"connection_id", "index", "settings_json"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsUpdateIndexSettingsRequest JSON must expose %q, got %s", key, b)
		}
	}
}

// EsClusterStats:一次调用返回全部监控指标,只读不审计。
func TestAppEsClusterStatsDelegates(t *testing.T) {
	fake := &fakeESApp{clusterStats: model.EsClusterStats{
		ClusterName:   "es-prod",
		Status:        "green",
		NumberOfNodes: 3,
		IndicesCount:  12,
		DocsCount:     345,
		Nodes:         []model.EsNodeInfo{{Name: "n1", IP: "10.0.0.1", Roles: "di", HeapPercent: 17, DiskPercent: 63}},
	}}
	app, connID := newESApp(t, fake)
	stats, err := app.EsClusterStats(EsClusterStatsRequest{ConnectionID: connID})
	if err != nil || stats.ClusterName != "es-prod" || stats.Status != "green" ||
		stats.NumberOfNodes != 3 || stats.IndicesCount != 12 || stats.DocsCount != 345 ||
		len(stats.Nodes) != 1 || stats.Nodes[0].Name != "n1" {
		t.Fatalf("EsClusterStats: %v %+v", err, stats)
	}
	audits, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// 仅有建连时的一条 create_connection:聚合查询不审计。
	if len(audits) != 1 || audits[0].Action != "create_connection" {
		t.Fatalf("cluster stats must not be audited, got %+v", audits)
	}
}

// TestAppEsClusterStatsJSONShapes 锁定聚合统计的 wire 契约:字段全部
// snake_case(前端按此契约渲染监控面板)。
func TestAppEsClusterStatsJSONShapes(t *testing.T) {
	b, err := json.Marshal(EsClusterStatsRequest{ConnectionID: "c"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"connection_id"`) {
		t.Fatalf("EsClusterStatsRequest JSON must expose \"connection_id\", got %s", b)
	}

	b, err = json.Marshal(model.EsClusterStats{ClusterName: "es-prod", Status: "green", Nodes: []model.EsNodeInfo{}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{
		"cluster_name", "status", "number_of_nodes", "number_of_data_nodes",
		"active_shards", "active_primary_shards", "relocating_shards", "unassigned_shards",
		"indices_count", "docs_count", "store_size_bytes", "templates_count", "nodes",
	} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsClusterStats JSON must expose %q, got %s", key, b)
		}
	}

	b, err = json.Marshal(model.EsNodeInfo{Name: "n1", IP: "10.0.0.1", Roles: "di", HeapPercent: 17, DiskPercent: 63})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{"name", "ip", "roles", "heap_percent", "disk_percent"} {
		if !strings.Contains(string(b), `"`+key+`"`) {
			t.Fatalf("EsNodeInfo JSON must expose %q, got %s", key, b)
		}
	}
}
