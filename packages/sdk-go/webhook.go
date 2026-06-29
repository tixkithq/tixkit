package tixkit

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const defaultWebhookTolerance = 5 * time.Minute

type webhookVerifyConfig struct {
	tolerance time.Duration
	now       func() time.Time
}

// WebhookVerifyOption configures webhook signature verification.
type WebhookVerifyOption func(*webhookVerifyConfig)

// WithWebhookTolerance configures the accepted timestamp skew. Use 0 to disable age checks.
func WithWebhookTolerance(tolerance time.Duration) WebhookVerifyOption {
	return func(cfg *webhookVerifyConfig) {
		cfg.tolerance = tolerance
	}
}

// WithWebhookClock configures the clock used for signature age checks.
func WithWebhookClock(now func() time.Time) WebhookVerifyOption {
	return func(cfg *webhookVerifyConfig) {
		if now != nil {
			cfg.now = now
		}
	}
}

// VerifyWebhookSignature verifies Tixkit's HMAC-SHA256 webhook signature.
func VerifyWebhookSignature(body []byte, signature string, secret string, options ...WebhookVerifyOption) bool {
	if len(body) == 0 || strings.TrimSpace(signature) == "" || secret == "" {
		return false
	}

	cfg := webhookVerifyConfig{
		tolerance: defaultWebhookTolerance,
		now:       time.Now,
	}
	for _, option := range options {
		if option != nil {
			option(&cfg)
		}
	}

	timestamp, receivedHex, ok := parseWebhookSignature(signature)
	if !ok {
		return false
	}
	if cfg.tolerance > 0 {
		age := cfg.now().Sub(time.Unix(timestamp, 0))
		if age < 0 {
			age = -age
		}
		if age > cfg.tolerance {
			return false
		}
	}

	expectedHex := WebhookSignature(body, secret, timestamp)
	expected, err := hex.DecodeString(expectedHex)
	if err != nil {
		return false
	}
	received, err := hex.DecodeString(receivedHex)
	if err != nil || len(expected) != len(received) {
		return false
	}
	return subtle.ConstantTimeCompare(expected, received) == 1
}

// WebhookSignature computes the v1 signature hex for a body and timestamp.
func WebhookSignature(body []byte, secret string, timestamp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(fmt.Sprintf("%d.", timestamp)))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// WebhookSignatureHeader builds a Tixkit signature header.
func WebhookSignatureHeader(body []byte, secret string, timestamp int64) string {
	return fmt.Sprintf("t=%d,v1=%s", timestamp, WebhookSignature(body, secret, timestamp))
}

func parseWebhookSignature(signature string) (int64, string, bool) {
	var timestamp int64
	var received string
	for _, part := range strings.Split(signature, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || key == "" || value == "" {
			continue
		}
		switch key {
		case "t":
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return 0, "", false
			}
			timestamp = parsed
		case "v1":
			received = value
		}
	}
	return timestamp, received, timestamp > 0 && received != ""
}
