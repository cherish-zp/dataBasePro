package store

import (
	"strings"
	"testing"
)

func TestCryptoRoundTrip(t *testing.T) {
	c, err := NewCrypto("master-password-123")
	if err != nil {
		t.Fatalf("NewCrypto failed: %v", err)
	}
	plain := "super-secret-kafka-password"
	enc, err := c.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}
	if enc == plain {
		t.Fatal("ciphertext must differ from plaintext")
	}
	dec, err := c.Decrypt(enc)
	if err != nil {
		t.Fatalf("Decrypt failed: %v", err)
	}
	if dec != plain {
		t.Fatalf("round trip mismatch: got %q want %q", dec, plain)
	}
}

func TestCryptoRandomizedCiphertext(t *testing.T) {
	c, _ := NewCrypto("master-password")
	enc1, _ := c.Encrypt("same value")
	enc2, _ := c.Encrypt("same value")
	if enc1 == enc2 {
		t.Fatal("two encryptions of the same plaintext must differ (random nonce/salt)")
	}
}

func TestCryptoWrongPasswordFails(t *testing.T) {
	c1, _ := NewCrypto("correct-password")
	enc, _ := c1.Encrypt("secret")
	c2, _ := NewCrypto("wrong-password")
	if _, err := c2.Decrypt(enc); err == nil {
		t.Fatal("decrypt with wrong password must fail")
	}
}

func TestCryptoTamperedCiphertextFails(t *testing.T) {
	c, _ := NewCrypto("password")
	enc, _ := c.Encrypt("secret")
	// Flip a byte in the payload portion.
	idx := strings.LastIndexByte(enc, ':') + 1
	chars := []byte(enc)
	chars[idx] = byte('A' + (chars[idx]-byte('A')+1)%26)
	tampered := string(chars)
	if _, err := c.Decrypt(tampered); err == nil {
		t.Fatal("tampered ciphertext must fail authentication")
	}
}

func TestCryptoRejectsMalformedBlob(t *testing.T) {
	c, _ := NewCrypto("password")
	if _, err := c.Decrypt("not-a-valid-blob"); err == nil {
		t.Fatal("malformed blob must fail")
	}
}

func TestNewCryptoEmptyPassword(t *testing.T) {
	if _, err := NewCrypto(""); err == nil {
		t.Fatal("empty master password must be rejected")
	}
}
