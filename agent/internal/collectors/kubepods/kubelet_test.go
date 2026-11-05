// SPDX-License-Identifier: AGPL-3.0-only

package kubepods

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func tlsKubelet(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sa-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"pods":[{"podRef":{"name":"web","namespace":"wl-test","uid":"u1"},"network":{"rxBytes":1,"txBytes":2}}]}`))
	}))
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	ca := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte("sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return srv, dir
}

// unrelatedCA writes a fresh self-signed CA (all httptest servers share one cert).
func unrelatedCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "other-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ca.crt"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestKubeletTLSModes(t *testing.T) {
	srv, dir := tlsKubelet(t)
	otherDir := unrelatedCA(t) // does not sign srv's certificate, like a cluster CA vs a self-signed kubelet
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cases := []struct {
		name, mode, ca string
		ok             bool
		state          string
	}{
		{"verify with the right CA", TLSVerify, dir, true, "verified"},
		{"verify with a wrong CA", TLSVerify, otherDir, false, ""},
		{"auto falls back when the CA does not match", TLSAuto, otherDir, true, "unverified"},
		{"auto stays verified when it can", TLSAuto, dir, true, "verified"},
		{"skip", TLSSkip, otherDir, true, "unverified"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, err := NewKubelet(srv.URL+"/stats/summary", filepath.Join(c.ca, "ca.crt"), filepath.Join(dir, "token"), c.mode, log)
			if err != nil {
				t.Fatal(err)
			}
			s, err := k.Fetch(context.Background())
			if (err == nil) != c.ok || k.TLS() != c.state {
				t.Fatalf("err=%v state=%q", err, k.TLS())
			}
			if c.ok && (len(s.Pods) != 1 || s.Pods[0].PodRef.UID != "u1") {
				t.Errorf("summary = %+v", s)
			}
		})
	}
	if _, err := NewKubelet("x", "", "", "sometimes", log); err == nil {
		t.Error("unknown mode accepted")
	}
}
