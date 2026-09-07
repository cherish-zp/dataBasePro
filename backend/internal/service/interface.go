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
	GetTopicMessageCounts(ctx context.Context, topics ...string) (map[string]model.TopicMessageCounts, error)
	DescribeTopic(ctx context.Context, name string) (*model.TopicDetail, error)
	AlterTopicConfig(ctx context.Context, name string, entries []model.TopicConfigEntry) error
	AlterTopicPartitions(ctx context.Context, name string, target int32) error
	DescribeCluster(ctx context.Context) (*model.ClusterHealth, error)
	CreateTopic(ctx context.Context, name string, partitions int32, replicationFactor int16) error
	DeleteTopic(ctx context.Context, name string) error
	DeleteTopics(ctx context.Context, names []string) ([]*model.TopicDeleteResult, error)
	DeleteConsumerGroup(ctx context.Context, name string) error
	ListConsumerGroups(ctx context.Context) ([]*model.ConsumerGroup, error)
	DescribeGroup(ctx context.Context, group string) (*model.GroupDetail, error)
	ConsumeMessages(ctx context.Context, topic string, partition int32, offset int64, limit int) ([]*model.Message, error)
	ConsumeMessagesByTimestamp(ctx context.Context, topic string, partition int32, timestampMS int64, limit int) ([]*model.Message, error)
	GetPartitionLag(ctx context.Context, topic string, group string) (map[int32]int64, error)
	ListActiveProducers(ctx context.Context, topic string) ([]*model.ActiveProducer, error)
	ListActiveConsumers(ctx context.Context, group, topic string) ([]*model.ActiveConsumer, error)
	ResetConsumerGroupOffset(ctx context.Context, group, topic string, mode model.ResetOffsetMode, timestampMS int64, offsets map[int32]int64) error
	PreviewResetOffset(ctx context.Context, topic string, mode model.ResetOffsetMode, timestampMS int64) (map[int32]int64, error)
	ProduceMessage(ctx context.Context, topic string, partition int32, key, value []byte) error
	ProduceMessages(ctx context.Context, topic string, partition int32, messages []model.BatchProduceMessage) ([]*model.ProduceResult, error)
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

// RedisDataSource extends DataSource with the Redis key-space operations of
// the MVP browser (scan/view/edit/delete/TTL/flush/INFO).
type RedisDataSource interface {
	DataSource
	Ping(ctx context.Context) error
	Databases(ctx context.Context) ([]model.RedisDBInfo, error)
	IsCluster() bool
	Scan(ctx context.Context, db int, cursor uint64, match string, count int64) (uint64, []model.RedisKeyInfo, error)
	GetKey(ctx context.Context, db int, key string) (model.RedisValue, error)
	RenameKey(ctx context.Context, db int, from, to string) error
	DeleteKeys(ctx context.Context, db int, keys []string) (int64, error)
	SetTTL(ctx context.Context, db int, key string, ttlSeconds int64) error
	SetString(ctx context.Context, db int, key, value string, ttlSeconds int64) error
	HashSetField(ctx context.Context, db int, key, field, value string) error
	HashDeleteField(ctx context.Context, db int, key, field string) error
	ListSetIndex(ctx context.Context, db int, key string, index int64, value string) error
	ListPush(ctx context.Context, db int, key, value string, atHead bool) error
	ListDeleteIndex(ctx context.Context, db int, key string, index int64) error
	SetAdd(ctx context.Context, db int, key, member string) error
	SetRemove(ctx context.Context, db int, key, member string) error
	ZSetAdd(ctx context.Context, db int, key, member string, score float64) error
	ZSetRemove(ctx context.Context, db int, key, member string) error
	FlushDB(ctx context.Context, db int) error
	FlushAll(ctx context.Context) error
	ServerInfo(ctx context.Context) (model.RedisServerInfo, error)
}
