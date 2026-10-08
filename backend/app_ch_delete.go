// ClickHouse 按行删除绑定:SQL 控制台结果与表浏览器的「删除行」。方法保持
// 薄:委托 service 层。删除是危险操作,落审计 action ch_delete_row,target
// 为 db.table(与 truncate/update_cell 同风格);审计详情只含错误文本(仅
// 引用列名,不含定位值),语句文本与值绝不入审计。预览只读,不审计。
package backend

import (
	"sheng-shou-yun-he/backend/internal/service"
)

// CHPreviewDeleteRow 预览按行删除:渲染 ALTER TABLE ... DELETE 语句全文 +
// 同条件 count() 命中行数(只读,不审计)。
func (a *App) CHPreviewDeleteRow(req service.CHDeleteRowRequest) (service.CHDeleteRowPreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CHPreviewDeleteRow(ctx, req.ConnectionID, req.Database, req.Table, req.Where)
}

// CHDeleteRow 执行同步 DELETE mutation(危险操作,审计 action ch_delete_row,
// target 为 db.table)。
func (a *App) CHDeleteRow(req service.CHDeleteRowRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.CHDeleteRow(ctx, req.ConnectionID, req.Database, req.Table, req.Where)
	a.audit(req.ConnectionID, "ch_delete_row", req.Database+"."+req.Table, auditResult(err), auditDetail(err))
	return err
}
