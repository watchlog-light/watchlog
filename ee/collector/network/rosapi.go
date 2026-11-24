// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

// The RouterOS API's wire format (the "API" and "API-SSL" services, TCP 8728 and 8729):
// sentences of length-prefixed words, ended by an empty word.

// WriteWord writes one word with its length prefix.
func WriteWord(w io.Writer, word string) error {
	n := len(word)
	var b []byte
	switch {
	case n < 0x80:
		b = []byte{byte(n)}
	case n < 0x4000:
		b = []byte{byte(n>>8) | 0x80, byte(n)}
	case n < 0x200000:
		b = []byte{byte(n>>16) | 0xC0, byte(n >> 8), byte(n)}
	case n < 0x10000000:
		b = []byte{byte(n>>24) | 0xE0, byte(n >> 16), byte(n >> 8), byte(n)}
	default:
		b = make([]byte, 5)
		b[0] = 0xF0
		binary.BigEndian.PutUint32(b[1:], uint32(n))
	}
	if _, err := w.Write(b); err != nil {
		return err
	}
	_, err := io.WriteString(w, word)
	return err
}

// WriteSentence writes words and the empty word that ends them.
func WriteSentence(w io.Writer, words ...string) error {
	for _, word := range words {
		if err := WriteWord(w, word); err != nil {
			return err
		}
	}
	return WriteWord(w, "")
}

// maxWord bounds one word (a RouterOS value is never near it).
const maxWord = 1 << 20

// ReadWord reads one word.
func ReadWord(r *bufio.Reader) (string, error) {
	c, err := r.ReadByte()
	if err != nil {
		return "", err
	}
	var n int
	switch {
	case c&0x80 == 0:
		n = int(c)
	case c&0xC0 == 0x80:
		b, err := r.ReadByte()
		if err != nil {
			return "", err
		}
		n = int(c&0x3F)<<8 | int(b)
	case c&0xE0 == 0xC0:
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		n = int(c&0x1F)<<16 | int(b[0])<<8 | int(b[1])
	case c&0xF0 == 0xE0:
		var b [3]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		n = int(c&0x0F)<<24 | int(b[0])<<16 | int(b[1])<<8 | int(b[2])
	case c == 0xF0:
		var b [4]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		n = int(binary.BigEndian.Uint32(b[:]))
	default:
		return "", errors.New("routeros api: bad length")
	}
	if n > maxWord {
		return "", fmt.Errorf("routeros api: a %d-byte word", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

// ReadSentence reads words up to the empty one.
func ReadSentence(r *bufio.Reader) ([]string, error) {
	var out []string
	for {
		w, err := ReadWord(r)
		if err != nil {
			return nil, err
		}
		if w == "" {
			return out, nil
		}
		out = append(out, w)
		if len(out) > 4096 {
			return nil, errors.New("routeros api: sentence too long")
		}
	}
}

// attrs reads "=key=value" words.
func attrs(words []string) map[string]string {
	m := map[string]string{}
	for _, w := range words {
		if !strings.HasPrefix(w, "=") {
			continue
		}
		k, v, _ := strings.Cut(w[1:], "=")
		m[k] = v
	}
	return m
}
