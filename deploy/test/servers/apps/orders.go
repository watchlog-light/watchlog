// SPDX-License-Identifier: AGPL-3.0-only
// A tiny Go service for the Servers tests: answers HTTP on :8091, exits with code 3 when
// asked (a crash), and allocates memory when asked (an OOM kill at its unit's limit).
package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	var hold [][]byte
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "orders ok") })
	http.HandleFunc("/crash", func(w http.ResponseWriter, _ *http.Request) { os.Exit(3) })
	http.HandleFunc("/grow", func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i < 64; i++ {
			b := make([]byte, 16<<20)
			for j := range b {
				b[j] = 1
			}
			hold = append(hold, b)
		}
		fmt.Fprintln(w, len(hold))
	})
	_ = http.ListenAndServe(":8091", nil)
}
