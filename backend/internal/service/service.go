package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

// Service coordinates persistence, the connection pool and the Kafka client
// factory. It is the single entry point used by the Wails app layer.
type Service struct {
	store   *store.Store
	pool    *Pool
	factory ClientFactory
}

// NewService builds a Service around the given store and client factory.
func NewService(st *store.Store, factory ClientFactory) *Service {
	return &Service{store: st, pool: NewPool(), factory: factory}
}

// CreateConnection validates and persists a connection definition.
func (s *Service) CreateConnection(ctx context.Context, c *model.Connection) (*model.Connection, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if c.ID == "" {
		c.ID = uuid.NewString()
	}
	if err := s.store.CreateConnection(c); err != nil {
		return nil, fmt.Errorf("save connection: %w", err)
	}
	return c, nil
}

// ListConnections returns every stored connection definition.
func (s *Service) ListConnections(ctx context.Context) ([]*model.Connection, error) {
	return s.store.ListConnections()
}

// GetConnection returns a single stored connection definition.
func (s *Service) GetConnection(ctx context.Context, id string) (*model.Connection, error) {
	return s.store.GetConnection(id)
}

// TestConnection verifies connectivity to the given config without persisting.
func (s *Service) TestConnection(ctx context.Context, cfg model.KafkaConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	kds, err := s.factory.NewKafkaClient(ctx, cfg)
	if err != nil {
		return fmt.Errorf("create client: %w", err)
	}
	defer kds.Close()
	if err := kds.Connect(ctx); err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	return nil
}

// ConnectConnection establishes a connection and registers it in the pool.
func (s *Service) ConnectConnection(ctx context.Context, id string) error {
	c, err := s.store.GetConnection(id)
	if err != nil {
		return err
	}
	kds, err := s.buildClient(ctx, c)
	if err != nil {
		return err
	}
	if err := s.pool.Put(id, kds); err != nil {
		kds.Close()
		return err
	}
	return nil
}

// CloseConnection removes a connection from the pool and closes it.
func (s *Service) CloseConnection(ctx context.Context, id string) error {
	ds, err := s.pool.Remove(id)
	if err != nil {
		return err
	}
	return ds.Close()
}

// DeleteConnection closes any pooled client and removes the definition.
func (s *Service) DeleteConnection(ctx context.Context, id string) error {
	if ds, err := s.pool.Remove(id); err == nil {
		_ = ds.Close()
	}
	return s.store.DeleteConnection(id)
}

// CreateTopic creates a topic on the connection's cluster.
func (s *Service) CreateTopic(ctx context.Context, id, name string, partitions int32, replicationFactor int16) error {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return d.CreateTopic(ctx, name, partitions, replicationFactor)
}

// DeleteTopic removes a topic from the connection's cluster.
func (s *Service) DeleteTopic(ctx context.Context, id, name string) error {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return d.DeleteTopic(ctx, name)
}

// DeleteConsumerGroup removes an empty consumer group from the connection's cluster.
func (s *Service) DeleteConsumerGroup(ctx context.Context, id, name string) error {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return d.DeleteConsumerGroup(ctx, name)
}

// ListTopics lists topics on the connection, auto-connecting if needed.
func (s *Service) ListTopics(ctx context.Context, id string) ([]*model.Topic, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ListTopics(ctx)
}

// DescribeTopic describes one topic's partition topology and key configs,
// auto-connecting if needed.
func (s *Service) DescribeTopic(ctx context.Context, id, name string) (*model.TopicDetail, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.DescribeTopic(ctx, name)
}

// ListConsumerGroups lists consumer groups with lag on the connection.
func (s *Service) ListConsumerGroups(ctx context.Context, id string) ([]*model.ConsumerGroup, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ListConsumerGroups(ctx)
}

// ConsumeMessages fetches a batch of messages from the connection.
func (s *Service) ConsumeMessages(ctx context.Context, id, topic string, partition int32, offset int64, limit int) ([]*model.Message, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ConsumeMessages(ctx, topic, partition, offset, limit)
}

// ConsumeMessagesByTimestamp fetches messages at or after a timestamp.
func (s *Service) ConsumeMessagesByTimestamp(ctx context.Context, id, topic string, partition int32, timestampMS int64, limit int) ([]*model.Message, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ConsumeMessagesByTimestamp(ctx, topic, partition, timestampMS, limit)
}

// GetPartitionLag returns lag per partition for a group on a topic.
func (s *Service) GetPartitionLag(ctx context.Context, id, topic, group string) (map[int32]int64, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.GetPartitionLag(ctx, topic, group)
}

// ListActiveProducers returns the active producers for a topic on the connection.
func (s *Service) ListActiveProducers(ctx context.Context, id, topic string) ([]*model.ActiveProducer, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ListActiveProducers(ctx, topic)
}

// ListActiveConsumers returns the group members assigned to a topic.
func (s *Service) ListActiveConsumers(ctx context.Context, id, group, topic string) ([]*model.ActiveConsumer, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ListActiveConsumers(ctx, group, topic)
}

// ResetConsumerGroupOffset resets a consumer group offset.
func (s *Service) ResetConsumerGroupOffset(ctx context.Context, id, group, topic string, mode model.ResetOffsetMode, timestampMS int64) error {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return kds.ResetConsumerGroupOffset(ctx, group, topic, mode, timestampMS)
}

// ProduceMessage publishes a record to the connection.
func (s *Service) ProduceMessage(ctx context.Context, id, topic string, partition int32, key, value []byte) error {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return kds.ProduceMessage(ctx, topic, partition, key, value)
}

// kafka returns the pooled Kafka client for id, auto-connecting using the
// stored definition when it is not yet pooled.
func (s *Service) kafka(ctx context.Context, id string) (KafkaDataSource, error) {
	if ds, err := s.pool.Get(id); err == nil {
		kds, ok := ds.(KafkaDataSource)
		if !ok {
			return nil, errors.New("connection is not a Kafka data source")
		}
		return kds, nil
	}
	c, err := s.store.GetConnection(id)
	if err != nil {
		return nil, err
	}
	kds, err := s.buildClient(ctx, c)
	if err != nil {
		return nil, err
	}
	if err := s.pool.Put(id, kds); err != nil {
		kds.Close()
		return nil, err
	}
	return kds, nil
}

// buildClient creates a Kafka client for the connection and verifies it.
func (s *Service) buildClient(ctx context.Context, c *model.Connection) (KafkaDataSource, error) {
	if c.Type != model.ConnectionTypeKafka {
		return nil, fmt.Errorf("connection %q is not a Kafka source (type %q)", c.ID, c.Type)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	kds, err := s.factory.NewKafkaClient(ctx, c.Config)
	if err != nil {
		return nil, fmt.Errorf("create client: %w", err)
	}
	if err := kds.Connect(ctx); err != nil {
		kds.Close()
		return nil, fmt.Errorf("connect: %w", err)
	}
	return kds, nil
}
