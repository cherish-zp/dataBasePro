package model

import (
	"strings"
	"testing"
)

func TestConnectionValidate_Valid(t *testing.T) {
	c := Connection{
		ID:   "id-1",
		Name: "local-dev",
		Type: ConnectionTypeKafka,
		Config: KafkaConfig{
			BootstrapServers: []string{"localhost:9092"},
		},
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("expected valid connection, got error: %v", err)
	}
}

func TestConnectionValidate_EmptyName(t *testing.T) {
	c := Connection{
		ID:   "id-1",
		Name: "",
		Type: ConnectionTypeKafka,
		Config: KafkaConfig{
			BootstrapServers: []string{"localhost:9092"},
		},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for empty name, got nil")
	}
}

func TestConnectionValidate_UnsupportedType(t *testing.T) {
	c := Connection{
		ID:   "id-1",
		Name: "bad",
		Type: ConnectionType("oracle"),
		Config: KafkaConfig{
			BootstrapServers: []string{"localhost:9092"},
		},
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for unsupported type, got nil")
	}
}

func TestConnectionValidate_NoBootstrapServers(t *testing.T) {
	c := Connection{
		ID:   "id-1",
		Name: "bad",
		Type: ConnectionTypeKafka,
	}
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for missing bootstrap servers, got nil")
	}
}

func TestKafkaConfigValidate_SASLRequiresUsername(t *testing.T) {
	cfg := KafkaConfig{
		BootstrapServers: []string{"localhost:9092"},
		SASL: &SASLConfig{
			Enabled:   true,
			Mechanism: "PLAIN",
			Password:  "secret",
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected error for SASL without username, got nil")
	}
}

func TestKafkaConfigValidate_InvalidSASLMechanism(t *testing.T) {
	cfg := KafkaConfig{
		BootstrapServers: []string{"localhost:9092"},
		SASL: &SASLConfig{
			Enabled:   true,
			Mechanism: "GSSAPI",
			Username:  "u",
			Password:  "p",
		},
	}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "mechanism") {
		t.Fatalf("expected mechanism error, got: %v", err)
	}
}

func TestKafkaConfigValidate_ValidSASL(t *testing.T) {
	cfg := KafkaConfig{
		BootstrapServers: []string{"localhost:9092"},
		SASL: &SASLConfig{
			Enabled:   true,
			Mechanism: SaslScramSha256,
			Username:  "u",
			Password:  "p",
		},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid SASL config, got error: %v", err)
	}
}

func TestKafkaConfigValidate_BadServerAddress(t *testing.T) {
	cfg := KafkaConfig{
		BootstrapServers: []string{"localhost"},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected error for address without port, got nil")
	}
}
