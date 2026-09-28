// MySQL/TiDB 表级 DDL 与导出:连接树右键的删除表 / 表结构编辑 / 导出能力。
// 所有 SQL 文本在后端拼装(标识符反引号转义、字符串字面量单引号双写),
// 前端只传结构化请求。危险操作(DROP/ALTER/导出)由 app 层落审计。
package service

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"dataBasePro/backend/internal/model"
)

// NewMysqlClientWithConnector 基于 driver.Connector 直接构造客户端:不解析
// DSN、不拨号验证。生产路径一律走 NewMysqlClient;本构造仅供离线测试注入
// fake 驱动(app 层测试无法构造未导出字段的 MysqlClient)。
func NewMysqlClientWithConnector(connector driver.Connector, connType model.ConnectionType) *MysqlClient {
	return &MysqlClient{db: sql.OpenDB(connector), connType: connType}
}

// --- 请求/响应形状(与前端 api/types.ts 的 MySQL DDL 契约严格一致) ---

// MysqlTableColumn 镜像 information_schema.columns 的一行全量元数据。
// DefaultValue 为 nil 表示「无默认值/DEFAULT NULL」;Extra 承载
// auto_increment / on update CURRENT_TIMESTAMP 等原文。
type MysqlTableColumn struct {
	Name         string  `json:"name"`
	ColumnType   string  `json:"column_type"`
	DataType     string  `json:"data_type"`
	Nullable     bool    `json:"nullable"`
	DefaultValue *string `json:"default_value"`
	Extra        string  `json:"extra"`
	Comment      string  `json:"comment"`
	IsPrimaryKey bool    `json:"is_primary_key"`
}

// MysqlTableColumnsResult 是一表的完整列清单与 SHOW CREATE TABLE 原文。
type MysqlTableColumnsResult struct {
	Columns []MysqlTableColumn `json:"columns"`
	DDL     string             `json:"ddl"`
}

// MysqlColumnDef 描述一条 ADD/MODIFY 的列定义,后端据此拼 ALTER。
type MysqlColumnDef struct {
	Name          string  `json:"name"`
	ColumnType    string  `json:"column_type"`
	Nullable      bool    `json:"nullable"`
	DefaultValue  *string `json:"default_value"`
	Comment       string  `json:"comment"`
	AutoIncrement bool    `json:"auto_increment"`
	// After 仅新增列生效:nil=追加表尾,非空=AFTER 该列;修改列忽略。
	After *string `json:"after,omitempty"`
}

// MysqlAlterTableSpec 是一次结构变更的三组操作,按 ADD → MODIFY → DROP 执行。
type MysqlAlterTableSpec struct {
	Database      string           `json:"database"`
	Table         string           `json:"table"`
	AddColumns    []MysqlColumnDef `json:"add_columns"`
	ModifyColumns []MysqlColumnDef `json:"modify_columns"`
	DropColumns   []string         `json:"drop_columns"`
}

// MysqlExportSpec 描述一次表导出:include_ddl 与 include_data 至少选一,
// 都为 false 拒绝执行;data_limit>0 时数据行数封顶,0 表示不限制。
// insert_per_row=true 每行一条独立 INSERT,否则按 mysqlExportInsertRows 合并;
// drop_table_if_exists 在表结构段前置 DROP TABLE IF EXISTS;strip_auto_increment
// 剥离 SHOW CREATE TABLE 里表级的 AUTO_INCREMENT=N 计数(列级 AUTO_INCREMENT
// 是语义,不受影响);include_create_db 在文件最头部加建库 + USE 语句。
type MysqlExportSpec struct {
	Database           string `json:"database"`
	Table              string `json:"table"`
	IncludeData        bool   `json:"include_data"`
	DataLimit          int    `json:"data_limit"`
	IncludeDDL         bool   `json:"include_ddl"`
	InsertPerRow       bool   `json:"insert_per_row"`
	DropTableIfExists  bool   `json:"drop_table_if_exists"`
	StripAutoIncrement bool   `json:"strip_auto_increment"`
	IncludeCreateDB    bool   `json:"include_create_db"`
}

// MysqlExportTableResult 返回建议文件名与 .sql 正文(结构 + 多行 INSERT)。
type MysqlExportTableResult struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

// --- 删除表 ---

// DropTable drops the table (structure and data).
func (c *MysqlClient) DropTable(ctx context.Context, database, table string) error {
	query := "DROP TABLE " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table)
	if _, err := c.db.ExecContext(ctx, query); err != nil {
		return fmt.Errorf("drop table: %w", err)
	}
	return nil
}

// --- 表结构(列清单 + DDL) ---

// mysqlTableColumnsQuery 读取一表的全量列元数据,按定义顺序(ordinal_position)
// 排序;column_key='PRI' 标记主键列。
const mysqlTableColumnsQuery = "SELECT column_name, column_type, data_type, is_nullable," +
	" column_default, extra, column_comment, column_key FROM information_schema.columns" +
	" WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position"

// TableColumns returns the table's full column metadata plus its DDL
// (SHOW CREATE TABLE).
func (c *MysqlClient) TableColumns(ctx context.Context, database, table string) (MysqlTableColumnsResult, error) {
	var res MysqlTableColumnsResult
	rows, err := c.db.QueryContext(ctx, mysqlTableColumnsQuery, database, table)
	if err != nil {
		return res, fmt.Errorf("table columns: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			name, colType, dataType, nullable, extra, comment, key sql.NullString
			def                                                    sql.NullString
		)
		if err := rows.Scan(&name, &colType, &dataType, &nullable, &def, &extra, &comment, &key); err != nil {
			return res, fmt.Errorf("scan column: %w", err)
		}
		col := MysqlTableColumn{
			Name:       name.String,
			ColumnType: colType.String,
			DataType:   dataType.String,
			Nullable:   strings.EqualFold(nullable.String, "YES"),
			Extra:      extra.String,
			Comment:    comment.String,
			// 主键判定与 PageRows 的 primary_key 元数据同源(column_key='PRI')。
			IsPrimaryKey: strings.EqualFold(strings.TrimSpace(key.String), "PRI"),
		}
		if def.Valid {
			v := def.String
			col.DefaultValue = &v
		}
		res.Columns = append(res.Columns, col)
	}
	if err := rows.Err(); err != nil {
		return res, err
	}
	if res.Columns == nil {
		res.Columns = []MysqlTableColumn{}
	}
	ddl, err := c.mysqlCreateTableDDL(ctx, database, table)
	if err != nil {
		return res, err
	}
	res.DDL = ddl
	return res, nil
}

// mysqlCreateTableDDL fetches the SHOW CREATE TABLE text (second column; the
// first is the table name).
func (c *MysqlClient) mysqlCreateTableDDL(ctx context.Context, database, table string) (string, error) {
	rows, err := c.db.QueryContext(ctx,
		"SHOW CREATE TABLE "+quoteMysqlIdent(database)+"."+quoteMysqlIdent(table))
	if err != nil {
		return "", fmt.Errorf("show create table: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("table %s.%s not found", database, table)
	}
	var name, ddl string
	if err := rows.Scan(&name, &ddl); err != nil {
		return "", fmt.Errorf("scan create table: %w", err)
	}
	return ddl, rows.Err()
}

// --- 编辑表字段(ALTER TABLE) ---

// mysqlCurrentDefaultRe 全文匹配 CURRENT_TIMESTAMP/CURRENT_DATE 一族默认值
// (大小写不敏感,可选 () 或 (精度) 后缀)。必须全文匹配才允许裸写进 DEFAULT:
// 前缀匹配会让 "CURRENT_TIMESTAMP(6), DROP COLUMN x" 一类值以裸形态拼进
// ALTER,单条语句内追加任意子句。
var mysqlCurrentDefaultRe = regexp.MustCompile(`(?i)^current_(timestamp|date)(\(\d*\))?$`)

// isMysqlCurrentDefault 判断默认值是否为 CURRENT_TIMESTAMP/CURRENT_DATE 一族
// (大小写不敏感,容忍 () 与精度后缀):是则裸写进 DEFAULT,不加引号;
// 其余默认值一律走单引号字面量转义路径。
func isMysqlCurrentDefault(v string) bool {
	return mysqlCurrentDefaultRe.MatchString(strings.TrimSpace(v))
}

// buildMysqlColumnDefinition 渲染 ADD/MODIFY 共用的列定义体:
// `name` type [NOT NULL] [DEFAULT ...] [COMMENT '...'] [AUTO_INCREMENT]。
// MODIFY 不重申的属性会被 MySQL 重置,因此 DEFAULT 与 COMMENT 恒输出:
// nil 默认值 → DEFAULT NULL,空注释 → COMMENT ”。
func buildMysqlColumnDefinition(def MysqlColumnDef) string {
	var b strings.Builder
	b.WriteString(quoteMysqlIdent(def.Name))
	b.WriteString(" ")
	b.WriteString(def.ColumnType)
	if !def.Nullable {
		b.WriteString(" NOT NULL")
	}
	switch {
	case def.DefaultValue == nil:
		b.WriteString(" DEFAULT NULL")
	case isMysqlCurrentDefault(*def.DefaultValue):
		b.WriteString(" DEFAULT " + strings.TrimSpace(*def.DefaultValue))
	default:
		b.WriteString(" DEFAULT " + quoteMysqlString(*def.DefaultValue))
	}
	b.WriteString(" COMMENT " + quoteMysqlString(def.Comment))
	if def.AutoIncrement {
		b.WriteString(" AUTO_INCREMENT")
	}
	return b.String()
}

// buildMysqlAlterStatements 展开 ADD → MODIFY → DROP 三组为逐条 ALTER 语句。
func buildMysqlAlterStatements(database, table string, add, modify []MysqlColumnDef, drop []string) []string {
	head := "ALTER TABLE " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table)
	var stmts []string
	for _, def := range add {
		stmt := head + " ADD COLUMN " + buildMysqlColumnDefinition(def)
		if def.After != nil && strings.TrimSpace(*def.After) != "" {
			stmt += " AFTER " + quoteMysqlIdent(strings.TrimSpace(*def.After))
		}
		stmts = append(stmts, stmt)
	}
	for _, def := range modify {
		stmts = append(stmts, head+" MODIFY COLUMN "+buildMysqlColumnDefinition(def))
	}
	for _, name := range drop {
		stmts = append(stmts, head+" DROP COLUMN "+quoteMysqlIdent(name))
	}
	return stmts
}

// mysqlColumnTypeRe 列类型白名单(全文匹配):首段为标识符形态的类型名,
// 可选一段括号参数(仅数字、逗号、空格、负号——decimal(10,2)/int(11) 形态;
// 禁止引号,enum/set 等含引号类型不走表结构编辑器改类型,可在 SQL 控制台
// 执行 DDL),后随空格分隔的 unsigned/zerofill 修饰(可重复)。
var mysqlColumnTypeRe = regexp.MustCompile(
	`^\s*[A-Za-z_][A-Za-z0-9_]*(?:\([0-9,\- ]+\))?(?:\s+(?i:unsigned|zerofill))*\s*$`)

// validateMysqlColumnType 校验用户提交的列类型:不在白名单内即拒绝,堵死
// "varchar(10) DEFAULT 'x', DROP COLUMN secret" 一类借类型字段往单条
// ALTER 里拼任意子句的注入面。
func validateMysqlColumnType(s string) error {
	if !mysqlColumnTypeRe.MatchString(s) {
		return fmt.Errorf("列类型不合法: %q", s)
	}
	return nil
}

// validateMysqlAlterSpec 拒绝空变更与缺失列名/类型的条目。
func validateMysqlAlterSpec(spec MysqlAlterTableSpec) error {
	if strings.TrimSpace(spec.Table) == "" {
		return errors.New("表名不能为空")
	}
	if len(spec.AddColumns) == 0 && len(spec.ModifyColumns) == 0 && len(spec.DropColumns) == 0 {
		return errors.New("没有需要执行的结构变更")
	}
	for _, def := range append(append([]MysqlColumnDef{}, spec.AddColumns...), spec.ModifyColumns...) {
		if strings.TrimSpace(def.Name) == "" {
			return errors.New("列名不能为空")
		}
		if strings.TrimSpace(def.ColumnType) == "" {
			return fmt.Errorf("列 %q 的类型不能为空", def.Name)
		}
		if err := validateMysqlColumnType(def.ColumnType); err != nil {
			return fmt.Errorf("列 %q: %w", def.Name, err)
		}
	}
	for _, name := range spec.DropColumns {
		if strings.TrimSpace(name) == "" {
			return errors.New("待删除列名不能为空")
		}
	}
	return nil
}

// AlterTable executes the ADD → MODIFY → DROP statements one by one
// (autocommit); the first failure aborts the run and surfaces its error.
func (c *MysqlClient) AlterTable(ctx context.Context, spec MysqlAlterTableSpec) error {
	if err := validateMysqlAlterSpec(spec); err != nil {
		return err
	}
	for _, stmt := range buildMysqlAlterStatements(spec.Database, spec.Table, spec.AddColumns, spec.ModifyColumns, spec.DropColumns) {
		if _, err := c.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("alter table: %w", err)
		}
	}
	return nil
}

// --- 导出表结构和数据 ---

const (
	// mysqlExportBatchSize 是数据导出的单批行数(OFFSET 递进翻页)。
	mysqlExportBatchSize = 1000
	// mysqlExportInsertRows 是一条多行 INSERT 聚合的行数上限。
	mysqlExportInsertRows = 100
	// mysqlDatetimeExportLayout 是导出 INSERT 时时间字面量的布局:本地墙钟、
	// 秒后小数(有则保留),MySQL 直接接受该形态。
	mysqlDatetimeExportLayout = "2006-01-02 15:04:05.999999"
)

// renderMysqlExportLiteral renders one driver value as a raw SQL literal for
// exported INSERTs. 与展示路径的 formatMysqlCell 不同,这里绝不能截断或做展示
// 格式化:[]byte 走十六进制(二进制安全),时间按 MySQL 接受的墙钟形态,
// 字符串单引号双写,nil → NULL。
func renderMysqlExportLiteral(v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case []byte:
		if len(x) == 0 {
			return "''"
		}
		return "0x" + fmt.Sprintf("%x", x)
	case time.Time:
		return quoteMysqlString(x.Format(mysqlDatetimeExportLayout))
	case string:
		return quoteMysqlString(x)
	case bool:
		return strconv.FormatBool(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'g', -1, 32)
	default:
		return quoteMysqlString(fmt.Sprintf("%v", v))
	}
}

// mysqlExportFilename 建议导出文件名:<table>_<时间戳>.sql。
func mysqlExportFilename(table string) string {
	return table + "_" + time.Now().Format("20060102150405") + ".sql"
}

// mysqlTablePKQuery 读取一表的主键列名(key_column_usage,按约束内的
// ordinal_position 排序,即复合主键的定义顺序)。
const mysqlTablePKQuery = "SELECT column_name FROM information_schema.key_column_usage" +
	" WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'" +
	" ORDER BY ordinal_position"

// mysqlAutoIncrementCounterRe 匹配 SHOW CREATE TABLE 输出中表级的
// AUTO_INCREMENT=N 行计数(表选项);列级 AUTO_INCREMENT 不带 "=N" 后缀,
// 不会被命中——那是插入语义,剥离会改变导入行为。
var mysqlAutoIncrementCounterRe = regexp.MustCompile(`(?i)\s*AUTO_INCREMENT=\d+`)

// mysqlSchemaCharsetQuery 读取库的默认字符集与排序规则(include_create_db
// 的建库头部用)。
const mysqlSchemaCharsetQuery = "SELECT default_character_set_name, default_collation_name" +
	" FROM information_schema.SCHEMATA WHERE schema_name = ?"

// mysqlCreateDatabaseHeader 渲染导出文件最头部的建库语句:优先带上从
// information_schema.SCHEMATA 读取的默认字符集/排序规则;查不到(无行)时
// 退化为裸 CREATE DATABASE。CREATE DATABASE 与 USE 两条语句恒成对输出。
func (c *MysqlClient) mysqlCreateDatabaseHeader(ctx context.Context, database string) (string, error) {
	rows, err := c.db.QueryContext(ctx, mysqlSchemaCharsetQuery, database)
	if err != nil {
		return "", fmt.Errorf("schema charset: %w", err)
	}
	defer rows.Close()
	var charset, collation sql.NullString
	if rows.Next() {
		if err := rows.Scan(&charset, &collation); err != nil {
			return "", fmt.Errorf("scan schema charset: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	db := quoteMysqlIdent(database)
	if charset.Valid && charset.String != "" && collation.Valid && collation.String != "" {
		return "CREATE DATABASE IF NOT EXISTS " + db +
			" DEFAULT CHARACTER SET " + quoteMysqlIdent(charset.String) +
			" COLLATE " + quoteMysqlIdent(collation.String) + ";\n" +
			"USE " + db + ";\n", nil
	}
	return "CREATE DATABASE IF NOT EXISTS " + db + ";\nUSE " + db + ";\n", nil
}

// mysqlTablePrimaryKey 查询一表的主键列名(按约束内定义顺序);无主键返回
// 空切片。导出数据分批据此拼 ORDER BY。
func (c *MysqlClient) mysqlTablePrimaryKey(ctx context.Context, database, table string) ([]string, error) {
	rows, err := c.db.QueryContext(ctx, mysqlTablePKQuery, database, table)
	if err != nil {
		return nil, fmt.Errorf("table primary key: %w", err)
	}
	defer rows.Close()
	var pk []string
	for rows.Next() {
		var name sql.NullString
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan primary key column: %w", err)
		}
		if name.String != "" {
			pk = append(pk, name.String)
		}
	}
	return pk, rows.Err()
}

// ExportTable renders a .sql script: 可选建库头部 → 可选表结构段(SHOW CREATE
// TABLE,可前置 DROP TABLE IF EXISTS 行并剥离表级 AUTO_INCREMENT 计数)→ 可选
// 批量 INSERT。include_ddl=false 完全跳过 SHOW CREATE TABLE,include_data=false
// 跳过主键查询与数据段。数据分批 SELECT(有主键则按主键排序,保证 OFFSET 翻页
// 行序稳定;每批 1000 行、OFFSET 递进;data_limit>0 封顶),用原始 driver 值
// 扫描并转义,严禁复用 collectMysqlRows(它会按展示截断 8192 字节)。
func (c *MysqlClient) ExportTable(ctx context.Context, spec MysqlExportSpec) (MysqlExportTableResult, error) {
	var res MysqlExportTableResult
	if !spec.IncludeDDL && !spec.IncludeData {
		return res, errors.New("请至少选择导出内容：表结构或表数据")
	}
	res.Filename = mysqlExportFilename(spec.Table)
	var b strings.Builder
	if spec.IncludeCreateDB {
		header, err := c.mysqlCreateDatabaseHeader(ctx, spec.Database)
		if err != nil {
			return res, err
		}
		b.WriteString(header)
	}
	if spec.IncludeDDL {
		ddl, err := c.mysqlCreateTableDDL(ctx, spec.Database, spec.Table)
		if err != nil {
			return res, err
		}
		if spec.StripAutoIncrement {
			ddl = mysqlAutoIncrementCounterRe.ReplaceAllString(ddl, "")
		}
		fmt.Fprintf(&b, "-- 表结构: %s.%s\n", spec.Database, spec.Table)
		if spec.DropTableIfExists {
			b.WriteString("DROP TABLE IF EXISTS " + quoteMysqlIdent(spec.Table) + ";\n")
		}
		b.WriteString(ddl)
		b.WriteString(";\n")
	}
	if !spec.IncludeData {
		res.Content = b.String()
		return res, nil
	}
	// 仅数据导出前查主键(结构导出不多发查询)。
	pkColumns, err := c.mysqlTablePrimaryKey(ctx, spec.Database, spec.Table)
	if err != nil {
		return res, err
	}
	rowsPerInsert := mysqlExportInsertRows
	if spec.InsertPerRow {
		rowsPerInsert = 1
	}
	inserts, rowsExported, err := c.mysqlExportInserts(ctx, spec.Database, spec.Table, spec.DataLimit, pkColumns, rowsPerInsert)
	if err != nil {
		return res, err
	}
	if rowsExported > 0 {
		fmt.Fprintf(&b, "\n-- 表数据: %s.%s (%d 行)\n", spec.Database, spec.Table, rowsExported)
		b.WriteString(inserts)
	}
	res.Content = b.String()
	return res, nil
}

// mysqlExportInserts pages through the whole table and renders INSERT
// statements (at most rowsPerInsert rows per statement; rowsPerInsert<=0 时
// 回落 mysqlExportInsertRows,insert_per_row 传 1 即每行一条独立 INSERT)。
// pkColumns 非空时数据批次按主键列排序:LIMIT/OFFSET 翻页只有在确定排序下
// 才保证不漏行不重行(InnoDB 无 ORDER BY 的行序不保证稳定)。无主键表保持
// 无序查询——跨批顺序不保证、可能漏/重行,是该场景的固有限制。
func (c *MysqlClient) mysqlExportInserts(ctx context.Context, database, table string, dataLimit int, pkColumns []string, rowsPerInsert int) (string, int, error) {
	if rowsPerInsert <= 0 {
		rowsPerInsert = mysqlExportInsertRows
	}
	var (
		b       strings.Builder
		columns []string
		head    string
		total   int
		batch   int // 当前 INSERT 语句里已聚合的行数
	)
	// flush 结束当前 INSERT 语句(有内容才补分号换行)。
	flush := func() {
		if batch > 0 {
			b.WriteString(";\n")
			batch = 0
		}
	}
	offset := 0
	// 主键列经反引号转义后拼 ORDER BY;列名来自 information_schema 且仍走
	// 转义 helper,不引入注入面。
	var orderClause string
	if len(pkColumns) > 0 {
		quoted := make([]string, len(pkColumns))
		for i, col := range pkColumns {
			quoted[i] = quoteMysqlIdent(col)
		}
		orderClause = " ORDER BY " + strings.Join(quoted, ", ")
	}
	for {
		size := mysqlExportBatchSize
		if dataLimit > 0 {
			if remaining := dataLimit - total; remaining < size {
				size = remaining
			}
			if size <= 0 {
				break
			}
		}
		// size/offset 均为内部计算的整数,字面量拼接无注入面。
		query := fmt.Sprintf("SELECT * FROM %s.%s%s LIMIT %d OFFSET %d",
			quoteMysqlIdent(database), quoteMysqlIdent(table), orderClause, size, offset)
		rows, err := c.db.QueryContext(ctx, query)
		if err != nil {
			flush()
			return b.String(), total, fmt.Errorf("export rows: %w", err)
		}
		names, err := rows.Columns()
		if err != nil {
			_ = rows.Close()
			flush()
			return b.String(), total, fmt.Errorf("export columns: %w", err)
		}
		if columns == nil {
			columns = names
			quoted := make([]string, len(names))
			for i, n := range names {
				quoted[i] = quoteMysqlIdent(n)
			}
			head = "INSERT INTO " + quoteMysqlIdent(database) + "." + quoteMysqlIdent(table) +
				" (" + strings.Join(quoted, ", ") + ") VALUES "
		}
		values := make([]any, len(names))
		pointers := make([]any, len(names))
		n := 0
		for rows.Next() {
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				_ = rows.Close()
				flush()
				return b.String(), total, fmt.Errorf("scan export row: %w", err)
			}
			if batch == 0 {
				b.WriteString(head)
			} else {
				b.WriteString(", ")
			}
			b.WriteString("(")
			for i, v := range values {
				if i > 0 {
					b.WriteString(", ")
				}
				b.WriteString(renderMysqlExportLiteral(v))
			}
			b.WriteString(")")
			batch++
			total++
			n++
			if batch == rowsPerInsert {
				flush()
			}
		}
		closeErr := rows.Close()
		if err := rows.Err(); err != nil {
			flush()
			return b.String(), total, err
		}
		if closeErr != nil {
			flush()
			return b.String(), total, closeErr
		}
		if n < size {
			break // 不足一批:已是最后一页
		}
		offset += n
	}
	flush()
	return b.String(), total, nil
}

// --- Service 层委托(断言具体 *MysqlClient;危险操作的审计由 app 层落) ---

// mysqlClient 取池中客户端并断言为生产 *MysqlClient:表级 DDL 的语句拼装
// 依赖 MysqlClient 的转义辅助,非 MySQL/TiDB 池化客户端一律拒绝。
func (s *Service) mysqlClient(ctx context.Context, id string) (*MysqlClient, error) {
	ds, err := s.pool.Get(id)
	if err != nil {
		if cerr := s.ConnectConnection(ctx, id); cerr != nil {
			return nil, err
		}
		if ds, err = s.pool.Get(id); err != nil {
			return nil, err
		}
	}
	m, ok := ds.(*MysqlClient)
	if !ok {
		return nil, fmt.Errorf("connection %q is not a MySQL/TiDB source", id)
	}
	return m, nil
}

// MysqlDropTable drops the table (dangerous, audited by the caller).
func (s *Service) MysqlDropTable(ctx context.Context, id, database, table string) error {
	m, err := s.mysqlClient(ctx, id)
	if err != nil {
		return err
	}
	return m.DropTable(ctx, database, table)
}

// MysqlTableColumns returns the table's full column metadata plus its DDL.
func (s *Service) MysqlTableColumns(ctx context.Context, id, database, table string) (MysqlTableColumnsResult, error) {
	m, err := s.mysqlClient(ctx, id)
	if err != nil {
		return MysqlTableColumnsResult{}, err
	}
	return m.TableColumns(ctx, database, table)
}

// MysqlAlterTable applies the ADD → MODIFY → DROP structure changes.
func (s *Service) MysqlAlterTable(ctx context.Context, id string, spec MysqlAlterTableSpec) error {
	m, err := s.mysqlClient(ctx, id)
	if err != nil {
		return err
	}
	return m.AlterTable(ctx, spec)
}

// MysqlExportTable renders the table's structure (and optionally data) as a
// .sql script. Unlike the other table operations it does NOT reuse the pooled
// client: an export can run far longer than the surrounding interactions, and
// reusing a pooled client means a concurrent 断开/编辑保存/删除连接
// (CloseConnection/UpdateConnection/DeleteConnection all Close the pooled
// client) kills the export mid-batch with "sql: database is closed". The
// dedicated client is built from the persisted connection config and closed
// when the export finishes, so export and pool lifecycles are fully decoupled
// (MySQL and TiDB share this path).
func (s *Service) MysqlExportTable(ctx context.Context, id string, spec MysqlExportSpec) (MysqlExportTableResult, error) {
	c, err := s.store.GetConnection(id)
	if err != nil {
		return MysqlExportTableResult{}, err
	}
	build := s.mysqlExportClientBuilder
	if build == nil {
		build = s.buildMysqlClient
	}
	m, err := build(c)
	if err != nil {
		return MysqlExportTableResult{}, err
	}
	defer m.Close()
	return m.ExportTable(ctx, spec)
}
