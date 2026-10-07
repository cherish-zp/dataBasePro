// Hive(HiveServer2)数据源:经 beltran/gohive 的原生 Thrift 客户端连接(该库
// 未提供 database/sql driver,故以薄接口 HiveConn/HiveRows 收敛 gohive 交互,
// 离线测试注入 fake)。浏览用 SHOW DATABASES / SHOW TABLES;元数据用
// DESCRIBE FORMATTED(列/分区列/transactional/表类型)+ SHOW CREATE TABLE
// (DDL 与主键约束);分页用 ROW_NUMBER() OVER() 窗口包装(Hive 不支持
// OFFSET)+ COUNT(*) 计数;单元格编辑/按行删除仅 transactional(ACID)表,
// WHERE 定位主键优先、整行原值兜底,字面量按类型分派(转义全在后端)。
package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/beltran/gohive"

	"sheng-shou-yun-he/backend/internal/model"
)

// hiveDialTimeout bounds the initial connect of a new client (gohive 的
// Connect 不接收 context,超时由 ConnectConfiguration 控制)。
const hiveDialTimeout = 10 * time.Second

// hivePageRowNumberCol 是分页包装里的行号列名(带 _dbp 前缀,避免与用户列
// 名冲突);包装语句的结果集中该列固定在末尾,返回前剥离。
const hivePageRowNumberCol = "_dbp_rn"

// --- 薄接口:gohive 交互收敛到这两个接口,fake 可注入 ---

// HiveRows is one result set: pre-resolved columns and a row iterator
// (cells nil = NULL;长度恒等于 Columns())。
type HiveRows interface {
	Columns() []model.HiveColumn
	// Next fetches the next row; ok=false means exhausted. FetchOne 取行时
	// gohive 依赖 HasMore 触发拉取,ctx 贯穿轮询循环。
	Next(ctx context.Context) (cells []*string, ok bool, err error)
	Close()
}

// HiveConn abstracts the gohive connection surface used by HiveClient
// (exported so offline fakes can be injected from other packages).
type HiveConn interface {
	Exec(ctx context.Context, query string) error
	Query(ctx context.Context, query string) (HiveRows, error)
	Close() error
}

// --- gohive 生产适配器 ---

// gohiveConn wraps a *gohive.Connection:每条语句使用独立 Cursor,用毕关闭。
type gohiveConn struct{ c *gohive.Connection }

func (g *gohiveConn) Exec(ctx context.Context, query string) error {
	cur := g.c.Cursor()
	defer cur.Close()
	cur.Exec(ctx, query)
	return cur.Err
}

func (g *gohiveConn) Query(ctx context.Context, query string) (HiveRows, error) {
	cur := g.c.Cursor()
	cur.Exec(ctx, query)
	if cur.Err != nil {
		cur.Close()
		return nil, cur.Err
	}
	// 元数据在执行后立即可用(失败直接判语句失败,避免 Columns() 无错误通道)。
	desc := cur.Description()
	if cur.Err != nil {
		cur.Close()
		return nil, cur.Err
	}
	cols := make([]model.HiveColumn, len(desc))
	types := make([]string, len(desc))
	for i, d := range desc {
		cols[i] = model.HiveColumn{Name: d[0], Type: hiveThriftToHiveType(d[1])}
		types[i] = d[1]
	}
	return &gohiveRows{cur: cur, cols: cols, thriftTypes: types}, nil
}

func (g *gohiveConn) Close() error { return g.c.Close() }

// gohiveRows iterates one gohive cursor with typed destinations(CELL NULL
// 语义依赖二级指针:nil 指针 = NULL)。
type gohiveRows struct {
	cur         *gohive.Cursor
	cols        []model.HiveColumn
	thriftTypes []string
}

func (r *gohiveRows) Columns() []model.HiveColumn { return r.cols }

func (r *gohiveRows) Next(ctx context.Context) ([]*string, bool, error) {
	if !r.cur.HasMore(ctx) {
		if r.cur.Err != nil {
			return nil, false, r.cur.Err
		}
		return nil, false, nil
	}
	dests := make([]any, len(r.thriftTypes))
	for i, t := range r.thriftTypes {
		dests[i] = newHiveDest(t)
	}
	r.cur.FetchOne(ctx, dests...)
	if r.cur.Err != nil {
		return nil, false, r.cur.Err
	}
	return hiveDestsToCells(dests), true, nil
}

func (r *gohiveRows) Close() { r.cur.Close() }

// newHiveDest builds the FetchOne destination matching the thrift primitive
// type;二级指针保证 NULL 与零值可区分。复合类型(DECIMAL/ARRAY/MAP/STRUCT/
// UNION/TIMESTAMP/DATE 等)服务端按字符串下发 → **string。
func newHiveDest(thriftType string) any {
	switch thriftType {
	case "BOOLEAN_TYPE":
		return new(*bool)
	case "TINYINT_TYPE":
		return new(*int8)
	case "SMALLINT_TYPE":
		return new(*int16)
	case "INT_TYPE":
		return new(*int32)
	case "BIGINT_TYPE":
		return new(*int64)
	case "FLOAT_TYPE", "DOUBLE_TYPE":
		return new(*float64)
	case "BINARY_TYPE":
		return new(*[]byte)
	default:
		return new(*string)
	}
}

// hiveDestsToCells converts fetched destinations into wire cells (nil =
// NULL);超长文本按 CH 同款上限截断。
func hiveDestsToCells(dests []any) []*string {
	cells := make([]*string, len(dests))
	for i, d := range dests {
		cells[i] = hiveDestToCell(d)
	}
	return cells
}

func hiveDestToCell(d any) *string {
	var s string
	switch x := d.(type) {
	case **bool:
		if *x == nil {
			return nil
		}
		s = strconv.FormatBool(**x)
	case **int8:
		if *x == nil {
			return nil
		}
		s = strconv.FormatInt(int64(**x), 10)
	case **int16:
		if *x == nil {
			return nil
		}
		s = strconv.FormatInt(int64(**x), 10)
	case **int32:
		if *x == nil {
			return nil
		}
		s = strconv.FormatInt(int64(**x), 10)
	case **int64:
		if *x == nil {
			return nil
		}
		s = strconv.FormatInt(**x, 10)
	case **float64:
		if *x == nil {
			return nil
		}
		s = strconv.FormatFloat(**x, 'f', -1, 64)
	case **[]byte:
		if *x == nil {
			return nil
		}
		s = string(**x)
	case **string:
		if *x == nil {
			return nil
		}
		s = **x
	default:
		return nil
	}
	if len(s) > CHCellMaxBytes {
		s = s[:CHCellMaxBytes] + CHCellTruncatedSuffix
	}
	return &s
}

// hiveThriftToHiveType maps a thrift primitive type (INT_TYPE) to the Hive
// display type ("int");未知类型保底小写去后缀。
func hiveThriftToHiveType(t string) string {
	if strings.HasSuffix(t, "_TYPE") {
		return strings.ToLower(strings.TrimSuffix(t, "_TYPE"))
	}
	return strings.ToLower(t)
}

// --- 连接建立 ---

// NewHiveClient builds a Hive client and verifies reachability(拨号即打开
// HS2 会话;Connect 再跑一次 SELECT 1 探活)。
func NewHiveClient(cfg model.HiveConfig) (*HiveClient, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	gc, err := dialHive(cfg)
	if err != nil {
		return nil, err
	}
	return &HiveClient{conn: &gohiveConn{c: gc}, defaultDB: cfg.Database}, nil
}

// NewHiveClientWithConn builds a client around an injected HiveConn(离线
// 测试专用:生产路径一律走 NewHiveClient)。
func NewHiveClientWithConn(conn HiveConn, defaultDB string) *HiveClient {
	return &HiveClient{conn: conn, defaultDB: defaultDB}
}

// dialHive opens the native gohive connection, mapping the stored auth mode
// onto gohive's auth strings (nosasl→NOSASL, ldap→LDAP, kerberos→KERBEROS;
// kerberos 先用 keytab kinit 预置票据,service 名取 principal 首段)。
func dialHive(cfg model.HiveConfig) (*gohive.Connection, error) {
	conf := gohive.NewConnectConfiguration()
	conf.ConnectTimeout = hiveDialTimeout
	conf.Database = cfg.Database // 空库时 gohive 自行回落 default
	var auth string
	switch cfg.AuthMode {
	case model.HiveAuthNoSASL:
		auth = "NOSASL"
	case model.HiveAuthLDAP:
		auth = "LDAP"
		conf.Username = cfg.Username
		conf.Password = cfg.Password // gohive 对空密码自行置 "x"
	case model.HiveAuthKerberos:
		auth = "KERBEROS"
		if err := hiveKinit(cfg.Kerberos); err != nil {
			return nil, err
		}
		conf.Service = cfg.Kerberos.ServiceComponent()
	default:
		return nil, fmt.Errorf("不支持的认证方式 %q", cfg.AuthMode)
	}
	conn, err := gohive.Connect(cfg.Host, cfg.Port, auth, conf)
	if err != nil {
		return nil, fmt.Errorf("hive connect: %w", err)
	}
	return conn, nil
}

// hiveKinit presets the OS credentials cache from the keytab: gohive 的
// GSSAPI 传输依赖 kinit 过的凭据缓存,不能直接消费 keytab。krb5_conf 经
// KRB5_CONFIG 注入 kinit 子进程(可选)。
func hiveKinit(k *model.HiveKerberosConfig) error {
	if k == nil {
		return errors.New("kerberos 认证必须提供 kerberos 配置")
	}
	bin, err := exec.LookPath("kinit")
	if err != nil {
		return fmt.Errorf("kerberos 认证需要 kinit(请先安装 krb5-workstation / krb5-user): %w", err)
	}
	cmd := exec.Command(bin, "-kt", k.Keytab, k.Principal)
	env := append([]string{}, os.Environ()...)
	if k.Krb5Conf != "" {
		env = append(env, "KRB5_CONFIG="+k.Krb5Conf)
	}
	cmd.Env = env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("kinit %s: %w: %s", k.Principal, err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// --- 客户端 ---

// HiveClient is the HiveDataSource production implementation over one
// HiveServer2 session(单会话连接,非池化;每条语句独立 Cursor)。
type HiveClient struct {
	conn HiveConn
	// defaultDB 是连接配置的默认库:请求未显式指定库名时兜底使用。
	defaultDB string
}

// compile-time proof that HiveClient implements the Hive data source.
var _ HiveDataSource = (*HiveClient)(nil)

// GetName returns the client name.
func (c *HiveClient) GetName() string { return "hive" }

// GetType returns the connection type.
func (c *HiveClient) GetType() string { return string(model.ConnectionTypeHive) }

// Connect probes the server with SELECT 1.
func (c *HiveClient) Connect(ctx context.Context) error {
	rows, err := c.conn.Query(ctx, "SELECT 1")
	if err != nil {
		return fmt.Errorf("hive ping: %w", err)
	}
	defer rows.Close()
	if _, ok, err := rows.Next(ctx); err != nil {
		return fmt.Errorf("hive ping: %w", err)
	} else if !ok {
		return errors.New("hive ping: 无返回行")
	}
	return nil
}

// Close releases the underlying session.
func (c *HiveClient) Close() error { return c.conn.Close() }

// resolveDatabase 兜底空库名:请求未指定库时依次回落配置默认库与 default。
func (c *HiveClient) resolveDatabase(database string) string {
	if d := strings.TrimSpace(database); d != "" {
		return d
	}
	if d := strings.TrimSpace(c.defaultDB); d != "" {
		return d
	}
	return "default"
}

// quoteHiveIdent backtick-quotes an identifier, escaping embedded backticks.
func quoteHiveIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// quoteHiveString single-quotes a string literal, doubling embedded quotes
// (Hive 同时接受 \' 转义,双写形态更通用)。
func quoteHiveString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// Databases lists the databases via SHOW DATABASES.
func (c *HiveClient) Databases(ctx context.Context) ([]string, error) {
	rows, err := c.conn.Query(ctx, "SHOW DATABASES")
	if err != nil {
		return nil, fmt.Errorf("show databases: %w", err)
	}
	defer rows.Close()
	out, err := collectHiveFirstColumn(ctx, rows)
	if err != nil {
		return nil, fmt.Errorf("show databases: %w", err)
	}
	return out, nil
}

// Tables lists a database's tables via SHOW TABLES IN db.
func (c *HiveClient) Tables(ctx context.Context, database string) ([]model.HiveTableInfo, error) {
	q := "SHOW TABLES IN " + quoteHiveIdent(c.resolveDatabase(database))
	rows, err := c.conn.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("show tables: %w", err)
	}
	defer rows.Close()
	names, err := collectHiveFirstColumn(ctx, rows)
	if err != nil {
		return nil, fmt.Errorf("show tables: %w", err)
	}
	out := make([]model.HiveTableInfo, 0, len(names))
	for _, n := range names {
		out = append(out, model.HiveTableInfo{Name: n})
	}
	return out, nil
}

// collectHiveFirstColumn drains a single-column result into strings.
func collectHiveFirstColumn(ctx context.Context, rows HiveRows) ([]string, error) {
	var out []string
	for {
		cells, ok, err := rows.Next(ctx)
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
		if len(cells) == 0 || cells[0] == nil {
			continue
		}
		out = append(out, *cells[0])
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// --- DESCRIBE FORMATTED 解析 ---

// hiveDescribeMeta 是 DESCRIBE FORMATTED 的解析产物。
type hiveDescribeMeta struct {
	Columns          []model.HiveColumn
	PartitionColumns []model.HiveColumn
	TableType        string
	Transactional    bool
}

// parseHiveDescribeFormatted parses the three-column DESCRIBE FORMATTED text
// rows into column/section structure:
//   - 普通列 = "# Partition Information" 之前所有 data_type 非空的行;
//   - 分区列 = "# Partition Information" 之后(跳过其表头)data_type 非空的行;
//   - 首个其它 "#" 小节(如 # Detailed Table Information)之后的行是元数据,
//     其中 "Table Type:" → 表类型;"# Table Parameters:" 小节内的
//     transactional=true → ACID 标记。
func parseHiveDescribeFormatted(rows [][]string) hiveDescribeMeta {
	var meta hiveDescribeMeta
	// section: 0=普通列,1=分区表头待开始,2=分区列,3=元数据区(终止)。
	section := 0
	inTableParams := false
	for _, r := range rows {
		name := ""
		typ := ""
		comment := ""
		if len(r) > 0 {
			name = strings.TrimSpace(r[0])
		}
		if len(r) > 1 {
			typ = strings.TrimSpace(r[1])
		}
		if len(r) > 2 {
			comment = strings.TrimSpace(r[2])
		}
		if strings.HasPrefix(name, "#") {
			low := strings.ToLower(name)
			switch {
			case strings.Contains(low, "partition information"):
				section = 1
				inTableParams = false
			case strings.Contains(low, "table parameters"):
				inTableParams = true
				section = 3
			case strings.Contains(low, "col_name"):
				// 当前小节的列头,忽略。
			default:
				section = 3
				inTableParams = false
			}
			continue
		}
		if name == "" && typ == "" {
			continue
		}
		switch {
		case section == 0 && typ != "":
			meta.Columns = append(meta.Columns, model.HiveColumn{Name: name, Type: typ, Comment: comment})
		case section == 1 && typ != "":
			section = 2
			meta.PartitionColumns = append(meta.PartitionColumns, model.HiveColumn{Name: name, Type: typ, Comment: comment})
		case section == 2 && typ != "":
			meta.PartitionColumns = append(meta.PartitionColumns, model.HiveColumn{Name: name, Type: typ, Comment: comment})
		}
		if section == 3 {
			if strings.EqualFold(name, "table type:") {
				meta.TableType = strings.ToUpper(typ)
			}
			if inTableParams && strings.EqualFold(name, "transactional") && strings.EqualFold(typ, "true") {
				meta.Transactional = true
			}
		}
	}
	return meta
}

// hivePrimaryKeyRe extracts the column list of the PRIMARY KEY constraint
// from SHOW CREATE TABLE text(Hive 3:`CONSTRAINT \`pk_t\` PRIMARY KEY (\`id\`)`)。
var hivePrimaryKeyRe = regexp.MustCompile(`(?is)constraint\s+(?:` + "`[^`]*`" + `|\S+)\s+primary\s+key\s*\(([^)]*)\)`)

// parseHivePrimaryKey extracts the primary key column names from the DDL
// (backtick/quote stripped);无约束返回 nil。
func parseHivePrimaryKey(ddl string) []string {
	m := hivePrimaryKeyRe.FindStringSubmatch(ddl)
	if m == nil {
		return nil
	}
	var pk []string
	for _, part := range strings.Split(m[1], ",") {
		name := strings.TrimSpace(part)
		name = strings.Trim(name, "`\"' ")
		if name == "" {
			continue
		}
		pk = append(pk, name)
	}
	return pk
}

// describeFormatted runs DESCRIBE FORMATTED and parses its rows.
func (c *HiveClient) describeFormatted(ctx context.Context, database, table string) (hiveDescribeMeta, error) {
	var meta hiveDescribeMeta
	rows, err := c.conn.Query(ctx, "DESCRIBE FORMATTED "+quoteHiveIdent(database)+"."+quoteHiveIdent(table))
	if err != nil {
		return meta, fmt.Errorf("describe formatted: %w", err)
	}
	raw, err := collectHiveRawRows(ctx, rows, 3)
	rows.Close()
	if err != nil {
		return meta, fmt.Errorf("describe formatted: %w", err)
	}
	return parseHiveDescribeFormatted(raw), nil
}

// collectHiveRawRows drains up to width columns of every row into plain
// strings(NULL → "")。
func collectHiveRawRows(ctx context.Context, rows HiveRows, width int) ([][]string, error) {
	var out [][]string
	for {
		cells, ok, err := rows.Next(ctx)
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
		row := make([]string, width)
		for i := 0; i < width && i < len(cells); i++ {
			if cells[i] != nil {
				row[i] = *cells[i]
			}
		}
		out = append(out, row)
	}
	return out, nil
}

// showCreateTable fetches the SHOW CREATE TABLE text (single row/column).
func (c *HiveClient) showCreateTable(ctx context.Context, database, table string) (string, error) {
	rows, err := c.conn.Query(ctx, "SHOW CREATE TABLE "+quoteHiveIdent(database)+"."+quoteHiveIdent(table))
	if err != nil {
		return "", fmt.Errorf("show create table: %w", err)
	}
	defer rows.Close()
	cells, ok, err := rows.Next(ctx)
	if err != nil {
		return "", fmt.Errorf("show create table: %w", err)
	}
	if !ok || len(cells) == 0 || cells[0] == nil {
		return "", fmt.Errorf("show create table: 表 %s.%s 无返回", database, table)
	}
	return *cells[0], nil
}

// TableColumns returns the table's metadata bundle(普通列/分区列/
// transactional/主键/DDL/表类型)。
func (c *HiveClient) TableColumns(ctx context.Context, database, table string) (model.HiveTableColumnsResult, error) {
	var res model.HiveTableColumnsResult
	db := c.resolveDatabase(database)
	meta, err := c.describeFormatted(ctx, db, table)
	if err != nil {
		return res, err
	}
	ddl, err := c.showCreateTable(ctx, db, table)
	if err != nil {
		return res, err
	}
	res.Columns = meta.Columns
	res.PartitionColumns = meta.PartitionColumns
	res.Transactional = meta.Transactional
	res.TableType = meta.TableType
	res.DDL = ddl
	res.PrimaryKey = parseHivePrimaryKey(ddl)
	if res.Columns == nil {
		res.Columns = []model.HiveColumn{}
	}
	if res.PartitionColumns == nil {
		res.PartitionColumns = []model.HiveColumn{}
	}
	if res.PrimaryKey == nil {
		res.PrimaryKey = []string{}
	}
	return res, nil
}

// --- 分页(ROW_NUMBER 窗口包装 + COUNT) ---

// buildHivePageQuery renders the paged table scan: Hive 无 OFFSET,行号列由
// ROW_NUMBER() OVER() 生成(无 ORDER BY 合法,顺序不作保证),外层按窗口
// 过滤。offset/limit 为整数拼接(无注入面)。
func buildHivePageQuery(database, table string, columns []string, limit, offset int) string {
	quoted := make([]string, len(columns))
	for i, c := range columns {
		quoted[i] = quoteHiveIdent(c)
	}
	colList := strings.Join(quoted, ", ")
	inner := "SELECT " + colList + ", ROW_NUMBER() OVER () AS " + quoteHiveIdent(hivePageRowNumberCol) +
		" FROM " + quoteHiveIdent(database) + "." + quoteHiveIdent(table)
	return "SELECT " + colList + " FROM (" + inner + ") " + quoteHiveIdent("_dbp") +
		" WHERE " + quoteHiveIdent(hivePageRowNumberCol) + " > " + strconv.Itoa(offset) +
		" AND " + quoteHiveIdent(hivePageRowNumberCol) + " <= " + strconv.Itoa(offset+limit)
}

// PageRows returns one page of `SELECT *` over the table with pre-formatted
// string cells (nil = NULL), plus the exact total row count (COUNT(*)).
// 列与类型来自 DESCRIBE(精确 hive 类型,含分区列——SELECT * 的尾部)。
func (c *HiveClient) PageRows(ctx context.Context, database, table string, limit, offset int) (model.HivePageRowsResult, error) {
	var res model.HivePageRowsResult
	db := c.resolveDatabase(database)
	if limit < 1 {
		return res, errors.New("limit 必须为正整数")
	}
	if offset < 0 {
		offset = 0
	}
	meta, err := c.describeFormatted(ctx, db, table)
	if err != nil {
		return res, err
	}
	cols := append(append([]model.HiveColumn{}, meta.Columns...), meta.PartitionColumns...)
	if len(cols) == 0 {
		return res, fmt.Errorf("表 %s.%s 无可用列", db, table)
	}
	names := make([]string, len(cols))
	for i, col := range cols {
		names[i] = col.Name
	}
	rows, err := c.conn.Query(ctx, buildHivePageQuery(db, table, names, limit, offset))
	if err != nil {
		return res, fmt.Errorf("page rows: %w", err)
	}
	data, err := collectHivePageData(ctx, rows, cols)
	rows.Close()
	if err != nil {
		return res, fmt.Errorf("page rows: %w", err)
	}
	res.Columns = cols
	res.Rows = data
	var total int64
	if err := c.countTableInto(ctx, db, table, &total); err != nil {
		return res, fmt.Errorf("count rows: %w", err)
	}
	res.TotalRows = total
	return res, nil
}

// collectHivePageData drains the paged query,覆盖 driver 推断的列类型为
// DESCRIBE 元数据的精确类型(按名匹配,找不到保持 driver 推断)。
func collectHivePageData(ctx context.Context, rows HiveRows, metaCols []model.HiveColumn) ([][]*string, error) {
	typeByName := make(map[string]string, len(metaCols))
	for _, col := range metaCols {
		typeByName[strings.ToLower(col.Name)] = col.Type
	}
	cols := rows.Columns()
	if cols != nil {
		for i := range cols {
			if t, ok := typeByName[strings.ToLower(cols[i].Name)]; ok {
				cols[i].Type = t
			}
		}
	}
	var out [][]*string
	for {
		cells, ok, err := rows.Next(ctx)
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
		out = append(out, cells)
	}
	if out == nil {
		out = [][]*string{}
	}
	return out, nil
}

// countTableInto runs SELECT COUNT(*) over the table.
func (c *HiveClient) countTableInto(ctx context.Context, database, table string, dest *int64) error {
	rows, err := c.conn.Query(ctx, "SELECT COUNT(*) FROM "+quoteHiveIdent(database)+"."+quoteHiveIdent(table))
	if err != nil {
		return err
	}
	defer rows.Close()
	cells, ok, err := rows.Next(ctx)
	if err != nil {
		return err
	}
	if !ok || len(cells) == 0 || cells[0] == nil {
		return errors.New("COUNT(*) 无返回")
	}
	v, err := strconv.ParseInt(*cells[0], 10, 64)
	if err != nil {
		return fmt.Errorf("解析 COUNT(*) 结果 %q: %w", *cells[0], err)
	}
	*dest = v
	return nil
}

// --- SQL 控制台(逐语句;limit>0 服务端分页,对齐 mysql 语义) ---

// hiveStatementReturnsRows reports whether the statement's first keyword
// produces a result set (SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/WITH)。
func hiveStatementReturnsRows(stmt string) bool {
	first := stmt
	if i := strings.IndexAny(stmt, " \t\n\r("); i >= 0 {
		first = stmt[:i]
	}
	switch strings.ToUpper(first) {
	case "SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "WITH":
		return true
	}
	return false
}

// wrapHivePagedQuery renders the paged form of a wrappable statement:原文
// (尾分号剥离)作为派生表 _q,外层 ROW_NUMBER 行号列按窗口过滤;顶层
// ORDER BY 外提到包装外(派生表不保证保留子查询内的 ORDER BY)。返回语句
// 与「结果集末列行号列」标记——该列由 _dbp_rn 命名,调用方在收行后剥离。
func wrapHivePagedQuery(stmt string, limit, offset int) string {
	body := stripTrailingSemicolon(stmt)
	tail := ""
	if head, order, ok := splitTrailingTopLevelOrderBy(body); ok {
		body, tail = head, " "+order
	}
	return "SELECT * FROM (SELECT _q.*, ROW_NUMBER() OVER () AS " + quoteHiveIdent(hivePageRowNumberCol) +
		" FROM (" + body + ") " + quoteHiveIdent("_q") + ") " + quoteHiveIdent("_dbp") +
		" WHERE " + quoteHiveIdent(hivePageRowNumberCol) + " > " + strconv.Itoa(offset) +
		" AND " + quoteHiveIdent(hivePageRowNumberCol) + " <= " + strconv.Itoa(offset+limit) + tail
}

// stripHiveRowNumber removes the trailing row-number column from the paged
// result(按列名识别,防御性:不存在则原样返回)。
func stripHiveRowNumber(cols []model.HiveColumn, rows [][]*string) ([]model.HiveColumn, [][]*string) {
	if len(cols) == 0 || cols[len(cols)-1].Name != hivePageRowNumberCol {
		return cols, rows
	}
	cols = cols[:len(cols)-1]
	trimmed := make([][]*string, len(rows))
	for i, row := range rows {
		if len(row) == len(cols)+1 {
			row = row[:len(cols)]
		}
		trimmed[i] = row
	}
	return cols, trimmed
}

// countHiveWrapped runs `SELECT COUNT(*) FROM (<stmt>) _dbp_cnt` and returns
// the exact total;失败返回 nil(total_rows 不下发而非猜数)。
func (c *HiveClient) countHiveWrapped(ctx context.Context, stmt string) *int64 {
	rows, err := c.conn.Query(ctx,
		"SELECT COUNT(*) FROM ("+stripTrailingSemicolon(stmt)+") "+quoteHiveIdent("_dbp_cnt"))
	if err != nil {
		return nil
	}
	defer rows.Close()
	cells, ok, err := rows.Next(ctx)
	if err != nil || !ok || len(cells) == 0 || cells[0] == nil {
		return nil
	}
	v, err := strconv.ParseInt(*cells[0], 10, 64)
	if err != nil {
		return nil
	}
	return &v
}

// collectHiveRowsN drains a result set into wire columns and string cells,
// 至多消费 max 行(max<=0 不限制;SHOW 类语句的截断回退用)。
func collectHiveRowsN(ctx context.Context, rows HiveRows, max int) ([]model.HiveColumn, [][]*string, error) {
	cols := rows.Columns()
	var out [][]*string
	for {
		if max > 0 && len(out) >= max {
			break
		}
		cells, ok, err := rows.Next(ctx)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			break
		}
		out = append(out, cells)
	}
	if cols == nil {
		cols = []model.HiveColumn{}
	}
	return cols, out, nil
}

// Execute runs the script statement by statement. database 非空时先 USE 该库
// (单会话连接,后续语句固定其上);Each result carries its duration, and
// either columns+rows (statements that return a result set) or an error text.
// A failing statement records its error and stops the run; the results
// gathered so far are returned. limit>0 启用服务端分页:SELECT/WITH 语句被
// ROW_NUMBER 窗口包装为仅返回 offset 起的 limit 行并附 COUNT 总数;SHOW/
// DESC/EXPLAIN 等不能包装的返回行语句只消费 offset+limit 行(取满 limit 行
// total_rows=-1,否则 offset+实际行数)。
func (c *HiveClient) Execute(ctx context.Context, database, sqlText string, limit, offset int) ([]model.HiveStatementResult, error) {
	if limit < 0 {
		limit = 0
	}
	if offset < 0 {
		offset = 0
	}
	statements := SplitSQLStatements(sqlText)
	if len(statements) == 0 {
		return nil, errors.New("没有可执行的 SQL 语句")
	}
	if db := strings.TrimSpace(database); db != "" {
		if err := c.conn.Exec(ctx, "USE "+quoteHiveIdent(db)); err != nil {
			return nil, fmt.Errorf("use database: %w", err)
		}
	}
	out := make([]model.HiveStatementResult, 0, len(statements))
	for _, stmt := range statements {
		res := model.HiveStatementResult{SQL: stmt}
		start := time.Now()
		if hiveStatementReturnsRows(stmt) {
			// 分页决策:可包装语句改写为 ROW_NUMBER 窗口子查询;SHOW/DESC/
			// EXPLAIN 等按原始语句执行但只消费 offset+limit 行。res.SQL 始终
			// 保持用户原文。
			query, collectMax, wrapped := stmt, 0, false
			if limit > 0 {
				if sqlStatementWrappable(stmt) {
					query = wrapHivePagedQuery(stmt, limit, offset)
					wrapped = true
				} else {
					collectMax = offset + limit
				}
			}
			rows, err := c.conn.Query(ctx, query)
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
			cols, dataRows, err := collectHiveRowsN(ctx, rows, collectMax)
			rows.Close()
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
			if limit > 0 {
				if wrapped {
					cols, dataRows = stripHiveRowNumber(cols, dataRows)
					// 计数失败不影响语句结果:total_rows 保持不下发(nil)。
					res.TotalRows = c.countHiveWrapped(ctx, stmt)
				} else {
					page, full := slicePageRows(dataRows, limit, offset)
					dataRows = page
					res.TotalRows = fallbackTotalRows(full, offset, len(page))
				}
			}
			if dataRows == nil {
				dataRows = [][]*string{}
			}
			res.Columns, res.Rows = cols, dataRows
		} else {
			if err := c.conn.Exec(ctx, stmt); err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				return append(out, res), nil
			}
		}
		res.DurationMs = msSince(start)
		out = append(out, res)
	}
	return out, nil
}

// --- 单元格更新 / 按行删除(仅 transactional(ACID)表) ---

// hiveTableEditMeta 是行级编辑的定位前提:ACID 标记、主键约束列与全列。
type hiveTableEditMeta struct {
	Transactional bool
	PrimaryKey    []string
	AllColumns    []string
	PartitionCols map[string]bool
}

// tableEditMeta gathers DESCRIBE FORMATTED + SHOW CREATE TABLE for the edit
// validations(主键来自 DDL 约束;全列 = 普通列 + 分区列)。
func (c *HiveClient) tableEditMeta(ctx context.Context, database, table string) (hiveTableEditMeta, error) {
	var meta hiveTableEditMeta
	desc, err := c.describeFormatted(ctx, database, table)
	if err != nil {
		return meta, err
	}
	ddl, err := c.showCreateTable(ctx, database, table)
	if err != nil {
		return meta, err
	}
	meta.Transactional = desc.Transactional
	meta.PrimaryKey = parseHivePrimaryKey(ddl)
	meta.PartitionCols = make(map[string]bool, len(desc.PartitionColumns))
	for _, col := range desc.PartitionColumns {
		meta.PartitionCols[strings.ToLower(col.Name)] = true
		meta.AllColumns = append(meta.AllColumns, col.Name)
	}
	for _, col := range desc.Columns {
		meta.AllColumns = append(meta.AllColumns, col.Name)
	}
	return meta, nil
}

// validateHiveEditWhere verifies the WHERE conditions locate rows in one of
// two modes: primary-key mode (every condition column is part of the primary
// key constraint, the precise default) or whole-row mode (the condition
// column set equals the table's full column set — 普通列 + 分区列 — order-
// insensitive, the fallback for constraint-less tables).其它混合/缺失列组合
// 一律拒绝,避免误伤面过大的 UPDATE/DELETE。
func validateHiveEditWhere(where []model.HiveCellRef, pk, allColumns []string) error {
	if len(where) == 0 {
		return errors.New("where 条件不能为空:已拒绝无定位的全表操作")
	}
	whereCols := make([]string, 0, len(where))
	whereSet := make(map[string]bool, len(where))
	for _, cond := range where {
		if strings.TrimSpace(cond.Column) == "" {
			return errors.New("where 条件列名不能为空")
		}
		whereCols = append(whereCols, cond.Column)
		whereSet[cond.Column] = true
	}
	if len(pk) > 0 {
		pkSet := make(map[string]bool, len(pk))
		for _, name := range pk {
			pkSet[name] = true
		}
		pkMode := true
		for _, name := range whereCols {
			if !pkSet[name] {
				pkMode = false
				break
			}
		}
		if pkMode {
			return nil
		}
	}
	if len(whereCols) == len(allColumns) && len(whereSet) == len(allColumns) {
		wholeRow := true
		for _, name := range allColumns {
			if !whereSet[name] {
				wholeRow = false
				break
			}
		}
		if wholeRow {
			return nil
		}
	}
	if len(pk) == 0 {
		return errors.New("表无主键约束,不支持编辑")
	}
	return errors.New("where 条件列必须是主键列或整行所有列,仅支持按主键或整行定位")
}

// requireHiveTransactional rejects row-level edits on non-ACID tables.
func requireHiveTransactional(meta hiveTableEditMeta) error {
	if !meta.Transactional {
		return errors.New("仅 transactional(ACID)表支持行级更新/删除,当前表未开启 ACID")
	}
	return nil
}

// isHiveNumericType reports whether the Hive type's literal is written
// unquoted (integer/float/decimal family;括号/泛型参数截断后按基名判定)。
func isHiveNumericType(typ string) bool {
	base := strings.ToLower(strings.TrimSpace(typ))
	if i := strings.IndexAny(base, "(< "); i >= 0 {
		base = base[:i]
	}
	switch base {
	case "tinyint", "smallint", "int", "integer", "bigint", "float", "double", "decimal", "numeric":
		return true
	}
	return false
}

// hiveCellLiteral renders (type, value) as a SQL literal:数值族按前缀分派
// 且必须可被解析为数值(否则报错,绝不拼进语句);boolean 仅接受 true/false;
// 其余类型按单引号字符串转义。nil 值 → NULL。
func hiveCellLiteral(typ string, value *string) (string, error) {
	if value == nil {
		return "NULL", nil
	}
	if isHiveNumericType(typ) {
		if !isCHNumericText(*value) {
			return "", fmt.Errorf("值 %q 不是合法的数值字面量(类型 %s)", *value, typ)
		}
		return *value, nil
	}
	if strings.EqualFold(strings.TrimSpace(typ), "boolean") {
		switch strings.ToLower(strings.TrimSpace(*value)) {
		case "true":
			return "TRUE", nil
		case "false":
			return "FALSE", nil
		default:
			return "", fmt.Errorf("值 %q 不是合法的 boolean 字面量", *value)
		}
	}
	return quoteHiveString(*value), nil
}

// buildHiveWhereClause renders the AND-joined conditions. 空条件直接报错:
// 拒绝无定位的全表操作。nil 值渲染为 IS NULL(= NULL 永假,无法命中)。
func buildHiveWhereClause(conds []model.HiveCellRef) (string, error) {
	if len(conds) == 0 {
		return "", errors.New("where 条件不能为空:已拒绝无定位的全表操作")
	}
	parts := make([]string, 0, len(conds))
	for _, cond := range conds {
		if strings.TrimSpace(cond.Column) == "" {
			return "", errors.New("where 条件列名不能为空")
		}
		if cond.Value == nil {
			parts = append(parts, quoteHiveIdent(cond.Column)+" IS NULL")
			continue
		}
		lit, err := hiveCellLiteral(cond.Type, cond.Value)
		if err != nil {
			return "", fmt.Errorf("where 条件列 %q: %w", cond.Column, err)
		}
		parts = append(parts, quoteHiveIdent(cond.Column)+" = "+lit)
	}
	return strings.Join(parts, " AND "), nil
}

// buildHiveUpdateStatement renders the full UPDATE. Hive 无参数化协议:转义
// 与字面量构造全部在后端完成(标识符反引号包裹,值按列类型分派)。
func buildHiveUpdateStatement(database, table string, set model.HiveCellRef, conds []model.HiveCellRef) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", errors.New("表名不能为空")
	}
	if strings.TrimSpace(set.Column) == "" {
		return "", errors.New("set 列名不能为空")
	}
	where, err := buildHiveWhereClause(conds)
	if err != nil {
		return "", err
	}
	lit, err := hiveCellLiteral(set.Type, set.Value)
	if err != nil {
		return "", fmt.Errorf("列 %q: %w", set.Column, err)
	}
	return "UPDATE " + quoteHiveIdent(database) + "." + quoteHiveIdent(table) +
		" SET " + quoteHiveIdent(set.Column) + " = " + lit +
		" WHERE " + where, nil
}

// buildHiveDeleteStatement renders the full DELETE(与单元格更新同源)。
func buildHiveDeleteStatement(database, table string, conds []model.HiveCellRef) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", errors.New("表名不能为空")
	}
	where, err := buildHiveWhereClause(conds)
	if err != nil {
		return "", err
	}
	return "DELETE FROM " + quoteHiveIdent(database) + "." + quoteHiveIdent(table) +
		" WHERE " + where, nil
}

// validateCellEdit enforces the full edit contract: ACID-only、set 列必须
// 存在且非分区列(分区列不可 UPDATE)、WHERE 定位合法。
func (c *HiveClient) validateCellEdit(ctx context.Context, database, table string, set *model.HiveCellRef, where []model.HiveCellRef) (hiveTableEditMeta, error) {
	var meta hiveTableEditMeta
	if strings.TrimSpace(table) == "" {
		return meta, errors.New("表名不能为空")
	}
	meta, err := c.tableEditMeta(ctx, database, table)
	if err != nil {
		return meta, err
	}
	if err := requireHiveTransactional(meta); err != nil {
		return meta, err
	}
	if set != nil {
		if strings.TrimSpace(set.Column) == "" {
			return meta, errors.New("set 列名不能为空")
		}
		found := false
		for _, name := range meta.AllColumns {
			if strings.EqualFold(name, set.Column) {
				found = true
				break
			}
		}
		if !found {
			return meta, fmt.Errorf("列 %q 不存在于表 %s.%s", set.Column, database, table)
		}
		if meta.PartitionCols[strings.ToLower(set.Column)] {
			return meta, fmt.Errorf("分区列 %q 不支持更新", set.Column)
		}
	}
	if err := validateHiveEditWhere(where, meta.PrimaryKey, meta.AllColumns); err != nil {
		return meta, err
	}
	return meta, nil
}

// countMatchedHiveRows counts the rows matched by the rendered WHERE clause
// (preview 命中行数与执行同源)。
func (c *HiveClient) countMatchedHiveRows(ctx context.Context, database, table, where string) (int64, error) {
	rows, err := c.conn.Query(ctx, "SELECT COUNT(*) FROM "+quoteHiveIdent(database)+"."+quoteHiveIdent(table)+
		" WHERE "+where)
	if err != nil {
		return 0, fmt.Errorf("count matched rows: %w", err)
	}
	defer rows.Close()
	cells, ok, err := rows.Next(ctx)
	if err != nil {
		return 0, fmt.Errorf("count matched rows: %w", err)
	}
	if !ok || len(cells) == 0 || cells[0] == nil {
		return 0, errors.New("count matched rows: 无返回")
	}
	v, err := strconv.ParseInt(*cells[0], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("count matched rows: 解析 %q: %w", *cells[0], err)
	}
	return v, nil
}

// PreviewCellUpdate renders the display text of the UPDATE and counts the
// rows matched by the same WHERE conditions (read-only, nothing executes).
func (c *HiveClient) PreviewCellUpdate(ctx context.Context, database, table string, set model.HiveCellRef, where []model.HiveCellRef) (model.HiveCellUpdatePreview, error) {
	var preview model.HiveCellUpdatePreview
	db := c.resolveDatabase(database)
	if _, err := c.validateCellEdit(ctx, db, table, &set, where); err != nil {
		return preview, err
	}
	stmt, err := buildHiveUpdateStatement(db, table, set, where)
	if err != nil {
		return preview, err
	}
	conds, err := buildHiveWhereClause(where)
	if err != nil {
		return preview, err // 语句构造已校验,防御性兜底
	}
	matched, err := c.countMatchedHiveRows(ctx, db, table, conds)
	if err != nil {
		return preview, err
	}
	return model.HiveCellUpdatePreview{Statement: stmt, MatchedRows: matched}, nil
}

// UpdateCell executes the cell UPDATE (ACID only). 执行路径重新走一遍语句
// 构造:转义与字面量校验不因预览而跳过。
func (c *HiveClient) UpdateCell(ctx context.Context, database, table string, set model.HiveCellRef, where []model.HiveCellRef) error {
	db := c.resolveDatabase(database)
	if _, err := c.validateCellEdit(ctx, db, table, &set, where); err != nil {
		return err
	}
	stmt, err := buildHiveUpdateStatement(db, table, set, where)
	if err != nil {
		return err
	}
	if err := c.conn.Exec(ctx, stmt); err != nil {
		return fmt.Errorf("update cell: %w", err)
	}
	return nil
}

// PreviewDeleteRow renders the exact DELETE statement and counts the rows
// matched by the same WHERE conditions (read-only, nothing executes).
func (c *HiveClient) PreviewDeleteRow(ctx context.Context, database, table string, where []model.HiveCellRef) (model.HiveDeleteRowPreview, error) {
	var preview model.HiveDeleteRowPreview
	db := c.resolveDatabase(database)
	if _, err := c.validateCellEdit(ctx, db, table, nil, where); err != nil {
		return preview, err
	}
	stmt, err := buildHiveDeleteStatement(db, table, where)
	if err != nil {
		return preview, err
	}
	conds, err := buildHiveWhereClause(where)
	if err != nil {
		return preview, err // 语句构造已校验,防御性兜底
	}
	matched, err := c.countMatchedHiveRows(ctx, db, table, conds)
	if err != nil {
		return preview, err
	}
	return model.HiveDeleteRowPreview{Statement: stmt, MatchedRows: matched}, nil
}

// DeleteRow executes the row DELETE (ACID only).
func (c *HiveClient) DeleteRow(ctx context.Context, database, table string, where []model.HiveCellRef) error {
	db := c.resolveDatabase(database)
	if _, err := c.validateCellEdit(ctx, db, table, nil, where); err != nil {
		return err
	}
	stmt, err := buildHiveDeleteStatement(db, table, where)
	if err != nil {
		return err
	}
	if err := c.conn.Exec(ctx, stmt); err != nil {
		return fmt.Errorf("delete row: %w", err)
	}
	return nil
}

// --- Service 层委托(危险操作的审计由 app 层落) ---

// HiveTestConnection verifies connectivity to the given config without
// persisting or pooling anything.
func (s *Service) HiveTestConnection(ctx context.Context, cfg model.HiveConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	client, err := NewHiveClient(cfg)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Connect(ctx)
}

// hive returns the pooled Hive client for the connection, auto-connecting
// when the tree has not connected it yet.
func (s *Service) hive(ctx context.Context, id string) (HiveDataSource, error) {
	if ds, err := s.pool.Get(id); err == nil {
		h, ok := ds.(HiveDataSource)
		if !ok {
			return nil, fmt.Errorf("connection %q is not a Hive source", id)
		}
		return h, nil
	}
	if err := s.ConnectConnection(ctx, id); err != nil {
		return nil, err
	}
	ds, err := s.pool.Get(id)
	if err != nil {
		return nil, err
	}
	h, ok := ds.(HiveDataSource)
	if !ok {
		return nil, fmt.Errorf("connection %q is not a Hive source", id)
	}
	return h, nil
}

// HiveDatabases lists the databases of the connection's HiveServer2.
func (s *Service) HiveDatabases(ctx context.Context, id string) ([]string, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return nil, err
	}
	return h.Databases(ctx)
}

// HiveTables lists a database's tables.
func (s *Service) HiveTables(ctx context.Context, id, database string) ([]model.HiveTableInfo, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return nil, err
	}
	return h.Tables(ctx, database)
}

// HiveTableColumns returns a table's metadata bundle.
func (s *Service) HiveTableColumns(ctx context.Context, id, database, table string) (model.HiveTableColumnsResult, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return model.HiveTableColumnsResult{}, err
	}
	return h.TableColumns(ctx, database, table)
}

// HivePageRows returns one page of a table's rows with metadata.
func (s *Service) HivePageRows(ctx context.Context, id, database, table string, limit, offset int) (model.HivePageRowsResult, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return model.HivePageRowsResult{}, err
	}
	return h.PageRows(ctx, database, table, limit, offset)
}

// HiveExecute runs a SQL script statement by statement. limit>0 启用服务端
// 分页(ROW_NUMBER 包装 + COUNT 计数,SHOW 类语句客户端截断)。
func (s *Service) HiveExecute(ctx context.Context, id, database, sqlText string, limit, offset int) ([]model.HiveStatementResult, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return nil, err
	}
	return h.Execute(ctx, database, sqlText, limit, offset)
}

// HivePreviewCellUpdate 预览单元格更新:构造展示语句 + 同 WHERE 命中行数
// (只读)。
func (s *Service) HivePreviewCellUpdate(ctx context.Context, id, database, table string, set model.HiveCellRef, where []model.HiveCellRef) (model.HiveCellUpdatePreview, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return model.HiveCellUpdatePreview{}, err
	}
	return h.PreviewCellUpdate(ctx, database, table, set, where)
}

// HiveUpdateCell 执行 ACID 单元格更新(危险操作,审计由 app 层落)。
func (s *Service) HiveUpdateCell(ctx context.Context, id, database, table string, set model.HiveCellRef, where []model.HiveCellRef) error {
	h, err := s.hive(ctx, id)
	if err != nil {
		return err
	}
	return h.UpdateCell(ctx, database, table, set, where)
}

// HivePreviewDeleteRow 预览按行删除:渲染 DELETE 语句全文 + 同条件命中行数
// (只读)。
func (s *Service) HivePreviewDeleteRow(ctx context.Context, id, database, table string, where []model.HiveCellRef) (model.HiveDeleteRowPreview, error) {
	h, err := s.hive(ctx, id)
	if err != nil {
		return model.HiveDeleteRowPreview{}, err
	}
	return h.PreviewDeleteRow(ctx, database, table, where)
}

// HiveDeleteRow 执行按条件定位的 DELETE(危险操作,审计由 app 层落)。
func (s *Service) HiveDeleteRow(ctx context.Context, id, database, table string, where []model.HiveCellRef) error {
	h, err := s.hive(ctx, id)
	if err != nil {
		return err
	}
	return h.DeleteRow(ctx, database, table, where)
}
