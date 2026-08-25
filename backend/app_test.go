package backend

import (
	"context"
	"fmt"
	"testing"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"

	"dataBasePro/backend/internal/kafka"
	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
	"dataBasePro/backend/internal/store"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	st, err := store.Open(t.TempDir()+"/config.db", "test-master")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	svc := service.NewService(st, service.ClientFactoryFunc(
		func(ctx context.Context, cfg model.KafkaConfig) (service.KafkaDataSource, error) {
			return kafka.NewClient("conn", cfg)
		}),
	)
	app := NewApp(svc)
	return app
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
