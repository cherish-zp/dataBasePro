package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"

	"dataBasePro/backend/internal/model"
)

// newCluster spins up a single-broker fake Kafka cluster with the given topics
// (each with the requested partition count) and returns it.
func newCluster(t *testing.T, partitions int32, topics ...string) *kfake.Cluster {
	t.Helper()
	c, err := kfake.NewCluster(kfake.NumBrokers(1), kfake.SeedTopics(partitions, topics...))
	if err != nil {
		t.Fatalf("kfake.NewCluster: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

func newKafkaClient(t *testing.T, c *kfake.Cluster) *Client {
	t.Helper()
	cl, err := NewClient("fake-cluster", model.KafkaConfig{BootstrapServers: c.ListenAddrs()})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = cl.Close() })
	return cl
}

// seedMessages produces n records to the topic/partition with deterministic
// keys, values and ascending timestamps starting at baseMS.
func seedMessages(t *testing.T, c *kfake.Cluster, topic string, partition int32, n int, baseMS int64) {
	t.Helper()
	producer, err := kgo.NewClient(
		kgo.SeedBrokers(c.ListenAddrs()...),
		kgo.RecordPartitioner(kgo.ManualPartitioner()),
	)
	if err != nil {
		t.Fatalf("producer client: %v", err)
	}
	defer producer.Close()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		rec := &kgo.Record{
			Topic:     topic,
			Partition: partition,
			Key:       []byte(fmt.Sprintf("k-%d", i)),
			Value:     []byte(fmt.Sprintf("v-%d", i)),
		}
		if baseMS > 0 {
			rec.Timestamp = time.UnixMilli(baseMS + int64(i)*1000)
		}
		producer.Produce(ctx, rec, nil)
	}
	if err := producer.Flush(ctx); err != nil {
		t.Fatalf("flush produced records: %v", err)
	}
}

func TestConnectAndListTopics(t *testing.T) {
	c := newCluster(t, 1, "user-log", "order-db")
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	topics, err := cl.ListTopics(ctx)
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	if len(topics) != 2 {
		t.Fatalf("expected 2 topics, got %d: %+v", len(topics), topics)
	}
	names := map[string]bool{}
	for _, tp := range topics {
		names[tp.Name] = true
		if len(tp.Partitions) != 1 {
			t.Fatalf("topic %s: expected 1 partition, got %d", tp.Name, len(tp.Partitions))
		}
	}
	if !names["user-log"] || !names["order-db"] {
		t.Fatalf("missing expected topics: %v", names)
	}
}

func TestListTopicsMultiplePartitions(t *testing.T) {
	c := newCluster(t, 3, "multi")
	cl := newKafkaClient(t, c)
	topics, err := cl.ListTopics(context.Background())
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	if len(topics) != 1 || len(topics[0].Partitions) != 3 {
		t.Fatalf("expected 1 topic with 3 partitions, got %+v", topics)
	}
	ids := map[int32]bool{}
	for _, p := range topics[0].Partitions {
		ids[p.ID] = true
	}
	for i := int32(0); i < 3; i++ {
		if !ids[i] {
			t.Fatalf("missing partition %d", i)
		}
	}
}

func TestConsumeMessagesFromEarliest(t *testing.T) {
	c := newCluster(t, 1, "t1")
	seedMessages(t, c, "t1", 0, 10, 0)
	cl := newKafkaClient(t, c)

	msgs, err := cl.ConsumeMessages(context.Background(), "t1", 0, model.OffsetEarliest, 5)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages, got %d", len(msgs))
	}
	for i, m := range msgs {
		if m.Offset != int64(i) {
			t.Fatalf("msg %d: expected offset %d, got %d", i, i, m.Offset)
		}
		if m.Key != fmt.Sprintf("k-%d", i) || m.Value != fmt.Sprintf("v-%d", i) {
			t.Fatalf("msg %d: unexpected key/value %q/%q", i, m.Key, m.Value)
		}
		if m.Partition != 0 {
			t.Fatalf("msg %d: expected partition 0, got %d", i, m.Partition)
		}
	}
}

func TestConsumeMessagesFromExactOffset(t *testing.T) {
	c := newCluster(t, 1, "t1")
	seedMessages(t, c, "t1", 0, 10, 0)
	cl := newKafkaClient(t, c)

	msgs, err := cl.ConsumeMessages(context.Background(), "t1", 0, 7, 3)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	if msgs[0].Offset != 7 {
		t.Fatalf("expected first offset 7, got %d", msgs[0].Offset)
	}
}

func TestConsumeMessagesLatestReturnsTail(t *testing.T) {
	c := newCluster(t, 1, "t1")
	seedMessages(t, c, "t1", 0, 10, 0)
	cl := newKafkaClient(t, c)

	msgs, err := cl.ConsumeMessages(context.Background(), "t1", 0, model.OffsetLatest, 3)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("expected 3 tail messages, got %d", len(msgs))
	}
	if msgs[0].Offset != 7 || msgs[2].Offset != 9 {
		t.Fatalf("expected tail offsets 7..9, got %d..%d", msgs[0].Offset, msgs[2].Offset)
	}
}

func TestConsumeMessagesByTimestamp(t *testing.T) {
	c := newCluster(t, 1, "t1")
	base := time.Now().Add(-time.Hour).UnixMilli()
	seedMessages(t, c, "t1", 0, 10, base)
	cl := newKafkaClient(t, c)

	// Messages are at base, base+1s, ..., base+9s. Ask for everything at or
	// after base+5s -> expect offsets 5..9 (5 messages).
	msgs, err := cl.ConsumeMessagesByTimestamp(context.Background(), "t1", 0, base+5000, 100)
	if err != nil {
		t.Fatalf("ConsumeMessagesByTimestamp: %v", err)
	}
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages at or after timestamp, got %d", len(msgs))
	}
	if msgs[0].Offset != 5 {
		t.Fatalf("expected first offset 5, got %d", msgs[0].Offset)
	}
}

func TestProduceMessage(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)

	if err := cl.ProduceMessage(context.Background(), "t1", 0, []byte("hello"), []byte("world")); err != nil {
		t.Fatalf("ProduceMessage: %v", err)
	}
	msgs, err := cl.ConsumeMessages(context.Background(), "t1", 0, model.OffsetEarliest, 1)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if len(msgs) != 1 || msgs[0].Key != "hello" || msgs[0].Value != "world" {
		t.Fatalf("produced message not visible: %+v", msgs)
	}
}

// consumeWithGroup reads n records from topic using a real consumer group and
// commits offsets, mimicking a production consumer.
func consumeWithGroup(t *testing.T, c *kfake.Cluster, group, topic string, n int) {
	t.Helper()
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.ListenAddrs()...),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topic),
	)
	if err != nil {
		t.Fatalf("group client: %v", err)
	}
	defer cl.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	got := 0
	for got < n {
		fetches := cl.PollFetches(ctx)
		if err := fetches.Err(); err != nil {
			t.Fatalf("group poll: %v", err)
		}
		recs := fetches.Records()
		if len(recs) == 0 {
			continue
		}
		toCommit := recs
		if remaining := n - got; len(toCommit) > remaining {
			toCommit = toCommit[:remaining]
		}
		if err := cl.CommitRecords(ctx, toCommit...); err != nil {
			t.Fatalf("commit records: %v", err)
		}
		got += len(toCommit)
	}
}

func TestListConsumerGroupsAndLag(t *testing.T) {
	c := newCluster(t, 1, "t1")
	seedMessages(t, c, "t1", 0, 10, 0)
	// A real consumer consumes and commits 4 of 10 records.
	consumeWithGroup(t, c, "grp-1", "t1", 4)
	cl := newKafkaClient(t, c)

	ctx := context.Background()
	groups, err := cl.ListConsumerGroups(ctx)
	if err != nil {
		t.Fatalf("ListConsumerGroups: %v", err)
	}
	if len(groups) != 1 || groups[0].Name != "grp-1" {
		t.Fatalf("expected 1 group grp-1, got %+v", groups)
	}

	lag, err := cl.GetPartitionLag(ctx, "t1", "grp-1")
	if err != nil {
		t.Fatalf("GetPartitionLag: %v", err)
	}
	if lag[0] != 6 {
		t.Fatalf("expected lag 6 for partition 0 (10 produced, 4 consumed), got %d", lag[0])
	}
}

func TestResetConsumerGroupOffset(t *testing.T) {
	c := newCluster(t, 1, "t1")
	seedMessages(t, c, "t1", 0, 10, 0)
	consumeWithGroup(t, c, "grp-1", "t1", 4)
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	// Reset to earliest: lag must become 10 (nothing consumed).
	if err := cl.ResetConsumerGroupOffset(ctx, "grp-1", "t1", model.ResetOffsetEarliest, 0); err != nil {
		t.Fatalf("reset to earliest: %v", err)
	}
	lag, _ := cl.GetPartitionLag(ctx, "t1", "grp-1")
	if lag[0] != 10 {
		t.Fatalf("after reset-to-earliest expected lag 10, got %d", lag[0])
	}

	// Reset to latest: lag must become 0.
	if err := cl.ResetConsumerGroupOffset(ctx, "grp-1", "t1", model.ResetOffsetLatest, 0); err != nil {
		t.Fatalf("reset to latest: %v", err)
	}
	lag, _ = cl.GetPartitionLag(ctx, "t1", "grp-1")
	if lag[0] != 0 {
		t.Fatalf("after reset-to-latest expected lag 0, got %d", lag[0])
	}
}

func TestResetConsumerGroupOffsetByTimestamp(t *testing.T) {
	c := newCluster(t, 1, "t1")
	base := time.Now().Add(-time.Hour).UnixMilli()
	seedMessages(t, c, "t1", 0, 10, base)
	consumeWithGroup(t, c, "grp-1", "t1", 10) // consume everything
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	// Reset to base+5000 (offset 5): 5 records remain unread -> lag 5.
	if err := cl.ResetConsumerGroupOffset(ctx, "grp-1", "t1", model.ResetOffsetTime, base+5000); err != nil {
		t.Fatalf("reset by timestamp: %v", err)
	}
	lag, _ := cl.GetPartitionLag(ctx, "t1", "grp-1")
	if lag[0] != 5 {
		t.Fatalf("expected lag 5 after timestamp reset, got %d", lag[0])
	}
}

func TestConsumeMessagesAllPartitionsEarliest(t *testing.T) {
	c := newCluster(t, 2, "multi")
	seedMessages(t, c, "multi", 0, 5, 0)
	seedMessages(t, c, "multi", 1, 5, 0)
	cl := newKafkaClient(t, c)

	msgs, err := cl.ConsumeMessages(context.Background(), "multi", -1, model.OffsetEarliest, 100)
	if err != nil {
		t.Fatalf("ConsumeMessages all partitions: %v", err)
	}
	if len(msgs) != 10 {
		t.Fatalf("expected 10 messages across both partitions, got %d", len(msgs))
	}
	seen := map[int32]map[int64]bool{}
	for _, m := range msgs {
		if seen[m.Partition] == nil {
			seen[m.Partition] = map[int64]bool{}
		}
		seen[m.Partition][m.Offset] = true
	}
	for p := int32(0); p < 2; p++ {
		for o := int64(0); o < 5; o++ {
			if !seen[p][o] {
				t.Fatalf("missing partition %d offset %d", p, o)
			}
		}
	}
}

func TestConsumeMessagesAllPartitionsLatestTail(t *testing.T) {
	c := newCluster(t, 2, "multi")
	seedMessages(t, c, "multi", 0, 5, 0)
	seedMessages(t, c, "multi", 1, 5, 0)
	cl := newKafkaClient(t, c)

	msgs, err := cl.ConsumeMessages(context.Background(), "multi", -1, model.OffsetLatest, 100)
	if err != nil {
		t.Fatalf("ConsumeMessages all partitions latest: %v", err)
	}
	if len(msgs) != 10 {
		t.Fatalf("expected 10 messages from all partitions at tail, got %d", len(msgs))
	}
}

func TestConsumeMessagesByTimestampAllPartitions(t *testing.T) {
	c := newCluster(t, 2, "multi")
	base := time.Now().Add(-time.Hour).UnixMilli()
	seedMessages(t, c, "multi", 0, 5, base)
	seedMessages(t, c, "multi", 1, 5, base)
	cl := newKafkaClient(t, c)

	// Ask for everything at or after base+3s -> offsets 3..4 from both partitions.
	msgs, err := cl.ConsumeMessagesByTimestamp(context.Background(), "multi", -1, base+3000, 100)
	if err != nil {
		t.Fatalf("ConsumeMessagesByTimestamp all partitions: %v", err)
	}
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages (2 per partition), got %d", len(msgs))
	}
	for _, m := range msgs {
		if m.Offset < 3 {
			t.Fatalf("unexpected early offset %d in partition %d", m.Offset, m.Partition)
		}
	}
}

func TestProduceMessageHonorsExplicitPartition(t *testing.T) {
	c := newCluster(t, 2, "multi")
	cl := newKafkaClient(t, c)
	ctx := context.Background()

	if err := cl.ProduceMessage(ctx, "multi", 1, []byte("key"), []byte("value")); err != nil {
		t.Fatalf("ProduceMessage: %v", err)
	}
	// Only partition 1 should contain the record.
	msgs, err := cl.ConsumeMessages(ctx, "multi", 1, model.OffsetEarliest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages partition 1: %v", err)
	}
	if len(msgs) != 1 || string(msgs[0].Value) != "value" {
		t.Fatalf("expected the produced record on partition 1, got %+v", msgs)
	}
	msgs, err = cl.ConsumeMessages(ctx, "multi", 0, model.OffsetEarliest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages partition 0: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("partition 0 must be empty, got %+v", msgs)
	}
}

func TestListConsumerGroupsEmptyReturnsSlice(t *testing.T) {
	c := newCluster(t, 1, "empty-topic")
	cl := newKafkaClient(t, c)
	groups, err := cl.ListConsumerGroups(context.Background())
	if err != nil {
		t.Fatalf("ListConsumerGroups: %v", err)
	}
	if groups == nil {
		t.Fatal("ListConsumerGroups on a cluster without groups must return a non-nil slice")
	}
	if len(groups) != 0 {
		t.Fatalf("expected 0 groups, got %d", len(groups))
	}
	b, err := json.Marshal(groups)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty groups must serialize to [] over JSON, got %s", b)
	}
}

func TestConsumeMessagesNoOffsetsReturnsSlice(t *testing.T) {
	c := newCluster(t, 1, "empty-topic")
	cl := newKafkaClient(t, c)
	// A non-existent partition with OffsetLatest resolves to no offsets.
	msgs, err := cl.ConsumeMessages(context.Background(), "empty-topic", 42, model.OffsetLatest, 10)
	if err != nil {
		t.Fatalf("ConsumeMessages: %v", err)
	}
	if msgs == nil {
		t.Fatal("ConsumeMessages with no resolvable offsets must return a non-nil slice")
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(msgs))
	}
	b, err := json.Marshal(msgs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty messages must serialize to [] over JSON, got %s", b)
	}
}

func TestCreateTopic(t *testing.T) {
	c := newCluster(t, 1, "existing")
	cl := newKafkaClient(t, c)

	if err := cl.CreateTopic(context.Background(), "brand-new", 2, 1); err != nil {
		t.Fatalf("CreateTopic: %v", err)
	}
	topics, err := cl.ListTopics(context.Background())
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	var created *model.Topic
	for _, tp := range topics {
		if tp.Name == "brand-new" {
			created = tp
			break
		}
	}
	if created == nil {
		t.Fatalf("created topic not found in ListTopics: %+v", topics)
	}
	if len(created.Partitions) != 2 {
		t.Fatalf("expected created topic to have 2 partitions, got %d", len(created.Partitions))
	}
}

func TestDeleteTopic(t *testing.T) {
	c := newCluster(t, 1, "t1", "t2")
	cl := newKafkaClient(t, c)

	if err := cl.DeleteTopic(context.Background(), "t1"); err != nil {
		t.Fatalf("DeleteTopic: %v", err)
	}
	topics, err := cl.ListTopics(context.Background())
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	for _, tp := range topics {
		if tp.Name == "t1" {
			t.Fatalf("topic t1 should have been deleted, still present: %+v", topics)
		}
	}
}
