package kafka

import (
	"context"
	"fmt"
	"time"

	"dataBasePro/backend/internal/model"
)

// GetTopicMessageCounts returns per-topic record counts derived from broker
// offsets for exactly the requested topics. Both offset list requests are
// batched per broker by kadm, so the cost is O(1) metadata lookups per
// partition rather than a log scan. Partitions whose offset fetch fails are
// skipped (contributing zero) so one offline partition cannot hide the rest
// of the topic's counts.
func (c *Client) GetTopicMessageCounts(ctx context.Context, topics ...string) (map[string]model.TopicMessageCounts, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if len(topics) == 0 {
		return map[string]model.TopicMessageCounts{}, nil
	}
	start, err := c.admin.ListStartOffsets(ctx, topics...)
	if err != nil {
		return nil, fmt.Errorf("list start offsets: %w", err)
	}
	end, err := c.admin.ListEndOffsets(ctx, topics...)
	if err != nil {
		return nil, fmt.Errorf("list end offsets: %w", err)
	}
	out := make(map[string]model.TopicMessageCounts, len(topics))
	for _, topic := range topics {
		counts := model.TopicMessageCounts{}
		for _, lo := range end[topic] {
			if lo.Err != nil {
				continue
			}
			counts.Total += lo.Offset
			counts.Retained += lo.Offset - start[topic][lo.Partition].Offset
		}
		out[topic] = counts
	}
	return out, nil
}
