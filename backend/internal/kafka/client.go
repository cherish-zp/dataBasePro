// Package kafka implements the KafkaDataSource behaviour on top of franz-go
// (a pure-Go, CGO-free Kafka client).
package kafka

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"

	"dataBasePro/backend/internal/model"
)

// defaultFetchLimit is the batch size used when a caller does not specify one.
const defaultFetchLimit = 500

// Client is a Kafka data source backed by franz-go. It satisfies the
// service.KafkaDataSource interface.
type Client struct {
	name  string
	kcl   *kgo.Client
	admin *kadm.Client
	opts  []kgo.Opt
}

// NewClient builds a Kafka client for the given config. No I/O happens until
// Connect (or another method) is called.
func NewClient(name string, cfg model.KafkaConfig) (*Client, error) {
	opts, err := clientOpts(cfg)
	if err != nil {
		return nil, err
	}
	kcl, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("create kafka client: %w", err)
	}
	return &Client{name: name, kcl: kcl, admin: kadm.NewClient(kcl), opts: opts}, nil
}

// clientOpts translates a model.KafkaConfig into kgo options, wiring up SASL
// and TLS when configured.
func clientOpts(cfg model.KafkaConfig) ([]kgo.Opt, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(cfg.BootstrapServers...),
		kgo.RequestTimeoutOverhead(10 * time.Second),
		// ProduceMessage sets an explicit partition; the default partitioner
		// would hash by key and ignore it.
		kgo.RecordPartitioner(kgo.ManualPartitioner()),
	}
	if cfg.SASL != nil && cfg.SASL.Enabled {
		mech := strings.ToUpper(strings.TrimSpace(cfg.SASL.Mechanism))
		auth := scram.Auth{User: cfg.SASL.Username, Pass: cfg.SASL.Password}
		switch mech {
		case model.SaslPlain:
			opts = append(opts, kgo.SASL(plain.Auth{User: cfg.SASL.Username, Pass: cfg.SASL.Password}.AsMechanism()))
		case model.SaslScramSha256:
			opts = append(opts, kgo.SASL(auth.AsSha256Mechanism()))
		case model.SaslScramSha512:
			opts = append(opts, kgo.SASL(auth.AsSha512Mechanism()))
		default:
			return nil, fmt.Errorf("unsupported SASL mechanism %q", cfg.SASL.Mechanism)
		}
	}
	if cfg.TLS != nil && cfg.TLS.Enabled {
		tlsCfg, err := buildTLSConfig(cfg.TLS)
		if err != nil {
			return nil, err
		}
		opts = append(opts, kgo.DialTLSConfig(tlsCfg))
	}
	return opts, nil
}

func buildTLSConfig(t *model.TLSConfig) (*tls.Config, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: t.InsecureSkipVerify}
	if t.CACert != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(t.CACert)) {
			return nil, errors.New("failed to parse CA certificate")
		}
		tlsCfg.RootCAs = pool
	}
	return tlsCfg, nil
}

// Connect verifies connectivity to the cluster.
func (c *Client) Connect(ctx context.Context) error {
	if err := c.kcl.Ping(ctx); err != nil {
		return fmt.Errorf("ping kafka cluster: %w", err)
	}
	return nil
}

// Close releases the underlying client.
func (c *Client) Close() error {
	c.kcl.Close()
	return nil
}

// GetName returns the connection name.
func (c *Client) GetName() string { return c.name }

// GetType returns the data source type.
func (c *Client) GetType() string { return "kafka" }

// ConsumeMessages fetches up to limit records from a topic. A partition >= 0
// restricts the fetch to that partition; a negative value fetches from every
// partition (used by the "All partitions" filter).
//
// The offset parameter accepts model.OffsetEarliest (-2), model.OffsetLatest
// (-1) or an absolute offset (>= 0). OffsetLatest reads the most recent
// `limit` records per partition (a tail of the log), which is the expected
// behaviour for a message browser.
func (c *Client) ConsumeMessages(ctx context.Context, topic string, partition int32, offset int64, limit int) ([]*model.Message, error) {
	offsets, err := c.partitionOffsets(ctx, topic, partition, offset, limit)
	if err != nil {
		return nil, err
	}
	if len(offsets) == 0 {
		return []*model.Message{}, nil
	}
	return c.fetch(ctx, topic, offsets, limit)
}

// ConsumeMessagesByTimestamp fetches up to limit records whose timestamp is at
// or after timestampMS (unix milliseconds). A negative partition means all.
func (c *Client) ConsumeMessagesByTimestamp(ctx context.Context, topic string, partition int32, timestampMS int64, limit int) ([]*model.Message, error) {
	partitions, err := c.partitionsOf(ctx, topic)
	if err != nil {
		return nil, err
	}
	if partition >= 0 {
		partitions = []int32{partition}
	}
	if len(partitions) == 0 {
		return []*model.Message{}, nil
	}
	offsets := make(map[int32]kgo.Offset, len(partitions))
	for _, p := range partitions {
		offsets[p] = kgo.NewOffset().AfterMilli(timestampMS)
	}
	return c.fetch(ctx, topic, offsets, limit)
}

// partitionsOf lists the partitions of a topic via the admin client.
func (c *Client) partitionsOf(ctx context.Context, topic string) ([]int32, error) {
	details, err := c.admin.ListTopics(ctx)
	if err != nil {
		return nil, fmt.Errorf("list topic metadata: %w", err)
	}
	td, ok := details[topic]
	if !ok {
		return nil, fmt.Errorf("topic %q not found", topic)
	}
	parts := make([]int32, 0, len(td.Partitions))
	for _, pd := range td.Partitions.Sorted() {
		parts = append(parts, pd.Partition)
	}
	return parts, nil
}

// partitionOffsets resolves the requested offset into per-partition kgo
// offsets for the (optionally single) target partition.
func (c *Client) partitionOffsets(ctx context.Context, topic string, partition int32, offset int64, limit int) (map[int32]kgo.Offset, error) {
	partitions, err := c.partitionsOf(ctx, topic)
	if err != nil {
		return nil, err
	}
	if partition >= 0 {
		partitions = []int32{partition}
	}

	// OffsetLatest means "tail": read the last limit records of each partition.
	if offset == model.OffsetLatest {
		endOffsets, err := c.admin.ListEndOffsets(ctx, topic)
		if err != nil {
			return nil, fmt.Errorf("list end offsets: %w", err)
		}
		out := make(map[int32]kgo.Offset, len(partitions))
		for _, p := range partitions {
			lo, ok := endOffsets.Lookup(topic, p)
			if !ok {
				continue
			}
			start := lo.Offset - int64(limit)
			if start < 0 {
				start = 0
			}
			out[p] = kgo.NewOffset().At(start)
		}
		return out, nil
	}

	var o kgo.Offset
	switch offset {
	case model.OffsetEarliest:
		o = kgo.NewOffset().AtStart()
	default:
		o = kgo.NewOffset().At(offset)
	}
	out := make(map[int32]kgo.Offset, len(partitions))
	for _, p := range partitions {
		out[p] = o
	}
	return out, nil
}

// ProduceMessage publishes a single record. A partition < 0 lets the client
// choose the partition.
func (c *Client) ProduceMessage(ctx context.Context, topic string, partition int32, key, value []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rec := &kgo.Record{Topic: topic, Key: key, Value: value}
	if partition >= 0 {
		rec.Partition = partition
	}
	if err := c.kcl.ProduceSync(ctx, rec).FirstErr(); err != nil {
		return fmt.Errorf("produce record: %w", err)
	}
	return nil
}

// ProduceMessages publishes a batch of records sequentially over the same
// writer as ProduceMessage and returns one result per message. Errors are
// reported per item in ProduceResult.Error; the call itself only fails when
// results cannot be collected at all. A partition < 0 lets the client choose
// the partition.
func (c *Client) ProduceMessages(ctx context.Context, topic string, partition int32, messages []model.BatchProduceMessage) ([]*model.ProduceResult, error) {
	results := make([]*model.ProduceResult, 0, len(messages))
	for i, msg := range messages {
		res := &model.ProduceResult{Index: i}
		rec := &kgo.Record{Topic: topic, Key: []byte(msg.Key), Value: []byte(msg.Value)}
		if partition >= 0 {
			rec.Partition = partition
		}
		pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := c.kcl.ProduceSync(pctx, rec).FirstErr(); err != nil {
			res.Error = fmt.Sprintf("produce record: %v", err)
		} else {
			res.Partition = rec.Partition
			res.Offset = rec.Offset
		}
		cancel()
		results = append(results, res)
	}
	return results, nil
}

// fetch spins up a short-lived consumer pinned to the given partitions and
// collects up to limit records.
func (c *Client) fetch(ctx context.Context, topic string, offsets map[int32]kgo.Offset, limit int) ([]*model.Message, error) {
	if limit <= 0 {
		limit = defaultFetchLimit
	}
	consumer, err := kgo.NewClient(
		append(append([]kgo.Opt{}, c.opts...),
			kgo.ConsumePartitions(map[string]map[int32]kgo.Offset{topic: offsets}),
		)...,
	)
	if err != nil {
		return nil, fmt.Errorf("create consumer: %w", err)
	}
	defer consumer.Close()

	// Bound the fetch so empty or end-of-log partitions return promptly rather
	// than blocking until the caller's deadline.
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	msgs := make([]*model.Message, 0, limit)
	for len(msgs) < limit {
		want := limit - len(msgs)
		fetches := consumer.PollRecords(ctx, want)
		if err := fetches.Err(); err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				break
			}
			return msgs, fmt.Errorf("poll records: %w", err)
		}
		recs := fetches.Records()
		if len(recs) == 0 {
			break
		}
		for _, r := range recs {
			msgs = append(msgs, toMessage(r))
		}
		if len(recs) < want {
			// Fewer records arrived than requested: we may be near the end of
			// the log, or records may still be trickling in from other
			// partitions. Drain with short timeouts until a poll returns
			// nothing, then return a stable batch.
			for len(msgs) < limit {
				short, scancel := context.WithTimeout(ctx, 200*time.Millisecond)
				more := consumer.PollRecords(short, limit-len(msgs))
				scancel()
				if len(more.Records()) == 0 {
					return msgs, nil
				}
				for _, r := range more.Records() {
					msgs = append(msgs, toMessage(r))
				}
			}
			break
		}
	}
	return msgs, nil
}

// toMessage converts a kgo.Record into the model.Message exposed to the UI.
func toMessage(r *kgo.Record) *model.Message {
	m := &model.Message{
		Partition: r.Partition,
		Offset:    r.Offset,
		Timestamp: r.Timestamp.UnixMilli(),
		Key:       string(r.Key),
		Value:     string(r.Value),
	}
	for _, h := range r.Headers {
		m.Headers = append(m.Headers, model.Header{Key: h.Key, Value: string(h.Value)})
	}
	return m
}
