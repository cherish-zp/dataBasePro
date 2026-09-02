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
	SaslGssapi      = "GSSAPI"
)

// SecurityProtocol enumerates the Kafka security protocols. Stored explicitly
// on new configs; legacy configs (only the tls/sasl booleans) derive it at
// read time via KafkaConfig.EffectiveSecurityProtocol.
type SecurityProtocol string

const (
	SecurityProtocolPlain      SecurityProtocol = "PLAINTEXT"
	SecurityProtocolSSL        SecurityProtocol = "SSL"
	SecurityProtocolSASLPlain  SecurityProtocol = "SASL_PLAINTEXT"
	SecurityProtocolSASLSSL    SecurityProtocol = "SASL_SSL"
)

// SASLConfig holds authentication settings for a Kafka cluster. GSSAPI
// (Kerberos) authenticates with a keytab instead of username/password: the
// four kerberos fields are used then, and Username/Password are ignored.
type SASLConfig struct {
	Enabled      bool   `json:"enabled"`
	Mechanism    string `json:"mechanism"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	Principal    string `json:"principal,omitempty"`
	KeytabPath   string `json:"keytab_path,omitempty"`
	Krb5ConfPath string `json:"krb5_conf_path,omitempty"`
	ServiceName  string `json:"service_name,omitempty"`
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
	SecurityProtocol string      `json:"security_protocol,omitempty"`
	SASL             *SASLConfig `json:"sasl,omitempty"`
	TLS              *TLSConfig  `json:"tls,omitempty"`
}

// EffectiveSecurityProtocol resolves the protocol from the explicit field,
// falling back to the legacy tls/sasl booleans for configs written before the
// field existed (they never store a protocol themselves). Values are
// normalized to upper case so "sasl_ssl" round-trips cleanly.
func (c KafkaConfig) EffectiveSecurityProtocol() SecurityProtocol {
	p := SecurityProtocol(strings.ToUpper(strings.TrimSpace(c.SecurityProtocol)))
	switch p {
	case SecurityProtocolPlain, SecurityProtocolSSL, SecurityProtocolSASLPlain, SecurityProtocolSASLSSL:
		return p
	}
	sasl := c.SASL != nil && c.SASL.Enabled
	tls := c.TLS != nil && c.TLS.Enabled
	switch {
	case sasl && tls:
		return SecurityProtocolSASLSSL
	case sasl:
		return SecurityProtocolSASLPlain
	case tls:
		return SecurityProtocolSSL
	default:
		return SecurityProtocolPlain
	}
}

// ValidSecurityProtocol reports whether p is one of the four Kafka security
// protocols (p is matched after upper-case normalization).
func ValidSecurityProtocol(p SecurityProtocol) bool {
	switch p {
	case SecurityProtocolPlain, SecurityProtocolSSL, SecurityProtocolSASLPlain, SecurityProtocolSASLSSL:
		return true
	}
	return false
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
	// An explicitly stored protocol must be valid; the legacy booleans derive
	// a protocol that is always valid, so they cannot fail here.
	if p := SecurityProtocol(strings.ToUpper(strings.TrimSpace(c.SecurityProtocol))); strings.TrimSpace(c.SecurityProtocol) != "" && !ValidSecurityProtocol(p) {
		return fmt.Errorf("unsupported security_protocol %q", c.SecurityProtocol)
	}
	if c.SASL != nil && c.SASL.Enabled {
		return c.SASL.Validate()
	}
	return nil
}

// Validate checks SASL settings per mechanism: PLAIN/SCRAM need
// username/password, GSSAPI needs principal (with realm), keytab and
// krb5.conf paths. GSSAPI normalizes an empty service name to "kafka" (the
// Kafka default principal first component) so the client layer can rely on
// it being set.
func (s *SASLConfig) Validate() error {
	mech := strings.ToUpper(strings.TrimSpace(s.Mechanism))
	switch mech {
	case SaslPlain, SaslScramSha256, SaslScramSha512:
		if s.Username == "" {
			return errors.New("SASL username must not be empty")
		}
	case SaslGssapi:
		p := strings.TrimSpace(s.Principal)
		if p == "" {
			return errors.New("Kerberos principal must not be empty")
		}
		if !strings.Contains(p, "@") || strings.TrimSpace(strings.SplitN(p, "@", 2)[1]) == "" {
			return fmt.Errorf("Kerberos principal %q must include a realm (user/host@REALM)", s.Principal)
		}
		if strings.TrimSpace(s.KeytabPath) == "" {
			return errors.New("Kerberos keytab path must not be empty")
		}
		if strings.TrimSpace(s.Krb5ConfPath) == "" {
			return errors.New("Kerberos krb5.conf path must not be empty")
		}
		if strings.TrimSpace(s.ServiceName) == "" {
			s.ServiceName = "kafka"
		}
	default:
		return fmt.Errorf("unsupported SASL mechanism %q", s.Mechanism)
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
