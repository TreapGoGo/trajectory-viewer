package main

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// archiveCache keeps upstream archive replies in memory. Payloads never change,
// so they stay until evicted by size; event pages and run details expire fast
// because late delivery events can still arrive after a run finishes.
type archiveCache struct {
	mu    sync.Mutex
	limit int
	size  int
	order *list.List
	items map[string]*list.Element
}

type cacheEntry struct {
	key     string
	raw     []byte
	expires time.Time // zero = never
}

func newArchiveCache(limit int) *archiveCache {
	return &archiveCache{limit: limit, order: list.New(), items: make(map[string]*list.Element)}
}

func (c *archiveCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	element, ok := c.items[key]
	if !ok {
		return nil, false
	}
	entry := element.Value.(*cacheEntry)
	if !entry.expires.IsZero() && time.Now().After(entry.expires) {
		c.removeLocked(element)
		return nil, false
	}
	c.order.MoveToFront(element)
	return entry.raw, true
}

func (c *archiveCache) put(key string, raw []byte, ttl time.Duration) {
	if len(raw) > c.limit/4 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.items[key]; ok {
		c.removeLocked(element)
	}
	entry := &cacheEntry{key: key, raw: raw}
	if ttl > 0 {
		entry.expires = time.Now().Add(ttl)
	}
	c.items[key] = c.order.PushFront(entry)
	c.size += len(raw)
	for c.size > c.limit && c.order.Len() > 0 {
		c.removeLocked(c.order.Back())
	}
}

func (c *archiveCache) removeLocked(element *list.Element) {
	entry := element.Value.(*cacheEntry)
	c.order.Remove(element)
	delete(c.items, entry.key)
	c.size -= len(entry.raw)
}

func cacheTTL(sub string, query url.Values) (time.Duration, bool) {
	switch {
	case strings.Contains(sub, "/payloads/"):
		return 0, true
	case strings.HasSuffix(sub, "/events"):
		return 45 * time.Second, true
	case sub != "" && !strings.Contains(sub[1:], "/"):
		return 10 * time.Second, true
	default:
		return 0, false // run lists are always fresh
	}
}

// archiveGet reads agent/trajectories+sub through the configured upstream.
func (v *viewer) archiveGet(ctx context.Context, auth archiveAuth, sub string, query url.Values, fresh bool) (int, []byte, error) {
	ttl, cacheable := cacheTTL(sub, query)
	key := auth.cacheScope() + " " + sub + "?" + query.Encode()
	if cacheable && !fresh {
		if raw, ok := v.cache.get(key); ok {
			return http.StatusOK, raw, nil
		}
	}
	select {
	case v.upstreamSlots <- struct{}{}:
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	}
	defer func() { <-v.upstreamSlots }()
	var (
		status int
		raw    []byte
		err    error
	)
	if v.devViewer != nil {
		status, raw, err = v.devGet(ctx, "/api/trajectories"+sub, query, auth.cookie)
	} else {
		status, raw, err = v.call(ctx, http.MethodGet, "agent/trajectories"+sub, query, auth.token, nil)
	}
	if err == nil && status == http.StatusOK && cacheable && json.Valid(raw) {
		v.cache.put(key, raw, ttl)
	}
	return status, raw, err
}

// runBundle is everything recorded for one run: its detail, every event, every
// archived payload keyed by payload_id, and (recursively) its child runs.
type runBundle struct {
	ID        string                     `json:"id"`
	Detail    json.RawMessage            `json:"detail"`
	Events    []json.RawMessage          `json:"events"`
	Payloads  map[string]json.RawMessage `json:"payloads"`
	Children  []*runBundle               `json:"children"`
	Problems  []string                   `json:"problems,omitempty"`
	FetchedMs int64                      `json:"fetched_ms"`
	TookMs    int64                      `json:"took_ms"`
}

type upstreamError struct{ status int }

func (e upstreamError) Error() string { return "upstream status " + strconv.Itoa(e.status) }

func (v *viewer) bundle(w http.ResponseWriter, r *http.Request) {
	auth, ok := v.authFor(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "Sign in to view cloud archives.")
		return
	}
	id := r.PathValue("id")
	if !validArchiveID(id) {
		fail(w, http.StatusBadRequest, "Invalid archive ID.")
		return
	}
	depth := 2
	if value, err := strconv.Atoi(r.URL.Query().Get("depth")); err == nil && value >= 0 && value <= 4 {
		depth = value
	}
	ctx, cancel := context.WithTimeout(r.Context(), 100*time.Second)
	defer cancel()
	started := time.Now()
	result, err := v.buildBundle(ctx, auth, id, depth, r.URL.Query().Get("fresh") == "1")
	var upstream upstreamError
	switch {
	case errors.As(err, &upstream):
		v.writeArchive(w, r, upstream.status, nil, nil)
	case err != nil:
		fail(w, http.StatusBadGateway, "The cloud archive service is unavailable.")
	default:
		result.TookMs = time.Since(started).Milliseconds()
		writeJSON(w, http.StatusOK, result)
	}
}

func (v *viewer) getJSON(ctx context.Context, auth archiveAuth, sub string, query url.Values, fresh bool, dst any) (json.RawMessage, error) {
	status, raw, err := v.archiveGet(ctx, auth, sub, query, fresh)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, upstreamError{status}
	}
	if dst != nil {
		if err := json.Unmarshal(raw, dst); err != nil {
			return nil, err
		}
	}
	return raw, nil
}

func (v *viewer) buildBundle(ctx context.Context, auth archiveAuth, id string, depth int, fresh bool) (*runBundle, error) {
	result := &runBundle{ID: id, Payloads: map[string]json.RawMessage{}, Children: []*runBundle{}, FetchedMs: time.Now().UnixMilli()}

	var detail struct {
		Children        []string `json:"children"`
		HasMoreChildren bool     `json:"has_more_children"`
		NextChildCursor string   `json:"next_child_cursor"`
	}
	raw, err := v.getJSON(ctx, auth, "/"+id, nil, fresh, &detail)
	if err != nil {
		return nil, err
	}
	result.Detail = raw
	children := append([]string(nil), detail.Children...)
	for pages := 0; detail.HasMoreChildren && detail.NextChildCursor != "" && pages < 20; pages++ {
		query := url.Values{"children_after": {detail.NextChildCursor}}
		cursor := detail.NextChildCursor
		detail.Children, detail.HasMoreChildren, detail.NextChildCursor = nil, false, ""
		if _, err := v.getJSON(ctx, auth, "/"+id, query, fresh, &detail); err != nil {
			result.Problems = append(result.Problems, "children page after "+cursor+": "+err.Error())
			break
		}
		children = append(children, detail.Children...)
	}

	after := 0
	for pages := 0; pages < 50; pages++ {
		var page struct {
			Events  []json.RawMessage `json:"events"`
			HasMore bool              `json:"has_more"`
			NextSeq int               `json:"next_seq"`
		}
		query := url.Values{"limit": {"500"}}
		if after > 0 {
			query.Set("after_seq", strconv.Itoa(after))
		}
		if _, err := v.getJSON(ctx, auth, "/"+id+"/events", query, fresh, &page); err != nil {
			if pages == 0 {
				return nil, err
			}
			result.Problems = append(result.Problems, fmt.Sprintf("events after %d: %v", after, err))
			break
		}
		result.Events = append(result.Events, page.Events...)
		if !page.HasMore || page.NextSeq <= after {
			break
		}
		after = page.NextSeq
	}

	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)
	for _, rawEvent := range result.Events {
		var event struct {
			PayloadID string `json:"payload_id"`
		}
		if json.Unmarshal(rawEvent, &event) != nil || event.PayloadID == "" || !validArchiveID(event.PayloadID) {
			continue
		}
		wg.Add(1)
		go func(payloadID string) {
			defer wg.Done()
			var reply struct {
				Payload json.RawMessage `json:"payload"`
			}
			_, err := v.getJSON(ctx, auth, "/"+id+"/payloads/"+payloadID, nil, false, &reply)
			value := reply.Payload
			if err != nil || len(value) == 0 {
				message := "missing"
				if err != nil {
					message = err.Error()
				}
				value, _ = json.Marshal(map[string]string{"error": message})
			}
			mu.Lock()
			result.Payloads[payloadID] = value
			mu.Unlock()
		}(event.PayloadID)
	}

	if depth > 0 {
		result.Children = make([]*runBundle, len(children))
		for i, childID := range children {
			if !validArchiveID(childID) {
				continue
			}
			wg.Add(1)
			go func(i int, childID string) {
				defer wg.Done()
				child, err := v.buildBundle(ctx, auth, childID, depth-1, fresh)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					result.Problems = append(result.Problems, "child "+childID+": "+err.Error())
					return
				}
				result.Children[i] = child
			}(i, childID)
		}
	}
	wg.Wait()
	kept := result.Children[:0]
	for _, child := range result.Children {
		if child != nil {
			kept = append(kept, child)
		}
	}
	result.Children = kept
	return result, nil
}
