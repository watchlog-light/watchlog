// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"

	"github.com/watchlog-light/watchlog/agent/internal/sender"
)

// Shipping intervals and sizes (ADR-055).
const (
	DeltaInterval    = 5 * time.Second
	SnapshotInterval = 10 * time.Minute
	SnapshotRetry    = 30 * time.Second
	ChunkSize        = 2000
	// DeltaFailuresBeforeSnapshot: after this many failed deltas in a row (30 s) the
	// cluster-agent sends a fresh snapshot instead of retrying the same delta until the
	// next one (ADR-117). If the snapshot fails too, the count doubles, up to
	// SnapshotInterval.
	DeltaFailuresBeforeSnapshot = 6
)

// errDeltaRejected: the backend refused a delta chunk (4xx); it is not retried.
var errDeltaRejected = errors.New("objects delta rejected")

// PostFunc sends one gzipped JSON body to /ingest/v1/objects.
type PostFunc func(ctx context.Context, body []byte) (sender.Outcome, int)

type objectsBody struct {
	Source     string   `json:"source"`
	Kind       string   `json:"kind"` // snapshot or delta
	SnapshotID string   `json:"snapshot_id"`
	Final      bool     `json:"final,omitempty"`
	Kinds      []string `json:"kinds,omitempty"` // on the final snapshot chunk: kinds to sweep
	Objects    []Record `json:"objects"`
}

type pendingKey struct{ kind, key string }

// Shipper sends snapshots and deltas of the cluster's objects. Deltas carry only
// objects whose summary changed since it was last delivered.
type Shipper struct {
	cluster *Cluster
	post    PostFunc
	log     *slog.Logger

	// ChunkSize caps the objects per request (default ChunkSize).
	ChunkSize int

	mu         sync.Mutex
	pending    map[pendingKey]bool
	deleted    map[string]Record // by UID
	sent       map[string]uint64 // UID → summary hash last delivered
	snapshotID string
}

// NewShipper registers change handlers on the cluster's informers.
func NewShipper(c *Cluster, post PostFunc, log *slog.Logger) (*Shipper, error) {
	s := &Shipper{cluster: c, post: post, log: log, ChunkSize: ChunkSize,
		pending: map[pendingKey]bool{}, deleted: map[string]Record{}, sent: map[string]uint64{}}
	for _, kind := range SentKinds {
		if err := c.AddHandler(kind, s.handler(kind)); err != nil {
			return nil, err
		}
	}
	// A Service's record includes the workloads behind it: re-send it when its
	// EndpointSlices change.
	if err := c.AddHandler("EndpointSlice", s.serviceOfSlice()); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Shipper) handler(kind string) cache.ResourceEventHandler {
	mark := func(obj any) {
		if key, err := cache.MetaNamespaceKeyFunc(obj); err == nil {
			s.mu.Lock()
			s.pending[pendingKey{kind, key}] = true
			s.mu.Unlock()
		}
	}
	return cache.ResourceEventHandlerDetailedFuncs{
		AddFunc: func(obj any, initialList bool) {
			if !initialList { // the snapshot covers the initial list
				mark(obj)
			}
		},
		UpdateFunc: func(oldObj, newObj any) {
			o, ok1 := oldObj.(metav1.Object)
			n, ok2 := newObj.(metav1.Object)
			if ok1 && ok2 && o.GetResourceVersion() == n.GetResourceVersion() {
				return // resync, nothing changed
			}
			mark(newObj)
		},
		DeleteFunc: func(obj any) {
			if t, ok := obj.(cache.DeletedFinalStateUnknown); ok {
				obj = t.Obj
			}
			m, ok := obj.(metav1.Object)
			if !ok {
				return
			}
			s.mu.Lock()
			s.deleted[string(m.GetUID())] = Record{Kind: kind, UID: string(m.GetUID()), Namespace: m.GetNamespace(),
				Name: m.GetName(), Spec: map[string]any{}, Status: map[string]any{}, Deleted: true}
			delete(s.pending, pendingKey{kind, m.GetNamespace() + "/" + m.GetName()})
			s.mu.Unlock()
		},
	}
}

func hashRecord(r Record) uint64 {
	b, _ := json.Marshal(r)
	h := fnv.New64a()
	_, _ = h.Write(b)
	return h.Sum64()
}

func newSnapshotID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Shipper) send(ctx context.Context, body objectsBody) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	switch outcome, status := s.post(ctx, b); outcome {
	case sender.Delivered:
		return nil
	case sender.Rejected:
		// A poison body is not retried; a snapshot replaces it (ADR-117).
		s.log.Warn("objects rejected by the backend", "kind", body.Kind, "status", status, "objects", len(body.Objects))
		if body.Kind == "delta" {
			return errDeltaRejected
		}
		return nil
	default:
		return fmt.Errorf("objects not delivered: %s (status %d)", outcome, status)
	}
}

// Snapshot sends every object in chunks; the final chunk lets the backend remove
// objects it did not see.
func (s *Shipper) Snapshot(ctx context.Context) error {
	id := newSnapshotID()
	var all []Record
	for _, kind := range SentKinds {
		all = append(all, s.cluster.Records(kind)...)
	}
	for start := 0; start < len(all) || start == 0; start += s.ChunkSize {
		end := min(start+s.ChunkSize, len(all))
		final := end == len(all)
		body := objectsBody{Source: "kubernetes", Kind: "snapshot", SnapshotID: id, Final: final, Objects: all[start:end]}
		if final {
			body.Kinds = SentKinds
		}
		if err := s.send(ctx, body); err != nil {
			return err
		}
		if final {
			break
		}
	}
	s.mu.Lock()
	s.snapshotID = id
	s.sent = make(map[string]uint64, len(all))
	for _, r := range all {
		s.sent[r.UID] = hashRecord(r)
	}
	s.mu.Unlock()
	s.log.Info("objects snapshot sent", "objects", len(all), "chunks", (len(all)+s.ChunkSize-1)/s.ChunkSize)
	return nil
}

// Flush sends the objects changed since the last flush. Undelivered changes are
// kept for the next flush.
func (s *Shipper) Flush(ctx context.Context) error {
	s.mu.Lock()
	pending, deleted, id := s.pending, s.deleted, s.snapshotID
	s.pending, s.deleted = map[pendingKey]bool{}, map[string]Record{}
	s.mu.Unlock()

	var out []Record
	hashes := map[string]uint64{}
	for k := range pending {
		store := s.cluster.Store(k.kind)
		obj, ok, err := store.GetByKey(k.key)
		if err != nil || !ok {
			continue // deleted meanwhile: the delete handler recorded it
		}
		r, ok := ToRecord(obj, s.cluster)
		if !ok {
			continue
		}
		h := hashRecord(r)
		s.mu.Lock()
		same := s.sent[r.UID] == h
		s.mu.Unlock()
		if !same {
			out = append(out, r)
			hashes[r.UID] = h
		}
	}
	for _, r := range deleted {
		out = append(out, r)
	}
	var rejected error
	for start := 0; start < len(out); start += s.ChunkSize {
		chunk := out[start:min(start+s.ChunkSize, len(out))]
		if err := s.send(ctx, objectsBody{Source: "kubernetes", Kind: "delta", SnapshotID: id, Objects: chunk}); err != nil {
			if errors.Is(err, errDeltaRejected) {
				rejected = err // dropped; the rest still goes, the snapshot fixes this chunk
				continue
			}
			s.requeue(chunk)
			s.requeue(out[min(start+s.ChunkSize, len(out)):])
			return err
		}
		s.mu.Lock()
		for _, r := range chunk {
			if r.Deleted {
				delete(s.sent, r.UID)
			} else {
				s.sent[r.UID] = hashes[r.UID]
			}
		}
		s.mu.Unlock()
	}
	return rejected
}

func (s *Shipper) requeue(records []Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range records {
		if r.Deleted {
			s.deleted[r.UID] = r
		} else {
			key := r.Name // cluster-scoped objects are keyed by name alone
			if r.Namespace != "" {
				key = r.Namespace + "/" + r.Name
			}
			s.pending[pendingKey{r.Kind, key}] = true
		}
	}
}

// Run sends a snapshot (retried until delivered), then deltas every DeltaInterval
// and a fresh snapshot every SnapshotInterval, until ctx ends.
func (s *Shipper) Run(ctx context.Context) {
	for {
		err := s.Snapshot(ctx)
		if err == nil {
			break
		}
		s.log.Warn("objects snapshot not delivered; retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(SnapshotRetry):
		}
	}
	deltas := time.NewTicker(DeltaInterval)
	defer deltas.Stop()
	snapshots := time.NewTicker(SnapshotInterval)
	defer snapshots.Stop()
	var f deltaFailures
	for {
		select {
		case <-ctx.Done():
			return
		case <-deltas.C:
			s.flushOrSnapshot(ctx, &f)
		case <-snapshots.C:
			if err := s.Snapshot(ctx); err != nil {
				s.log.Warn("objects snapshot not delivered; the next one follows in 10 minutes", "err", err)
			}
		}
	}
}

// deltaFailures counts failed deltas in a row and how many trigger a fresh snapshot.
type deltaFailures struct {
	n, limit int
}

// flushOrSnapshot sends a delta. After DeltaFailuresBeforeSnapshot failures in a row
// (rejected, or not delivered) it sends a fresh snapshot instead (ADR-117): the backend
// may refuse one object kind or one body forever (a 500 for a new namespace marker
// once), and retrying the same delta would hold every later change until the next
// 10-minute snapshot. It returns whether a snapshot was sent and delivered.
func (s *Shipper) flushOrSnapshot(ctx context.Context, f *deltaFailures) bool {
	if f.limit == 0 {
		f.limit = DeltaFailuresBeforeSnapshot
	}
	err := s.Flush(ctx)
	if err == nil {
		f.n, f.limit = 0, DeltaFailuresBeforeSnapshot
		return false
	}
	f.n++
	if f.n < f.limit {
		s.log.Debug("objects delta not delivered; kept for the next flush", "err", err, "failures", f.n)
		return false
	}
	s.log.Warn("objects deltas keep failing; sending a fresh snapshot instead", "failures", f.n, "err", err)
	f.n = 0
	if serr := s.Snapshot(ctx); serr != nil {
		maxLimit := int(SnapshotInterval / DeltaInterval)
		f.limit = min(f.limit*2, maxLimit)
		s.log.Warn("fresh objects snapshot not delivered either", "err", serr, "next_after_failures", f.limit)
		return false
	}
	f.limit = DeltaFailuresBeforeSnapshot
	return true
}

func (s *Shipper) serviceOfSlice() cache.ResourceEventHandler {
	mark := func(obj any) {
		if t, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			obj = t.Obj
		}
		keys, _ := sliceService(obj)
		s.mu.Lock()
		for _, k := range keys {
			s.pending[pendingKey{"Service", k}] = true
		}
		s.mu.Unlock()
	}
	return cache.ResourceEventHandlerDetailedFuncs{
		AddFunc: func(obj any, initialList bool) {
			if !initialList {
				mark(obj)
			}
		},
		UpdateFunc: func(_, newObj any) { mark(newObj) },
		DeleteFunc: mark,
	}
}
