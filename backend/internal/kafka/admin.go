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

// brokerProbe carries the fields of a per-broker API-versions probe needed to
// decide its online state and Kafka version guess, decoupled from kadm so the
// mapping can be unit-tested without a live cluster.
type brokerProbe struct {
	NodeID  int32
	Version string // best-guess Kafka version from the API versions response
	Err     bool   // probe failed -> broker considered offline
}

// DescribeCluster returns a health snapshot of the cluster: broker topology
// (id/host/port/rack), controller, Kafka version and under-replicated
// partitions. Broker online state derives from each broker's API versions
// probe; when probes cannot be fetched at all, brokers are reported online
// with an unknown version rather than failing the whole call.
func (c *Client) DescribeCluster(ctx context.Context) (*model.ClusterHealth, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	meta, err := c.admin.Metadata(ctx)
	if err != nil {
		return nil, fmt.Errorf("describe cluster: %w", err)
	}
	var probes []brokerProbe
	if avs, perr := c.admin.ApiVersions(ctx); perr == nil {
		probes = extractProbes(avs)
	}
	return mapClusterHealth(meta, probes), nil
}

// extractProbes converts kadm API-version responses into broker probes,
// guessing each healthy broker's Kafka version.
func extractProbes(avs kadm.BrokersApiVersions) []brokerProbe {
	probes := make([]brokerProbe, 0, len(avs))
	for _, v := range avs.Sorted() {
		p := brokerProbe{NodeID: v.NodeID}
		if v.Err != nil {
			p.Err = true
		} else {
			p.Version = v.VersionGuess()
		}
		probes = append(probes, p)
	}
	return probes
}

// mapClusterHealth assembles the model snapshot from cluster metadata plus
// optional per-broker probes (nil when probing failed wholesale).
func mapClusterHealth(m kadm.Metadata, probes []brokerProbe) *model.ClusterHealth {
	byNode := make(map[int32]brokerProbe, len(probes))
	for _, p := range probes {
		byNode[p.NodeID] = p
	}
	out := &model.ClusterHealth{
		ClusterID:    m.Cluster,
		ControllerID: m.Controller,
		Brokers:      make([]model.BrokerInfo, 0, len(m.Brokers)),
	}
	for _, b := range m.Brokers {
		bi := model.BrokerInfo{ID: b.NodeID, Host: b.Host, Port: b.Port, Online: true}
		if b.Rack != nil {
			bi.Rack = *b.Rack
		}
		if p, ok := byNode[b.NodeID]; ok {
			bi.Version = p.Version
			bi.Online = !p.Err
		}
		out.Brokers = append(out.Brokers, bi)
	}
	out.KafkaVersion = clusterVersion(byNode, m.Controller)
	out.UnderReplicatedPartitions = countUnderReplicated(m.Topics)
	return out
}

// clusterVersion returns the controller broker's version guess, falling back
// to the lowest healthy probed broker id. Empty when no broker answered.
func clusterVersion(probes map[int32]brokerProbe, controllerID int32) string {
	if p, ok := probes[controllerID]; ok && !p.Err && p.Version != "" {
		return p.Version
	}
	ids := make([]int32, 0, len(probes))
	for id := range probes {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		p := probes[id]
		if !p.Err && p.Version != "" {
			return p.Version
		}
	}
	return ""
}

// countUnderReplicated counts partitions whose ISR holds fewer replicas than
// their full replica assignment. Errored partitions are skipped because their
// ISR is unknown.
func countUnderReplicated(topics kadm.TopicDetails) int32 {
	n := int32(0)
	topics.EachPartition(func(d kadm.PartitionDetail) {
		if d.Err != nil {
			return
		}
		if len(d.ISR) < len(d.Replicas) {
			n++
		}
	})
	return n
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

// AlterTopicConfig applies the given whitelisted topic config values via an
// incremental alter (SET semantics). Any key outside describeTopicConfigKeys,
// an empty entry list, or an empty value fails the whole call before any
// alter is issued.
func (c *Client) AlterTopicConfig(ctx context.Context, name string, entries []model.TopicConfigEntry) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if len(entries) == 0 {
		return errors.New("无配置修改")
	}
	configs := make([]kadm.AlterConfig, 0, len(entries))
	for _, e := range entries {
		if _, ok := describeTopicConfigKeys[e.Key]; !ok {
			return fmt.Errorf("配置项 %q 不在可编辑白名单", e.Key)
		}
		if e.Value == "" {
			return fmt.Errorf("配置值不能为空: %q", e.Key)
		}
		v := e.Value
		configs = append(configs, kadm.AlterConfig{Op: kadm.SetConfig, Name: e.Key, Value: &v})
	}
	resp, err := c.admin.AlterTopicConfigs(ctx, configs, name)
	if err != nil {
		return fmt.Errorf("alter topic %q configs: %w", name, err)
	}
	for _, r := range resp {
		if r.Err != nil {
			return fmt.Errorf("alter topic %q configs: %w", name, r.Err)
		}
	}
	return nil
}

// AlterTopicPartitions grows a topic to the requested final partition count
// via an UpdatePartitions request (Kafka cannot shrink a topic). A target
// count below the current one is rejected locally with a clear error before
// any broker call; an unknown topic surfaces the broker's own error.
func (c *Client) AlterTopicPartitions(ctx context.Context, name string, target int32) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	details, err := c.admin.ListTopics(ctx, name)
	if err != nil {
		return fmt.Errorf("describe topic %q: %w", name, err)
	}
	td, ok := details[name]
	if !ok || td.Err != nil {
		return fmt.Errorf("topic %q not found", name)
	}
	current := int32(len(td.Partitions))
	if target < current {
		return fmt.Errorf("目标分区数 %d 不能少于当前分区数 %d（Kafka 仅支持扩容）", target, current)
	}
	if target == current {
		return fmt.Errorf("目标分区数等于当前分区数 %d，无需修改", current)
	}
	resp, err := c.admin.UpdatePartitions(ctx, int(target), name)
	if err != nil {
		return fmt.Errorf("alter topic %q partitions: %w", name, err)
	}
	r, rerr := resp.On(name, nil)
	return firstErr(rerr, r.Err)
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

// DeleteTopics removes several topics in one request and returns one result
// per topic, sorted by name. Per-topic broker failures (e.g. deleting an
// unknown topic) surface in the matching result's Error; the call itself only
// fails when the request cannot be issued at all.
func (c *Client) DeleteTopics(ctx context.Context, names []string) ([]*model.TopicDeleteResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.admin.DeleteTopics(ctx, names...)
	if err != nil {
		return nil, fmt.Errorf("delete topics: %w", err)
	}
	return mapDeleteResults(resp), nil
}

// mapDeleteResults converts kadm per-topic delete responses into model form,
// decoupled from kadm so the mapping can be unit-tested.
func mapDeleteResults(rs kadm.DeleteTopicResponses) []*model.TopicDeleteResult {
	out := make([]*model.TopicDeleteResult, 0, len(rs))
	for _, r := range rs {
		res := &model.TopicDeleteResult{Name: r.Topic}
		if r.Err != nil {
			res.Error = r.Err.Error()
		}
		out = append(out, res)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
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
func (c *Client) ResetConsumerGroupOffset(ctx context.Context, group, topic string, mode model.ResetOffsetMode, timestampMS int64, offsets map[int32]int64) error {
	var (
		offsetsToCommit kadm.Offsets
		err             error
	)
	switch mode {
	case model.ResetOffsetEarliest:
		var start kadm.ListedOffsets
		start, err = c.admin.ListStartOffsets(ctx, topic)
		if err == nil {
			offsetsToCommit = start.Offsets()
		}
	case model.ResetOffsetLatest:
		var end kadm.ListedOffsets
		end, err = c.admin.ListEndOffsets(ctx, topic)
		if err == nil {
			offsetsToCommit = end.Offsets()
		}
	case model.ResetOffsetTime:
		var at kadm.ListedOffsets
		at, err = c.admin.ListOffsetsAfterMilli(ctx, timestampMS, topic)
		if err == nil {
			offsetsToCommit = at.Offsets()
		}
	case model.ResetOffsetExplicit:
		if len(offsets) == 0 {
			return errors.New("指定 offset 模式需要至少一个分区的目标 offset")
		}
		offsetsToCommit = kadm.Offsets{}
		for partition, offset := range offsets {
			offsetsToCommit.Add(kadm.Offset{
				Topic:       topic,
				Partition:   partition,
				At:          offset,
				LeaderEpoch: -1,
			})
		}
	default:
		return fmt.Errorf("unsupported reset mode %q", mode)
	}
	if err != nil {
		return fmt.Errorf("list offsets for reset: %w", err)
	}
	// A Stable group has active members: the broker rejects admin offset
	// commits from it, surfacing as a cryptic ILLEGAL_GENERATION error. Refuse
	// up front with an actionable message instead.
	dg, derr := c.describeGroupRaw(ctx, group)
	if derr != nil {
		return fmt.Errorf("describe group for reset: %w", derr)
	}
	if dg.State == "Stable" {
		return fmt.Errorf("消费组 %q 仍有活跃成员（Stable），请先停止消费者再重置", group)
	}
	if _, err := c.admin.CommitOffsets(ctx, group, offsetsToCommit); err != nil {
		return fmt.Errorf("commit reset offsets: %w", err)
	}
	return nil
}

// PreviewResetOffset returns the per-partition target offsets a reset in the
// given mode would commit, without altering anything (read-only dry-run).
// Earliest returns the log start offset, timestamp the first offset at or
// after timestampMS. Latest is intentionally unsupported: the frontend already
// previews log end offsets from its lag data.
func (c *Client) PreviewResetOffset(ctx context.Context, topic string, mode model.ResetOffsetMode, timestampMS int64) (map[int32]int64, error) {
	var (
		list kadm.ListedOffsets
		err  error
	)
	switch mode {
	case model.ResetOffsetEarliest:
		list, err = c.admin.ListStartOffsets(ctx, topic)
	case model.ResetOffsetTime:
		list, err = c.admin.ListOffsetsAfterMilli(ctx, timestampMS, topic)
	default:
		return nil, fmt.Errorf("unsupported preview reset mode %q", mode)
	}
	if err != nil {
		return nil, fmt.Errorf("list offsets for preview: %w", err)
	}
	if err := list.Error(); err != nil {
		return nil, fmt.Errorf("list offsets for preview: %w", err)
	}
	out := map[int32]int64{}
	for p, lo := range list[topic] {
		if lo.Err != nil {
			continue
		}
		out[p] = lo.Offset
	}
	return out, nil
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
	dg, err := c.describeGroupRaw(ctx, group)
	if err != nil {
		return nil, err
	}
	return mapActiveConsumers(extractConsumerAssignments(dg.Members), topic), nil
}

// DescribeGroup returns a consumer group's state and member topology, with
// every member's per-topic partition assignment.
func (c *Client) DescribeGroup(ctx context.Context, group string) (*model.GroupDetail, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	dg, err := c.describeGroupRaw(ctx, group)
	if err != nil {
		return nil, err
	}
	return mapGroupDetail(group, dg), nil
}

// describeGroupRaw describes a single group, tolerating unknown groups (which
// surface as an empty description) like the rest of the group views.
func (c *Client) describeGroupRaw(ctx context.Context, group string) (kadm.DescribedGroup, error) {
	groups, err := c.admin.DescribeGroups(ctx, group)
	if err != nil {
		return kadm.DescribedGroup{}, fmt.Errorf("describe group %q: %w", group, err)
	}
	dg, ok := groups[group]
	if !ok {
		return kadm.DescribedGroup{Group: group}, nil
	}
	if dg.Err != nil && !errors.Is(dg.Err, kerr.GroupIDNotFound) {
		return kadm.DescribedGroup{}, fmt.Errorf("describe group %q: %w", group, dg.Err)
	}
	return dg, nil
}

// extractConsumerAssignments converts described group members into the
// testable consumerAssignment form (member identity + topic->partitions map).
// It is shared by ListActiveConsumers and DescribeGroup.
func extractConsumerAssignments(members []kadm.DescribedGroupMember) []consumerAssignment {
	out := make([]consumerAssignment, 0, len(members))
	for _, m := range members {
		ca := consumerAssignment{MemberID: m.MemberID, ClientID: m.ClientID, ClientHost: m.ClientHost}
		if a, ok := m.Assigned.AsConsumer(); ok {
			topics := map[string][]int32{}
			for _, t := range a.Topics {
				topics[t.Topic] = append([]int32(nil), t.Partitions...)
			}
			ca.topics = topics
		}
		out = append(out, ca)
	}
	return out
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

// mapGroupDetail assembles the group description from a described group,
// mapping members through their resolved assignments with deterministic
// topic/partition ordering for display.
func mapGroupDetail(group string, dg kadm.DescribedGroup) *model.GroupDetail {
	return &model.GroupDetail{
		Group:        group,
		State:        dg.State,
		ProtocolType: dg.ProtocolType,
		Members:      mapGroupMembers(extractConsumerAssignments(dg.Members)),
	}
}

// mapGroupMembers converts resolved member assignments into model form. The
// returned slice is never nil; assignment topics and partitions are sorted so
// the topology renders stably.
func mapGroupMembers(members []consumerAssignment) []model.GroupMember {
	out := make([]model.GroupMember, 0, len(members))
	for _, m := range members {
		assignment := make(map[string][]int32, len(m.topics))
		for topic, parts := range m.topics {
			sorted := append([]int32(nil), parts...)
			sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
			assignment[topic] = sorted
		}
		out = append(out, model.GroupMember{
			MemberID:   m.MemberID,
			ClientID:   m.ClientID,
			Host:       m.ClientHost,
			Assignment: assignment,
		})
	}
	return out
}
