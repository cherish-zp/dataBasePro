// Package service defines the data source abstractions and coordinates
// connection lifecycle, persistence and the Kafka client implementations.
package service

import (
	"context"

	"dataBasePro/backend/internal/model"
)

// DataSource is the unified interface for any connectable data source,
// designed so MySQL and Elasticsearch can be added later.
type DataSource interface {
	Connect(ctx context.Context) error
	Close() error
	GetName() string
	GetType() string
}

// KafkaDataSource extends DataSource with Kafka-specific operations.
type KafkaDataSource interface {
	DataSource
	ListTopics(ctx context.Context) ([]*model.Topic, error)
	DescribeTopic(ctx context.Context, name string) (*model.TopicDetail, error)
	DescribeCluster(ctx context.Context) (*model.ClusterHealth, error)
	CreateTopic(ctx context.Context, name string, partitions int32, replicationFactor int16) error
	DeleteTopic(ctx context.Context, name string) error
	DeleteConsumerGroup(ctx context.Context, name string) error
	ListConsumerGroups(ctx context.Context) ([]*model.ConsumerGroup, error)
	ConsumeMessages(ctx context.Context, topic string, partition int32, offset int64, limit int) ([]*model.Message, error)
	ConsumeMessagesByTimestamp(ctx context.Context, topic string, partition int32, timestampMS int64, limit int) ([]*model.Message, error)
	GetPartitionLag(ctx context.Context, topic string, group string) (map[int32]int64, error)
	ListActiveProducers(ctx context.Context, topic string) ([]*model.ActiveProducer, error)
	ListActiveConsumers(ctx context.Context, group, topic string) ([]*model.ActiveConsumer, error)
	ResetConsumerGroupOffset(ctx context.Context, group, topic string, mode model.ResetOffsetMode, timestampMS int64) error
	ProduceMessage(ctx context.Context, topic string, partition int32, key, value []byte) error
}

// ClientFactory creates KafkaDataSource instances; it exists so callers can
// inject fakes in tests.
type ClientFactory interface {
	NewKafkaClient(ctx context.Context, cfg model.KafkaConfig) (KafkaDataSource, error)
}

// ClientFactoryFunc adapts a function to the ClientFactory interface.
type ClientFactoryFunc func(ctx context.Context, cfg model.KafkaConfig) (KafkaDataSource, error)

// NewKafkaClient implements ClientFactory.
func (f ClientFactoryFunc) NewKafkaClient(ctx context.Context, cfg model.KafkaConfig) (KafkaDataSource, error) {
	return f(ctx, cfg)
}
