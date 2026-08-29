// Package backend exposes the application API to the Wails frontend. Each
// exported method is bound to the UI and talks to the service layer.
//
// Bound methods intentionally do NOT take a context.Context parameter: Wails
// v2 marshals arguments as JSON and cannot inject a Go context. Instead the
// app stores the context handed to Startup (or tests may SetContext) and each
// call derives a bounded sub-context from it.
package backend

import (
	"context"
	"fmt"
	"strings"
	"time"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
)

// methodTimeout bounds each individual frontend call.
const methodTimeout = 60 * time.Second

// App is the Wails application root. Methods on it are exposed to the frontend.
type App struct {
	svc *service.Service
}

// NewApp builds the application root around the service layer.
func NewApp(svc *service.Service) *App {
	return &App{svc: svc}
}

// newContext returns a per-call context with a timeout. Bound methods do not
// accept a context (Wails v2 cannot marshal one), so each call is bounded by
// methodTimeout.
func (a *App) newContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), methodTimeout)
}

// auditResult classifies an operation outcome for the audit log.
func auditResult(err error) string {
	if err != nil {
		return "error"
	}
	return "ok"
}

// auditDetail returns the failure detail, or an empty string on success.
func auditDetail(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}

// audit best-effort records a dangerous operation. A failed write must never
// change the outcome of the operation being audited, so the error is dropped.
func (a *App) audit(connectionID, action, target, result, detail string) {
	_ = a.svc.RecordAudit(context.Background(), &model.AuditEntry{
		ConnectionID: connectionID,
		Action:       action,
		Target:       target,
		Result:       result,
		Detail:       detail,
	})
}

// joinAuditTargets renders topic names for the batch-delete audit target,
// capping the joined list at 10 names followed by an ellipsis.
func joinAuditTargets(names []string) string {
	if len(names) <= 10 {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:10], ", ") + "…"
}

// connectionIDOf best-effort returns a connection's id, guarding nil input so
// a malformed create request cannot panic in the audit path.
func connectionIDOf(c *model.Connection) string {
	if c == nil {
		return ""
	}
	return c.ID
}

// nameOf best-effort returns a connection's name, guarding nil input.
func nameOf(c *model.Connection) string {
	if c == nil {
		return ""
	}
	return c.Name
}

// ConsumeRequest carries the parameters for a message fetch.
type ConsumeRequest struct {
	ConnectionID string `json:"connection_id"`
	Topic        string `json:"topic"`
	Partition    int32  `json:"partition"`
	Offset       int64  `json:"offset"`
	TimestampMS  int64  `json:"timestamp_ms,omitempty"`
	Limit        int    `json:"limit"`
}

// ActiveMembersRequest carries the parameters for listing active producers or
// consumers on a topic for a consumer group.
type ActiveMembersRequest struct {
	ConnectionID string `json:"connection_id"`
	Group        string `json:"group"`
	Topic        string `json:"topic"`
}

// ResetOffsetRequest carries the parameters for resetting a group offset.
type ResetOffsetRequest struct {
	ConnectionID string                `json:"connection_id"`
	Group        string                `json:"group"`
	Topic        string                `json:"topic"`
	Mode         model.ResetOffsetMode `json:"mode"`
	TimestampMS  int64                 `json:"timestamp_ms,omitempty"`
}

// CreateTopicRequest carries the parameters for creating a Kafka topic.
type CreateTopicRequest struct {
	ConnectionID      string `json:"connection_id"`
	Topic             string `json:"topic"`
	Partitions        int32  `json:"partitions"`
	ReplicationFactor int16  `json:"replication_factor"`
}

// DeleteTopicRequest carries the parameters for deleting a Kafka topic.
type DeleteTopicRequest struct {
	ConnectionID string `json:"connection_id"`
	Topic        string `json:"topic"`
}

// DeleteTopicsRequest carries the parameters for batch-deleting Kafka topics.
type DeleteTopicsRequest struct {
	ConnectionID string   `json:"connection_id"`
	Names        []string `json:"names"`
}

// AlterTopicConfigRequest carries the parameters for editing a topic's
// whitelisted configs.
type AlterTopicConfigRequest struct {
	ConnectionID string                   `json:"connection_id"`
	Topic        string                   `json:"topic"`
	Entries      []model.TopicConfigEntry `json:"entries"`
}

// DeleteConsumerGroupRequest carries the parameters for deleting a consumer group.
type DeleteConsumerGroupRequest struct {
	ConnectionID string `json:"connection_id"`
	Group        string `json:"group"`
}

// ProduceRequest carries the parameters for publishing a record.
type ProduceRequest struct {
	ConnectionID string `json:"connection_id"`
	Topic        string `json:"topic"`
	Partition    int32  `json:"partition"`
	Key          string `json:"key"`
	Value        string `json:"value"`
}

// BatchProduceRequest carries the parameters for publishing a batch of records.
type BatchProduceRequest struct {
	ConnectionID string                      `json:"connection_id"`
	Topic        string                      `json:"topic"`
	Partition    int32                       `json:"partition"`
	Messages     []model.BatchProduceMessage `json:"messages"`
}

// CreateTopic creates a topic on a connection's cluster.
func (a *App) CreateTopic(req CreateTopicRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.CreateTopic(ctx, req.ConnectionID, req.Topic, req.Partitions, req.ReplicationFactor)
	a.audit(req.ConnectionID, "create_topic", req.Topic, auditResult(err), auditDetail(err))
	return err
}

// DeleteTopic removes a topic from a connection's cluster.
func (a *App) DeleteTopic(req DeleteTopicRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.DeleteTopic(ctx, req.ConnectionID, req.Topic)
	a.audit(req.ConnectionID, "delete_topic", req.Topic, auditResult(err), auditDetail(err))
	return err
}

// DeleteTopics removes several topics from a connection's cluster and returns
// one result per topic. The audit target is the joined topic names (capped at
// 10) and the result is ok only when every topic was deleted.
func (a *App) DeleteTopics(req DeleteTopicsRequest) ([]*model.TopicDeleteResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	target := joinAuditTargets(req.Names)
	results, err := a.svc.DeleteTopics(ctx, req.ConnectionID, req.Names)
	if err != nil {
		a.audit(req.ConnectionID, "delete_topics", target, "error", auditDetail(err))
		return nil, err
	}
	result := "ok"
	var failures []string
	for _, r := range results {
		if r.Error != "" {
			result = "error"
			failures = append(failures, fmt.Sprintf("%s: %s", r.Name, r.Error))
		}
	}
	if len(failures) > 10 {
		failures = failures[:10]
	}
	a.audit(req.ConnectionID, "delete_topics", target, result, strings.Join(failures, "; "))
	return results, nil
}

// DeleteConsumerGroup removes a consumer group from a connection's cluster.
func (a *App) DeleteConsumerGroup(req DeleteConsumerGroupRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.DeleteConsumerGroup(ctx, req.ConnectionID, req.Group)
	a.audit(req.ConnectionID, "delete_consumer_group", req.Group, auditResult(err), auditDetail(err))
	return err
}

// CreateConnection validates and saves a new connection.
func (a *App) CreateConnection(c *model.Connection) (*model.Connection, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	created, err := a.svc.CreateConnection(ctx, c)
	if err != nil {
		a.audit(connectionIDOf(c), "create_connection", nameOf(c), "error", auditDetail(err))
		return nil, err
	}
	a.audit(created.ID, "create_connection", created.Name, "ok", "")
	return created, nil
}

// ListConnections returns all saved connections.
func (a *App) ListConnections() ([]*model.Connection, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListConnections(ctx)
}

// GetConnection returns a single saved connection.
func (a *App) GetConnection(id string) (*model.Connection, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.GetConnection(ctx, id)
}

// DeleteConnection removes a connection and closes any pooled client.
func (a *App) DeleteConnection(id string) error {
	ctx, cancel := a.newContext()
	defer cancel()
	// Prefer the human-readable name as the audit target when available.
	target := id
	if c, err := a.svc.GetConnection(ctx, id); err == nil && c.Name != "" {
		target = c.Name
	}
	err := a.svc.DeleteConnection(ctx, id)
	a.audit(id, "delete_connection", target, auditResult(err), auditDetail(err))
	return err
}

// TestConnection verifies connectivity to a config without saving it.
func (a *App) TestConnection(cfg model.KafkaConfig) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.TestConnection(ctx, cfg)
}

// Connect establishes a pooled connection by id.
func (a *App) Connect(id string) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ConnectConnection(ctx, id)
}

// Disconnect closes a pooled connection by id.
func (a *App) Disconnect(id string) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CloseConnection(ctx, id)
}

// ListTopics lists topics for a connection.
func (a *App) ListTopics(id string) ([]*model.Topic, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListTopics(ctx, id)
}

// DescribeTopic returns a topic's partition topology and key configs.
func (a *App) DescribeTopic(id, topic string) (*model.TopicDetail, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.DescribeTopic(ctx, id, topic)
}

// AlterTopicConfig applies the whitelisted topic config values in req.
func (a *App) AlterTopicConfig(req AlterTopicConfigRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.AlterTopicConfig(ctx, req.ConnectionID, req.Topic, req.Entries)
	detail := auditDetail(err)
	if err == nil {
		keys := make([]string, 0, len(req.Entries))
		for _, e := range req.Entries {
			keys = append(keys, e.Key)
		}
		detail = strings.Join(keys, ", ")
	}
	a.audit(req.ConnectionID, "alter_topic_config", req.Topic, auditResult(err), detail)
	return err
}

// DescribeCluster returns broker topology, controller, Kafka version and
// under-replicated partitions for a connection's cluster.
func (a *App) DescribeCluster(id string) (*model.ClusterHealth, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.DescribeCluster(ctx, id)
}

// ListConsumerGroups lists consumer groups (with lag) for a connection.
func (a *App) ListConsumerGroups(id string) ([]*model.ConsumerGroup, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListConsumerGroups(ctx, id)
}

// DescribeGroup returns a consumer group's state and member topology with
// per-topic partition assignments.
func (a *App) DescribeGroup(id, group string) (*model.GroupDetail, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.DescribeGroup(ctx, id, group)
}

// ConsumeMessages fetches a batch of messages for a connection.
func (a *App) ConsumeMessages(req ConsumeRequest) ([]*model.Message, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ConsumeMessages(ctx, req.ConnectionID, req.Topic, req.Partition, req.Offset, req.Limit)
}

// ConsumeMessagesByTimestamp fetches messages at or after a unix-ms timestamp.
func (a *App) ConsumeMessagesByTimestamp(req ConsumeRequest) ([]*model.Message, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ConsumeMessagesByTimestamp(ctx, req.ConnectionID, req.Topic, req.Partition, req.TimestampMS, req.Limit)
}

// GetPartitionLag returns per-partition lag for a group on a topic.
func (a *App) GetPartitionLag(id, topic, group string) (map[int32]int64, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.GetPartitionLag(ctx, id, topic, group)
}

// ListActiveProducers returns the producers currently producing to a topic.
func (a *App) ListActiveProducers(req ActiveMembersRequest) ([]*model.ActiveProducer, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListActiveProducers(ctx, req.ConnectionID, req.Topic)
}

// ListActiveConsumers returns the group members assigned to a topic.
func (a *App) ListActiveConsumers(req ActiveMembersRequest) ([]*model.ActiveConsumer, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListActiveConsumers(ctx, req.ConnectionID, req.Group, req.Topic)
}

// ResetConsumerGroupOffset resets a consumer group offset.
func (a *App) ResetConsumerGroupOffset(req ResetOffsetRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	err := a.svc.ResetConsumerGroupOffset(ctx, req.ConnectionID, req.Group, req.Topic, req.Mode, req.TimestampMS)
	detail := auditDetail(err)
	if err == nil {
		detail = string(req.Mode)
		if req.TimestampMS > 0 {
			detail = fmt.Sprintf("%s(%d)", req.Mode, req.TimestampMS)
		}
	}
	a.audit(req.ConnectionID, "reset_group_offset", req.Group+"/"+req.Topic, auditResult(err), detail)
	return err
}

// ListAudit returns the most recent audit entries, newest first. A non-positive
// limit falls back to the store default (200).
func (a *App) ListAudit(limit int) ([]*model.AuditEntry, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListAudit(ctx, limit)
}

// ProduceMessage publishes a record to a connection.
func (a *App) ProduceMessage(req ProduceRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ProduceMessage(ctx, req.ConnectionID, req.Topic, req.Partition, []byte(req.Key), []byte(req.Value))
}

// ProduceMessages publishes a batch of records to a connection and returns one
// result per message.
func (a *App) ProduceMessages(req BatchProduceRequest) ([]*model.ProduceResult, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ProduceMessages(ctx, req.ConnectionID, req.Topic, req.Partition, req.Messages)
}
