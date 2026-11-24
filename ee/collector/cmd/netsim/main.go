// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

// Command netsim serves simulated network devices (ee/collector/netsim, ADR-233): the
// office (a RouterOS router, a Nexus core and two Catalyst access switches) for the live
// demo, or a fleet of 52-port switches for the poller's budget run.
//
//	netsim -office -listen 0.0.0.0 -snmp-port 1161      # the demo: real time, events every few hours
//	netsim -fleet 50 -listen 127.0.0.1 -control :0      # the budget run: time set by the caller
//	netsim -office -dahua-port 8080                      # with a Dahua recorder, nvr-1 (HTTP API)
//
// It prints one JSON line per device (name, address, protocol, port) on start.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
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
	admin := flag.String("admin", "", "serve POST /port?device=&port=&up=, /rate?device=&port=&in=&out=, /camera?channel=&online= and /iscsi?present= (tests) on this address")
	dahuaPort := flag.Int("dahua-port", 0, "serve a Dahua recorder (nvr-1) on this HTTP port (0: none)")
	dahuaUser := flag.String("dahua-user", "watchlog", "the recorder's user")
	dahuaPassword := flag.String("dahua-password", "read-only-sample", "the recorder's password")
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
	var nvr *netsim.Dahua
	if *dahuaPort > 0 {
		nvr = netsim.NVR()
		nvr.User, nvr.Password, nvr.Clock = *dahuaUser, *dahuaPassword, clock
		got, err := nvr.Serve(ctx, net.JoinHostPort(*listen, strconv.Itoa(*dahuaPort)), false)
		if err != nil {
			log.Error("dahua", "err", err)
			os.Exit(1)
		}
		_, port, _ := net.SplitHostPort(got)
		p, _ := strconv.Atoi(port)
		_ = out.Encode(device{Name: "nvr-1", Address: *listen, Port: p, Protocol: "dahua"})
		if *control == "" && *admin == "" {
			go nvrEvents(ctx, log, nvr)
		}
	}
	if *office && *control == "" {
		go traffic(ctx, agents, nvr, clock)
	}
	if *admin != "" {
		serveAdmin(ctx, log, *admin, agents, router, nvr)
	}
	<-ctx.Done()
}

// traffic drives the ports the 0.17 pages read (ADR-234): the recorder writes about 6 MB/s
// toward the NAS (next to nothing while its iSCSI disk is lost, when the NAS's target loses its
// session too), and the access points carry a day's curve, busiest in office hours.
func traffic(ctx context.Context, agents map[string]*netsim.Agent, nvr *netsim.Dahua, clock func() time.Time) {
	sw1, sw2, nas := agents["sw-access-1"], agents["sw-access-2"], agents["nas-1"]
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	was := true
	for {
		now := clock()
		h := float64(now.Hour()) + float64(now.Minute())/60
		day := math.Max(0, math.Sin((h-7)/12*math.Pi)) // 07:00–19:00
		jitter := 1 + 0.03*math.Sin(float64(now.Unix())/97)
		if sw2 != nil {
			sw2.SetRate("Gi1/0/44", now, (300_000+2_500_000*day)*jitter, (900_000+6_000_000*day)*jitter)
			sw2.SetRate("Gi1/0/46", now, (200_000+1_600_000*day)*jitter, (600_000+4_200_000*day)*jitter)
		}
		if nvr != nil {
			present := nvr.ISCSIPresent()
			write := 6_200_000 * jitter
			if !present {
				write = 15_000
			}
			if sw2 != nil {
				sw2.SetRate("Gi1/0/40", now, write, 180_000)
			}
			if sw1 != nil {
				sw1.SetRate("Gi1/0/20", now, 120_000, write)
			}
			if nas != nil && present != was {
				nas.SetTarget(1, present)
			}
			was = present
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
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

// nvrEvents makes the demo's recorder do something at irregular times: every few hours a
// camera drops for 5 to 20 minutes, and once a day the iSCSI disk is lost for 3 to 8 minutes.
func nvrEvents(ctx context.Context, log *slog.Logger, nvr *netsim.Dahua) {
	pause := func(d time.Duration) bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	go func() {
		for pause(time.Duration(120+rand.IntN(240)) * time.Minute) {
			ch := rand.IntN(16)
			log.Info("camera offline", "device", "nvr-1", "channel", ch)
			nvr.SetCamera(ch, false)
			if !pause(time.Duration(5+rand.IntN(16)) * time.Minute) {
				return
			}
			nvr.SetCamera(ch, true)
		}
	}()
	for pause(time.Duration(20*60+rand.IntN(8*60)) * time.Minute) {
		log.Info("iscsi lost", "device", "nvr-1")
		nvr.SetISCSI(false)
		if !pause(time.Duration(3+rand.IntN(6)) * time.Minute) {
			return
		}
		nvr.SetISCSI(true)
	}
}

// serveAdmin lets a test flap a port, load a link, drop a camera or lose the recorder's
// iSCSI disk now, instead of waiting hours.
func serveAdmin(ctx context.Context, log *slog.Logger, addr string, agents map[string]*netsim.Agent, router *netsim.RouterOS, nvr *netsim.Dahua) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /camera", func(w http.ResponseWriter, r *http.Request) {
		ch, err := strconv.Atoi(r.URL.Query().Get("channel"))
		if nvr == nil || err != nil {
			http.Error(w, "no recorder or no channel", http.StatusNotFound)
			return
		}
		nvr.SetCamera(ch, r.URL.Query().Get("online") == "true")
	})
	mux.HandleFunc("POST /iscsi", func(w http.ResponseWriter, r *http.Request) {
		if nvr == nil {
			http.Error(w, "no recorder", http.StatusNotFound)
			return
		}
		nvr.SetISCSI(r.URL.Query().Get("present") == "true")
	})
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
