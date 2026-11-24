// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"fmt"
	"hash/fnv"
	"strconv"
	"time"
)

// The simulated router's CAPsMAN (0.17): three APs on the `wifi` package's CAPsMAN, one of
// them (ap-warehouse) reached over a wireless backhaul from ap-office, and a few dozen
// clients that come and go with the clock. Field names follow MikroTik's manual for
// /interface/wifi/capsman/remote-cap, /interface/wifi/radio and the registration table;
// what the manual doesn't state (a remote-cap state word, the order of `bytes`) is guessed
// (ADR-234). Legacy (/caps-man) is the same network in the old menus, for tests.
type capsman struct {
	legacy bool
	down   map[string]bool
}

type simAP struct{ name, mac, addr, model string }

var simAPs = []simAP{
	{"ap-lobby", "48:a9:8a:10:00:01", "10.0.150.11", "cAP ax"},
	{"ap-office", "48:a9:8a:10:00:02", "10.0.150.12", "cAP ax"},
	{"ap-warehouse", "48:a9:8a:10:00:03", "10.0.150.13", "wAP ax"},
}

// EnableCAPsMAN turns on the router's CAPsMAN; legacy serves the /caps-man menus instead.
func (r *RouterOS) EnableCAPsMAN(legacy bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.caps = &capsman{legacy: legacy, down: map[string]bool{}}
}

// SetAP connects or disconnects an AP from CAPsMAN.
func (r *RouterOS) SetAP(name string, up bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.caps != nil {
		r.caps.down[name] = !up
	}
}

func h32(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

// wifiMenu answers the CAPsMAN menus; ok false for any other path. Called with r.mu held.
func (r *RouterOS) wifiMenu(path string, now time.Time) ([]map[string]string, bool) {
	c := r.caps
	if c == nil {
		return nil, false
	}
	up := r.now().Sub(r.Start)
	var aps []simAP
	for _, a := range simAPs {
		if !c.down[a.name] {
			aps = append(aps, a)
		}
	}
	ifName := func(ap string, band int) string { return fmt.Sprintf("%s-%dg", ap, band) }
	// Clients: 36 phones and laptops; each is on for a stretch of the day, by its own hash.
	type cl struct {
		mac, ap, iface, ssid, band string
		signal, uptime             int
	}
	var clients []cl
	minute := now.Unix() / 60
	for i := 0; i < 36; i++ {
		seed := h32(strconv.Itoa(i))
		// On for ~70% of each 2-hour window, shifted per client.
		if (uint32(minute/7)+seed)%10 >= 7 {
			continue
		}
		ap := aps
		if len(ap) == 0 {
			break
		}
		a := ap[int(seed)%len(ap)]
		band := 5
		if seed%3 == 0 {
			band = 2
		}
		ssid := "office"
		if seed%4 == 0 {
			ssid = "guest"
		}
		clients = append(clients, cl{
			mac: fmt.Sprintf("3c:22:fb:%02x:%02x:%02x", byte(i), byte(seed>>8), byte(seed)),
			ap:  a.name, iface: ifName(a.name, band), ssid: ssid,
			band:   map[int]string{2: "2ghz-ax", 5: "5ghz-ax"}[band],
			signal: -45 - int(seed%40), uptime: int(minute%97)*60 + int(seed%600),
		})
	}
	// The backhaul: ap-warehouse is a station of ap-office's 5 GHz radio.
	mesh := !c.down["ap-warehouse"] && !c.down["ap-office"]
	switch {
	case !c.legacy && path == "interface/wifi/capsman/remote-cap":
		var out []map[string]string
		for i, a := range aps {
			out = append(out, map[string]string{
				".id": "*" + strconv.Itoa(i+1), "identity": a.name, "address": a.addr + ":5246", "board-name": a.model,
				"serial": fmt.Sprintf("HFA0%04d", h32(a.name)%10000), "version": "7.16.2", "base-mac": a.mac,
				"state": "Ok", "uptime": fmtUptime(up), "connected-time": fmtUptime(up / 2),
			})
		}
		return out, true
	case !c.legacy && path == "interface/wifi/radio":
		var out []map[string]string
		for _, a := range aps {
			for _, b := range []int{2, 5} {
				out = append(out, map[string]string{"cap": a.name + "@" + a.addr, "interface": ifName(a.name, b), "radio-mac": a.mac})
			}
		}
		return out, true
	case !c.legacy && path == "interface/wifi":
		var out []map[string]string
		for _, a := range aps {
			for _, b := range []int{2, 5} {
				freq := map[int]string{2: "2412", 5: "5180"}[b]
				if a.name == "ap-office" && b == 2 {
					freq = "2437"
				}
				if a.name == "ap-warehouse" && b == 2 {
					freq = "2422" // overlaps ap-lobby's channel 1 (2.4 GHz)
				}
				out = append(out, map[string]string{
					"name": ifName(a.name, b), "configuration.ssid": "office", "channel": freq + "/ax",
					"channel.band": map[int]string{2: "2ghz-ax", 5: "5ghz-ax"}[b], "running": "true", "tx-power": "17",
				})
			}
		}
		return out, true
	case !c.legacy && path == "interface/wifi/registration-table":
		var out []map[string]string
		for _, x := range clients {
			out = append(out, map[string]string{
				"mac-address": x.mac, "interface": x.iface, "ssid": x.ssid, "band": x.band, "signal": strconv.Itoa(x.signal),
				"tx-rate": "433.3Mbps", "rx-rate": "390Mbps", "uptime": fmtUptime(time.Duration(x.uptime) * time.Second),
				"bytes": fmt.Sprintf("%d,%d", x.uptime*41000, x.uptime*9000), "authorized": "true",
			})
		}
		if mesh {
			out = append(out, map[string]string{
				"mac-address": simAPs[2].mac, "interface": ifName("ap-office", 5), "ssid": "backhaul", "band": "5ghz-ax",
				"signal": "-58", "tx-rate": "866.7Mbps", "rx-rate": "780Mbps", "uptime": fmtUptime(up / 2),
			})
		}
		return out, true
	case c.legacy && path == "caps-man/remote-cap":
		var out []map[string]string
		for i, a := range aps {
			out = append(out, map[string]string{".id": "*" + strconv.Itoa(i+1), "identity": a.name, "address": a.mac + "/" + a.addr, "board": a.model, "version": "6.49.15", "state": "Run", "radios": "1", "base-mac": a.mac})
		}
		return out, true
	case c.legacy && path == "caps-man/radio":
		var out []map[string]string
		for _, a := range aps {
			out = append(out, map[string]string{"radio-mac": a.mac, "interface": ifName(a.name, 2), "remote-cap-identity": a.name})
		}
		return out, true
	case c.legacy && path == "caps-man/interface":
		var out []map[string]string
		for _, a := range aps {
			n := 0
			for _, x := range clients {
				if x.ap == a.name {
					n++
				}
			}
			out = append(out, map[string]string{"name": ifName(a.name, 2), "radio-mac": a.mac, "configuration": "cfg-office", "current-channel": "2412/20-Ce/gn(20dBm)", "current-registered-clients": strconv.Itoa(n), "running": "true"})
		}
		return out, true
	case c.legacy && path == "caps-man/registration-table":
		var out []map[string]string
		for _, x := range clients {
			out = append(out, map[string]string{"interface": ifName(x.ap, 2), "mac-address": x.mac, "ssid": x.ssid, "uptime": fmtUptime(time.Duration(x.uptime) * time.Second), "rx-signal": strconv.Itoa(x.signal), "tx-rate": "72.2Mbps-20MHz/1S/SGI", "rx-rate": "65Mbps-20MHz/1S"})
		}
		return out, true
	}
	return nil, false
}

// DisableCAPsMAN turns the router's CAPsMAN off (a router that manages no AP).
func (r *RouterOS) DisableCAPsMAN() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.caps = nil
}
