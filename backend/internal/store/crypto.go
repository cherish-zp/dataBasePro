package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const (
	cryptoVersion = "v1"
	encPrefix     = "enc:"
	keyLen        = 32 // AES-256
	saltLen       = 16
	iterations    = 4096
)

// Crypto encrypts sensitive fields (e.g. Kafka passwords) at rest using
// AES-256-GCM. The key is derived from a user master password with PBKDF2
// and a random per-encryption salt.
type Crypto struct {
	master string
}

// NewCrypto returns a Crypto bound to the given master password.
func NewCrypto(masterPassword string) (*Crypto, error) {
	if masterPassword == "" {
		return nil, errors.New("master password must not be empty")
	}
	return &Crypto{master: masterPassword}, nil
}

// Encrypt returns a self-contained, versioned ciphertext string.
// Format: "enc:v1:<base64(salt || nonce || ciphertext)>".
func (c *Crypto) Encrypt(plaintext string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	key, err := pbkdf2.Key(sha256.New, c.master, salt, iterations, keyLen)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	sealed := gcm.Seal(nil, nonce, []byte(plaintext), nil)

	blob := make([]byte, 0, len(salt)+len(nonce)+len(sealed))
	blob = append(blob, salt...)
	blob = append(blob, nonce...)
	blob = append(blob, sealed...)

	return encPrefix + cryptoVersion + ":" + base64.RawStdEncoding.EncodeToString(blob), nil
}

// Decrypt reverses Encrypt. It returns an error if the blob was tampered
// with or the master password is wrong.
func (c *Crypto) Decrypt(blob string) (string, error) {
	payload, ok := strings.CutPrefix(blob, encPrefix+cryptoVersion+":")
	if !ok {
		return "", errors.New("malformed ciphertext: missing version")
	}
	raw, err := base64.RawStdEncoding.DecodeString(payload)
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}

	salt := raw[:saltLen]
	key, err := pbkdf2.Key(sha256.New, c.master, salt, iterations, keyLen)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < saltLen+gcm.NonceSize() {
		return "", errors.New("malformed ciphertext: too short")
	}
	nonce := raw[saltLen : saltLen+gcm.NonceSize()]
	sealed := raw[saltLen+gcm.NonceSize():]

	plain, err := gcm.Open(nil, nonce, sealed, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt failed (wrong password or tampered data): %w", err)
	}
	return string(plain), nil
}
