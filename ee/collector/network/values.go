// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"fmt"
	"math/big"
	"net"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gosnmp/gosnmp"
)

// num reads a numeric value (Integer, Counter32/64, Gauge32, TimeTicks, Uinteger32, or a
// number written as text).
func num(v Var) (float64, bool) {
	switch x := v.Value.(type) {
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case uint:
		return float64(x), true
	case uint32:
		return float64(x), true
	case uint64:
		return float64(x), true
	case *big.Int:
		f, _ := new(big.Float).SetInt(x).Float64()
		return f, true
	case []byte:
		f, err := strconv.ParseFloat(strings.TrimSpace(string(x)), 64)
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	}
	return 0, false
}

// str reads a value as text: printable octet strings as they are, binary ones as hex pairs.
func str(v Var) string {
	switch x := v.Value.(type) {
	case []byte:
		if printable(x) {
			return strings.TrimRight(string(x), "\x00 ")
		}
		return hexPairs(x)
	case string:
		return x
	case nil:
		return ""
	}
	if f, ok := num(v); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return fmt.Sprint(v.Value)
}

func printable(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, r := range strings.TrimRight(string(b), "\x00") {
		if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}

func hexPairs(b []byte) string {
	parts := make([]string, len(b))
	for i, c := range b {
		parts[i] = fmt.Sprintf("%02x", c)
	}
	return strings.Join(parts, ":")
}

// macOf reads a 6-byte MAC address ("" when it isn't one).
func macOf(v Var) string {
	if b, ok := v.Value.([]byte); ok && len(b) == 6 {
		return hexPairs(b)
	}
	if s, ok := v.Value.(string); ok {
		if hw, err := net.ParseMAC(s); err == nil && len(hw) == 6 {
			return hw.String()
		}
	}
	return ""
}

// macFromIndex reads a MAC address from the last 6 parts of an OID index.
func macFromIndex(parts []string) string {
	if len(parts) < 6 {
		return ""
	}
	b := make([]byte, 6)
	for i, p := range parts[len(parts)-6:] {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return ""
		}
		b[i] = byte(n)
	}
	return hexPairs(b)
}

// ipv4FromIndex reads an IPv4 address from 4 parts of an OID index.
func ipv4FromIndex(parts []string) string {
	if len(parts) != 4 {
		return ""
	}
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return ""
		}
	}
	return strings.Join(parts, ".")
}

// ipv4Of reads an IPv4 address from a value (IpAddress or 4 octets).
func ipv4Of(v Var) string {
	switch x := v.Value.(type) {
	case string:
		if ip := net.ParseIP(x); ip != nil && ip.To4() != nil {
			return ip.To4().String()
		}
	case []byte:
		if len(x) == 4 {
			return net.IP(x).String()
		}
	}
	return ""
}

// table is one walked column: index → value.
type table map[string]Var

// walkCol reads a column (or any subtree), keyed by the index after it. An empty OID reads
// nothing.
func walkCol(ctx context.Context, r Reader, col string) (table, error) {
	out := table{}
	if col == "" {
		return out, nil
	}
	col = strings.TrimPrefix(col, ".")
	prefix := col + "."
	err := r.Walk(ctx, col, func(v Var) error {
		if strings.HasPrefix(v.OID, prefix) {
			out[v.OID[len(prefix):]] = v
		}
		return nil
	})
	return out, err
}

func (t table) num(idx string) (float64, bool) {
	v, ok := t[idx]
	if !ok {
		return 0, false
	}
	return num(v)
}

func (t table) str(idx string) string {
	v, ok := t[idx]
	if !ok {
		return ""
	}
	return str(v)
}

// isCounter says a value is a counter type (for the wrap width).
func counterBits(v Var) int {
	if v.Type == gosnmp.Counter64 {
		return 64
	}
	return 32
}
