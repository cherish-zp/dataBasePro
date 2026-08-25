// Package model defines the core data structures shared across the
// backend: connection definitions, Kafka domain objects and helpers.
package model

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// ConnectionType identifies the kind of a data source.
type ConnectionType string

const (
	ConnectionTypeKafka ConnectionType = "kafka"
	ConnectionTypeMySQL ConnectionType = "mysql"
	ConnectionTypeES    ConnectionType = "es"
)

// Valid reports whether the type is currently supported.
func (t ConnectionType) Valid() bool {
	switch t {
	case ConnectionTypeKafka, ConnectionTypeMySQL, ConnectionTypeES:
		return true
	}
	return false
}

// SASL mechanisms supported by the Kafka client.
const (
	SaslPlain       = "PLAIN"
	SaslScramSha256 = "SCRAM-SHA-256"
	SaslScramSha512 = "SCRAM-SHA-512"
)

// SASLConfig holds authentication settings for a Kafka cluster.
type SASLConfig struct {
	Enabled   bool   `json:"enabled"`
	Mechanism string `json:"mechanism"`
	Username  string `json:"username"`
	Password  string `json:"password"`
}

// TLSConfig holds TLS settings for a Kafka cluster.
type TLSConfig struct {
	Enabled            bool   `json:"enabled"`
	CACert             string `json:"ca_cert,omitempty"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify,omitempty"`
}

// KafkaConfig stores the details required to connect to a Kafka cluster.
type KafkaConfig struct {
	BootstrapServers []string    `json:"bootstrap_servers"`
	SASL             *SASLConfig `json:"sasl,omitempty"`
	TLS              *TLSConfig  `json:"tls,omitempty"`
}

// Validate checks the Kafka configuration for obvious errors.
func (c KafkaConfig) Validate() error {
	if len(c.BootstrapServers) == 0 {
		return errors.New("bootstrap_servers must not be empty")
	}
	for _, addr := range c.BootstrapServers {
		if _, _, err := net.SplitHostPort(addr); err != nil {
			return fmt.Errorf("invalid bootstrap server %q (expected host:port): %w", addr, err)
		}
	}
	if c.SASL != nil && c.SASL.Enabled {
		mech := strings.ToUpper(strings.TrimSpace(c.SASL.Mechanism))
		switch mech {
		case SaslPlain, SaslScramSha256, SaslScramSha512:
		default:
			return fmt.Errorf("unsupported SASL mechanism %q", c.SASL.Mechanism)
		}
		if c.SASL.Username == "" {
			return errors.New("SASL username must not be empty")
		}
	}
	return nil
}

// Connection is a persisted data source definition.
type Connection struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Type      ConnectionType `json:"type"`
	Config    KafkaConfig    `json:"config"`
	CreatedAt int64          `json:"created_at"`
	UpdatedAt int64          `json:"updated_at"`
}

// Validate checks the connection definition.
func (c Connection) Validate() error {
	if strings.TrimSpace(c.Name) == "" {
		return errors.New("connection name must not be empty")
	}
	if !c.Type.Valid() {
		return fmt.Errorf("unsupported connection type %q", c.Type)
	}
	switch c.Type {
	case ConnectionTypeKafka:
		return c.Config.Validate()
	}
	return nil
}
