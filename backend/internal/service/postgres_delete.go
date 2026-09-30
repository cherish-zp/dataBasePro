// PostgreSQL 按行删除:SQL 控制台结果与表浏览器的「删除行」。WHERE 只允许
// 主键列(与单元格编辑同源 pg_index 主键元数据),视图/物化视图一律拒绝;
// 语句全程参数化($n 占位,转义交给驱动),预览只读(SELECT COUNT(*) 同
// WHERE),删除为危险操作、审计由 app 层落。
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"dataBasePro/backend/internal/model"
)

// --- 请求/响应形状(与前端 api/types.ts 的 PostgreSQL 按行删除契约严格一致) ---

// PostgresDeleteRowRequest 按主键条件定位待删行:relation_kind 为
// view/materialized_view 时后端拒绝(仅实体表可删)。Database 可为空,兜底
// 连接配置的默认库;schema/relation 必填。
type PostgresDeleteRowRequest struct {
	ConnectionID string                     `json:"connection_id"`
	Database     string                     `json:"database"`
	Schema       string                     `json:"schema"`
	Relation     string                     `json:"relation"`
	RelationKind model.PostgresRelationKind `json:"relation_kind"`
	Where        []model.PostgresCellValue  `json:"where"`
}

// PostgresDeleteRowPreview 是删除预览的只读结果:statement 为将执行的参数化
// DELETE 语句全文($n 占位),matched_rows 为同 WHERE 条件 COUNT(*) 的命中行数。
type PostgresDeleteRowPreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// PostgresRowDeleter 是按行删除能力接口:与单元格编辑同风格,池中客户端
// 方法集不足时给出明确错误而非 panic。
type PostgresRowDeleter interface {
	PreviewDeleteRow(ctx context.Context, req PostgresDeleteRowRequest) (PostgresDeleteRowPreview, error)
	DeleteRow(ctx context.Context, req PostgresDeleteRowRequest) error
}

var _ PostgresRowDeleter = (*PostgresClient)(nil)

// --- 客户端实现(参数化与 PostgresPreviewCellUpdate/UpdateCell 同源) ---

// PreviewDeleteRow renders the parameterized DELETE statement and counts the
// rows matched by the same WHERE conditions. 只读:删除语句本身不执行。
func (c *PostgresClient) PreviewDeleteRow(ctx context.Context, req PostgresDeleteRowRequest) (PostgresDeleteRowPreview, error) {
	var preview PostgresDeleteRowPreview
	if err := validatePostgresDeleteKind(req.RelationKind); err != nil {
		return preview, err
	}
	names, err := postgresRelationNames(req.Database, req.Schema, req.Relation)
	if err != nil {
		return preview, err
	}
	db, err := c.getDB(ctx, names.database)
	if err != nil {
		return preview, err
	}
	pk, err := postgresPrimaryKey(ctx, db, names.schema, names.relation)
	if err != nil {
		return preview, err
	}
	statement, _, err := buildPostgresDeleteStatement(names.database, names.schema, names.relation, req.Where, pk)
	if err != nil {
		return preview, err
	}
	countSQL, countArgs, err := buildPostgresCellCountStatement(names.database, names.schema, names.relation, req.Where, pk)
	if err != nil {
		return preview, err // 语句构造已校验,防御性兜底
	}
	var matched int64
	if err := db.QueryRowContext(ctx, countSQL, countArgs...).Scan(&matched); err != nil {
		return preview, fmt.Errorf("count matched rows: %w", err)
	}
	preview.Statement = statement
	preview.MatchedRows = matched
	return preview, nil
}

// DeleteRow executes the parameterized DELETE. Only primary-key columns may
// appear in WHERE. 执行路径重新走一遍校验与语句构造。
func (c *PostgresClient) DeleteRow(ctx context.Context, req PostgresDeleteRowRequest) error {
	if err := validatePostgresDeleteKind(req.RelationKind); err != nil {
		return err
	}
	names, err := postgresRelationNames(req.Database, req.Schema, req.Relation)
	if err != nil {
		return err
	}
	db, err := c.getDB(ctx, names.database)
	if err != nil {
		return err
	}
	pk, err := postgresPrimaryKey(ctx, db, names.schema, names.relation)
	if err != nil {
		return err
	}
	statement, args, err := buildPostgresDeleteStatement(names.database, names.schema, names.relation, req.Where, pk)
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, statement, args...); err != nil {
		return fmt.Errorf("delete row: %w", err)
	}
	return nil
}

// validatePostgresDeleteKind keeps row deletion restricted to ordinary tables
// before any database connection is established. 文案与单元格编辑区分开:
// 删除语境明确报「仅实体表支持删除行」。
func validatePostgresDeleteKind(kind model.PostgresRelationKind) error {
	if !kind.Valid() {
		return fmt.Errorf("不支持的 relation_kind %q", kind)
	}
	if !kind.CanTruncate() {
		return errors.New("仅实体表支持删除行")
	}
	return nil
}

// buildPostgresDeleteStatement renders the parameterized DELETE ($n 占位,
// 标识符双引号转义,值经驱动参数化)。与单元格更新的构造同风格:非空 WHERE、
// 条件列必须是主键列。database 仅用于签名对称(PostgreSQL 无三段命名)。
func buildPostgresDeleteStatement(database, schema, relation string, where []model.PostgresCellValue, primaryKeys []string) (string, []any, error) {
	if len(where) == 0 {
		return "", nil, errors.New("主键 WHERE 条件不能为空")
	}
	pkSet := make(map[string]bool, len(primaryKeys))
	for _, key := range primaryKeys {
		pkSet[key] = true
	}
	args := make([]any, 0, len(where))
	buf := strings.Builder{}
	buf.WriteString("DELETE FROM ")
	buf.WriteString(postgresQualifiedName(schema, relation))
	buf.WriteString(" WHERE ")
	for i, condition := range where {
		column := strings.TrimSpace(condition.Column)
		if !pkSet[column] {
			return "", nil, fmt.Errorf("WHERE 列 %q 不是主键列", column)
		}
		if i > 0 {
			buf.WriteString(" AND ")
		}
		buf.WriteString(postgresQuoteIdent(column))
		fmt.Fprintf(&buf, " = $%d", i+1)
		args = append(args, condition.Value)
	}
	return buf.String(), args, nil
}

// --- Service 层委托(获取方式与 PostgresPreviewCellUpdate 相同) ---

// PostgresPreviewDeleteRow 预览按行删除:渲染参数化 DELETE 语句全文 + 同
// WHERE 命中行数(只读)。
func (s *Service) PostgresPreviewDeleteRow(ctx context.Context, req PostgresDeleteRowRequest) (PostgresDeleteRowPreview, error) {
	pg, err := s.postgres(ctx, req.ConnectionID)
	if err != nil {
		return PostgresDeleteRowPreview{}, err
	}
	up, ok := pg.(PostgresRowDeleter)
	if !ok {
		return PostgresDeleteRowPreview{}, fmt.Errorf("connection %q 不支持按行删除", req.ConnectionID)
	}
	return up.PreviewDeleteRow(ctx, req)
}

// PostgresDeleteRow 执行按主键定位的 DELETE(危险操作,审计由 app 层落)。
func (s *Service) PostgresDeleteRow(ctx context.Context, req PostgresDeleteRowRequest) error {
	pg, err := s.postgres(ctx, req.ConnectionID)
	if err != nil {
		return err
	}
	up, ok := pg.(PostgresRowDeleter)
	if !ok {
		return fmt.Errorf("connection %q 不支持按行删除", req.ConnectionID)
	}
	return up.DeleteRow(ctx, req)
}
