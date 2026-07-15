// Package tixkit provides a typed Go client for the Tixkit API.
//
// The client sends X-Tixkit-Version with API version 2026-08-05 on every
// request and exposes resources for checkout sessions, events, ticket types,
// orders, refunds, attendees, check-in, questions, waitlist, reports, exports,
// webhooks, and developer API keys. Write operations accept caller-provided
// idempotency keys where the API requires replay-safe behavior.
//
// Webhook helpers verify Tixkit's X-Tixkit-Signature header using the
// t=<timestamp>,v1=<hex> HMAC-SHA256 format.
package tixkit
