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

// ClickHouseDataSource extends DataSource with the ClickHouse browser
// operations: database/table listing, paged rows, truncate and a SQL console.
type ClickHouseDataSource interface {
	DataSource
	Databases(ctx context.Context) ([]string, error)
	Tables(ctx context.Context, database string, showSystem bool) ([]model.CHTableInfo, error)
	PageRows(ctx context.Context, database, table, where, orderBy string, asc bool, limit, offset int) (model.CHPageRowsResult, error)
	TruncateTable(ctx context.Context, database, table string, onCluster bool) error
	Execute(ctx context.Context, sqlText string) ([]model.CHStatementResult, error)
}

// MysqlDataSource extends DataSource with the MySQL browser operations:
// database/table listing, paged rows, truncate, a SQL console and parameterized
// cell edits. TiDB speaks the MySQL protocol, so one implementation serves
// both the mysql and tidb connection types (GetType reports the real one).
type MysqlDataSource interface {
	DataSource
	Databases(ctx context.Context) ([]string, error)
	// Tables lists the database's base tables (views are always excluded).
	Tables(ctx context.Context, database string) ([]model.MysqlTableInfo, error)
	PageRows(ctx context.Context, database, table, where, orderBy string, asc bool, limit, offset int) (model.MysqlPageRowsResult, error)
	TruncateTable(ctx context.Context, database, table string) error
	Execute(ctx context.Context, sqlText string) ([]model.MysqlStatementResult, error)
	// PreviewCellUpdate renders the display text of the UPDATE and counts the
	// rows matched by the same WHERE conditions (read-only, nothing executes).
	PreviewCellUpdate(ctx context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) (model.MysqlCellUpdatePreview, error)
	// UpdateCell executes the parameterized cell update; WHERE conditions may
	// only reference primary key columns.
	UpdateCell(ctx context.Context, database, table string, set model.MysqlCellValue, where []model.MysqlCellValue) error
}
