// SPDX-License-Identifier: AGPL-3.0-only

// Package buffer stores outgoing batches on disk until they are delivered (ADR-022).
// Each batch is one file holding the exact request body, written to a temporary
// name and renamed, so a crash never leaves a partial batch behind.
package buffer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const suffix = ".rw"

// Item is one stored batch.
type Item struct {
	Name    string
	Created time.Time
	Size    int64
}

// Dropped counts batches removed by the limits.
type Dropped struct {
	Expired    int
	BufferFull int
}

// Buffer is a directory of batches, oldest first.
type Buffer struct {
	dir      string
	maxBytes int64
	maxAge   time.Duration
	now      func() time.Time

	mu  sync.Mutex
	seq uint64
}

// Open creates the directory if needed and removes temporary files left by a crash.
func Open(dir string, maxBytes int64, maxAge time.Duration) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("buffer dir: %w", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("buffer dir: %w", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return &Buffer{dir: dir, maxBytes: maxBytes, maxAge: maxAge, now: time.Now}, nil
}

// Put stores a batch and applies the limits.
func (b *Buffer) Put(body []byte) (Dropped, error) {
	b.mu.Lock()
	b.seq++
	name := fmt.Sprintf("%020d-%08d%s", b.now().UnixNano(), b.seq, suffix)
	b.mu.Unlock()

	tmp := filepath.Join(b.dir, name+".tmp")
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		_ = os.Remove(tmp)
		return Dropped{}, fmt.Errorf("buffer write: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(b.dir, name)); err != nil {
		_ = os.Remove(tmp)
		return Dropped{}, fmt.Errorf("buffer rename: %w", err)
	}
	return b.Enforce()
}

// List returns the stored batches, oldest first.
func (b *Buffer) List() ([]Item, error) {
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		return nil, err
	}
	var items []Item
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), suffix) {
			continue
		}
		ns, err := strconv.ParseInt(strings.SplitN(e.Name(), "-", 2)[0], 10, 64)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // removed concurrently
		}
		items = append(items, Item{Name: e.Name(), Created: time.Unix(0, ns), Size: info.Size()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}

// Oldest returns the oldest batch, if any.
func (b *Buffer) Oldest() (Item, bool, error) {
	items, err := b.List()
	if err != nil || len(items) == 0 {
		return Item{}, false, err
	}
	return items[0], true, nil
}

// Read returns a batch's body.
func (b *Buffer) Read(item Item) ([]byte, error) {
	return os.ReadFile(filepath.Join(b.dir, item.Name))
}

// Remove deletes a batch; removing a missing batch is not an error.
func (b *Buffer) Remove(item Item) error {
	err := os.Remove(filepath.Join(b.dir, item.Name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Stats returns the number of batches and their total size.
func (b *Buffer) Stats() (files int, bytes int64, err error) {
	items, err := b.List()
	for _, it := range items {
		bytes += it.Size
	}
	return len(items), bytes, err
}

// Enforce drops batches older than maxAge, then the oldest until the total fits maxBytes.
func (b *Buffer) Enforce() (Dropped, error) {
	items, err := b.List()
	if err != nil {
		return Dropped{}, err
	}
	var dropped Dropped
	var total int64
	cutoff := b.now().Add(-b.maxAge)
	kept := items[:0]
	for _, it := range items {
		if it.Created.Before(cutoff) {
			if err := b.Remove(it); err != nil {
				return dropped, err
			}
			dropped.Expired++
			continue
		}
		kept = append(kept, it)
		total += it.Size
	}
	for i := 0; total > b.maxBytes && i < len(kept)-1; i++ {
		if err := b.Remove(kept[i]); err != nil {
			return dropped, err
		}
		total -= kept[i].Size
		dropped.BufferFull++
	}
	return dropped, nil
}
