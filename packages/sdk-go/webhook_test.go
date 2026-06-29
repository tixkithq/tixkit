package tixkit

import (
	"testing"
	"time"
)

func TestWebhookSignatureVector(t *testing.T) {
	t.Parallel()

	body := []byte(`{"id":"whe_123","type":"order.paid"}`)
	secret := "whsec_test"
	timestamp := int64(1_775_000_000)
	expected := "99978ceb7afad605bed97d2fd961c24769d7686ac906cecac1db3b22649220a8"

	if got := WebhookSignature(body, secret, timestamp); got != expected {
		t.Fatalf("signature = %s", got)
	}
	header := WebhookSignatureHeader(body, secret, timestamp)
	if header != "t=1775000000,v1="+expected {
		t.Fatalf("header = %s", header)
	}
	ok := VerifyWebhookSignature(
		body,
		header,
		secret,
		WithWebhookClock(func() time.Time { return time.Unix(timestamp+10, 0) }),
	)
	if !ok {
		t.Fatal("expected valid signature")
	}
}

func TestWebhookSignatureRejectsBadAndExpiredSignatures(t *testing.T) {
	t.Parallel()

	body := []byte(`{"id":"whe_123"}`)
	secret := "whsec_test"
	timestamp := int64(1_775_000_000)
	header := WebhookSignatureHeader(body, secret, timestamp)

	if VerifyWebhookSignature(body, "t=1775000000,v1=bad", secret, WithWebhookClock(func() time.Time { return time.Unix(timestamp, 0) })) {
		t.Fatal("bad signature verified")
	}
	if VerifyWebhookSignature(body, header, "wrong", WithWebhookClock(func() time.Time { return time.Unix(timestamp, 0) })) {
		t.Fatal("wrong secret verified")
	}
	if VerifyWebhookSignature(body, header, secret, WithWebhookClock(func() time.Time { return time.Unix(timestamp+600, 0) })) {
		t.Fatal("expired signature verified")
	}
	if !VerifyWebhookSignature(body, header, secret, WithWebhookTolerance(0), WithWebhookClock(func() time.Time { return time.Unix(timestamp+600, 0) })) {
		t.Fatal("expected tolerance-disabled signature to verify")
	}
}
