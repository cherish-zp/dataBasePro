// PostgreSQL 按行删除绑定:SQL 控制台结果与表浏览器的「删除行」。方法保持
// 薄:委托 service 层。删除是危险操作,落审计 action postgres_delete_row,
// target 为 db.schema.relation(与 truncate/update_cell 同风格);审计详情
// 只含错误文本(仅引用列名,不含定位值),语句文本与值绝不入审计。预览只读,
// 不审计。
package backend

import (
	"dataBasePro/backend/internal/service"
)

// PostgresPreviewDeleteRow 预览按行删除:渲染参数化 DELETE 语句全文 + 同
// WHERE 命中行数(只读,不审计)。
func (a *App) PostgresPreviewDeleteRow(req service.PostgresDeleteRowRequest) (service.PostgresDeleteRowPreview, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.PostgresPreviewDeleteRow(ctx, req)
}

// PostgresDeleteRow 执行按主键定位的 DELETE(危险操作,审计 action
// postgres_delete_row,target 为 db.schema.relation)。
func (a *App) PostgresDeleteRow(req service.PostgresDeleteRowRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.PostgresDeleteRow(ctx, req)
	a.audit(req.ConnectionID, "postgres_delete_row", req.Database+"."+req.Schema+"."+req.Relation, auditResult(err), auditDetail(err))
	return err
}
