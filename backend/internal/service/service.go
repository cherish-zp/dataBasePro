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

// UpdateConnection validates and overwrites an existing connection definition,
// keeping its id and created_at while the store refreshes updated_at. The
// pooled client still holds the old config, so it is evicted and closed: the
// next operation reconnects with the edited settings.
func (s *Service) UpdateConnection(ctx context.Context, c *model.Connection) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := s.store.UpdateConnection(c); err != nil {
		return fmt.Errorf("update connection: %w", err)
	}
	if ds, err := s.pool.Remove(c.ID); err == nil {
		_ = ds.Close()
	}
	return nil
}

// ListConnections returns every stored connection definition.
func (s *Service) ListConnections(ctx context.Context) ([]*model.Connection, error) {
	return s.store.ListConnections()
}

// GetConnection returns a single stored connection definition.
func (s *Service) GetConnection(ctx context.Context, id string) (*model.Connection, error) {
	return s.store.GetConnection(id)
}

// RecordAudit persists an audit entry for a dangerous operation. It is a pure
// store delegation and never touches the Kafka cluster.
func (s *Service) RecordAudit(ctx context.Context, e *model.AuditEntry) error {
	return s.store.RecordAudit(e)
}

// ListAudit returns the most recent audit entries, newest first. A non-positive
// limit falls back to the store default (200).
func (s *Service) ListAudit(ctx context.Context, limit int) ([]*model.AuditEntry, error) {
	return s.store.ListAudit(limit)
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
	var ds DataSource
	switch c.Type {
	case model.ConnectionTypeRedis:
		ds, err = s.buildRedisClient(c)
	case model.ConnectionTypeClickHouse:
		ds, err = s.buildCHClient(c)
	case model.ConnectionTypeMySQL, model.ConnectionTypeTiDB:
		ds, err = s.buildMysqlClient(c)
	default:
		ds, err = s.buildClient(ctx, c)
	}
	if err != nil {
		return err
	}
	if err := s.pool.Put(id, ds); err != nil {
		ds.Close()
		return err
	}
	return nil
}

// buildRedisClient creates the Redis client for the connection.
func (s *Service) buildRedisClient(c *model.Connection) (*RedisClient, error) {
	if c.Type != model.ConnectionTypeRedis {
		return nil, fmt.Errorf("connection %q is not a Redis source (type %q)", c.ID, c.Type)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	cfg, err := c.RedisConfig()
	if err != nil {
		return nil, fmt.Errorf("decode redis config: %w", err)
	}
	return NewRedisClient(cfg)
}

// buildCHClient creates the ClickHouse client for the connection (it pings as
// part of construction).
func (s *Service) buildCHClient(c *model.Connection) (*CHClient, error) {
	if c.Type != model.ConnectionTypeClickHouse {
		return nil, fmt.Errorf("connection %q is not a ClickHouse source (type %q)", c.ID, c.Type)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	cfg, err := c.ClickHouseConfig()
	if err != nil {
		return nil, fmt.Errorf("decode clickhouse config: %w", err)
	}
	return NewCHClient(cfg)
}

// buildMysqlClient creates the MySQL/TiDB client for the connection (it pings
// as part of construction). TiDB speaks the MySQL protocol, so both types share
// the builder; the client keeps the real type for GetType.
func (s *Service) buildMysqlClient(c *model.Connection) (*MysqlClient, error) {
	if c.Type != model.ConnectionTypeMySQL && c.Type != model.ConnectionTypeTiDB {
		return nil, fmt.Errorf("connection %q is not a MySQL/TiDB source (type %q)", c.ID, c.Type)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	cfg, err := c.MysqlConfig()
	if err != nil {
		return nil, fmt.Errorf("decode mysql config: %w", err)
	}
	return NewMysqlClientOfType(cfg, c.Type)
}

// redis returns the pooled Redis client for the connection, auto-connecting
// when the tree has not connected it yet.
func (s *Service) redis(ctx context.Context, id string) (RedisDataSource, error) {
	if ds, err := s.pool.Get(id); err == nil {
		if rds, ok := ds.(RedisDataSource); ok {
			return rds, nil
		}
		return nil, fmt.Errorf("connection %q is not a Redis source", id)
	}
	if err := s.ConnectConnection(ctx, id); err != nil {
		return nil, err
	}
	ds, err := s.pool.Get(id)
	if err != nil {
		return nil, err
	}
	rds, ok := ds.(RedisDataSource)
	if !ok {
		return nil, fmt.Errorf("connection %q is not a Redis source", id)
	}
	return rds, nil
}

// RedisDatabases lists the logical DBs of the connection's Redis.
func (s *Service) RedisDatabases(ctx context.Context, id string) ([]model.RedisDBInfo, error) {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return nil, err
	}
	return rds.Databases(ctx)
}

// RedisScan pages the key space.
func (s *Service) RedisScan(ctx context.Context, id string, db int, cursor uint64, match string, count int64) (uint64, []model.RedisKeyInfo, error) {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return 0, nil, err
	}
	return rds.Scan(ctx, db, cursor, match, count)
}

// RedisGetKey loads a key's typed value.
func (s *Service) RedisGetKey(ctx context.Context, id string, db int, key string) (model.RedisValue, error) {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return model.RedisValue{}, err
	}
	return rds.GetKey(ctx, db, key)
}

// RedisRenameKey renames a key.
func (s *Service) RedisRenameKey(ctx context.Context, id string, db int, from, to string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.RenameKey(ctx, db, from, to)
}

// RedisDeleteKeys deletes keys and returns the removal count.
func (s *Service) RedisDeleteKeys(ctx context.Context, id string, db int, keys []string) (int64, error) {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return 0, err
	}
	return rds.DeleteKeys(ctx, db, keys)
}

// RedisSetTTL applies or removes a key expiry.
func (s *Service) RedisSetTTL(ctx context.Context, id string, db int, key string, ttlSeconds int64) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.SetTTL(ctx, db, key, ttlSeconds)
}

// RedisSetString writes a string key.
func (s *Service) RedisSetString(ctx context.Context, id string, db int, key, value string, ttlSeconds int64) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.SetString(ctx, db, key, value, ttlSeconds)
}

// RedisHashSetField writes one field of a hash key.
func (s *Service) RedisHashSetField(ctx context.Context, id string, db int, key, field, value string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.HashSetField(ctx, db, key, field, value)
}

// RedisHashDeleteField removes one field from a hash key.
func (s *Service) RedisHashDeleteField(ctx context.Context, id string, db int, key, field string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.HashDeleteField(ctx, db, key, field)
}

// RedisListSetIndex overwrites the element at the given list index.
func (s *Service) RedisListSetIndex(ctx context.Context, id string, db int, key string, index int64, value string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.ListSetIndex(ctx, db, key, index, value)
}

// RedisListPush prepends or appends one element of a list.
func (s *Service) RedisListPush(ctx context.Context, id string, db int, key, value string, atHead bool) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.ListPush(ctx, db, key, value, atHead)
}

// RedisListDeleteIndex removes the element at the given list index.
func (s *Service) RedisListDeleteIndex(ctx context.Context, id string, db int, key string, index int64) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.ListDeleteIndex(ctx, db, key, index)
}

// RedisSetAdd inserts a member into a set.
func (s *Service) RedisSetAdd(ctx context.Context, id string, db int, key, member string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.SetAdd(ctx, db, key, member)
}

// RedisSetRemove deletes a member from a set.
func (s *Service) RedisSetRemove(ctx context.Context, id string, db int, key, member string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.SetRemove(ctx, db, key, member)
}

// RedisZSetAdd inserts a sorted-set member or updates its score.
func (s *Service) RedisZSetAdd(ctx context.Context, id string, db int, key, member string, score float64) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.ZSetAdd(ctx, db, key, member, score)
}

// RedisZSetRemove deletes a member from a sorted set.
func (s *Service) RedisZSetRemove(ctx context.Context, id string, db int, key, member string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.ZSetRemove(ctx, db, key, member)
}

// RedisFlushDB empties the given DB (dangerous, audited by the caller).
func (s *Service) RedisFlushDB(ctx context.Context, id string, db int) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.FlushDB(ctx, db)
}

// RedisFlushAll empties the whole instance/cluster (dangerous, audited).
func (s *Service) RedisFlushAll(ctx context.Context, id string) error {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return err
	}
	return rds.FlushAll(ctx)
}

// RedisServerInfo builds the overview for the connection's Redis.
func (s *Service) RedisServerInfo(ctx context.Context, id string) (model.RedisServerInfo, error) {
	rds, err := s.redis(ctx, id)
	if err != nil {
		return model.RedisServerInfo{}, err
	}
	return rds.ServerInfo(ctx)
}

// CHTestConnection verifies connectivity to the given config without
// persisting or pooling anything (the client pings during construction).
func (s *Service) CHTestConnection(ctx context.Context, cfg model.ClickHouseConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	client, err := NewCHClient(cfg)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Connect(ctx)
}

// ch returns the pooled ClickHouse client for the connection, auto-connecting
// when the tree has not connected it yet.
func (s *Service) ch(ctx context.Context, id string) (ClickHouseDataSource, error) {
	if ds, err := s.pool.Get(id); err == nil {
		ch, ok := ds.(ClickHouseDataSource)
		if !ok {
			return nil, fmt.Errorf("connection %q is not a ClickHouse source", id)
		}
		return ch, nil
	}
	if err := s.ConnectConnection(ctx, id); err != nil {
		return nil, err
	}
	ds, err := s.pool.Get(id)
	if err != nil {
		return nil, err
	}
	ch, ok := ds.(ClickHouseDataSource)
	if !ok {
		return nil, fmt.Errorf("connection %q is not a ClickHouse source", id)
	}
	return ch, nil
}

// CHDatabases lists the user databases of the connection's ClickHouse server.
func (s *Service) CHDatabases(ctx context.Context, id string) ([]string, error) {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return nil, err
	}
	return ch.Databases(ctx)
}

// CHTables lists a database's tables (engine + approximate row counts).
func (s *Service) CHTables(ctx context.Context, id, database string, showSystem bool) ([]model.CHTableInfo, error) {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return nil, err
	}
	return ch.Tables(ctx, database, showSystem)
}

// CHPageRows returns one page of a table's rows with metadata.
func (s *Service) CHPageRows(ctx context.Context, id, database, table, where, orderBy string, asc bool, limit, offset int) (model.CHPageRowsResult, error) {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return model.CHPageRowsResult{}, err
	}
	return ch.PageRows(ctx, database, table, where, orderBy, asc, limit, offset)
}

// CHTruncateTable empties a table (dangerous, audited by the caller).
func (s *Service) CHTruncateTable(ctx context.Context, id, database, table string, onCluster bool) error {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return err
	}
	return ch.TruncateTable(ctx, database, table, onCluster)
}

// CHExecute runs a SQL script statement by statement.
func (s *Service) CHExecute(ctx context.Context, id, sqlText string) ([]model.CHStatementResult, error) {
	ch, err := s.ch(ctx, id)
	if err != nil {
		return nil, err
	}
	return ch.Execute(ctx, sqlText)
}

// MysqlTestConnection verifies connectivity to the given config without
// persisting or pooling anything (the client pings during construction).
func (s *Service) MysqlTestConnection(ctx context.Context, cfg model.MysqlConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	client, err := NewMysqlClient(cfg)
	if err != nil {
		return err
	}
	defer client.Close()
	return client.Connect(ctx)
}

// mysql returns the pooled MySQL/TiDB client for the connection,
// auto-connecting when the tree has not connected it yet.
func (s *Service) mysql(ctx context.Context, id string) (MysqlDataSource, error) {
	if ds, err := s.pool.Get(id); err == nil {
		m, ok := ds.(MysqlDataSource)
		if !ok {
			return nil, fmt.Errorf("connection %q is not a MySQL source", id)
		}
		return m, nil
	}
	if err := s.ConnectConnection(ctx, id); err != nil {
		return nil, err
	}
	ds, err := s.pool.Get(id)
	if err != nil {
		return nil, err
	}
	m, ok := ds.(MysqlDataSource)
	if !ok {
		return nil, fmt.Errorf("connection %q is not a MySQL source", id)
	}
	return m, nil
}

// CloseConnection removes a connection from the pool and closes it.
func (s *Service) CloseConnection(ctx context.Context, id string) error {
	ds, err := s.pool.Remove(id)
	if err != nil {
		return err
	}
	return ds.Close()
}

// PutPooledForTest registers a pre-built data source under id, bypassing any
// real connection. Test seam only: the ClickHouse driver has no offline fake
// server, so app/service-layer tests inject fakes through it.
func (s *Service) PutPooledForTest(id string, ds DataSource) error {
	return s.pool.Put(id, ds)
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

// DeleteTopics removes several topics from the connection's cluster and
// returns one result per topic.
func (s *Service) DeleteTopics(ctx context.Context, id string, names []string) ([]*model.TopicDeleteResult, error) {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return d.DeleteTopics(ctx, names)
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

// AlterTopicConfig applies whitelisted topic config values on the connection's
// cluster, auto-connecting if needed.
func (s *Service) AlterTopicConfig(ctx context.Context, id, topic string, entries []model.TopicConfigEntry) error {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return d.AlterTopicConfig(ctx, topic, entries)
}

// AlterTopicPartitions grows the topic to the requested final partition count
// on the connection's cluster, auto-connecting if needed.
func (s *Service) AlterTopicPartitions(ctx context.Context, id, topic string, target int32) error {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return d.AlterTopicPartitions(ctx, topic, target)
}

// GetTopicMessageCounts returns per-topic record counts derived from broker
// offsets, auto-connecting if needed.
func (s *Service) GetTopicMessageCounts(ctx context.Context, id string, topics ...string) (map[string]model.TopicMessageCounts, error) {
	d, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return d.GetTopicMessageCounts(ctx, topics...)
}

// DescribeCluster returns the cluster health snapshot (brokers, controller,
// Kafka version, under-replicated partitions), auto-connecting if needed.
func (s *Service) DescribeCluster(ctx context.Context, id string) (*model.ClusterHealth, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.DescribeCluster(ctx)
}

// ListConsumerGroups lists consumer groups with lag on the connection.
func (s *Service) ListConsumerGroups(ctx context.Context, id string) ([]*model.ConsumerGroup, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ListConsumerGroups(ctx)
}

// DescribeGroup describes one consumer group's state and member topology,
// auto-connecting if needed.
func (s *Service) DescribeGroup(ctx context.Context, id, group string) (*model.GroupDetail, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.DescribeGroup(ctx, group)
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
func (s *Service) ResetConsumerGroupOffset(ctx context.Context, id, group, topic string, mode model.ResetOffsetMode, timestampMS int64, offsets map[int32]int64) error {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return kds.ResetConsumerGroupOffset(ctx, group, topic, mode, timestampMS, offsets)
}

// PreviewResetOffset returns the per-partition target offsets a reset would
// commit (read-only dry-run), auto-connecting if needed.
func (s *Service) PreviewResetOffset(ctx context.Context, id, topic string, mode model.ResetOffsetMode, timestampMS int64) (map[int32]int64, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.PreviewResetOffset(ctx, topic, mode, timestampMS)
}

// ProduceMessage publishes a record to the connection.
func (s *Service) ProduceMessage(ctx context.Context, id, topic string, partition int32, key, value []byte) error {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return err
	}
	return kds.ProduceMessage(ctx, topic, partition, key, value)
}

// ProduceMessages publishes a batch of records to the connection and returns
// one result per message.
func (s *Service) ProduceMessages(ctx context.Context, id, topic string, partition int32, messages []model.BatchProduceMessage) ([]*model.ProduceResult, error) {
	kds, err := s.kafka(ctx, id)
	if err != nil {
		return nil, err
	}
	return kds.ProduceMessages(ctx, topic, partition, messages)
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
	kcfg, err := c.KafkaConfig()
	if err != nil {
		return nil, fmt.Errorf("decode kafka config: %w", err)
	}
	kds, err := s.factory.NewKafkaClient(ctx, kcfg)
	if err != nil {
		return nil, fmt.Errorf("create client: %w", err)
	}
	if err := kds.Connect(ctx); err != nil {
		kds.Close()
		return nil, fmt.Errorf("connect: %w", err)
	}
	return kds, nil
}
