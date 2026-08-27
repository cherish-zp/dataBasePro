package kafka

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"

	"dataBasePro/backend/internal/model"
)

// describeTopicConfigKeys whitelists the topic configs surfaced in
// TopicDetail.Configs. The full DescribeConfigs response contains dozens of
// keys; only these handful of core entries are mapped through.
var describeTopicConfigKeys = map[string]struct{}{
	"retention.ms":        {},
	"cleanup.policy":      {},
	"segment.bytes":       {},
	"retention.bytes":     {},
	"min.insync.replicas": {},
	"max.message.bytes":   {},
}

// DescribeTopic returns the partition topology (leader/replica/ISR per
// partition) and the whitelisted key configs for a single topic.
func (c *Client) DescribeTopic(ctx context.Context, name string) (*model.TopicDetail, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	details, err := c.admin.ListTopics(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("describe topic %q: %w", name, err)
	}
	td, ok := details[name]
	if !ok {
		return nil, fmt.Errorf("topic %q not found", name)
	}
	if td.Err != nil {
		return nil, fmt.Errorf("describe topic %q: %w", name, td.Err)
	}
	out := &model.TopicDetail{Name: name}
	for _, pd := range td.Partitions.Sorted() {
		out.Partitions = append(out.Partitions, model.Partition{
			ID:       pd.Partition,
			Leader:   pd.Leader,
			Replicas: pd.Replicas,
			ISR:      pd.ISR,
		})
	}

	configs, err := c.admin.DescribeTopicConfigs(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("describe topic %q configs: %w", name, err)
	}
	rc, rerr := configs.On(name, nil)
	if err := firstErr(err, rerr, rc.Err); err != nil {
		return nil, fmt.Errorf("describe topic %q configs: %w", name, err)
	}
	out.Configs = mapTopicConfigs(rc)
	return out, nil
}

// mapTopicConfigs keeps only the whitelisted keys of a described topic config
// resource and sorts the survivors by key for stable display.
func mapTopicConfigs(rc kadm.ResourceConfig) []model.TopicConfigEntry {
	out := make([]model.TopicConfigEntry, 0, len(rc.Configs))
	for _, cfg := range rc.Configs {
		if _, want := describeTopicConfigKeys[cfg.Key]; !want {
			continue
		}
		out = append(out, model.TopicConfigEntry{Key: cfg.Key, Value: cfg.MaybeValue()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// firstErr returns the first non-nil error of its arguments (or nil).
func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// ListTopics returns all topics with their partition metadata, sorted by name.
func (c *Client) ListTopics(ctx context.Context) ([]*model.Topic, error) {
	details, err := c.admin.ListTopics(ctx)
	if err != nil {
		return nil, fmt.Errorf("list topics: %w", err)
	}
	topics := make([]*model.Topic, 0, len(details))
	for name, td := range details {
		t := &model.Topic{Name: name}
		for _, pd := range td.Partitions.Sorted() {
			t.Partitions = append(t.Partitions, model.Partition{
				ID:       pd.Partition,
				Leader:   pd.Leader,
				Replicas: pd.Replicas,
				ISR:      pd.ISR,
			})
		}
		topics = append(topics, t)
	}
	sort.Slice(topics, func(i, j int) bool { return topics[i].Name < topics[j].Name })
	return topics, nil
}

// CreateTopic creates a topic with the requested partition count and
// replication factor.
func (c *Client) CreateTopic(ctx context.Context, name string, partitions int32, replicationFactor int16) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.admin.CreateTopic(ctx, partitions, replicationFactor, nil, name)
	if err != nil {
		return fmt.Errorf("create topic: %w", err)
	}
	if resp.Err != nil {
		return fmt.Errorf("create topic %q: %w", name, resp.Err)
	}
	return nil
}

// DeleteTopic removes a topic from the cluster.
func (c *Client) DeleteTopic(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.admin.DeleteTopic(ctx, name)
	if err != nil {
		return fmt.Errorf("delete topic: %w", err)
	}
	if resp.Err != nil {
		return fmt.Errorf("delete topic %q: %w", name, resp.Err)
	}
	return nil
}

// DeleteConsumerGroup removes an empty consumer group from the cluster.
// Groups with live members cannot be deleted and surface the broker error.
func (c *Client) DeleteConsumerGroup(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.admin.DeleteGroup(ctx, name)
	if err != nil {
		return fmt.Errorf("delete consumer group: %w", err)
	}
	if resp.Err != nil {
		return fmt.Errorf("delete consumer group %q: %w", name, resp.Err)
	}
	return nil
}

// ListConsumerGroups returns all consumer groups together with their per
// topic/partition lag, sorted by name.
func (c *Client) ListConsumerGroups(ctx context.Context) ([]*model.ConsumerGroup, error) {
	listed, err := c.admin.ListGroups(ctx)
	if err != nil {
		return nil, fmt.Errorf("list consumer groups: %w", err)
	}
	names := make([]string, 0, len(listed))
	for _, g := range listed {
		names = append(names, g.Group)
	}
	if len(names) == 0 {
		return []*model.ConsumerGroup{}, nil
	}
	sort.Strings(names)

	lags, err := c.admin.Lag(ctx, names...)
	if err != nil {
		return nil, fmt.Errorf("compute consumer group lag: %w", err)
	}

	groups := make([]*model.ConsumerGroup, 0, len(names))
	for _, name := range names {
		cg := &model.ConsumerGroup{Name: name, Topics: map[string][]model.PartitionLag{}}
		if dgl, ok := lags[name]; ok {
			cg.State = dgl.State
			for topic, partitions := range dgl.Lag {
				for _, m := range partitions {
					cg.Topics[topic] = append(cg.Topics[topic], mapPartitionLag(m))
				}
			}
		}
		groups = append(groups, cg)
	}
	return groups, nil
}

// mapPartitionLag converts a kadm per-partition lag into model form, carrying
// the group member that is consuming the partition when the group is active.
func mapPartitionLag(m kadm.GroupMemberLag) model.PartitionLag {
	pl := model.PartitionLag{
		Partition: m.Partition,
		Current:   m.Commit.At,
		LogEnd:    m.End.Offset,
		Lag:       m.Lag,
	}
	if m.Member != nil {
		pl.MemberID = m.Member.MemberID
		pl.ClientID = m.Member.ClientID
		pl.ClientHost = m.Member.ClientHost
	}
	return pl
}

// GetPartitionLag returns the lag per partition for a group on a topic.
func (c *Client) GetPartitionLag(ctx context.Context, topic, group string) (map[int32]int64, error) {
	lags, err := c.admin.Lag(ctx, group)
	if err != nil {
		return nil, fmt.Errorf("compute lag for group %s: %w", group, err)
	}
	out := map[int32]int64{}
	if dgl, ok := lags[group]; ok {
		if partitions, ok := dgl.Lag[topic]; ok {
			for p, m := range partitions {
				out[p] = m.Lag
			}
		}
	}
	return out, nil
}

// ResetConsumerGroupOffset resets the committed offset of group on topic.
// Supported modes are ResetOffsetEarliest, ResetOffsetLatest and
// ResetOffsetTime (with an explicit unix-millisecond timestamp).
func (c *Client) ResetConsumerGroupOffset(ctx context.Context, group, topic string, mode model.ResetOffsetMode, timestampMS int64) error {
	var (
		offsets kadm.Offsets
		err     error
	)
	switch mode {
	case model.ResetOffsetEarliest:
		var start kadm.ListedOffsets
		start, err = c.admin.ListStartOffsets(ctx, topic)
		if err == nil {
			offsets = start.Offsets()
		}
	case model.ResetOffsetLatest:
		var end kadm.ListedOffsets
		end, err = c.admin.ListEndOffsets(ctx, topic)
		if err == nil {
			offsets = end.Offsets()
		}
	case model.ResetOffsetTime:
		var at kadm.ListedOffsets
		at, err = c.admin.ListOffsetsAfterMilli(ctx, timestampMS, topic)
		if err == nil {
			offsets = at.Offsets()
		}
	default:
		return fmt.Errorf("unsupported reset mode %q", mode)
	}
	if err != nil {
		return fmt.Errorf("list offsets for reset: %w", err)
	}
	if _, err := c.admin.CommitOffsets(ctx, group, offsets); err != nil {
		return fmt.Errorf("commit reset offsets: %w", err)
	}
	return nil
}

// ListActiveProducers returns the producers currently producing to a topic.
func (c *Client) ListActiveProducers(ctx context.Context, topic string) ([]*model.ActiveProducer, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	producers, err := c.admin.DescribeProducers(ctx, kadm.TopicsSet{topic: {}})
	if err != nil {
		return nil, fmt.Errorf("describe producers for topic %q: %w", topic, err)
	}
	return mapActiveProducers(producers.SortedProducers()), nil
}

// mapActiveProducers converts kadm described producers into model form.
func mapActiveProducers(ps []kadm.DescribedProducer) []*model.ActiveProducer {
	out := make([]*model.ActiveProducer, 0, len(ps))
	for _, p := range ps {
		out = append(out, &model.ActiveProducer{
			Topic:         p.Topic,
			Partition:     p.Partition,
			ProducerID:    p.ProducerID,
			ProducerEpoch: p.ProducerEpoch,
			LastSequence:  p.LastSequence,
			LastTimestamp: p.LastTimestamp,
			Leader:        p.Leader,
		})
	}
	return out
}

// ListActiveConsumers returns the members of a group that are assigned
// partitions of the given topic.
func (c *Client) ListActiveConsumers(ctx context.Context, group, topic string) ([]*model.ActiveConsumer, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	groups, err := c.admin.DescribeGroups(ctx, group)
	if err != nil {
		return nil, fmt.Errorf("describe group %q: %w", group, err)
	}
	dg, ok := groups[group]
	if !ok {
		return []*model.ActiveConsumer{}, nil
	}
	if dg.Err != nil && !errors.Is(dg.Err, kerr.GroupIDNotFound) {
		return nil, fmt.Errorf("describe group %q: %w", group, dg.Err)
	}
	members := make([]consumerAssignment, 0, len(dg.Members))
	for _, m := range dg.Members {
		ca := consumerAssignment{MemberID: m.MemberID, ClientID: m.ClientID, ClientHost: m.ClientHost}
		if a, ok := m.Assigned.AsConsumer(); ok {
			topics := map[string][]int32{}
			for _, t := range a.Topics {
				topics[t.Topic] = append([]int32(nil), t.Partitions...)
			}
			ca.topics = topics
		}
		members = append(members, ca)
	}
	return mapActiveConsumers(members, topic), nil
}

// consumerAssignment carries the fields of a group member needed to filter by
// topic, decoupled from kadm so the mapping can be unit-tested.
type consumerAssignment struct {
	MemberID   string
	ClientID   string
	ClientHost string
	topics     map[string][]int32
}

// mapActiveConsumers keeps only members assigned to the given topic.
func mapActiveConsumers(members []consumerAssignment, topic string) []*model.ActiveConsumer {
	var out []*model.ActiveConsumer
	for _, m := range members {
		parts, ok := m.topics[topic]
		if !ok || len(parts) == 0 {
			continue
		}
		out = append(out, &model.ActiveConsumer{
			MemberID:   m.MemberID,
			ClientID:   m.ClientID,
			ClientHost: m.ClientHost,
			Partitions: parts,
		})
	}
	return out
}
