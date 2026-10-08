// MySQL/TiDB 按行删除:控制台结果与表浏览器的「删除行」。WHERE 只允许主键列
// 且值不可为 NULL(主键定位),语句文本与执行同源(标识符反引号转义、字符串
// 字面量单引号双写);预览只读(SELECT COUNT(*) 同 WHERE),删除为危险操作、
// 审计由 app 层落。
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"sheng-shou-yun-he/backend/internal/model"
)

// --- 请求/响应形状(与前端 api/types.ts 的 MySQL 按行删除契约严格一致) ---

// MysqlDeleteRowRequest 按主键条件定位待删行:where 只允许主键列(后端强制),
// value 为 nil 表示 NULL——主键不会为 NULL,直接报错拒绝。Database 可为空,
// 兜底连接配置的默认库。
type MysqlDeleteRowRequest struct {
	ConnectionID string                 `json:"connection_id"`
	Database     string                 `json:"database"`
	Table        string                 `json:"table"`
	Where        []model.MysqlCellValue `json:"where"`
}

// MysqlDeleteRowPreview 是删除预览的只读结果:statement 为将执行的 DELETE
// 语句全文,matched_rows 为同 WHERE 条件 SELECT COUNT(*) 的命中行数。
type MysqlDeleteRowPreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// PreviewDeleteRow 渲染 DELETE 语句全文并统计同 WHERE 的命中行数。
// 只读:删除语句本身不执行。
func (c *MysqlClient) PreviewDeleteRow(ctx context.Context, req MysqlDeleteRowRequest) (MysqlDeleteRowPreview, error) {
	var preview MysqlDeleteRowPreview
	db := c.resolveDatabase(req.Database)
	if err := c.validateMysqlDelete(ctx, db, req.Table, req.Where); err != nil {
		return preview, err
	}
	stmt, err := buildMysqlDeleteStatement(db, req.Table, req.Where)
	if err != nil {
		return preview, err
	}
	countQuery, args, err := buildMysqlCountQuery(db, req.Table, req.Where)
	if err != nil {
		return preview, err // 语句构造已校验,防御性兜底
	}
	var matched int64
	if err := c.db.QueryRowContext(ctx, countQuery, args...).Scan(&matched); err != nil {
		return preview, fmt.Errorf("count matched rows: %w", err)
	}
	return MysqlDeleteRowPreview{Statement: stmt, MatchedRows: matched}, nil
}

// DeleteRow 执行按主键定位的 DELETE。执行路径重新走一遍校验与语句构造。
func (c *MysqlClient) DeleteRow(ctx context.Context, req MysqlDeleteRowRequest) error {
	db := c.resolveDatabase(req.Database)
	if err := c.validateMysqlDelete(ctx, db, req.Table, req.Where); err != nil {
		return err
	}
	stmt, err := buildMysqlDeleteStatement(db, req.Table, req.Where)
	if err != nil {
		return err
	}
	if _, err := c.db.ExecContext(ctx, stmt); err != nil {
		return fmt.Errorf("delete row: %w", err)
	}
	return nil
}

// validateMysqlDelete 按行删除的 WHERE 契约:非空(拒绝无定位的全表 DELETE)、
// 每个条件列必须是主键列(信息与单元格编辑同源:information_schema.columns
// 的 PRI 行)、主键值不可为 NULL。
func (c *MysqlClient) validateMysqlDelete(ctx context.Context, database, table string, where []model.MysqlCellValue) error {
	if strings.TrimSpace(table) == "" {
		return errors.New("表名不能为空")
	}
	if err := validateMysqlDeleteWhere(where); err != nil {
		return err
	}
	_, pk, err := c.tableColumnsWithPK(ctx, c.db, database, table)
	if err != nil {
		return err
	}
	if len(pk) == 0 {
		return errors.New("表无主键,不支持按行删除")
	}
	pkSet := make(map[string]bool, len(pk))
	for _, name := range pk {
		pkSet[name] = true
	}
	for _, cond := range where {
		if !pkSet[cond.Column] {
			return fmt.Errorf("where 条件列 %q 不是主键列,仅允许按主键删除", cond.Column)
		}
	}
	return nil
}

// validateMysqlDeleteWhere 校验条件的形状:非空、列名非空、值不可为 NULL
// (主键不会为 NULL,= NULL 永不命中,静默删 0 行比报错更危险)。
func validateMysqlDeleteWhere(where []model.MysqlCellValue) error {
	if len(where) == 0 {
		return errors.New("缺少定位主键:已拒绝无 WHERE 的全表 DELETE")
	}
	for _, cond := range where {
		if strings.TrimSpace(cond.Column) == "" {
			return errors.New("where 条件列名不能为空")
		}
		if cond.Value == nil {
			return fmt.Errorf("主键列 %q 的值不能为 NULL", cond.Column)
		}
	}
	return nil
}

// buildMysqlDeleteStatement 渲染 DELETE 语句全文:标识符反引号转义、值渲染为
// 单引号字面量(内嵌单引号双写)。预览展示与执行路径共用这一构造,转义即
// 执行语义。
func buildMysqlDeleteStatement(database, table string, where []model.MysqlCellValue) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", errors.New("表名不能为空")
	}
	if err := validateMysqlDeleteWhere(where); err != nil {
		return "", err
	}
	parts := make([]string, 0, len(where))
	for _, cond := range where {
		parts = append(parts, quoteMysqlIdent(cond.Column)+" = "+quoteMysqlString(*cond.Value))
	}
	return "DELETE FROM " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table) +
		" WHERE " + strings.Join(parts, " AND "), nil
}

// --- Service 层委托(断言生产 *MysqlClient;危险操作的审计由 app 层落) ---

// MysqlPreviewDeleteRow 预览按行删除:渲染 DELETE 语句全文 + 同 WHERE 命中
// 行数(只读)。
func (s *Service) MysqlPreviewDeleteRow(ctx context.Context, req MysqlDeleteRowRequest) (MysqlDeleteRowPreview, error) {
	m, err := s.mysqlClient(ctx, req.ConnectionID)
	if err != nil {
		return MysqlDeleteRowPreview{}, err
	}
	return m.PreviewDeleteRow(ctx, req)
}

// MysqlDeleteRow 执行按主键定位的 DELETE(危险操作,审计由 app 层落)。
func (s *Service) MysqlDeleteRow(ctx context.Context, req MysqlDeleteRowRequest) error {
	m, err := s.mysqlClient(ctx, req.ConnectionID)
	if err != nil {
		return err
	}
	return m.DeleteRow(ctx, req)
}
