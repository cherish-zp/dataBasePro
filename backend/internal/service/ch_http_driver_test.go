package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dataBasePro/backend/internal/model"
)

// CH HTTP 自实现通道:clickhouse-go 的 HTTP 传输会在所有请求上固化
// client_protocol_version,老服务器(如 22.8)对该 setting 报 404
// UNKNOWN_SETTING——因此 HTTP 协议模式绕开驱动传输,以 database/sql
// 驱动形式直发 POST(与 redis-cli/http 工具同款,老服务器全兼容)。


// chRoutingHandler 按查询命中的系统表路由响应:tables/columns 返回合法
// JSONCompact(names+types 行),其余交给 default。
func chRoutingHandler(tablesJSON string, def func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		switch {
		case strings.Contains(sqlText, "system.columns"):
			io.WriteString(w, `["name","type","comment"]
["String","String","String"]
["id","UInt64",""]
["name","String","用户名"]`)
		case strings.Contains(sqlText, "system.tables"):
			io.WriteString(w, tablesJSON)
		default:
			def(w, r, sqlText)
		}
	}
}

func newCHHTTPClient(t *testing.T, handler http.HandlerFunc) *CHClient {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	cfg := model.ClickHouseConfig{
		Hosts:    []string{strings.TrimPrefix(srv.URL, "http://")},
		Username: "default",
		Database: "default",
		Protocol: "http",
	}
	cl, err := NewCHClient(cfg)
	if err != nil {
		t.Fatalf("NewCHClient: %v", err)
	}
	t.Cleanup(func() { cl.Close() })
	return cl
}

const chHTTPJSONResponse = `["name","UInt64"]
["String","UInt64"]
["a",1]
["b",null]
["c",2]`

// 请求路由:system.tables → 表元信息 TSV;system.columns → 列 TSV;
// 其余 → JSONCompact 数据。覆盖 PageRows 的三次后端查询。
func chHTTPMetaHandler(totalRows *int64) http.HandlerFunc {
	meta := "events\tMergeTree\t"
	if totalRows != nil {
		meta += fmt.Sprint(*totalRows)
	} else {
		meta += "\\N"
	}
	cols := "id\tUInt64\t\nname\tString\t用户名"
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sqlText := string(body)
		isJSON := strings.Contains(r.URL.RawQuery, "JSONCompactEachRowWithNamesAndTypes")
		switch {
		case strings.Contains(sqlText, "system.clusters"):
			if isJSON {
				io.WriteString(w, `["cluster"]
["String"]
["prod_cluster"]
["other"]`)
			} else {
				io.WriteString(w, "prod_cluster\t2\nother\t1")
			}
		case strings.Contains(sqlText, "system.tables"):
			if isJSON {
				io.WriteString(w, `["engine","total_rows"]
["String","UInt64"]
["MergeTree",1234]`)
			} else {
				io.WriteString(w, meta)
			}
		case strings.Contains(sqlText, "system.columns"):
			if isJSON {
				io.WriteString(w, `["name","type","comment"]
["String","String","String"]
["id","UInt64",""]
["name","String","用户名"]`)
			} else {
				io.WriteString(w, cols)
			}
		default:
			io.WriteString(w, chHTTPJSONResponse)
		}
	}
}

func TestCHHTTPDriverPing(t *testing.T) {
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "1")
	})
	if err := cl.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestCHHTTPDriverPageRows(t *testing.T) {
	total := int64(1234)
	cl := newCHHTTPClient(t, chHTTPMetaHandler(&total))
	res, err := cl.PageRows(context.Background(), "logs", "events", "", "name", true, 200, 0)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if res.Engine != "MergeTree" || res.TotalRows == nil || *res.TotalRows != 1234 {
		t.Fatalf("unexpected meta: %+v", res)
	}
	if len(res.Columns) != 2 || res.Columns[0].Name != "id" || res.Columns[0].Type != "UInt64" {
		t.Fatalf("unexpected columns: %+v", res.Columns)
	}
	// 字段描述随 system.columns.comment 一并返回:空描述为空串。
	if res.Columns[0].Comment != "" || res.Columns[1].Comment != "用户名" {
		t.Fatalf("unexpected column comments: %+v", res.Columns)
	}
	if len(res.Rows) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(res.Rows))
	}
	// 行值:*string(nil=NULL,数字保留文本精度)
	if res.Rows[0][0] == nil || *res.Rows[0][0] != "a" {
		t.Fatalf("row0 col0 = %v", res.Rows[0][0])
	}
	if res.Rows[1][1] != nil {
		t.Fatalf("NULL must stay nil, got %v", res.Rows[1][1])
	}
	if res.Rows[2][1] == nil || *res.Rows[2][1] != "2" {
		t.Fatalf("number must be text, got %v", res.Rows[2][1])
	}
}

// system.columns 的 comment 为 JSON null 时(老服务端/异常数据可能给出,
// 正常空描述为空串,不带引号),必须经 sql.NullString 防御落为空串而非报错。
func TestCHTableColumnsNullComment(t *testing.T) {
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "system.columns") {
			io.WriteString(w, `["name","type","comment"]
["String","String","String"]
["id","UInt64",null]
["name","String","用户名"]`)
			return
		}
		io.WriteString(w, "1")
	})
	cols, err := cl.tableColumns(context.Background(), "logs", "events")
	if err != nil {
		t.Fatalf("tableColumns: %v", err)
	}
	if len(cols) != 2 {
		t.Fatalf("expected 2 columns, got %+v", cols)
	}
	if cols[0].Name != "id" || cols[0].Type != "UInt64" || cols[0].Comment != "" {
		t.Fatalf("null comment must become empty string, got %+v", cols[0])
	}
	if cols[1].Comment != "用户名" {
		t.Fatalf("non-empty comment must survive scan, got %+v", cols[1])
	}
}

func TestCHHTTPDriverTruncate(t *testing.T) {
	var bodies []string
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(body))
		if strings.Contains(string(body), "system.clusters") {
			io.WriteString(w, `["cluster"]
["String"]
["prod_cluster"]
["other"]`)
			return
		}
		io.WriteString(w, "")
	})
	if err := cl.TruncateTable(context.Background(), "logs", "events", true); err != nil {
		t.Fatalf("TruncateTable: %v", err)
	}
	trunc := ""
	for _, b := range bodies {
		if strings.Contains(b, "TRUNCATE") {
			trunc = b
		}
	}
	if !strings.Contains(trunc, "TRUNCATE TABLE `logs`.`events` ON CLUSTER `prod_cluster`") {
		t.Fatalf("truncate sql missing ON CLUSTER: %q", trunc)
	}
}

func TestCHHTTPDriverExecReturnsEmptyRows(t *testing.T) {
	cl := newCHHTTPClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "")
	})
	res, err := cl.Execute(context.Background(), "CREATE TABLE t (x UInt8) ENGINE = Memory")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(res) != 1 || res[0].Error != "" {
		t.Fatalf("unexpected statements %+v", res)
	}
}

func TestCHHTTPDriverErrorSurfacesBody(t *testing.T) {
	cl := newCHHTTPClient(t, chRoutingHandler(
		`["engine","total_rows"]
["String","UInt64"]
["MergeTree",1234]`,
		func(w http.ResponseWriter, r *http.Request, sqlText string) {
			if strings.Contains(sqlText, "SELECT 1") {
				io.WriteString(w, "1")
				return
			}
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, "DB::Exception: boom")
		},
	))
	_, err := cl.PageRows(context.Background(), "logs", "events", "", "", true, 200, 0)
	if err == nil || !strings.Contains(err.Error(), "DB::Exception: boom") {
		t.Fatalf("server error body must surface, got %v", err)
	}
}

func TestCHHTTPDriverMultiHostFailover(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "1")
	}))
	defer srv.Close()
	cfg := model.ClickHouseConfig{
		Hosts:    []string{strings.TrimPrefix(bad.URL, "http://"), strings.TrimPrefix(srv.URL, "http://")},
		Username: "default",
		Database: "default",
		Protocol: "http",
	}
	cl, err := NewCHClient(cfg)
	if err != nil {
		t.Fatalf("NewCHClient with failover: %v", err)
	}
	if err := cl.Ping(context.Background()); err != nil {
		t.Fatalf("Ping after failover: %v", err)
	}
}

// 语义钉死:数字以文本形式保留(json 原文→字符串),避免 UInt64 精度丢失。
func TestCHHTTPNumberStaysText(t *testing.T) {
	body := `["n","UInt64"]
["String","UInt64"]
[9007199254740992,null]`
	srv := httptest.NewServer(chRoutingHandler(
		`["engine","total_rows"]
["String","UInt64"]
["MergeTree",9007199254740992]`,
		func(w http.ResponseWriter, r *http.Request, sqlText string) {
			io.WriteString(w, body)
		},
	))
	defer srv.Close()
	cfg := model.ClickHouseConfig{
		Hosts:    []string{strings.TrimPrefix(srv.URL, "http://")},
		Username: "default",
		Database: "default",
		Protocol: "http",
	}
	cl, err := NewCHClient(cfg)
	if err != nil {
		t.Fatalf("NewCHClient: %v", err)
	}
	defer cl.Close()
	res, err := cl.PageRows(context.Background(), "logs", "t", "", "", true, 200, 0)
	if err != nil {
		t.Fatalf("PageRows: %v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(res.Rows))
	}
	if res.Rows[0][0] == nil || *res.Rows[0][0] != "9007199254740992" {
		t.Fatalf("precision lost: %v", res.Rows[0][0])
	}
	if res.Rows[0][1] != nil {
		t.Fatalf("null must stay nil, got %v", res.Rows[0][1])
	}
}

// 复现用户真机问题:空表(0 行)时 PageRows 必须仍返回列信息,
// 前端才能渲染表头(此前用户真机看到右侧空白、字段全部缺失)。
func TestCHHTTPDriverEmptyBodyFallsBackToColumns(t *testing.T) {
	cl := newCHHTTPClient(t, chRoutingHandler(
		// system.tables 响应为空体(模拟老服务端对 0 行结果省略元数据)。
		`["engine","total_rows"]
["String","UInt64"]
["events",0]`,
		func(w http.ResponseWriter, r *http.Request, sqlText string) {
			if strings.Contains(sqlText, "system.columns") {
				io.WriteString(w, `["name","type"]
["String","String"]
["id","UInt64"]
["name","String"]`)
				return
			}
			io.WriteString(w, "")
		},
	))
	res, err := cl.PageRows(context.Background(), "logs", "events", "", "", true, 200, 0)
	if err != nil {
		t.Fatalf("PageRows empty body: %v", err)
	}
	if len(res.Columns) != 2 || res.Columns[0].Name != "id" {
		t.Fatalf("columns must fall back to system.columns, got %+v", res.Columns)
	}
}

// 复现用户真机问题:空表(0 行)时 PageRows 必须仍返回列信息,
// 前端才能渲染表头(此前用户真机看到右侧空白、字段全部缺失)。
func TestCHHTTPDriverEmptyTableKeepsColumns(t *testing.T) {
	cl := newCHHTTPClient(t, chRoutingHandler(
		// 空表:system.tables 仍有该表的元数据行(total_rows=0)。
		`["engine","total_rows"]
["String","UInt64"]
["MergeTree",0]`,
		func(w http.ResponseWriter, r *http.Request, sqlText string) {
			if strings.Contains(sqlText, "SELECT 1") {
				io.WriteString(w, "1")
				return
			}
			// 空表数据查询:names + types 行,无数据行。
			if !strings.Contains(sqlText, "system.") {
				io.WriteString(w, `["id","name"]
["UInt64","String"]`)
				return
			}
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, "unexpected query: "+sqlText)
		},
	))
	res, err := cl.PageRows(context.Background(), "logs", "events", "", "", true, 200, 0)
	if err != nil {
		t.Fatalf("PageRows on empty table: %v", err)
	}
	if len(res.Columns) == 0 {
		t.Fatalf("empty table must still return columns, got %+v", res)
	}
	if len(res.Columns) != 2 || res.Columns[0].Name != "id" {
		t.Fatalf("unexpected columns: %+v", res.Columns)
	}
	if len(res.Rows) != 0 {
		t.Fatalf("expected 0 rows, got %d", len(res.Rows))
	}
}
