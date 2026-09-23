package backend

import (
	"context"

	"dataBasePro/backend/internal/kafka"
	"dataBasePro/backend/internal/model"
	"dataBasePro/backend/internal/service"
	"dataBasePro/backend/internal/store"
)

// NewDefaultApp wires the store, service and app together using the default
// Kafka client factory. It returns the app plus a close function that should
// be called on shutdown.
func NewDefaultApp(dbPath, masterPassword string) (*App, func(), error) {
	st, err := store.Open(dbPath, masterPassword)
	if err != nil {
		return nil, nil, err
	}
	svc := service.NewService(st, service.ClientFactoryFunc(
		func(ctx context.Context, cfg model.KafkaConfig) (service.KafkaDataSource, error) {
			return kafka.NewClient("kafka", cfg)
		}),
	)
	return NewApp(svc), func() { _ = st.Close() }, nil
}

// NewKafkaConnection builds a Kafka connection definition, handy for callers
// (CLI/tests) that should not depend on the internal model package directly.
func NewKafkaConnection(name string, bootstrapServers []string) *model.Connection {
	return &model.Connection{
		Name:   name,
		Type:   model.ConnectionTypeKafka,
		Config: model.MustConfigJSON(model.KafkaConfig{BootstrapServers: bootstrapServers}),
	}
}
