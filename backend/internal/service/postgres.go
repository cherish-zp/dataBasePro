package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"dataBasePro/backend/internal/model"
)

// postgresDialTimeout bounds the default database ping in Connect.
const postgresDialTimeout = 5 * time.Second

// postgresConnMaxLifetime bounds stale backend connections; PostgreSQL idle
// sessions can hold backend memory and connection-slot state for a long time.
const postgresConnMaxLifetime = 30 * time.Minute

// postgresSystemSchemas are always hidden; every remaining pg_ prefixed schema
// is hidden as well.
var postgresSystemSchemas = []string{"pg_catalog", "information_schema", "pg_toast"}

// pgRelationKinds maps PostgreSQL pg_class relkind codes to semantic kinds.
// Foreign tables are treated like ordinary tables for metadata purposes.
var pgRelationKinds = map[string]model.PostgresRelationKind{
	"r": model.PostgresRelationKindTable,
	"p": model.PostgresRelationKindTable,
	"f": model.PostgresRelationKindTable,
	"v": model.PostgresRelationKindView,
	"m": model.PostgresRelationKindMaterializedView,
}

// PostgresClient is the production PostgreSQL data source. It keeps one
// database/sql pool per database, created lazily; the configured database is
// the default used when a request does not name one.
type PostgresClient struct {
	cfg       model.PostgresConfig
	defaultDB string

	mu  sync.Mutex
	dbs map[string]*sql.DB
}

var _ PostgresDataSource = (*PostgresClient)(nil)

// NewPostgresClient validates the configuration and opens the default database
// handle lazily; a ping is deferred until Connect or the first operation.
func NewPostgresClient(cfg model.PostgresConfig) (*PostgresClient, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &PostgresClient{cfg: cfg, defaultDB: cfg.Database, dbs: map[string]*sql.DB{}}, nil
}

// buildPostgresDSN renders a URL-style libpq DSN. Values are URL-encoded, so
// special characters in credentials cannot alter DSN structure and the DSN is
// safe to log only after credentials are removed (we never log it).
func buildPostgresDSN(cfg model.PostgresConfig, database string) string {
	db := strings.TrimSpace(database)
	if db == "" {
		db = cfg.Database
	}
	host := cfg.Host
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(cfg.Username, cfg.Password),
		Host:   fmt.Sprintf("%s:%d", host, cfg.Port),
		Path:   "/" + db,
	}
	q := url.Values{}
	q.Set("sslmode", cfg.TLSMode)
	if cfg.SearchPath != "" {
		q.Set("search_path", cfg.SearchPath)
	}
	// libpq's connect_timeout is in whole seconds; a sub-second value rounds up.
	q.Set("connect_timeout", fmt.Sprint((cfg.ConnectTimeoutMs+999)/1000))
	u.RawQuery = q.Encode()
	return u.String()
}

// Connect verifies the configured default database.
func (c *PostgresClient) Connect(ctx context.Context) error {
	db, err := c.getDB(ctx, "")
	if err != nil {
		return err
	}
	pingCtx, cancel := context.WithTimeout(ctx, postgresDialTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		return fmt.Errorf("postgres ping: %w", err)
	}
	return nil
}

// Close closes every lazily created database pool.
func (c *PostgresClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var errs []error
	for database, db := range c.dbs {
		if err := db.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close %s: %w", database, err))
		}
	}
	c.dbs = map[string]*sql.DB{}
	return errors.Join(errs...)
}

// setConnectionSearchPath scopes the dedicated console connection and then
// restores it when the next Execute has no schema. set_config is parameterized;
// RESET restores the server/session default when the config has none.
func (c *PostgresClient) setConnectionSearchPath(ctx context.Context, conn *sql.Conn, schema string) error {
	const setSearchPath = "SELECT set_config('search_path', $1, false)"
	target := strings.TrimSpace(schema)
	if target == "" {
		target = strings.TrimSpace(c.cfg.SearchPath)
	}
	if target == "" {
		if _, err := conn.ExecContext(ctx, "RESET search_path"); err != nil {
			return fmt.Errorf("reset search_path: %w", err)
		}
		return nil
	}
	if _, err := conn.ExecContext(ctx, setSearchPath, target); err != nil {
		return fmt.Errorf("set search_path: %w", err)
	}
	return nil
}

// applyPostgresConnPoolSettings centralizes conservative pool limits.
func applyPostgresConnPoolSettings(db *sql.DB) {
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(postgresConnMaxLifetime)
}

func (c *PostgresClient) GetName() string { return c.defaultDB }
func (c *PostgresClient) GetType() string { return string(model.ConnectionTypePostgres) }

// getDB returns the database/sql pool for database (empty = configured default),
// creating and registering it on first use.
func (c *PostgresClient) getDB(_ context.Context, database string) (*sql.DB, error) {
	name := strings.TrimSpace(database)
	if name == "" {
		name = c.defaultDB
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if db, ok := c.dbs[name]; ok {
		return db, nil
	}
	db, err := sql.Open("pgx", buildPostgresDSN(c.cfg, name))
	if err != nil {
		return nil, fmt.Errorf("postgres open %s: %w", name, err)
	}
	applyPostgresConnPoolSettings(db)
	c.dbs[name] = db
	return db, nil
}

// Databases lists connectable, non-template databases in server order.
func (c *PostgresClient) Databases(ctx context.Context) ([]string, error) {
	db, err := c.getDB(ctx, "")
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx,
		"SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname")
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan database name: %w", err)
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// Schemas lists user schemas in the selected database, ordered by name.
func (c *PostgresClient) Schemas(ctx context.Context, database string) ([]string, error) {
	db, err := c.getDB(ctx, database)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx,
		`SELECT schema_name FROM information_schema.schemata
		 WHERE schema_name <> ALL($1::text[]) AND schema_name NOT LIKE 'pg\_%'
		 ORDER BY schema_name`, pqStringArray(postgresSystemSchemas))
	if err != nil {
		return nil, fmt.Errorf("list schemas: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan schema name: %w", err)
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// Tables lists ordinary tables, partitioned/foreign tables, views and
// materialized views, together with primary-key columns.
func (c *PostgresClient) Tables(ctx context.Context, database, schema string) ([]model.PostgresTableInfo, error) {
	schemaName := strings.TrimSpace(schema)
	if schemaName == "" {
		return nil, errors.New("schema 不能为空")
	}
	db, err := c.getDB(ctx, database)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
SELECT c.relname, c.relkind::text, COALESCE(pk.primary_key::text, '[]'), COALESCE(obj_description(c.oid, 'pg_class'), '')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN LATERAL (
    SELECT json_agg(a.attname ORDER BY k.ord) AS primary_key
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indrelid = c.oid AND i.indisprimary
) pk ON true
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
ORDER BY c.relname`, schemaName)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	defer rows.Close()
	out := []model.PostgresTableInfo{}
	for rows.Next() {
		var name, relType, primaryKey, comment string
		if err := rows.Scan(&name, &relType, &primaryKey, &comment); err != nil {
			return nil, fmt.Errorf("scan table: %w", err)
		}
		kind := pgRelationKinds[relType]
		if !kind.Valid() {
			kind = model.PostgresRelationKindTable
		}
		out = append(out, newPostgresTableInfo(schemaName, name, relType, decodePostgresStringArray(primaryKey), comment))
	}
	return out, rows.Err()
}

// newPostgresTableInfo normalizes a pg_class row to the frontend contract:
// relation_type/relation_kind are semantic; only raw_relation_type retains
// PostgreSQL's own code.
func newPostgresTableInfo(schema, name, relType string, primaryKeys []string, comment string) model.PostgresTableInfo {
	kind := pgRelationKinds[relType]
	if !kind.Valid() {
		kind = model.PostgresRelationKindTable
	}
	return model.PostgresTableInfo{
		Relation:        name,
		Schema:          schema,
		RelationType:    string(kind),
		RelationKind:    kind,
		RawRelationType: relType,
		PrimaryKey:      primaryKeys,
		Comment:         comment,
	}
}

// validatePostgresEditableKind keeps the cell editor restricted to ordinary
// tables before any database connection is established.
func validatePostgresEditableKind(kind model.PostgresRelationKind) error {
	if !kind.Valid() {
		return fmt.Errorf("不支持的 relation_kind %q", kind)
	}
	if !kind.CanTruncate() {
		return fmt.Errorf("%s 不可编辑", kind)
	}
	return nil
}

// PageRows returns a `SELECT *` page, exact total rows and table metadata.
func (c *PostgresClient) PageRows(ctx context.Context, database, schema, relation, relationKind, where, orderBy string, asc bool, limit, offset int) (model.PostgresPageRowsResult, error) {
	var res model.PostgresPageRowsResult
	names, err := postgresRelationNames(database, schema, relation)
	if err != nil {
		return res, err
	}
	if err := validatePostgresPageRange(limit, offset); err != nil {
		return res, err
	}
	if relationKind != "" && !model.PostgresRelationKind(relationKind).Valid() {
		return res, fmt.Errorf("不支持的 relation_kind %q", relationKind)
	}
	db, err := c.getDB(ctx, names.database)
	if err != nil {
		return res, err
	}
	pk, err := postgresPrimaryKey(ctx, db, names.schema, names.relation)
	if err != nil {
		return res, err
	}
	res.PrimaryKey = pk
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM "+postgresQualifiedName(names.schema, names.relation),
	).Scan(&res.TotalRows); err != nil {
		return res, fmt.Errorf("count rows: %w", err)
	}
	// where is a native SQL fragment supplied by the SQL console/grid filter.
	// It has the same trust boundary as the SQL console: identifiers and order
	// columns are quoted here, but arbitrary predicates are intentionally not
	// parsed or sanitized.
	pageSQL := buildPostgresPageRowsSQL(names.database, names.schema, names.relation, where, orderBy, asc, limit, offset)
	rows, err := db.QueryContext(ctx, pageSQL)
	if err != nil {
		return res, fmt.Errorf("page rows: %w", err)
	}
	defer rows.Close()
	cols, dataRows, err := collectPostgresRows(rows)
	if err != nil {
		return res, err
	}
	res.Columns = markPostgresPrimaryKeys(cols, pk)
	res.Rows = dataRows
	if res.Columns == nil {
		res.Columns = []model.PostgresColumn{}
	}
	if res.Rows == nil {
		res.Rows = [][]*string{}
	}
	if res.PrimaryKey == nil {
		res.PrimaryKey = []string{}
	}
	return res, nil
}

// Execute splits and runs each statement on one connection. A non-empty schema
// first sets search_path so unqualified statements are scoped as expected.
func (c *PostgresClient) Execute(ctx context.Context, database, schema, sqlText string) ([]model.PostgresStatementResult, error) {
	statements := SplitPostgresStatements(sqlText)
	if len(statements) == 0 {
		return nil, errors.New("没有可执行的 SQL 语句")
	}
	db, err := c.getDB(ctx, database)
	if err != nil {
		return nil, err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Close()
	if err := c.setConnectionSearchPath(ctx, conn, schema); err != nil {
		return nil, err
	}
	out := make([]model.PostgresStatementResult, 0, len(statements))
	for _, statement := range statements {
		res := model.PostgresStatementResult{Statement: statement, HasRows: postgresStatementReturnsRows(statement)}
		start := time.Now()
		if res.HasRows {
			rows, err := conn.QueryContext(ctx, statement)
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				out = append(out, res)
				return out, nil
			}
			cols, dataRows, err := collectPostgresRows(rows)
			closeErr := rows.Close()
			if err != nil || closeErr != nil {
				res.DurationMs = msSince(start)
				if err != nil {
					res.Error = err.Error()
				} else {
					res.Error = closeErr.Error()
				}
				out = append(out, res)
				return out, nil
			}
			res.Columns = cols
			res.Rows = dataRows
			if table, ok := postgresSingleTableSelect(statement, schema); ok {
				if pk, pkErr := postgresPrimaryKey(ctx, conn, table.schema, table.relation); pkErr == nil {
					res.PrimaryKey = pk
				}
				res.Columns = markPostgresPrimaryKeys(cols, res.PrimaryKey)
			}
		} else {
			result, err := conn.ExecContext(ctx, statement)
			if err != nil {
				res.DurationMs = msSince(start)
				res.Error = err.Error()
				out = append(out, res)
				return out, nil
			}
			if affected, err := result.RowsAffected(); err == nil {
				res.AffectedRows = affected
			}
		}
		res.DurationMs = msSince(start)
		out = append(out, res)
	}
	return out, nil
}

// TruncateTable empties an ordinary table; views and materialized views are
// rejected before touching the database.
func (c *PostgresClient) TruncateTable(ctx context.Context, database, schema, relation, relationKind string) error {
	names, err := postgresRelationNames(database, schema, relation)
	if err != nil {
		return err
	}
	kind := model.PostgresRelationKind(strings.TrimSpace(relationKind))
	if !kind.Valid() {
		return fmt.Errorf("不支持的 relation_kind %q", relationKind)
	}
	if !kind.CanTruncate() {
		return fmt.Errorf("%s 不可 TRUNCATE", kind)
	}
	db, err := c.getDB(ctx, names.database)
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "TRUNCATE TABLE "+postgresQualifiedName(names.schema, names.relation)); err != nil {
		return fmt.Errorf("truncate table: %w", err)
	}
	return nil
}

// PreviewCellUpdate builds and counts a parameterized UPDATE without running it.
func (c *PostgresClient) PreviewCellUpdate(ctx context.Context, req model.PostgresCellUpdateRequest) (model.PostgresCellUpdatePreview, error) {
	var preview model.PostgresCellUpdatePreview
	if err := validatePostgresEditableKind(req.RelationKind); err != nil {
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
	statement, _, err := buildPostgresCellUpdateStatement(names.database, names.schema, names.relation, req.Set, req.Where, pk)
	if err != nil {
		return preview, err
	}
	countSQL, countArgs, err := buildPostgresCellCountStatement(names.database, names.schema, names.relation, req.Where, pk)
	if err != nil {
		return preview, err
	}
	var matched int64
	if err := db.QueryRowContext(ctx, countSQL, countArgs...).Scan(&matched); err != nil {
		return preview, fmt.Errorf("count matched rows: %w", err)
	}
	preview.Statement = statement
	preview.MatchedRows = matched
	return preview, nil
}

// UpdateCell executes the parameterized UPDATE. Only primary-key columns may
// appear in WHERE.
func (c *PostgresClient) UpdateCell(ctx context.Context, req model.PostgresCellUpdateRequest) error {
	if err := validatePostgresEditableKind(req.RelationKind); err != nil {
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
	statement, args, err := buildPostgresCellUpdateStatement(names.database, names.schema, names.relation, req.Set, req.Where, pk)
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, statement, args...); err != nil {
		return fmt.Errorf("update cell: %w", err)
	}
	return nil
}

type postgresQualified struct {
	database, schema, relation string
}

func postgresRelationNames(database, schema, relation string) (postgresQualified, error) {
	names := postgresQualified{
		database: strings.TrimSpace(database),
		schema:   strings.TrimSpace(schema),
		relation: strings.TrimSpace(relation),
	}
	if names.relation == "" {
		return names, errors.New("relation 不能为空")
	}
	if names.schema == "" {
		return names, errors.New("schema 不能为空")
	}
	return names, nil
}

func validatePostgresPageRange(limit, offset int) error {
	if limit <= 0 {
		return errors.New("limit 必须大于 0")
	}
	if offset < 0 {
		return errors.New("offset 不能为负数")
	}
	return nil
}

func postgresQuoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// postgresQualifiedName intentionally uses exactly two parts. PostgreSQL has
// no database.schema.relation naming; database selects the connection pool and
// the schema selects the namespace on that connection.
func postgresQualifiedName(schema, relation string) string {
	return postgresQuoteIdent(schema) + "." + postgresQuoteIdent(relation)
}

func buildPostgresPageRowsSQL(database, schema, relation, where, orderBy string, asc bool, limit, offset int) string {
	buf := strings.Builder{}
	buf.WriteString("SELECT * FROM ")
	buf.WriteString(postgresQualifiedName(schema, relation))
	if w := strings.TrimSpace(where); w != "" {
		buf.WriteString(" WHERE ")
		buf.WriteString(w)
	}
	if o := strings.TrimSpace(orderBy); o != "" {
		buf.WriteString(" ORDER BY ")
		buf.WriteString(postgresQuoteIdent(o))
		if asc {
			buf.WriteString(" ASC")
		} else {
			buf.WriteString(" DESC")
		}
	}
	fmt.Fprintf(&buf, " LIMIT %d OFFSET %d", limit, offset)
	return buf.String()
}

type postgresParameterizedStatement struct {
	SQL  string
	Args []any
}

func buildPostgresCellUpdateStatement(database, schema, relation string, set model.PostgresCellValue, where []model.PostgresCellValue, primaryKeys []string) (string, []any, error) {
	stmt, err := buildPostgresParameterizedUpdate(database, schema, relation, set, where, primaryKeys)
	return stmt.SQL, stmt.Args, err
}

func buildPostgresParameterizedUpdate(database, schema, relation string, set model.PostgresCellValue, where []model.PostgresCellValue, primaryKeys []string) (postgresParameterizedStatement, error) {
	var stmt postgresParameterizedStatement
	setColumn := strings.TrimSpace(set.Column)
	if setColumn == "" {
		return stmt, errors.New("set.column 不能为空")
	}
	if len(where) == 0 {
		return stmt, errors.New("主键 WHERE 条件不能为空")
	}
	pkSet := make(map[string]bool, len(primaryKeys))
	for _, key := range primaryKeys {
		pkSet[key] = true
	}
	args := []any{set.Value}
	buf := strings.Builder{}
	buf.WriteString("UPDATE ")
	buf.WriteString(postgresQualifiedName(schema, relation))
	buf.WriteString(" SET ")
	buf.WriteString(postgresQuoteIdent(setColumn))
	buf.WriteString(" = $1 WHERE ")
	for i, condition := range where {
		column := strings.TrimSpace(condition.Column)
		if !pkSet[column] {
			return stmt, fmt.Errorf("WHERE 列 %q 不是主键列", column)
		}
		if i > 0 {
			buf.WriteString(" AND ")
		}
		buf.WriteString(postgresQuoteIdent(column))
		fmt.Fprintf(&buf, " = $%d", len(args)+1)
		args = append(args, condition.Value)
	}
	stmt.SQL, stmt.Args = buf.String(), args
	return stmt, nil
}

func buildPostgresCellCountStatement(database, schema, relation string, where []model.PostgresCellValue, primaryKeys []string) (string, []any, error) {
	if len(where) == 0 {
		return "", nil, errors.New("主键 WHERE 条件不能为空")
	}
	pkSet := make(map[string]bool, len(primaryKeys))
	for _, key := range primaryKeys {
		pkSet[key] = true
	}
	args := make([]any, 0, len(where))
	buf := strings.Builder{}
	buf.WriteString("SELECT COUNT(*) FROM ")
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
		buf.WriteString(" = $")
		buf.WriteString(fmt.Sprint(i + 1))
		args = append(args, condition.Value)
	}
	return buf.String(), args, nil
}

// postgresPrimaryKey reads the primary-key columns as a JSON array.
func postgresPrimaryKey(ctx context.Context, q postgresQueryer, schema, relation string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
SELECT COALESCE((SELECT json_agg(a.attname ORDER BY k.ord)::text
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary), '[]')`, schema, relation)
	if err != nil {
		return nil, fmt.Errorf("read primary key: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return []string{}, nil
	}
	var raw string
	if err := rows.Scan(&raw); err != nil {
		return nil, fmt.Errorf("scan primary key: %w", err)
	}
	pk := decodePostgresStringArray(raw)
	if pk == nil {
		pk = []string{}
	}
	return pk, nil
}

// pqStringArray serializes a Go string slice to a PostgreSQL text[] literal.
// The values are simple internal constants, never user input.
func pqStringArray(values []string) string {
	return "{" + strings.Join(values, ",") + "}"
}

func decodePostgresStringArray(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

type postgresQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func collectPostgresRows(rows *sql.Rows) ([]model.PostgresColumn, [][]*string, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, nil, fmt.Errorf("column types: %w", err)
	}
	cols := make([]model.PostgresColumn, len(types))
	for i, typ := range types {
		cols[i] = model.PostgresColumn{Name: typ.Name(), Type: typ.DatabaseTypeName()}
	}
	values := make([]any, len(types))
	pointers := make([]any, len(types))
	out := [][]*string{}
	for rows.Next() {
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, nil, fmt.Errorf("scan row: %w", err)
		}
		row := make([]*string, len(values))
		for i, value := range values {
			row[i] = FormatCHCell(value, CHCellMaxBytes)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return cols, out, nil
}

func markPostgresPrimaryKeys(cols []model.PostgresColumn, pk []string) []model.PostgresColumn {
	if len(cols) == 0 {
		return cols
	}
	pkSet := make(map[string]bool, len(pk))
	for _, name := range pk {
		pkSet[name] = true
	}
	for i := range cols {
		cols[i].IsInPrimaryKey = pkSet[cols[i].Name]
	}
	return cols
}

// postgresStatementReturnsRows treats SELECT/WITH/TABLE/VALUES as result sets.
// DML RETURNING is intentionally executed as a statement; the console UI needs
// a stable result-set/non-query distinction.
func postgresStatementReturnsRows(statement string) bool {
	switch firstSQLKeyword(statement) {
	case "SELECT", "WITH", "TABLE", "VALUES", "EXPLAIN", "SHOW":
		return true
	default:
		return false
	}
}

func firstSQLKeyword(statement string) string {
	trimmed := strings.TrimSpace(statement)
	for _, prefix := range []string{"(", "--", "/*"} {
		trimmed = strings.TrimPrefix(trimmed, prefix)
	}
	trimmed = strings.TrimSpace(trimmed)
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(regexp.MustCompile(`[^A-Za-z]+`).ReplaceAllString(fields[0], ""))
}

var postgresQualifiedPattern = regexp.MustCompile(
	`(?is)^(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))(?:\.(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))){1,2}$`)

func postgresSingleTableSelect(statement, defaultSchema string) (postgresQualified, bool) {
	trimmed := strings.TrimSpace(statement)
	trimmed = strings.TrimSuffix(trimmed, ";")
	if !strings.HasPrefix(strings.ToUpper(trimmed), "SELECT ") {
		return postgresQualified{}, false
	}
	match := postgresSelectTablePattern.FindStringSubmatch(trimmed)
	if match == nil {
		return postgresQualified{}, false
	}
	parts := decodePostgresQualified(match[1])
	if len(parts) == 0 || len(parts) > 3 {
		return postgresQualified{}, false
	}
	out := postgresQualified{}
	switch len(parts) {
	case 1:
		out.schema, out.relation = defaultSchema, parts[0]
	case 2:
		out.schema, out.relation = parts[0], parts[1]
	case 3:
		out.database, out.schema, out.relation = parts[0], parts[1], parts[2]
	}
	return out, true
}

var postgresSelectTablePattern = regexp.MustCompile(
	`(?is)^select\s+.*\bfrom\s+("((?:[^"]|"")+)"(?:\."(?:[^"]|"")+")*|[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*){0,2})(\s+where\b.*|\s+order\s+by\b.*|\s+limit\b.*|\s+offset\b.*)?$`)

func decodePostgresQualified(qualified string) []string {
	match := postgresQualifiedPattern.FindStringSubmatch(qualified)
	if match == nil {
		// Unquoted dot-delimited identifiers are the common case.
		return strings.Split(qualified, ".")
	}
	var parts []string
	for _, group := range [][]string{{match[1], match[2]}, {match[3], match[4]}} {
		if group[0] != "" {
			parts = append(parts, strings.ReplaceAll(group[0], `""`, `"`))
		} else if group[1] != "" {
			parts = append(parts, group[1])
		}
	}
	return parts
}
