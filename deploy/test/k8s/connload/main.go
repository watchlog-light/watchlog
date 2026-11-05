// SPDX-License-Identifier: AGPL-3.0-only

// connload opens short TCP connections at a fixed rate, for the Phase 4 agent CPU
// budget test (1,000 connections a second per node, SPEC §13).
//
//	connload server :8080
//	connload client conn-server:8080 1000
package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: connload server <addr> | client <addr> <per second>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "server":
		server(os.Args[2])
	case "client":
		rate, err := strconv.Atoi(os.Args[3])
		if err != nil || rate <= 0 {
			fmt.Fprintln(os.Stderr, "rate must be a positive number")
			os.Exit(2)
		}
		client(os.Args[2], rate)
	}
}

func server(addr string) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		_ = c.Close()
	}
}

func client(addr string, rate int) {
	var ok, failed atomic.Int64
	sem := make(chan struct{}, 256)
	go func() {
		for range time.Tick(10 * time.Second) {
			fmt.Printf("%s ok=%d failed=%d\n", time.Now().Format(time.TimeOnly), ok.Swap(0), failed.Swap(0))
		}
	}()
	tick := time.NewTicker(time.Second / time.Duration(rate))
	for range tick.C {
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			c, err := net.DialTimeout("tcp", addr, 2*time.Second)
			if err != nil {
				failed.Add(1)
				return
			}
			_ = c.Close()
			ok.Add(1)
		}()
	}
}
