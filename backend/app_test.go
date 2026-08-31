package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"

	"dataBasePro/backend/internal/kafka"
	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
	"dataBasePro/backend/internal/store"
)

func newTestApp(t *testing.T) *App {
	return newTestAppWithFactory(t, service.ClientFactoryFunc(
		func(ctx context.Context, cfg model.KafkaConfig) (service.KafkaDataSource, error) {
			return kafka.NewClient("conn", cfg)
		}),
	)
}

func newTestAppWithFactory(t *testing.T, factory service.ClientFactory) *App {
	t.Helper()
	st, err := store.Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	svc := service.NewService(st, factory)
	return NewApp(svc)
}

func TestAppCreateAndListConnections(t *testing.T) {
	app := newTestApp(t)

	created, err := app.CreateConnection(&model.Connection{
		Name:   "local",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	if created.ID == "" {
		t.Fatal("id must be assigned")
	}

	list, err := app.ListConnections()
	if err != nil {
		t.Fatalf("ListConnections: %v", err)
	}
	if len(list) != 1 || list[0].Name != "local" {
		t.Fatalf("unexpected connections: %+v", list)
	}
}

func TestAppCreateConnectionValidation(t *testing.T) {
	app := newTestApp(t)
	_, err := app.CreateConnection(&model.Connection{Name: "", Type: model.ConnectionTypeKafka})
	if err == nil {
		t.Fatal("invalid connection must be rejected")
	}
}

func TestAppAuditsCreateConnection(t *testing.T) {
	app := newTestApp(t)

	created, err := app.CreateConnection(&model.Connection{
		Name:   "local",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 audit entry, got %d", len(list))
	}
	e := list[0]
	if e.Action != "create_connection" || e.Result != "ok" || e.Target != "local" || e.ConnectionID != created.ID {
		t.Fatalf("unexpected create audit: %+v", e)
	}
	if e.Timestamp == 0 {
		t.Fatal("audit timestamp must be set")
	}
}

func TestAppAuditsFailedCreateConnection(t *testing.T) {
	app := newTestApp(t)

	_, err := app.CreateConnection(&model.Connection{Name: "", Type: model.ConnectionTypeKafka})
	if err == nil {
		t.Fatal("invalid connection must be rejected")
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 audit entry for failed create, got %d", len(list))
	}
	e := list[0]
	if e.Action != "create_connection" || e.Result != "error" || e.Detail == "" {
		t.Fatalf("failed create must be audited with error detail: %+v", e)
	}
}

func TestAppAuditsDeleteConnectionWithNameTarget(t *testing.T) {
	app := newTestApp(t)

	created, err := app.CreateConnection(&model.Connection{
		Name:   "local",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}
	if err := app.DeleteConnection(created.ID); err != nil {
		t.Fatalf("DeleteConnection: %v", err)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// Newest first: [0] delete, [1] create.
	if len(list) != 2 {
		t.Fatalf("expected 2 audit entries, got %d", len(list))
	}
	e := list[0]
	if e.Action != "delete_connection" || e.Result != "ok" || e.Target != "local" || e.ConnectionID != created.ID {
		t.Fatalf("unexpected delete audit: %+v", e)
	}
}

func TestAppAuditsFailedDeleteConnection(t *testing.T) {
	app := newTestApp(t)

	if err := app.DeleteConnection("nope"); err == nil {
		t.Fatal("deleting a missing connection must fail")
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 audit entry for failed delete, got %d", len(list))
	}
	e := list[0]
	if e.Action != "delete_connection" || e.Result != "error" || e.Target != "nope" || e.Detail == "" {
		t.Fatalf("failed delete must be audited with the raw id target: %+v", e)
	}
}

func TestAppListAuditDefaultLimit(t *testing.T) {
	app := newTestApp(t)

	for i := 0; i < 3; i++ {
		if _, err := app.CreateConnection(&model.Connection{
			Name:   fmt.Sprintf("c-%d", i),
			Type:   model.ConnectionTypeKafka,
			Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
		}); err != nil {
			t.Fatalf("create #%d: %v", i, err)
		}
	}
	list, err := app.ListAudit(0)
	if err != nil {
		t.Fatalf("ListAudit(0): %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("ListAudit(0) must fall back to the default limit, got %d", len(list))
	}
}

// TestAppEndToEnd exercises the full stack (App -> Service -> kafka client)
// against a fake Kafka cluster: connect, list topics, consume, produce, lag.
func TestAppEndToEnd(t *testing.T) {
	cluster, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(1, "events"))
	if err != nil {
		t.Fatalf("kfake cluster: %v", err)
	}
	t.Cleanup(cluster.Close)

	producer, err := kgo.NewClient(kgo.SeedBrokers(cluster.ListenAddrs()...))
	if err != nil {
		t.Fatalf("producer: %v", err)
	}
	for i := 0; i < 5; i++ {
		producer.Produce(context.Background(), &kgo.Record{
			Topic: "events", Key: []byte(fmt.Sprintf("k%d", i)), Value: []byte(fmt.Sprintf("v%d", i)),
		}, nil)
	}
	if err := producer.Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	producer.Close()

	app := newTestApp(t)

	conn, err := app.CreateConnection(&model.Connection{
		Name:   "fake",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: cluster.ListenAddrs()},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}

	if err := app.Connect(conn.ID); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	topics, err := app.ListTopics(conn.ID)
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	if len(topics) != 1 || topics[0].Name != "events" {
		t.Fatalf("unexpected topics: %+v", topics)
	}

	msgs, err := app.ConsumeMessages(ConsumeRequest{
		ConnectionID: conn.ID, Topic: "events", Partition: 0, Offset: model.OffsetEarliest, Limit: 100,
	})
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages, got %d", len(msgs))
	}
	if string(msgs[0].Key) != "k0" || string(msgs[4].Value) != "v4" {
		t.Fatalf("unexpected first/last message: %+v", msgs)
	}

	if err := app.ProduceMessage(ProduceRequest{
		ConnectionID: conn.ID, Topic: "events", Partition: 0, Key: "hello", Value: "world",
	}); err != nil {
		t.Fatalf("ProduceMessage: %v", err)
	}
	msgs, err = app.ConsumeMessages(ConsumeRequest{
		ConnectionID: conn.ID, Topic: "events", Partition: 0, Offset: model.OffsetLatest, Limit: 1,
	})
	if err != nil {
		t.Fatalf("ConsumeMessages latest: %v", err)
	}
	if len(msgs) != 1 || string(msgs[0].Key) != "hello" {
		t.Fatalf("expected produced message at tail, got %+v", msgs)
	}

	if err := app.Disconnect(conn.ID); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
}

// fakeBatchKafka implements KafkaDataSource for DeleteTopics audit tests; every
// operation besides DeleteTopics is inert so the fake runs fully in the sandbox
// (no kfake loopback binding).
type fakeBatchKafka struct {
	failures []*model.TopicDeleteResult
	preview  map[int32]int64
}

func (f *fakeBatchKafka) Connect(context.Context) error { return nil }
func (f *fakeBatchKafka) Close() error                  { return nil }
func (f *fakeBatchKafka) GetName() string               { return "fake" }
func (f *fakeBatchKafka) GetType() string               { return string(model.ConnectionTypeKafka) }
func (f *fakeBatchKafka) ListTopics(context.Context) ([]*model.Topic, error) {
	return nil, nil
}
func (f *fakeBatchKafka) DescribeTopic(context.Context, string) (*model.TopicDetail, error) {
	return nil, nil
}
func (f *fakeBatchKafka) AlterTopicConfig(context.Context, string, []model.TopicConfigEntry) error {
	return nil
}
func (f *fakeBatchKafka) DescribeCluster(context.Context) (*model.ClusterHealth, error) {
	return nil, nil
}
func (f *fakeBatchKafka) CreateTopic(context.Context, string, int32, int16) error { return nil }
func (f *fakeBatchKafka) DeleteTopic(context.Context, string) error               { return nil }
func (f *fakeBatchKafka) DeleteTopics(_ context.Context, _ []string) ([]*model.TopicDeleteResult, error) {
	return f.failures, nil
}
func (f *fakeBatchKafka) DeleteConsumerGroup(context.Context, string) error { return nil }
func (f *fakeBatchKafka) ListConsumerGroups(context.Context) ([]*model.ConsumerGroup, error) {
	return nil, nil
}
func (f *fakeBatchKafka) DescribeGroup(context.Context, string) (*model.GroupDetail, error) {
	return nil, nil
}
func (f *fakeBatchKafka) ConsumeMessages(context.Context, string, int32, int64, int) ([]*model.Message, error) {
	return nil, nil
}
func (f *fakeBatchKafka) ConsumeMessagesByTimestamp(context.Context, string, int32, int64, int) ([]*model.Message, error) {
	return nil, nil
}
func (f *fakeBatchKafka) GetPartitionLag(context.Context, string, string) (map[int32]int64, error) {
	return nil, nil
}
func (f *fakeBatchKafka) ListActiveProducers(context.Context, string) ([]*model.ActiveProducer, error) {
	return nil, nil
}
func (f *fakeBatchKafka) ListActiveConsumers(context.Context, string, string) ([]*model.ActiveConsumer, error) {
	return nil, nil
}
func (f *fakeBatchKafka) ResetConsumerGroupOffset(context.Context, string, string, model.ResetOffsetMode, int64) error {
	return nil
}
func (f *fakeBatchKafka) PreviewResetOffset(context.Context, string, model.ResetOffsetMode, int64) (map[int32]int64, error) {
	return f.preview, nil
}
func (f *fakeBatchKafka) ProduceMessage(context.Context, string, int32, []byte, []byte) error {
	return nil
}
func (f *fakeBatchKafka) ProduceMessages(context.Context, string, int32, []model.BatchProduceMessage) ([]*model.ProduceResult, error) {
	return nil, nil
}

// joinFailureLines renders the audit detail text the app is expected to write
// for the given per-topic failures (mirror of the production join).
func joinFailureLines(rs []*model.TopicDeleteResult) string {
	lines := make([]string, 0, len(rs))
	for _, r := range rs {
		lines = append(lines, fmt.Sprintf("%s: %s", r.Name, r.Error))
	}
	return strings.Join(lines, "; ")
}

func TestAppAuditsDeleteTopicsFailureDetailCapped(t *testing.T) {
	fake := &fakeBatchKafka{}
	app := newTestAppWithFactory(t, service.ClientFactoryFunc(
		func(context.Context, model.KafkaConfig) (service.KafkaDataSource, error) { return fake, nil },
	))
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "local",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}

	names := make([]string, 0, 15)
	failures := make([]*model.TopicDeleteResult, 0, 15)
	for i := 0; i < 15; i++ {
		name := fmt.Sprintf("t%02d", i)
		names = append(names, name)
		failures = append(failures, &model.TopicDeleteResult{Name: name, Error: "delete failed"})
	}
	fake.failures = failures

	results, err := app.DeleteTopics(DeleteTopicsRequest{ConnectionID: conn.ID, Names: names})
	if err != nil {
		t.Fatalf("DeleteTopics: %v", err)
	}
	if len(results) != 15 {
		t.Fatalf("expected 15 results, got %d", len(results))
	}

	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// Newest first: [0] delete_topics, [1] create_connection.
	if len(list) != 2 {
		t.Fatalf("expected 2 audit entries, got %d", len(list))
	}
	e := list[0]
	if e.Action != "delete_topics" || e.Result != "error" {
		t.Fatalf("unexpected delete_topics audit: %+v", e)
	}
	want := joinFailureLines(failures[:10]) + "…"
	if e.Detail != want {
		t.Fatalf("detail must cap at 10 failures with ellipsis, got %q want %q", e.Detail, want)
	}
}

func TestAppAuditsDeleteTopicsFailureDetailFull(t *testing.T) {
	fake := &fakeBatchKafka{}
	app := newTestAppWithFactory(t, service.ClientFactoryFunc(
		func(context.Context, model.KafkaConfig) (service.KafkaDataSource, error) { return fake, nil },
	))
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "local",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}

	names := make([]string, 0, 5)
	failures := make([]*model.TopicDeleteResult, 0, 5)
	for i := 0; i < 5; i++ {
		name := fmt.Sprintf("t%02d", i)
		names = append(names, name)
		failures = append(failures, &model.TopicDeleteResult{Name: name, Error: "delete failed"})
	}
	fake.failures = failures

	if _, err := app.DeleteTopics(DeleteTopicsRequest{ConnectionID: conn.ID, Names: names}); err != nil {
		t.Fatalf("DeleteTopics: %v", err)
	}
	list, err := app.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	// Newest first: [0] delete_topics, [1] create_connection.
	if len(list) != 2 {
		t.Fatalf("expected 2 audit entries, got %d", len(list))
	}
	if want := joinFailureLines(failures); list[0].Detail != want {
		t.Fatalf("detail must join all failures under the cap, got %q want %q", list[0].Detail, want)
	}
}

func TestAppPreviewResetOffsetDelegates(t *testing.T) {
	fake := &fakeBatchKafka{preview: map[int32]int64{0: 0, 1: 15}}
	app := newTestAppWithFactory(t, service.ClientFactoryFunc(
		func(context.Context, model.KafkaConfig) (service.KafkaDataSource, error) { return fake, nil },
	))
	conn, err := app.CreateConnection(&model.Connection{
		Name:   "local",
		Type:   model.ConnectionTypeKafka,
		Config: model.KafkaConfig{BootstrapServers: []string{"localhost:9092"}},
	})
	if err != nil {
		t.Fatalf("CreateConnection: %v", err)
	}

	got, err := app.PreviewResetOffset(ResetOffsetRequest{
		ConnectionID: conn.ID, Group: "grp-1", Topic: "orders", Mode: model.ResetOffsetEarliest,
	})
	if err != nil {
		t.Fatalf("PreviewResetOffset: %v", err)
	}
	if got[0] != 0 || got[1] != 15 {
		t.Fatalf("unexpected preview: %+v", got)
	}
}

// TestBatchProduceRequestJSONShape locks the wire shape of the batch produce
// request (the type the frontend actually serializes). The model package's
// former dead ProduceRequest copy was removed (BL-030); this test moved to the
// binding package so snake_case coverage is not lost.
func TestBatchProduceRequestJSONShape(t *testing.T) {
	req := BatchProduceRequest{
		ConnectionID: "c-1",
		Topic:        "orders",
		Partition:    -1,
		Messages:     []model.BatchProduceMessage{{Key: "k", Value: "v"}},
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"connection_id", "topic", "partition", "messages"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("BatchProduceRequest JSON must expose snake_case key %q, got %s", key, b)
		}
	}
	msgs, ok := raw["messages"].([]any)
	if !ok || len(msgs) != 1 {
		t.Fatalf("messages must marshal as an array, got %s", b)
	}
	first, _ := msgs[0].(map[string]any)
	if _, ok := first["key"]; !ok {
		t.Fatalf("batch message must expose key, got %s", b)
	}
	if _, ok := first["value"]; !ok {
		t.Fatalf("batch message must expose value, got %s", b)
	}
}
