package kafka

import (
	"context"
	"reflect"
	"testing"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"

	"dataBasePro/backend/internal/model"
)

func rackPtr(s string) *string { return &s }

// metadataFixture returns a two-topic metadata snapshot with three brokers,
// two under-replicated partitions and one errored partition.
func metadataFixture() kadm.Metadata {
	return kadm.Metadata{
		Cluster:    "test-cluster",
		Controller: 2,
		Brokers: []kgo.BrokerMetadata{
			{NodeID: 0, Host: "b0", Port: 9092},
			{NodeID: 1, Host: "b1", Port: 9093, Rack: rackPtr("rack-a")},
			{NodeID: 2, Host: "b2", Port: 9094},
		},
		Topics: kadm.TopicDetails{
			"t": {
				Topic: "t",
				Partitions: kadm.PartitionDetails{
					0: {Topic: "t", Partition: 0, Leader: 0, Replicas: []int32{0}, ISR: []int32{0}},
					1: {Topic: "t", Partition: 1, Leader: 1, Replicas: []int32{1, 2}, ISR: []int32{1}},
					2: {Topic: "t", Partition: 2, Leader: 2, Replicas: []int32{0, 2}, ISR: []int32{0, 2}},
					3: {Topic: "t", Partition: 3, Leader: -1, Replicas: []int32{1}, ISR: []int32{}, Err: kerr.NotLeaderForPartition},
				},
			},
			"u": {
				Topic: "u",
				Partitions: kadm.PartitionDetails{
					0: {Topic: "u", Partition: 0, Leader: 1, Replicas: []int32{1, 0}, ISR: []int32{}},
				},
			},
		},
	}
}

func TestMapClusterHealthAssemblesBrokersControllerAndURP(t *testing.T) {
	m := metadataFixture()
	probes := []brokerProbe{
		{NodeID: 0, Version: "v3.7"},
		{NodeID: 1, Err: true},
		{NodeID: 2, Version: "at least v3.9"},
	}
	got := mapClusterHealth(m, probes)
	want := &model.ClusterHealth{
		ClusterID:    "test-cluster",
		ControllerID: 2,
		KafkaVersion: "at least v3.9", // prefers the controller broker's guess
		Brokers: []model.BrokerInfo{
			{ID: 0, Host: "b0", Port: 9092, Online: true, Version: "v3.7"},
			{ID: 1, Host: "b1", Port: 9093, Rack: "rack-a", Online: false},
			{ID: 2, Host: "b2", Port: 9094, Online: true, Version: "at least v3.9"},
		},
		UnderReplicatedPartitions: 2,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapClusterHealth mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestMapClusterHealthWithoutProbesKeepsBrokersOnline(t *testing.T) {
	got := mapClusterHealth(metadataFixture(), nil)
	want := &model.ClusterHealth{
		ClusterID:    "test-cluster",
		ControllerID: 2,
		Brokers: []model.BrokerInfo{
			{ID: 0, Host: "b0", Port: 9092, Online: true},
			{ID: 1, Host: "b1", Port: 9093, Rack: "rack-a", Online: true},
			{ID: 2, Host: "b2", Port: 9094, Online: true},
		},
		UnderReplicatedPartitions: 2,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mapClusterHealth mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestCountUnderReplicatedIgnoresErroredPartitions(t *testing.T) {
	topics := kadm.TopicDetails{
		"ok": {
			Topic: "ok",
			Partitions: kadm.PartitionDetails{
				0: {Topic: "ok", Partition: 0, Replicas: []int32{0}, ISR: []int32{0}},
				1: {Topic: "ok", Partition: 1, Replicas: []int32{0, 1}, ISR: []int32{}},
			},
		},
		"broken": {
			Topic:      "broken",
			Partitions: kadm.PartitionDetails{},
			Err:        kerr.UnknownTopicOrPartition,
		},
	}
	if got := countUnderReplicated(topics); got != 1 {
		t.Fatalf("expected 1 under-replicated partition, got %d", got)
	}
}

func TestDescribeClusterReportsBrokersControllerAndVersion(t *testing.T) {
	c, err := kfake.NewCluster(kfake.NumBrokers(3))
	if err != nil {
		t.Fatalf("kfake.NewCluster: %v", err)
	}
	t.Cleanup(c.Close)
	cl := newKafkaClient(t, c)

	h, err := cl.DescribeCluster(context.Background())
	if err != nil {
		t.Fatalf("DescribeCluster: %v", err)
	}
	if len(h.Brokers) != 3 {
		t.Fatalf("expected 3 brokers, got %d: %+v", len(h.Brokers), h.Brokers)
	}
	ids := map[int32]bool{}
	for _, b := range h.Brokers {
		ids[b.ID] = true
		if b.Host == "" || b.Port == 0 {
			t.Fatalf("broker %d missing host/port: %+v", b.ID, b)
		}
		if b.Version == "" {
			t.Fatalf("broker %d missing version guess: %+v", b.ID, b)
		}
		if !b.Online {
			t.Fatalf("broker %d should be online on a healthy cluster: %+v", b.ID, b)
		}
	}
	for id := int32(0); id < 3; id++ {
		if !ids[id] {
			t.Fatalf("missing broker id %d: %+v", id, h.Brokers)
		}
	}
	if h.ControllerID < 0 || !ids[h.ControllerID] {
		t.Fatalf("controller id must name a listed broker, got %d: %+v", h.ControllerID, h.Brokers)
	}
	if h.UnderReplicatedPartitions != 0 {
		t.Fatalf("expected 0 under-replicated partitions, got %d", h.UnderReplicatedPartitions)
	}
	if h.KafkaVersion == "" {
		t.Fatal("expected a non-empty Kafka version guess")
	}
}
