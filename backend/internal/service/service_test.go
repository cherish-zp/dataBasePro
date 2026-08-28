package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/store"
)

// fakeKafka implements KafkaDataSource for service-layer tests.
type fakeKafka struct {
	fakeDataSource
	topics     []*model.Topic
	msgs       []*model.Message
	lag        map[int32]int64
	group      []*model.ConsumerGroup
	producers  []*model.ActiveProducer
	consumers  []*model.ActiveConsumer
	resetCalls []model.ResetOffsetMode
	detail     *model.TopicDetail
	health     *model.ClusterHealth
	batchCalls [][]model.BatchProduceMessage
}

func (f *fakeKafka) ListTopics(context.Context) ([]*model.Topic, error)      { return f.topics, nil }
func (f *fakeKafka) CreateTopic(context.Context, string, int32, int16) error { return nil }
func (f *fakeKafka) DeleteTopic(context.Context, string) error               { return nil }
func (f *fakeKafka) DeleteConsumerGroup(context.Context, string) error       { return nil }
func (f *fakeKafka) ListConsumerGroups(context.Context) ([]*model.ConsumerGroup, error) {
	return f.group, nil
}
func (f *fakeKafka) ConsumeMessages(_ context.Context, _ string, _ int32, _ int64, _ int) ([]*model.Message, error) {
	return f.msgs, nil
}
func (f *fakeKafka) ConsumeMessagesByTimestamp(_ context.Context, _ string, _ int32, _ int64, _ int) ([]*model.Message, error) {
	return f.msgs, nil
}
func (f *fakeKafka) GetPartitionLag(context.Context, string, string) (map[int32]int64, error) {
	return f.lag, nil
}
func (f *fakeKafka) ResetConsumerGroupOffset(_ context.Context, _, _ string, mode model.ResetOffsetMode, _ int64) error {
	f.resetCalls = append(f.resetCalls, mode)
	return nil
}
func (f *fakeKafka) ProduceMessage(_ context.Context, _ string, _ int32, _, _ []byte) error {
	return nil
}

func (f *fakeKafka) ProduceMessages(_ context.Context, _ string, _ int32, msgs []model.BatchProduceMessage) ([]*model.ProduceResult, error) {
	f.batchCalls = append(f.batchCalls, msgs)
	out := make([]*model.ProduceResult, len(msgs))
	for i := range msgs {
		out[i] = &model.ProduceResult{Index: i, Partition: 0, Offset: int64(i)}
	}
	return out, nil
}
func (f *fakeKafka) ListActiveProducers(context.Context, string) ([]*model.ActiveProducer, error) {
	return f.producers, nil
}
func (f *fakeKafka) ListActiveConsumers(context.Context, string, string) ([]*model.ActiveConsumer, error) {
	return f.consumers, nil
}
func (f *fakeKafka) DescribeTopic(context.Context, string) (*model.TopicDetail, error) {
	return f.detail, nil
}
func (f *fakeKafka) DescribeCluster(context.Context) (*model.ClusterHealth, error) {
	return f.health, nil
}

type fakeFactory struct {
	mu      sync.Mutex
	created []model.KafkaConfig
	err     error
	k       *fakeKafka
}

func (f *fakeFactory) NewKafkaClient(_ context.Context, cfg model.KafkaConfig) (KafkaDataSource, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, cfg)
	if f.err != nil {
		return nil, f.err
	}
	return f.k, nil
}

func (f *fakeFactory) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.created)
}

func newTestService(t *testing.T) (*Service, *fakeFactory) {
	t.Helper()
	path := t.TempDir() + "/config.db"
	st, err := store.Open(path, "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	f := &fakeFactory{k: &fakeKafka{}}
	return NewService(st, f), f
}

func sampleConn() *model.Connection {
	return &model.Connection{
		Name: "local",
		Type: model.ConnectionTypeKafka,
		Config: model.KafkaConfig{
			BootstrapServers: []string{"localhost:9092"},
		},
	}
}

func TestCreateConnectionPersistsAndAssignsID(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()

	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	if c.ID == "" {
		t.Fatal("connection must receive a generated id")
	}
	got, err := svc.store.GetConnection(c.ID)
	if err != nil {
		t.Fatalf("connection not persisted: %v", err)
	}
	if got.Name != "local" {
		t.Fatalf("unexpected name: %s", got.Name)
	}
}

func TestCreateConnectionValidates(t *testing.T) {
	svc, _ := newTestService(t)
	bad := sampleConn()
	bad.Name = ""
	if _, err := svc.CreateConnection(context.Background(), bad); err == nil {
		t.Fatal("invalid connection must be rejected")
	}
}

func TestTestConnection(t *testing.T) {
	svc, f := newTestService(t)
	if err := svc.TestConnection(context.Background(), sampleConn().Config); err != nil {
		t.Fatalf("TestConnection: %v", err)
	}
	if f.count() != 1 {
		t.Fatalf("factory should have created 1 client, got %d", f.count())
	}
}

func TestTestConnectionFailure(t *testing.T) {
	svc, f := newTestService(t)
	f.err = errors.New("boom")
	if err := svc.TestConnection(context.Background(), sampleConn().Config); err == nil {
		t.Fatal("TestConnection must surface client errors")
	}
}

func TestListTopicsAutoConnects(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	f.k.topics = []*model.Topic{{Name: "t1"}}

	topics, err := svc.ListTopics(ctx, c.ID)
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	if len(topics) != 1 || topics[0].Name != "t1" {
		t.Fatalf("unexpected topics: %+v", topics)
	}
	if f.count() != 1 {
		t.Fatalf("expected client auto-created, got %d", f.count())
	}
	// The connection must now be pooled.
	if ds, err := svc.pool.Get(c.ID); err != nil || ds == nil {
		t.Fatal("connection should be pooled after auto-connect")
	}
}

func TestListTopicsUnknownConnection(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.ListTopics(context.Background(), "nope"); err == nil {
		t.Fatal("unknown connection must fail")
	}
}

func TestListConsumerGroupsDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	f.k.group = []*model.ConsumerGroup{{Name: "g1"}}

	groups, err := svc.ListConsumerGroups(ctx, c.ID)
	if err != nil {
		t.Fatalf("ListConsumerGroups: %v", err)
	}
	if len(groups) != 1 || groups[0].Name != "g1" {
		t.Fatalf("unexpected groups: %+v", groups)
	}
}

func TestConsumeMessagesDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	f.k.msgs = []*model.Message{{Partition: 0, Offset: 1}}

	msgs, err := svc.ConsumeMessages(ctx, c.ID, "t1", 0, model.OffsetEarliest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Offset != 1 {
		t.Fatalf("unexpected messages: %+v", msgs)
	}
}

func TestGetPartitionLagDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	f.k.lag = map[int32]int64{0: 5}

	lag, err := svc.GetPartitionLag(ctx, c.ID, "t1", "g1")
	if err != nil {
		t.Fatalf("GetPartitionLag: %v", err)
	}
	if lag[0] != 5 {
		t.Fatalf("unexpected lag: %+v", lag)
	}
}

func TestResetConsumerGroupOffsetDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())

	if err := svc.ResetConsumerGroupOffset(ctx, c.ID, "g1", "t1", model.ResetOffsetEarliest, 0); err != nil {
		t.Fatalf("ResetConsumerGroupOffset: %v", err)
	}
	if len(f.k.resetCalls) != 1 || f.k.resetCalls[0] != model.ResetOffsetEarliest {
		t.Fatalf("unexpected reset calls: %+v", f.k.resetCalls)
	}
}

func TestCloseConnectionRemovesFromPool(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	if _, err := svc.ListTopics(ctx, c.ID); err != nil {
		t.Fatalf("auto-connect: %v", err)
	}
	if err := svc.CloseConnection(ctx, c.ID); err != nil {
		t.Fatalf("CloseConnection: %v", err)
	}
	if _, err := svc.pool.Get(c.ID); err == nil {
		t.Fatal("connection must be removed from pool after CloseConnection")
	}
}

func TestCloseConnectionNotPooled(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	if err := svc.CloseConnection(ctx, c.ID); err == nil {
		t.Fatal("closing a non-pooled connection must fail")
	}
}

func TestDeleteConnectionRemovesPersisted(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	// Auto-connect so there is a pooled client to clean up.
	if _, err := svc.ListTopics(ctx, c.ID); err != nil {
		t.Fatalf("auto-connect: %v", err)
	}
	if err := svc.DeleteConnection(ctx, c.ID); err != nil {
		t.Fatalf("DeleteConnection: %v", err)
	}
	if _, err := svc.store.GetConnection(c.ID); err == nil {
		t.Fatal("connection must be removed from store")
	}
	if _, err := svc.pool.Get(c.ID); err == nil {
		t.Fatal("connection must be removed from pool")
	}
}

func TestProduceMessageDelegates(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	c, _ := svc.CreateConnection(ctx, sampleConn())
	if err := svc.ProduceMessage(ctx, c.ID, "t1", 0, []byte("k"), []byte("v")); err != nil {
		t.Fatalf("ProduceMessage: %v", err)
	}
}

func TestProduceMessagesDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	msgs := []model.BatchProduceMessage{
		{Key: "k-1", Value: "v-1"},
		{Key: "k-2", Value: "v-2"},
	}
	got, err := svc.ProduceMessages(ctx, c.ID, "t1", 0, msgs)
	if err != nil {
		t.Fatalf("ProduceMessages: %v", err)
	}
	if len(f.k.batchCalls) != 1 {
		t.Fatalf("expected 1 batch call, got %d", len(f.k.batchCalls))
	}
	if len(f.k.batchCalls[0]) != 2 || f.k.batchCalls[0][0].Key != "k-1" || f.k.batchCalls[0][1].Value != "v-2" {
		t.Fatalf("batch must be delegated verbatim, got %+v", f.k.batchCalls)
	}
	if len(got) != 2 || got[0].Index != 0 || got[1].Index != 1 || got[1].Offset != 1 {
		t.Fatalf("unexpected results: %+v", got)
	}
}

func TestDescribeTopicDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	want := &model.TopicDetail{Name: "t1"}
	f.k.detail = want
	got, err := svc.DescribeTopic(ctx, c.ID, "t1")
	if err != nil {
		t.Fatalf("DescribeTopic: %v", err)
	}
	if got != want {
		t.Fatalf("DescribeTopic must delegate to the data source, got %+v", got)
	}
}

func TestDescribeClusterDelegates(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	want := &model.ClusterHealth{ClusterID: "c-1"}
	f.k.health = want
	got, err := svc.DescribeCluster(ctx, c.ID)
	if err != nil {
		t.Fatalf("DescribeCluster: %v", err)
	}
	if got != want {
		t.Fatalf("DescribeCluster must delegate to the data source, got %+v", got)
	}
}

func TestListActiveProducers(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	f.k.producers = []*model.ActiveProducer{
		{Topic: "t1", Partition: 0, ProducerID: 101, ProducerEpoch: 2, LastSequence: 9, LastTimestamp: 1700000000000, Leader: 1},
	}
	got, err := svc.ListActiveProducers(ctx, c.ID, "t1")
	if err != nil {
		t.Fatalf("ListActiveProducers: %v", err)
	}
	if len(got) != 1 || got[0].ProducerID != 101 || got[0].Topic != "t1" {
		t.Fatalf("unexpected producers: %+v", got)
	}
}

func TestListActiveConsumers(t *testing.T) {
	svc, f := newTestService(t)
	ctx := context.Background()
	c, err := svc.CreateConnection(ctx, sampleConn())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	f.k.consumers = []*model.ActiveConsumer{
		{MemberID: "m-1", ClientID: "c-1", ClientHost: "10.0.0.1", Partitions: []int32{0, 1}},
	}
	got, err := svc.ListActiveConsumers(ctx, c.ID, "grp", "t1")
	if err != nil {
		t.Fatalf("ListActiveConsumers: %v", err)
	}
	if len(got) != 1 || got[0].MemberID != "m-1" || len(got[0].Partitions) != 2 {
		t.Fatalf("unexpected consumers: %+v", got)
	}
}
