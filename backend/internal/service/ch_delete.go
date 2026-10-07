// ClickHouse 按行删除:SQL 控制台结果与表浏览器的「删除行」。ClickHouse 无
// 行级 DELETE,以同步 mutation 落地:ALTER TABLE ... DELETE WHERE ... SETTINGS
// mutations_sync = 1。WHERE 为类型化字面量条件(与单元格编辑的 chCellLiteral
// 同源:数值族不引号、其余单引号转义、Nullable 才可为 NULL),预览只读
// (SELECT count() 同条件),删除为危险操作、审计由 app 层落。
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"sheng-shou-yun-he/backend/internal/model"
)

// --- 请求/响应形状(与前端 api/types.ts 的 ClickHouse 按行删除契约严格一致) ---

// CHDeleteRowRequest 按类型化条件定位待删行:where 允许主键/排序键列(类型
// 来自列元数据,由 chCellLiteral 按类型渲染字面量)。Database 可为空,兜底
// 连接配置的默认库。
type CHDeleteRowRequest struct {
	ConnectionID string              `json:"connection_id"`
	Database     string              `json:"database"`
	Table        string              `json:"table"`
	Where        []model.CHCellValue `json:"where"`
}

// CHDeleteRowPreview 是删除预览的只读结果:statement 为将执行的
// ALTER TABLE ... DELETE 语句全文,matched_rows 为同条件 count() 的命中行数。
type CHDeleteRowPreview struct {
	Statement   string `json:"statement"`
	MatchedRows int64  `json:"matched_rows"`
}

// CHRowDeleter 是按行删除能力接口:与单元格更新的 CHCellUpdater 同风格,
// 池中客户端方法集不足时给出明确错误而非 panic。
type CHRowDeleter interface {
	PreviewDeleteRow(ctx context.Context, database, table string, where []model.CHCellValue) (CHDeleteRowPreview, error)
	DeleteRow(ctx context.Context, database, table string, where []model.CHCellValue) error
}

var _ CHRowDeleter = (*CHClient)(nil)

// --- 客户端实现(语句构造与单元格编辑同源) ---

// PreviewDeleteRow renders the exact ALTER TABLE ... DELETE statement and
// counts the rows matched by the same WHERE conditions. 只读:mutation 不执行。
func (c *CHClient) PreviewDeleteRow(ctx context.Context, database, table string, where []model.CHCellValue) (CHDeleteRowPreview, error) {
	var preview CHDeleteRowPreview
	db := c.resolveDatabase(database)
	stmt, err := buildCHDeleteStatement(db, table, where)
	if err != nil {
		return preview, err
	}
	conds, err := buildCHWhereClause(where)
	if err != nil {
		return preview, err // 语句构造已校验,防御性兜底
	}
	matched, err := c.countMatchedRows(ctx, db, table, conds)
	if err != nil {
		return preview, err
	}
	return CHDeleteRowPreview{Statement: stmt, MatchedRows: matched}, nil
}

// DeleteRow executes the synchronous delete mutation. 执行路径重新走一遍
// 语句构造:转义与字面量校验不因预览而跳过。
func (c *CHClient) DeleteRow(ctx context.Context, database, table string, where []model.CHCellValue) error {
	stmt, err := buildCHDeleteStatement(c.resolveDatabase(database), table, where)
	if err != nil {
		return err
	}
	if _, err := c.db.ExecContext(ctx, stmt); err != nil {
		return fmt.Errorf("delete row: %w", err)
	}
	return nil
}

// buildCHDeleteStatement renders the full mutation statement. 转义与字面量
// 构造全部在后端完成(与 buildCHCellUpdateStatement 同源):标识符反引号
// 包裹,条件按列类型分派字面量;空条件直接报错,拒绝无定位的全表 DELETE。
func buildCHDeleteStatement(database, table string, conds []model.CHCellValue) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", errors.New("表名不能为空")
	}
	if len(conds) == 0 {
		return "", errors.New("where 条件不能为空:已拒绝无定位的全表 DELETE")
	}
	where, err := buildCHWhereClause(conds)
	if err != nil {
		return "", err
	}
	return "ALTER TABLE " + quoteCHIdent(database) + "." + quoteCHIdent(table) +
		" DELETE WHERE " + where + " SETTINGS mutations_sync = 1", nil
}

// --- Service 层委托(复用 s.ch;危险操作的审计由 app 层落) ---

// CHPreviewDeleteRow 预览按行删除:渲染 DELETE mutation 语句全文 + 同条件
// 命中行数(只读)。
func (s *Service) CHPreviewDeleteRow(ctx context.Context, id, database, table string, where []model.CHCellValue) (CHDeleteRowPreview, error) {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return CHDeleteRowPreview{}, err
	}
	up, ok := ch.(CHRowDeleter)
	if !ok {
		return CHDeleteRowPreview{}, fmt.Errorf("connection %q 不支持按行删除", id)
	}
	return up.PreviewDeleteRow(ctx, database, table, where)
}

// CHDeleteRow 执行按条件定位的 DELETE mutation(危险操作,审计由 app 层落)。
func (s *Service) CHDeleteRow(ctx context.Context, id, database, table string, where []model.CHCellValue) error {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return err
	}
	up, ok := ch.(CHRowDeleter)
	if !ok {
		return fmt.Errorf("connection %q 不支持按行删除", id)
	}
	return up.DeleteRow(ctx, database, table, where)
}
