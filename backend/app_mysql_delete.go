// MySQL/TiDB 按行删除绑定:SQL 控制台结果与表浏览器的「删除行」。方法保持
// 薄:委托 service 层。删除是危险操作,落审计 action mysql_delete_row,
// target 为 db.table(与 truncate/drop 同风格);审计详情只含错误文本(仅
// 引用列名,不含定位值),语句文本与值绝不入审计。预览只读,不审计。
package backend

import (
	"sheng-shou-yun-he/backend/internal/service"
)

// MysqlPreviewDeleteRow 预览按行删除:渲染 DELETE 语句全文 + 同 WHERE 命中
// 行数(只读,不审计)。
func (a *App) MysqlPreviewDeleteRow(req service.MysqlDeleteRowRequest) (service.MysqlDeleteRowPreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.MysqlPreviewDeleteRow(ctx, req)
}

// MysqlDeleteRow 执行按主键定位的 DELETE(危险操作,审计 action
// mysql_delete_row,target 为 db.table)。
func (a *App) MysqlDeleteRow(req service.MysqlDeleteRowRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.MysqlDeleteRow(ctx, req)
	a.audit(req.ConnectionID, "mysql_delete_row", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}
