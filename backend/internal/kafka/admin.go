package kafka

import (
	"context"
	"fmt"
	"sort"

	"github.com/twmb/franz-go/pkg/kadm"

	"dataBasePro/backend/internal/model"
)

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
				for p, m := range partitions {
					cg.Topics[topic] = append(cg.Topics[topic], model.PartitionLag{
						Partition: p,
						Current:   m.Commit.At,
						LogEnd:    m.End.Offset,
						Lag:       m.Lag,
					})
				}
			}
		}
		groups = append(groups, cg)
	}
	return groups, nil
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
