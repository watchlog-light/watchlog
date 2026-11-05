// SPDX-License-Identifier: AGPL-3.0-only

package buffer

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newBuffer(t *testing.T, maxBytes int64, maxAge time.Duration) (*Buffer, *time.Time) {
	t.Helper()
	b, err := Open(t.TempDir(), maxBytes, maxAge)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	b.now = func() time.Time { return now }
	return b, &now
}

func TestPutAndReadOldestFirst(t *testing.T) {
	b, now := newBuffer(t, 1<<20, time.Hour)
	for _, body := range []string{"one", "two", "three"} {
		if _, err := b.Put([]byte(body)); err != nil {
			t.Fatal(err)
		}
		*now = now.Add(time.Second)
	}
	it, ok, err := b.Oldest()
	if err != nil || !ok {
		t.Fatalf("Oldest: %v %v", ok, err)
	}
	body, _ := b.Read(it)
	if string(body) != "one" {
		t.Errorf("oldest = %q", body)
	}
	if err := b.Remove(it); err != nil {
		t.Fatal(err)
	}
	if err := b.Remove(it); err != nil {
		t.Errorf("removing twice should be fine: %v", err)
	}
	files, size, _ := b.Stats()
	if files != 2 || size != int64(len("two")+len("three")) {
		t.Errorf("stats = %d files, %d bytes", files, size)
	}
}

func TestOrderSurvivesSameTimestamp(t *testing.T) {
	b, _ := newBuffer(t, 1<<20, time.Hour)
	for i := 0; i < 12; i++ {
		if _, err := b.Put([]byte{byte(i)}); err != nil {
			t.Fatal(err)
		}
	}
	items, _ := b.List()
	for i, it := range items {
		body, _ := b.Read(it)
		if !bytes.Equal(body, []byte{byte(i)}) {
			t.Fatalf("item %d has body %v", i, body)
		}
	}
}

func TestDropsExpiredBatches(t *testing.T) {
	b, now := newBuffer(t, 1<<20, 15*time.Minute)
	_, _ = b.Put([]byte("old"))
	*now = now.Add(16 * time.Minute)
	dropped, err := b.Put([]byte("new"))
	if err != nil {
		t.Fatal(err)
	}
	if dropped.Expired != 1 {
		t.Errorf("dropped = %+v", dropped)
	}
	it, _, _ := b.Oldest()
	if body, _ := b.Read(it); string(body) != "new" {
		t.Errorf("remaining = %q", body)
	}
}

func TestDropsOldestWhenFullButKeepsNewest(t *testing.T) {
	b, now := newBuffer(t, 10, time.Hour)
	for _, body := range []string{"aaaa", "bbbb", "cccc"} {
		_, _ = b.Put([]byte(body))
		*now = now.Add(time.Second)
	}
	files, size, _ := b.Stats()
	if files != 2 || size != 8 {
		t.Errorf("stats = %d files, %d bytes", files, size)
	}
	// A single batch larger than the limit is still kept (it is the newest).
	dropped, _ := b.Put(bytes.Repeat([]byte("x"), 50))
	files, _, _ = b.Stats()
	if files != 1 || dropped.BufferFull != 2 {
		t.Errorf("files = %d, dropped = %+v", files, dropped)
	}
}

func TestOpenRemovesTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "00000000000000000001-00000001.rw.tmp"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := Open(dir, 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if files, _, _ := b.Stats(); files != 0 {
		t.Errorf("files = %d", files)
	}
	if _, err := os.Stat(filepath.Join(dir, "00000000000000000001-00000001.rw.tmp")); !os.IsNotExist(err) {
		t.Error("temporary file was not removed")
	}
}
