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

// CreateTopic creates a topic on a connection's cluster.
func (a *App) CreateTopic(req CreateTopicRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CreateTopic(ctx, req.ConnectionID, req.Topic, req.Partitions, req.ReplicationFactor)
}

// DeleteTopic removes a topic from a connection's cluster.
func (a *App) DeleteTopic(req DeleteTopicRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.DeleteTopic(ctx, req.ConnectionID, req.Topic)
}

// DeleteConsumerGroup removes a consumer group from a connection's cluster.
func (a *App) DeleteConsumerGroup(req DeleteConsumerGroupRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.DeleteConsumerGroup(ctx, req.ConnectionID, req.Group)
}

// CreateConnection validates and saves a new connection.
func (a *App) CreateConnection(c *model.Connection) (*model.Connection, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.CreateConnection(ctx, c)
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
	return a.svc.DeleteConnection(ctx, id)
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

// ListConsumerGroups lists consumer groups (with lag) for a connection.
func (a *App) ListConsumerGroups(id string) ([]*model.ConsumerGroup, error) {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ListConsumerGroups(ctx, id)
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
	return a.svc.ResetConsumerGroupOffset(ctx, req.ConnectionID, req.Group, req.Topic, req.Mode, req.TimestampMS)
}

// ProduceMessage publishes a record to a connection.
func (a *App) ProduceMessage(req ProduceRequest) error {
	ctx, cancel := a.newContext()
	defer cancel()
	return a.svc.ProduceMessage(ctx, req.ConnectionID, req.Topic, req.Partition, []byte(req.Key), []byte(req.Value))
}
