package model

import (
	"strings"
	"testing"
)

func gssapiConfig() KafkaConfig {
	return KafkaConfig{
		BootstrapServers: []string{"broker1:9092"},
		SecurityProtocol: "SASL_PLAINTEXT",
		SASL: &SASLConfig{
			Enabled:      true,
			Mechanism:    SaslGssapi,
			Principal:    "admin/admin@YHSJ.COM",
			KeytabPath:   "/etc/security/keytabs/admin.keytab",
			Krb5ConfPath: "/etc/krb5.conf",
			ServiceName:  "kafka",
		},
	}
}

func TestValidateGSSAPIRequiresPrincipalWithRealm(t *testing.T) {
	cfg := gssapiConfig()
	cfg.SASL.Principal = "admin"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "@REALM") {
		t.Fatalf("expected missing-realm error, got %v", err)
	}
	cfg.SASL.Principal = "admin/admin@YHSJ.COM"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid principal rejected: %v", err)
	}
}

func TestValidateGSSAPIRequiresKeytabAndKrb5Conf(t *testing.T) {
	cfg := gssapiConfig()
	cfg.SASL.KeytabPath = ""
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "keytab") {
		t.Fatalf("expected keytab required error, got %v", err)
	}
	cfg.SASL.KeytabPath = "/etc/security/keytabs/admin.keytab"
	cfg.SASL.Krb5ConfPath = ""
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "krb5") {
		t.Fatalf("expected krb5.conf required error, got %v", err)
	}
}

func TestValidateGSSAPIDoesNotRequireUsernamePassword(t *testing.T) {
	// GSSAPI 用 keytab 认证,username/password 必须不参与校验——这是与
	// PLAIN/SCRAM 校验分支的核心差异。
	if err := gssapiConfig().Validate(); err != nil {
		t.Fatalf("GSSAPI config without username/password rejected: %v", err)
	}
}

func TestValidateGSSAPIDefaultsServiceName(t *testing.T) {
	cfg := gssapiConfig()
	cfg.SASL.ServiceName = ""
	if err := cfg.Validate(); err != nil {
		t.Fatalf("empty service name must default to kafka, got %v", err)
	}
	if cfg.SASL.ServiceName != "kafka" {
		t.Fatalf("expected service name normalized to kafka, got %q", cfg.SASL.ServiceName)
	}
}

func TestEffectiveSecurityProtocolDerivesFromLegacyFlags(t *testing.T) {
	cases := []struct {
		name string
		cfg  KafkaConfig
		want SecurityProtocol
	}{
		{"legacy sasl plaintext", KafkaConfig{BootstrapServers: []string{"b:1"}, SASL: &SASLConfig{Enabled: true, Mechanism: SaslPlain, Username: "u"}}, SecurityProtocolSASLPlain},
		{"legacy sasl tls", KafkaConfig{BootstrapServers: []string{"b:1"}, SASL: &SASLConfig{Enabled: true, Mechanism: SaslPlain, Username: "u"}, TLS: &TLSConfig{Enabled: true}}, SecurityProtocolSASLSSL},
		{"legacy plain tls", KafkaConfig{BootstrapServers: []string{"b:1"}, TLS: &TLSConfig{Enabled: true}}, SecurityProtocolSSL},
		{"legacy plain", KafkaConfig{BootstrapServers: []string{"b:1"}}, SecurityProtocolPlain},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.EffectiveSecurityProtocol(); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEffectiveSecurityProtocolPrefersExplicitField(t *testing.T) {
	cfg := KafkaConfig{BootstrapServers: []string{"b:1"}, SecurityProtocol: "SASL_SSL", SASL: &SASLConfig{Enabled: true, Mechanism: SaslGssapi, Principal: "a/a@R", KeytabPath: "k", Krb5ConfPath: "krb"}}
	if got := cfg.EffectiveSecurityProtocol(); got != SecurityProtocolSASLSSL {
		t.Fatalf("explicit field must win, got %q", got)
	}
}

func TestEffectiveSecurityProtocolNormalizesCase(t *testing.T) {
	cfg := KafkaConfig{BootstrapServers: []string{"b:1"}, SecurityProtocol: "sasl_ssl"}
	if got := cfg.EffectiveSecurityProtocol(); got != SecurityProtocolSASLSSL {
		t.Fatalf("expected normalized SASL_SSL, got %q", got)
	}
}

func TestValidateRejectsUnknownSecurityProtocol(t *testing.T) {
	cfg := gssapiConfig()
	cfg.SecurityProtocol = "MAGIC"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "security_protocol") {
		t.Fatalf("expected unknown protocol error, got %v", err)
	}
}
