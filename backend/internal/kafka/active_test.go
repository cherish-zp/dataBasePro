package kafka

import (
	"context"
	"reflect"
	"testing"

	"github.com/twmb/franz-go/pkg/kadm"

	"dataBasePro/backend/internal/model"
)

func TestMapActiveProducers(t *testing.T) {
	in := []kadm.DescribedProducer{
		{Topic: "t1", Partition: 0, ProducerID: 101, ProducerEpoch: 3, LastSequence: 42, LastTimestamp: 1700000000000, Leader: 1},
		{Topic: "t1", Partition: 1, ProducerID: 202, ProducerEpoch: 1, LastSequence: 7, LastTimestamp: 1700000005000, Leader: 1},
	}
	got := mapActiveProducers(in)
	want := []*model.ActiveProducer{
		{Topic: "t1", Partition: 0, ProducerID: 101, ProducerEpoch: 3, LastSequence: 42, LastTimestamp: 1700000000000, Leader: 1},
		{Topic: "t1", Partition: 1, ProducerID: 202, ProducerEpoch: 1, LastSequence: 7, LastTimestamp: 1700000005000, Leader: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapActiveProducers mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestMapActiveConsumersFiltersByTopic(t *testing.T) {
	members := []consumerAssignment{
		{MemberID: "m-1", ClientID: "c-1", ClientHost: "10.0.0.1", topics: map[string][]int32{"t1": {0, 1}, "other": {0}}},
		{MemberID: "m-2", ClientID: "c-2", ClientHost: "10.0.0.2", topics: map[string][]int32{"t2": {0}}},
		{MemberID: "m-3", ClientID: "c-3", ClientHost: "10.0.0.3", topics: nil},
	}
	got := mapActiveConsumers(members, "t1")
	want := []*model.ActiveConsumer{
		{MemberID: "m-1", ClientID: "c-1", ClientHost: "10.0.0.1", Partitions: []int32{0, 1}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapActiveConsumers mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestListActiveProducersEmptyOnFakeCluster(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)
	producers, err := cl.ListActiveProducers(context.Background(), "t1")
	if err != nil {
		t.Fatalf("ListActiveProducers: %v", err)
	}
	if len(producers) != 0 {
		t.Fatalf("expected no active producers on fake cluster, got %+v", producers)
	}
}

func TestListActiveConsumersUnknownGroupOnFakeCluster(t *testing.T) {
	c := newCluster(t, 1, "t1")
	cl := newKafkaClient(t, c)
	consumers, err := cl.ListActiveConsumers(context.Background(), "no-such-group", "t1")
	if err != nil {
		t.Fatalf("ListActiveConsumers: %v", err)
	}
	if len(consumers) != 0 {
		t.Fatalf("expected no active consumers for unknown group, got %+v", consumers)
	}
}
