// Hive 表级 DDL 与导出:连接树右键的截断 / 删除表 / 编辑表字段 / 导出。
// 截断仅内部表(MANAGED_TABLE,外部表/视图拒绝);删表 DROP TABLE;编辑
// 表字段按 Hive 方言:ADD COLUMNS 追加表尾(无 AFTER)、CHANGE COLUMN 改
// 类型/注释、DROP COLUMN(Hive 3)失败自动降级 REPLACE COLUMNS 重建;导出
// 仅表结构(SHOW CREATE TABLE 原文,Hive 普通表不支持 INSERT VALUES)。
// 危险操作由 app 层落审计;列类型经递归校验白名单,堵死借类型字段往单条
// ALTER 里拼任意子句的注入面。
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"sheng-shou-yun-he/backend/internal/model"
)

// HiveColumnDef 描述一条 ADD/MODIFY 的列定义,后端据此拼 ALTER。
type HiveColumnDef struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Comment string `json:"comment"`
}

// HiveAlterTableSpec 是一次结构变更的三组操作,按 ADD → CHANGE → DROP 执行
// (Hive 无 AFTER:新增列只能追加表尾;DROP 列在 Hive 3 直接 DROP COLUMN,
// 失败自动降级 REPLACE COLUMNS 重建)。
type HiveAlterTableSpec struct {
	Database      string          `json:"database"`
	Table         string          `json:"table"`
	AddColumns    []HiveColumnDef `json:"add_columns"`
	ModifyColumns []HiveColumnDef `json:"modify_columns"`
	DropColumns   []string        `json:"drop_columns"`
}

// HiveExportTableResult 返回建议文件名与 .sql 正文(仅表结构)。
type HiveExportTableResult struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

// --- 截断 / 删除表 ---

// TruncateTable empties the table. 仅内部表(MANAGED_TABLE)允许:外部表
// (数据在 HDFS 外部路径)与视图既不可 TRUNCATE 也不该被误清。
func (c *HiveClient) TruncateTable(ctx context.Context, database, table string) error {
	db := c.resolveDatabase(database)
	if strings.TrimSpace(table) == "" {
		return errors.New("表名不能为空")
	}
	meta, err := c.describeFormatted(ctx, db, table)
	if err != nil {
		return err
	}
	if meta.TableType != model.HiveTableTypeManaged {
		return fmt.Errorf("仅内部表(MANAGED_TABLE)支持清空,表 %s.%s 的类型为 %q", db, table, meta.TableType)
	}
	if err := c.conn.Exec(ctx, "TRUNCATE TABLE "+quoteHiveIdent(db)+"."+quoteHiveIdent(table)); err != nil {
		return fmt.Errorf("truncate: %w", err)
	}
	return nil
}

// DropTable drops the table (structure and data).
func (c *HiveClient) DropTable(ctx context.Context, database, table string) error {
	if strings.TrimSpace(table) == "" {
		return errors.New("表名不能为空")
	}
	if err := c.conn.Exec(ctx, "DROP TABLE "+quoteHiveIdent(c.resolveDatabase(database))+"."+quoteHiveIdent(table)); err != nil {
		return fmt.Errorf("drop table: %w", err)
	}
	return nil
}

// --- 编辑表字段(ALTER TABLE) ---

// validateHiveAlterSpec 拒绝空变更与缺失列名/类型的条目。
func validateHiveAlterSpec(spec HiveAlterTableSpec) error {
	if strings.TrimSpace(spec.Table) == "" {
		return errors.New("表名不能为空")
	}
	if len(spec.AddColumns) == 0 && len(spec.ModifyColumns) == 0 && len(spec.DropColumns) == 0 {
		return errors.New("没有需要执行的结构变更")
	}
	for _, def := range append(append([]HiveColumnDef{}, spec.AddColumns...), spec.ModifyColumns...) {
		if strings.TrimSpace(def.Name) == "" {
			return errors.New("列名不能为空")
		}
		if strings.TrimSpace(def.Type) == "" {
			return fmt.Errorf("列 %q 的类型不能为空", def.Name)
		}
		if err := validateHiveColumnType(def.Type); err != nil {
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

// buildHiveAddColumnDefinition renders `name type [COMMENT 'x']`(Hive 无
// AFTER:ADD COLUMNS 只能追加表尾)。
func buildHiveAddColumnDefinition(def HiveColumnDef) string {
	var b strings.Builder
	b.WriteString(quoteHiveIdent(def.Name))
	b.WriteString(" ")
	b.WriteString(strings.TrimSpace(def.Type))
	if strings.TrimSpace(def.Comment) != "" {
		b.WriteString(" COMMENT " + quoteHiveString(def.Comment))
	}
	return b.String()
}

// buildHiveChangeColumnDefinition renders `old new type COMMENT 'x'`:
// Hive CHANGE COLUMN 不重申的注释会被清空,因此 COMMENT 恒输出(空注释 =
// 显式清空,与前端契约一致)。
func buildHiveChangeColumnDefinition(def HiveColumnDef) string {
	return quoteHiveIdent(def.Name) + " " + quoteHiveIdent(def.Name) + " " +
		strings.TrimSpace(def.Type) + " COMMENT " + quoteHiveString(def.Comment)
}

// AlterTable executes the ADD → CHANGE → DROP statements one by one;第一
// 条失败即中止并透出其错误。DROP COLUMN(Hive 3)失败时按整列重建语义自动
// 降级 REPLACE COLUMNS(剔除待删列后以其余列定义重建非分区 schema)。
func (c *HiveClient) AlterTable(ctx context.Context, spec HiveAlterTableSpec) error {
	if err := validateHiveAlterSpec(spec); err != nil {
		return err
	}
	db := c.resolveDatabase(spec.Database)
	head := "ALTER TABLE " + quoteHiveIdent(db) + "." + quoteHiveIdent(spec.Table)
	for _, def := range spec.AddColumns {
		stmt := head + " ADD COLUMNS (" + buildHiveAddColumnDefinition(def) + ")"
		if err := c.conn.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("alter table: %w", err)
		}
	}
	for _, def := range spec.ModifyColumns {
		stmt := head + " CHANGE COLUMN " + buildHiveChangeColumnDefinition(def)
		if err := c.conn.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("alter table: %w", err)
		}
	}
	for _, name := range spec.DropColumns {
		if err := c.dropHiveColumn(ctx, db, spec.Table, name); err != nil {
			return err
		}
	}
	return nil
}

// dropHiveColumn tries the Hive 3 `DROP COLUMN` first and falls back to
// `REPLACE COLUMNS` 重建(剔除待删列;至少保留一列)。
func (c *HiveClient) dropHiveColumn(ctx context.Context, database, table, name string) error {
	head := "ALTER TABLE " + quoteHiveIdent(database) + "." + quoteHiveIdent(table)
	dropStmt := head + " DROP COLUMN " + quoteHiveIdent(name)
	if err := c.conn.Exec(ctx, dropStmt); err == nil {
		return nil
	}
	// 降级 REPLACE COLUMNS:以当前元数据(剔除待删列的非分区列)重建。
	meta, err := c.describeFormatted(ctx, database, table)
	if err != nil {
		return fmt.Errorf("alter table: drop column 降级 REPLACE COLUMNS 读取元数据失败: %w", err)
	}
	var remaining []HiveColumnDef
	for _, col := range meta.Columns {
		if strings.EqualFold(col.Name, name) {
			continue
		}
		remaining = append(remaining, HiveColumnDef{Name: col.Name, Type: col.Type, Comment: col.Comment})
	}
	if len(remaining) == 0 {
		return fmt.Errorf("alter table: 不能删除唯一列")
	}
	parts := make([]string, len(remaining))
	for i, def := range remaining {
		parts[i] = buildHiveAddColumnDefinition(def)
	}
	replaceStmt := head + " REPLACE COLUMNS (" + strings.Join(parts, ", ") + ")"
	if err := c.conn.Exec(ctx, replaceStmt); err != nil {
		return fmt.Errorf("alter table: drop column 与 REPLACE COLUMNS 降级均失败: %w", err)
	}
	return nil
}

// --- 列类型白名单(递归下降校验) ---

// hiveTypeValidator 解析校验一个 Hive 列类型:基名 + 可选括号参数(仅数字/
// 逗号/空格)或尖括号泛型(递归;元素可为 name:type 或纯类型,顶层逗号分隔)。
// 拒绝引号/反引号/分号/反斜杠/注释等一切可借道注入的字符;类型文本恒整段
// 通过校验后才允许拼进 DDL。
type hiveTypeValidator struct {
	src string
	pos int
}

// validateHiveColumnType 校验用户提交的列类型全文(尾随空白容忍)。
func validateHiveColumnType(s string) error {
	v := &hiveTypeValidator{src: s}
	if err := v.parseType(); err != nil {
		return fmt.Errorf("列类型不合法: %q", s)
	}
	v.skipSpaces()
	if v.pos != len(v.src) {
		return fmt.Errorf("列类型不合法: %q", s)
	}
	return nil
}

func (v *hiveTypeValidator) skipSpaces() {
	for v.pos < len(v.src) && (v.src[v.pos] == ' ' || v.src[v.pos] == '\t') {
		v.pos++
	}
}

func (v *hiveTypeValidator) peek() byte {
	if v.pos < len(v.src) {
		return v.src[v.pos]
	}
	return 0
}

// parseType parses: name [suffix-words] [('params' | '<generics>') suffix-words]*.
func (v *hiveTypeValidator) parseType() error {
	v.skipSpaces()
	start := v.pos
	for v.pos < len(v.src) {
		c := v.src[v.pos]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' {
			v.pos++
			continue
		}
		break
	}
	if v.pos == start {
		return errors.New("类型名缺失")
	}
	// 参数/泛型后缀:可重复出现(如 decimal(10,2)、array<map<string,int>>)。
	for {
		switch v.peek() {
		case '(':
			if err := v.parseParenParams(); err != nil {
				return err
			}
		case '<':
			if err := v.parseGenerics(); err != nil {
				return err
			}
		default:
			// 允许的多词后缀(timestamp with local time zone / double precision),
			// 词表之外的尾随内容一律拒绝。
			return v.parseSuffixWords()
		}
		v.skipSpaces()
	}
}

// parseParenParams consumes (...) with digits/comma/space content only
// (decimal(10,2)/varchar(20)/char(5) 形态)。
func (v *hiveTypeValidator) parseParenParams() error {
	if v.peek() != '(' {
		return errors.New("期望 (")
	}
	v.pos++
	depth := 1
	for v.pos < len(v.src) {
		c := v.src[v.pos]
		switch c {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				v.pos++
				return nil
			}
		case '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',', ' ', '\t':
		default:
			return errors.New("括号参数含非法字符")
		}
		v.pos++
	}
	return errors.New("括号未闭合")
}

// parseGenerics consumes <...>:顶层逗号分隔的元素,元素为 name:type 或纯
// 类型(递归;支持任意嵌套)。
func (v *hiveTypeValidator) parseGenerics() error {
	if v.peek() != '<' {
		return errors.New("期望 <")
	}
	v.pos++
	for {
		v.skipSpaces()
		// 元素前缀名(struct<a:int> 的 a;uniontype 无名元素直接是类型)。
		mark := v.pos
		for v.pos < len(v.src) && (isHiveTypeWord(v.src[v.pos])) {
			v.pos++
		}
		v.skipSpaces()
		if v.peek() == ':' {
			v.pos++ // 命名元素,冒号后是类型主体
		} else if v.pos == mark {
			return errors.New("泛型元素为空")
		} else {
			v.pos = mark // 无冒号:该词本身是类型基名
		}
		if err := v.parseType(); err != nil {
			return err
		}
		v.skipSpaces()
		switch v.peek() {
		case ',':
			v.pos++
		case '>':
			v.pos++
			return nil
		default:
			return errors.New("泛型未闭合或含非法分隔符")
		}
	}
}

// parseSuffixWords 允许类型基名后的多词修饰(timestamp with local time zone
// 等):词表固定,其余尾随内容报错。
func (v *hiveTypeValidator) parseSuffixWords() error {
	allowed := map[string]bool{"with": true, "local": true, "time": true, "zone": true, "precision": true}
	for {
		save := v.pos
		v.skipSpaces()
		start := v.pos
		for v.pos < len(v.src) && isHiveTypeWord(v.src[v.pos]) {
			v.pos++
		}
		if v.pos == start {
			v.pos = save
			return nil
		}
		if !allowed[strings.ToLower(v.src[start:v.pos])] {
			v.pos = save
			return nil
		}
	}
}

func isHiveTypeWord(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

// --- 导出表结构 ---

// ExportTable renders the table's DDL via SHOW CREATE TABLE(Hive 普通表
// 不支持 INSERT VALUES,数据导出不提供)。
func (c *HiveClient) ExportTable(ctx context.Context, database, table string) (HiveExportTableResult, error) {
	var res HiveExportTableResult
	db := c.resolveDatabase(database)
	if strings.TrimSpace(table) == "" {
		return res, errors.New("表名不能为空")
	}
	ddl, err := c.showCreateTable(ctx, db, table)
	if err != nil {
		return res, err
	}
	res.Filename = "hive-" + table + "-" + time.Now().Format("20060102-150405") + ".sql"
	res.Content = ddl + "\n"
	return res, nil
}

// --- Service 层委托 ---

// HiveTruncateTable empties an internal table (dangerous, audited by the
// caller).
func (s *Service) HiveTruncateTable(ctx context.Context, id, database, table string) error {
	h, err := s.hive(ctx, id)
	if err != nil {
		return err
	}
	return h.TruncateTable(ctx, database, table)
}

// HiveDropTable drops the table (dangerous, audited by the caller).
func (s *Service) HiveDropTable(ctx context.Context, id, database, table string) error {
	h, err := s.hive(ctx, id)
	if err != nil {
		return err
	}
	return h.DropTable(ctx, database, table)
}

// HiveAlterTable applies the structure changes (dangerous, audited by the
// caller).
func (s *Service) HiveAlterTable(ctx context.Context, id string, spec HiveAlterTableSpec) error {
	h, err := s.hive(ctx, id)
	if err != nil {
		return err
	}
	return h.AlterTable(ctx, spec)
}

// HiveExportTable renders the table's .sql DDL script (audited like truncate).
func (s *Service) HiveExportTable(ctx context.Context, id, database, table string) (HiveExportTableResult, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return HiveExportTableResult{}, err
	}
	return h.ExportTable(ctx, database, table)
}
