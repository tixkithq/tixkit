package tixkit

import (
	"context"
	"net/url"
	"strconv"
)

// PaginationParams configures cursor pagination.
type PaginationParams struct {
	Cursor string
	Limit  int
}

func (p PaginationParams) values() url.Values {
	values := make(url.Values)
	if p.Cursor != "" {
		values.Set("cursor", p.Cursor)
	}
	if p.Limit > 0 {
		values.Set("limit", strconv.Itoa(p.Limit))
	}
	return values
}

// Page is Tixkit's cursor pagination envelope.
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
	HasMore    bool   `json:"hasMore"`
	Total      int    `json:"total,omitempty"`
}

// CursorPageFetcher fetches a page for the supplied cursor.
type CursorPageFetcher[T any] func(ctx context.Context, cursor string) (*Page[T], error)

// CursorIterator streams items from a cursor-paginated endpoint.
type CursorIterator[T any] struct {
	fetch       CursorPageFetcher[T]
	buffer      []T
	nextCursor  string
	hasMore     bool
	loadedFirst bool
}

// NewCursorIterator constructs a cursor iterator from a page fetcher.
func NewCursorIterator[T any](fetch CursorPageFetcher[T]) *CursorIterator[T] {
	return &CursorIterator[T]{
		fetch:   fetch,
		hasMore: true,
	}
}

// Next returns the next item. ok is false when iteration is complete.
func (it *CursorIterator[T]) Next(ctx context.Context) (item T, ok bool, err error) {
	for len(it.buffer) == 0 {
		if it.loadedFirst && !it.hasMore {
			return item, false, nil
		}
		page, err := it.fetch(ctx, it.nextCursor)
		if err != nil {
			return item, false, err
		}
		it.loadedFirst = true
		if page == nil {
			it.hasMore = false
			return item, false, nil
		}
		it.buffer = append(it.buffer, page.Items...)
		it.nextCursor = page.NextCursor
		it.hasMore = page.HasMore && page.NextCursor != ""
		if len(it.buffer) == 0 && !it.hasMore {
			return item, false, nil
		}
	}

	item = it.buffer[0]
	it.buffer = it.buffer[1:]
	return item, true, nil
}

// All drains the iterator into a slice.
func (it *CursorIterator[T]) All(ctx context.Context) ([]T, error) {
	var items []T
	for {
		item, ok, err := it.Next(ctx)
		if err != nil {
			return nil, err
		}
		if !ok {
			return items, nil
		}
		items = append(items, item)
	}
}
