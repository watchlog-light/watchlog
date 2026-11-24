// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

// Command netsim serves simulated network devices (ee/collector/netsim, ADR-233): the
// office (a RouterOS router, a Nexus core and two Catalyst access switches) for the live
// demo, or a fleet of 52-port switches for the poller's budget run.
//
//	netsim -office -listen 0.0.0.0 -snmp-port 1161      # the demo: real time, events every few hours
//	netsim -fleet 50 -listen 127.0.0.1 -control :0      # the budget run: time set by the caller
//
// It prints one JSON line per device (name, address, protocol, port) on start.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/watchlog-light/watchlog/ee/collector/netsim"
)

type device struct {
	Name     string `json:"name"`
	Address  string `json:"address"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	APIPort  int    `json:"apiPort,omitempty"`
}

func main() {
	office := flag.Bool("office", false, "serve the office network")
	fleet := flag.Int("fleet", 0, "serve N 52-port access switches")
	listen := flag.String("listen", "127.0.0.1", "address to listen on")
	snmpPort := flag.Int("snmp-port", 0, "first SNMP port (0: any free port)")
	restPort := flag.Int("rest-port", 0, "the router's REST (HTTPS) port")
	apiPort := flag.Int("api-ssl-port", 0, "the router's API-SSL port")
	community := flag.String("community", "public", "the SNMP v2c community")
	control := flag.String("control", "", "serve POST /time?ms= (a replayed clock) on this address")
	nodes := flag.String("nodes", "", "JSON list of {mac, ip, vlan} for the servers and nodes behind the switches")
	admin := flag.String("admin", "", "serve POST /port?device=&port=&up= and /rate?device=&port=&in=&out= (tests) on this address")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	start := time.Now().Add(-37 * 24 * time.Hour)
	var replay atomic.Int64
	clock := func() time.Time {
		if ms := replay.Load(); ms > 0 {
			return time.UnixMilli(ms)
		}
		return time.Now()
	}
	if *control != "" {
		start = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		replay.Store(start.Add(time.Hour).UnixMilli())
		ln, err := net.Listen("tcp", *control)
		if err != nil {
			log.Error("control", "err", err)
			os.Exit(1)
		}
		mux := http.NewServeMux()
		mux.HandleFunc("POST /time", func(w http.ResponseWriter, r *http.Request) {
			ms, err := strconv.ParseInt(r.URL.Query().Get("ms"), 10, 64)
			if err != nil {
				http.Error(w, "ms", http.StatusBadRequest)
				return
			}
			replay.Store(ms)
		})
		go func() { _ = (&http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}).Serve(ln) }()
		fmt.Printf(`{"control":%q,"start":%d}`+"\n", ln.Addr().String(), start.UnixMilli())
	}

	var specs []netsim.Spec
	var eps []netsim.Endpoint
	if *nodes != "" {
		if err := json.Unmarshal([]byte(*nodes), &eps); err != nil {
			log.Error("nodes", "err", err)
			os.Exit(2)
		}
	}
	if *office {
		specs = netsim.Office(eps)
	}
	specs = append(specs, netsim.Fleet(*fleet)...)
	srv := &netsim.Server{Community: *community, Clock: clock}
	agents := map[string]*netsim.Agent{}
	out := json.NewEncoder(os.Stdout)
	for i, s := range specs {
		a := netsim.Build(s, start)
		agents[s.Name] = a
		addr := net.JoinHostPort(*listen, "0")
		if *snmpPort > 0 {
			addr = net.JoinHostPort(*listen, strconv.Itoa(*snmpPort+i))
		}
		got, err := srv.Listen(ctx, addr, a)
		if err != nil {
			log.Error("listen", "device", s.Name, "err", err)
			os.Exit(1)
		}
		host, port, _ := net.SplitHostPort(got)
		p, _ := strconv.Atoi(port)
		_ = out.Encode(device{Name: s.Name, Address: host, Port: p, Protocol: "snmp"})
	}
	var router *netsim.RouterOS
	if *office {
		router = netsim.Edge(start)
		router.Clock = clock
		rest, err := router.ServeREST(ctx, net.JoinHostPort(*listen, strconv.Itoa(*restPort)))
		if err != nil {
			log.Error("rest", "err", err)
			os.Exit(1)
		}
		api, err := router.ServeAPI(ctx, net.JoinHostPort(*listen, strconv.Itoa(*apiPort)), true)
		if err != nil {
			log.Error("api-ssl", "err", err)
			os.Exit(1)
		}
		_, rp, _ := net.SplitHostPort(rest)
		_, ap, _ := net.SplitHostPort(api)
		p1, _ := strconv.Atoi(rp)
		p2, _ := strconv.Atoi(ap)
		_ = out.Encode(device{Name: "edge-1", Address: *listen, Port: p1, Protocol: "routeros", APIPort: p2})
		if *control == "" && *admin == "" {
			go events(ctx, log, agents, router)
		}
	}
	if *admin != "" {
		serveAdmin(ctx, log, *admin, agents, router)
	}
	<-ctx.Done()
}

// events makes the demo's network do something every few hours, at irregular times: a desk
// port flaps, or the uplink of an access switch gets busy for twenty minutes.
func events(ctx context.Context, log *slog.Logger, agents map[string]*netsim.Agent, router *netsim.RouterOS) {
	for {
		wait := time.Duration(90+rand.IntN(180)) * time.Minute
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if rand.IntN(2) == 0 {
			sw := agents["sw-access-1"]
			port := fmt.Sprintf("Gi1/0/%d", 30+2*rand.IntN(6))
			log.Info("flap", "device", "sw-access-1", "port", port)
			sw.SetOper(port, false)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Duration(2+rand.IntN(6)) * time.Minute):
			}
			sw.SetOper(port, true)
			continue
		}
		sw := agents["sw-access-2"]
		log.Info("busy", "device", "sw-access-2", "port", "Te1/1/1")
		sw.SetRate("Te1/1/1", time.Now(), 1_180_000_000, 300_000_000) // ~94% of 10 Gb/s in
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(15+rand.IntN(15)) * time.Minute):
		}
		sw.SetRate("Te1/1/1", time.Now(), 4_000_000, 2_400_000)
		_ = router
	}
}

// serveAdmin lets a test flap a port or load a link now, instead of waiting hours.
func serveAdmin(ctx context.Context, log *slog.Logger, addr string, agents map[string]*netsim.Agent, router *netsim.RouterOS) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /port", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		up := q.Get("up") == "true"
		if q.Get("device") == "edge-1" && router != nil {
			router.SetRunning(q.Get("port"), up)
			return
		}
		a, ok := agents[q.Get("device")]
		if !ok {
			http.Error(w, "no such device", http.StatusNotFound)
			return
		}
		a.SetOper(q.Get("port"), up)
	})
	mux.HandleFunc("POST /rate", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		a, ok := agents[q.Get("device")]
		if !ok {
			http.Error(w, "no such device", http.StatusNotFound)
			return
		}
		in, _ := strconv.ParseFloat(q.Get("in"), 64)
		out, _ := strconv.ParseFloat(q.Get("out"), 64)
		a.SetRate(q.Get("port"), time.Now(), in, out)
	})
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Error("admin", "err", err)
		os.Exit(1)
	}
	go func() { <-ctx.Done(); _ = ln.Close() }()
	go func() { _ = (&http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}).Serve(ln) }()
}
