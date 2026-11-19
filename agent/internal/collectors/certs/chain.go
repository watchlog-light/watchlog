// SPDX-License-Identifier: AGPL-3.0-only

package certs

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

// Chain states (ADR-222):
const (
	// ChainComplete: the presented chain reaches a root the server trusts.
	ChainComplete = "complete"
	// ChainIncomplete: a public CA's certificate (it names where its issuer is published)
	// sent without the intermediate that links it to a trusted root. Browsers may fetch it;
	// many clients (curl, Java, Go, mail servers) fail.
	ChainIncomplete = "incomplete"
	// ChainPrivate: issued by a CA the server doesn't trust (an internal CA). Shown, not alerted.
	ChainPrivate = "private"
	// ChainSelfSigned: the certificate signs itself.
	ChainSelfSigned = "self-signed"
)

// MaxNames is the most names kept per certificate.
const MaxNames = 20

// chainState examines a presented chain as it was sent. Nothing is fetched: a missing
// intermediate is never downloaded.
func chainState(chain []*x509.Certificate, roots *x509.CertPool, now time.Time) string {
	leaf := chain[0]
	inter := x509.NewCertPool()
	for _, c := range chain[1:] {
		inter.AddCert(c)
	}
	// Validity is judged apart (expiry): the chain is checked at a time it was valid.
	at := now
	switch {
	case at.After(leaf.NotAfter):
		at = leaf.NotAfter.Add(-time.Second) // its last valid moment
	case at.Before(leaf.NotBefore):
		at = leaf.NotBefore.Add(time.Second)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter, CurrentTime: at, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err == nil {
		return ChainComplete
	}
	if len(chain) == 1 && selfSigned(leaf) {
		return ChainSelfSigned
	}
	last := chain[len(chain)-1]
	if selfSigned(last) {
		return ChainPrivate
	}
	// The last certificate's issuer wasn't sent. A public CA's certificate says where its
	// issuer is published (Authority Information Access); an internal CA's rarely does.
	if len(last.IssuingCertificateURL) > 0 {
		return ChainIncomplete
	}
	return ChainPrivate
}

func selfSigned(c *x509.Certificate) bool {
	return bytes.Equal(c.RawIssuer, c.RawSubject) && c.CheckSignatureFrom(c) == nil
}

// namesOf are the names a certificate covers: its DNS names (subject alternative names),
// else its common name; lower case, at most MaxNames.
func namesOf(c *x509.Certificate) []string {
	var out []string
	seen := map[string]bool{}
	add := func(n string) {
		n = strings.ToLower(strings.TrimSpace(n))
		if n == "" || seen[n] || len(out) >= MaxNames {
			return
		}
		seen[n] = true
		out = append(out, n)
	}
	for _, n := range c.DNSNames {
		add(n)
	}
	for _, ip := range c.IPAddresses {
		add(ip.String())
	}
	if len(out) == 0 {
		add(c.Subject.CommonName)
	}
	return out
}

// identity names a certificate on a server by its names, so a renewed certificate for the
// same names is the same row and the same alert (ADR-222, slice 1).
func identity(names []string) string {
	s := append([]string(nil), names...)
	sort.Strings(s)
	sum := sha256.Sum256([]byte(strings.Join(s, "\n")))
	return hex.EncodeToString(sum[:8])
}

func fingerprint(c *x509.Certificate) string {
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:])
}

func keyOf(c *x509.Certificate) (string, int) {
	switch k := c.PublicKey.(type) {
	case *rsa.PublicKey:
		return "RSA", k.N.BitLen()
	case *ecdsa.PublicKey:
		return "ECDSA", k.Curve.Params().BitSize
	case ed25519.PublicKey:
		return "Ed25519", 256
	}
	return c.PublicKeyAlgorithm.String(), 0
}

// covers says whether the certificate is valid for a host name (wildcards as TLS has them).
func covers(c *x509.Certificate, host string) bool {
	return c.VerifyHostname(host) == nil
}
