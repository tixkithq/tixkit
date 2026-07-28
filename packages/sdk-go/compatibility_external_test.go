package tixkit_test

import (
	"context"

	tixkit "github.com/tixkithq/tixkit-go"
)

type legacyTicketTypeBatchUpdater interface {
	UpdateBatch(context.Context, string, tixkit.TicketTypeBatchRequest) (*tixkit.TicketTypeBatchResult, error)
}

// These assignments are compile-time consumer proofs. The original exact
// UpdateBatch signature remains source-compatible, while the typed nullable
// contract is additive under UpdateBatchTyped.
var _ legacyTicketTypeBatchUpdater = (*tixkit.TicketTypesService)(nil)

var _ func(
	*tixkit.TicketTypesService,
	context.Context,
	string,
	tixkit.TicketTypeBatchRequest,
) (*tixkit.TicketTypeBatchResult, error) = (*tixkit.TicketTypesService).UpdateBatch
