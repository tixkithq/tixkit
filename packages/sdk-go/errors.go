package tixkit

import (
	"encoding/json"
	"fmt"
)

// APIError is returned for non-2xx API responses.
type APIError struct {
	Code       string         `json:"code"`
	Message    string         `json:"message"`
	StatusCode int            `json:"statusCode"`
	RequestID  string         `json:"requestId,omitempty"`
	Details    map[string]any `json:"details,omitempty"`
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code == "" {
		return fmt.Sprintf("tixkit: request failed with status %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("tixkit: %s: %s", e.Code, e.Message)
}

func newAPIError(statusCode int, body []byte) *APIError {
	apiErr := &APIError{
		Code:       fmt.Sprintf("HTTP_%d", statusCode),
		Message:    fmt.Sprintf("Request failed with status %d", statusCode),
		StatusCode: statusCode,
	}

	var envelope struct {
		Error struct {
			Code      string         `json:"code"`
			Message   string         `json:"message"`
			RequestID string         `json:"requestId"`
			Details   map[string]any `json:"details"`
		} `json:"error"`
	}
	if len(body) == 0 || json.Unmarshal(body, &envelope) != nil {
		return apiErr
	}
	if envelope.Error.Code != "" {
		apiErr.Code = envelope.Error.Code
	}
	if envelope.Error.Message != "" {
		apiErr.Message = envelope.Error.Message
	}
	apiErr.RequestID = envelope.Error.RequestID
	apiErr.Details = envelope.Error.Details
	return apiErr
}
