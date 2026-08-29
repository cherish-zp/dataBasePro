package model

// AuditEntry records a single dangerous operation (create/delete/reset/config
// change) so the settings page can surface a reviewable trail.
type AuditEntry struct {
	ID           int64  `json:"id,omitempty"`
	ConnectionID string `json:"connection_id"`
	Action       string `json:"action"`
	Target       string `json:"target"`
	Result       string `json:"result"` // "ok" | "error"
	Detail       string `json:"detail,omitempty"`
	Timestamp    int64  `json:"timestamp"` // unix ms
}
