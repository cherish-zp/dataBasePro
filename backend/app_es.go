// Elasticsearch bindings exposed to the Wails frontend. Methods are thin: they
// delegate to the service layer; dangerous operations (SQL console / PutDoc /
// cell update / delete) are audited.
package backend

import (
	"strings"

	"dataBasePro/backend/internal/model"
)

// EsMappingRequest carries the mapping-listing parameters.
type EsMappingRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
}

// EsPageRowsRequest carries one page request over an index.
type EsPageRowsRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	// Where is the user's native query-string fragment (without the keyword);
	// empty matches all documents.
	Where   string `json:"where,omitempty"`
	OrderBy string `json:"order_by,omitempty"`
	Asc     bool   `json:"asc"`
	Limit   int    `json:"limit"`
	Offset  int    `json:"offset"`
}

// EsGetDocRequest addresses one document to read.
type EsGetDocRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	ID           string `json:"id"`
}

// EsPutDocRequest replaces one document (doc is the full _source JSON text).
type EsPutDocRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	ID           string `json:"id"`
	Doc          string `json:"doc"`
}

// EsCreateDocRequest creates one document: an empty id lets the server
// generate the _id (POST /{index}/_doc); a non-empty id indexes under that id
// (PUT /{index}/_doc/{id} — an existing document is overwritten). doc_json is
// the JSON object text sent verbatim as the request body.
type EsCreateDocRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	ID           string `json:"id"`
	DocJSON      string `json:"doc_json"`
}

// EsCellUpdateRequest patches one field of a document; a nil (null) value
// clears the field (writes JSON null).
type EsCellUpdateRequest struct {
	ConnectionID string  `json:"connection_id"`
	Index        string  `json:"index"`
	ID           string  `json:"id"`
	Column       string  `json:"column"`
	Value        *string `json:"value"`
}

// EsDeleteDocRequest addresses one document to remove.
type EsDeleteDocRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	ID           string `json:"id"`
}

// EsDeleteByQueryRequest deletes documents matching a DSL query (query is the
// JSON query object); the backend forwards {"query":...} and returns the
// removed count.
type EsDeleteByQueryRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	Query        string `json:"query"`
}

// EsExecuteRequest carries the multi-statement SQL script.
type EsExecuteRequest struct {
	ConnectionID string `json:"connection_id"`
	SQL          string `json:"sql"`
}

// EsDslRequest carries one raw DSL console request (Kibana Dev Tools style):
// method+path+body are forwarded to the cluster as-is; body may be empty and
// must be valid JSON when present. The path must start with "/" and may carry
// a query string.
type EsDslRequest struct {
	ConnectionID string `json:"connection_id"`
	Method       string `json:"method"`
	Path         string `json:"path"`
	Body         string `json:"body"`
}

// EsRefreshIndexRequest asks for one index to be refreshed.
type EsRefreshIndexRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
}

// EsGetTemplateRequest addresses one legacy index template to read.
type EsGetTemplateRequest struct {
	ConnectionID string `json:"connection_id"`
	Name         string `json:"name"`
}

// EsPutTemplateRequest creates or replaces one legacy index template
// (template_json is the full template definition text).
type EsPutTemplateRequest struct {
	ConnectionID string `json:"connection_id"`
	Name         string `json:"name"`
	TemplateJSON string `json:"template_json"`
}

// EsDeleteTemplateRequest addresses one legacy index template to remove.
type EsDeleteTemplateRequest struct {
	ConnectionID string `json:"connection_id"`
	Name         string `json:"name"`
}

// EsCreateIndexRequest creates one index with the given shard/replica counts.
type EsCreateIndexRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	Shards       int64  `json:"shards"`
	Replicas     int64  `json:"replicas"`
}

// EsDeleteIndexRequest addresses one index to remove.
type EsDeleteIndexRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
}

// EsUpdateIndexSettingsRequest applies settings to one index (settings_json is
// the JSON object text forwarded verbatim as the request body).
type EsUpdateIndexSettingsRequest struct {
	ConnectionID string `json:"connection_id"`
	Index        string `json:"index"`
	SettingsJSON string `json:"settings_json"`
}

// EsClusterStatsRequest addresses one connection's cluster monitoring
// aggregate.
type EsClusterStatsRequest struct {
	ConnectionID string `json:"connection_id"`
}

// TestESConnection verifies reachability without persisting anything.
func (a *App) TestESConnection(cfg model.EsConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsTestConnection(ctx, cfg)
}

// ListESIndices lists the user indices (system indices filtered server-side).
func (a *App) ListESIndices(connectionID string) ([]model.EsIndexInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsListIndices(ctx, connectionID)
}

// EsClusterStats returns the cluster monitoring aggregate in one call
// (read-only, not audited).
func (a *App) EsClusterStats(req EsClusterStatsRequest) (model.EsClusterStats, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsClusterStats(ctx, req.ConnectionID)
}

// ESMapping flattens an index's mapping into columns.
func (a *App) ESMapping(req EsMappingRequest) ([]model.EsColumn, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsMapping(ctx, req.ConnectionID, req.Index)
}

// ESPageRows returns one page of an index's documents with metadata.
func (a *App) ESPageRows(req EsPageRowsRequest) (model.EsPageRowsResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsPageRows(ctx, req.ConnectionID, req.Index, req.Where, req.OrderBy, req.Asc, req.Limit, req.Offset)
}

// ESGetDoc loads one document's _source JSON text.
func (a *App) ESGetDoc(req EsGetDocRequest) (model.EsDoc, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	source, err := a.svc.EsGetDoc(ctx, req.ConnectionID, req.Index, req.ID)
	if err != nil {
		return model.EsDoc{}, err
	}
	return model.EsDoc{ID: req.ID, Source: source}, nil
}

// ESPutDoc replaces one document (dangerous, audited).
func (a *App) ESPutDoc(req EsPutDocRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsPutDoc(ctx, req.ConnectionID, req.Index, req.ID, req.Doc)
	a.audit(req.ConnectionID, "es_put_doc", req.Index+"/"+req.ID, auditResult(err), auditDetail(err))
	return err
}

// EsCreateDoc creates one document (dangerous, audited): the audit target
// distinguishes the auto-id form (index) from the specified-id form
// (index/id). The returned doc carries the _id resolved from the response and
// the request doc_json verbatim as source.
func (a *App) EsCreateDoc(req EsCreateDocRequest) (model.EsDoc, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	doc, err := a.svc.EsCreateDoc(ctx, req.ConnectionID, req.Index, req.ID, req.DocJSON)
	target := req.Index
	if strings.TrimSpace(req.ID) != "" {
		target = req.Index + "/" + req.ID
	}
	a.audit(req.ConnectionID, "es_create_doc", target, auditResult(err), auditDetail(err))
	return doc, err
}

// ESUpdateCell patches one document field (dangerous, audited).
func (a *App) ESUpdateCell(req EsCellUpdateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsUpdateCell(ctx, req.ConnectionID, req.Index, req.ID, req.Column, req.Value)
	a.audit(req.ConnectionID, "es_update_cell", req.Index+"/"+req.ID, auditResult(err), auditDetail(err))
	return err
}

// ESDeleteDoc removes one document (dangerous, audited).
func (a *App) ESDeleteDoc(req EsDeleteDocRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsDeleteDoc(ctx, req.ConnectionID, req.Index, req.ID)
	a.audit(req.ConnectionID, "es_delete_doc", req.Index+"/"+req.ID, auditResult(err), auditDetail(err))
	return err
}

// ESDeleteByQuery deletes documents matching the DSL query (dangerous,
// audited; returns the removed count).
func (a *App) ESDeleteByQuery(req EsDeleteByQueryRequest) (int64, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	deleted, err := a.svc.EsDeleteByQuery(ctx, req.ConnectionID, req.Index, req.Query)
	a.audit(req.ConnectionID, "es_delete_by_query", req.Index, auditResult(err), auditDetail(err))
	return deleted, err
}

// ESExecute runs a SQL script statement by statement (dangerous, audited; the
// audit target is the script's first 60 characters).
func (a *App) ESExecute(req EsExecuteRequest) ([]model.EsStatementResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	results, err := a.svc.EsExecute(ctx, req.ConnectionID, req.SQL)
	a.audit(req.ConnectionID, "es_execute", auditSQLTarget(req.SQL), auditResult(err), auditDetail(err))
	return results, err
}

// ESDsl executes one raw REST request for the DSL console (dangerous, audited):
// every HTTP response returns as status+body — 4xx/5xx are not Go errors, the
// frontend renders them by status. The audit target is the upper-cased
// "METHOD PATH" (body excluded).
func (a *App) ESDsl(req EsDslRequest) (model.EsDslResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	target := strings.ToUpper(strings.TrimSpace(req.Method)) + " " + req.Path
	res, err := a.svc.EsDsl(ctx, req.ConnectionID, req.Method, req.Path, req.Body)
	a.audit(req.ConnectionID, "es_dsl", target, auditResult(err), auditDetail(err))
	return res, err
}

// EsRefreshIndex refreshes the index's shards (not a destructive operation,
// not audited).
func (a *App) EsRefreshIndex(req EsRefreshIndexRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsRefreshIndex(ctx, req.ConnectionID, req.Index)
}

// ListEsTemplates lists the legacy index templates (GET /_template).
func (a *App) ListEsTemplates(connectionID string) ([]model.EsTemplateInfo, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.EsListTemplates(ctx, connectionID)
}

// GetEsTemplate returns the template's raw JSON text.
func (a *App) GetEsTemplate(req EsGetTemplateRequest) (model.EsTemplateContent, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	text, err := a.svc.EsGetTemplate(ctx, req.ConnectionID, req.Name)
	if err != nil {
		return model.EsTemplateContent{}, err
	}
	return model.EsTemplateContent{TemplateJSON: text}, nil
}

// PutEsTemplate creates or replaces one legacy index template (dangerous,
// audited; the audit target is the template name).
func (a *App) PutEsTemplate(req EsPutTemplateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsPutTemplate(ctx, req.ConnectionID, req.Name, req.TemplateJSON)
	a.audit(req.ConnectionID, "es_put_template", req.Name, auditResult(err), auditDetail(err))
	return err
}

// DeleteEsTemplate removes one legacy index template (dangerous, audited; the
// audit target is the template name).
func (a *App) DeleteEsTemplate(req EsDeleteTemplateRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsDeleteTemplate(ctx, req.ConnectionID, req.Name)
	a.audit(req.ConnectionID, "es_delete_template", req.Name, auditResult(err), auditDetail(err))
	return err
}

// EsCreateIndex creates one index with shard/replica settings (dangerous,
// audited; the audit target is the index name).
func (a *App) EsCreateIndex(req EsCreateIndexRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsCreateIndex(ctx, req.ConnectionID, req.Index, req.Shards, req.Replicas)
	a.audit(req.ConnectionID, "es_create_index", req.Index, auditResult(err), auditDetail(err))
	return err
}

// EsDeleteIndex removes one index (dangerous, audited; the audit target is the
// index name).
func (a *App) EsDeleteIndex(req EsDeleteIndexRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsDeleteIndex(ctx, req.ConnectionID, req.Index)
	a.audit(req.ConnectionID, "es_delete_index", req.Index, auditResult(err), auditDetail(err))
	return err
}

// EsUpdateIndexSettings applies one index's settings (dangerous, audited; the
// audit target is the index name).
func (a *App) EsUpdateIndexSettings(req EsUpdateIndexSettingsRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.EsUpdateIndexSettings(ctx, req.ConnectionID, req.Index, req.SettingsJSON)
	a.audit(req.ConnectionID, "es_update_settings", req.Index, auditResult(err), auditDetail(err))
	return err
}
