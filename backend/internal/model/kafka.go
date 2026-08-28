package model

// Offset sentinels for ConsumeMessages. Values >= 0 are absolute offsets,
// while these negative constants select well-known positions.
const (
	OffsetEarliest int64 = -2 // consume from the earliest available offset
	OffsetLatest   int64 = -1 // consume from the latest available offset
)

// Topic is a Kafka topic together with its partition metadata.
type Topic struct {
	Name       string      `json:"name"`
	Partitions []Partition `json:"partitions"`
}

// Partition carries metadata for a single Kafka partition.
type Partition struct {
	ID       int32   `json:"id"`
	Leader   int32   `json:"leader"`
	Replicas []int32 `json:"replicas"`
	ISR      []int32 `json:"isr"`
}

// Message is a single Kafka record surfaced to the UI.
type Message struct {
	Partition int32    `json:"partition"`
	Offset    int64    `json:"offset"`
	Timestamp int64    `json:"timestamp"` // unix milliseconds
	Key       string   `json:"key"`
	Value     string   `json:"value"`
	Headers   []Header `json:"headers"`
}

// Header is a Kafka record header.
type Header struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ConsumerGroup summarises a consumer group and its per-partition lag.
type ConsumerGroup struct {
	Name   string                    `json:"name"`
	State  string                    `json:"state"`
	Topics map[string][]PartitionLag `json:"topics"`
}

// PartitionLag holds current/end offsets and the computed lag for one partition,
// together with the group member consuming it (empty when the group is Empty).
type PartitionLag struct {
	Partition  int32  `json:"partition"`
	Current    int64  `json:"current_offset"`
	LogEnd     int64  `json:"log_end_offset"`
	Lag        int64  `json:"lag"`
	MemberID   string `json:"member_id,omitempty"`
	ClientID   string `json:"client_id,omitempty"`
	ClientHost string `json:"client_host,omitempty"`
}

// ResetOffsetMode selects how a consumer group offset is reset.
type ResetOffsetMode string

const (
	ResetOffsetEarliest ResetOffsetMode = "earliest"
	ResetOffsetLatest   ResetOffsetMode = "latest"
	ResetOffsetTime     ResetOffsetMode = "timestamp"
)

// ActiveProducer is a producer currently producing to a topic (KIP-664).
type ActiveProducer struct {
	Topic         string `json:"topic"`
	Partition     int32  `json:"partition"`
	ProducerID    int64  `json:"producer_id"`
	ProducerEpoch int16  `json:"producer_epoch"`
	LastSequence  int32  `json:"last_sequence"`
	LastTimestamp int64  `json:"last_timestamp"` // unix milliseconds
	Leader        int32  `json:"leader"`
}

// ActiveConsumer is a group member currently assigned partitions of a topic.
type ActiveConsumer struct {
	MemberID   string  `json:"member_id"`
	ClientID   string  `json:"client_id"`
	ClientHost string  `json:"client_host"`
	Partitions []int32 `json:"partitions"`
}

// GroupDetail describes one consumer group: its state plus the member
// topology with each member's per-topic partition assignment.
type GroupDetail struct {
	Group        string        `json:"group"`
	State        string        `json:"state"`
	ProtocolType string        `json:"protocol_type"`
	Members      []GroupMember `json:"members"`
}

// GroupMember is a member of a consumer group together with the partitions it
// was assigned per topic.
type GroupMember struct {
	MemberID   string             `json:"member_id"`
	ClientID   string             `json:"client_id"`
	Host       string             `json:"host"`
	Assignment map[string][]int32 `json:"assignment"`
}
