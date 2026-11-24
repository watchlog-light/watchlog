// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// CAPsMAN (0.17, ADR-234): the access points a RouterOS router manages and their clients,
// read every round over the router's own read-only connection. Two generations, which manage
// different radios and can run side by side: the `wifi` package's /interface/wifi/capsman
// and the legacy /caps-man. Each is read when its remote-cap menu lists a CAP.
var capsmanPaths = []string{
	"interface/wifi/capsman/remote-cap",
	"interface/wifi/registration-table",
	"interface/wifi",
	"interface/wifi/radio",
	"caps-man/remote-cap",
	"caps-man/registration-table",
	"caps-man/interface",
	"caps-man/radio",
}

func init() {
	for _, p := range capsmanPaths {
		rosPaths[p] = true
	}
}

// readWireless reads both generations; nil when the router manages no CAP.
func readWireless(ctx context.Context, c ROS) *Wireless {
	w := &Wireless{APs: []AP{}, Clients: []WifiClient{}}
	if caps, err := c.Print(ctx, "interface/wifi/capsman/remote-cap"); err == nil && len(caps) > 0 {
		w.Generations = append(w.Generations, "wifi")
		ifs, _ := c.Print(ctx, "interface/wifi")
		radios, _ := c.Print(ctx, "interface/wifi/radio")
		reg, _ := c.Print(ctx, "interface/wifi/registration-table")
		addGeneration(w, "wifi", caps, ifs, radios, reg)
	}
	if caps, err := c.Print(ctx, "caps-man/remote-cap"); err == nil && len(caps) > 0 {
		w.Generations = append(w.Generations, "legacy")
		ifs, _ := c.Print(ctx, "caps-man/interface")
		radios, _ := c.Print(ctx, "caps-man/radio")
		reg, _ := c.Print(ctx, "caps-man/registration-table")
		addGeneration(w, "legacy", caps, ifs, radios, reg)
	}
	if len(w.Generations) == 0 {
		return nil
	}
	w.Mesh = meshLinks(w)
	sort.Slice(w.APs, func(i, j int) bool { return w.APs[i].Name < w.APs[j].Name })
	sort.Slice(w.Clients, func(i, j int) bool { return w.Clients[i].MAC < w.Clients[j].MAC })
	return w
}

// capName is a CAP's name from "hapAX3@192.168.88.30" or an identity.
func capName(s string) string {
	s, _, _ = strings.Cut(s, "@")
	return strings.TrimSpace(s)
}

func addGeneration(w *Wireless, gen string, caps, ifs, radios, reg []map[string]string) {
	byName := map[string]int{}
	for _, r := range caps {
		name := firstOf(r, "identity", "name", "common-name")
		if name == "" {
			continue
		}
		ap := AP{
			Name: name, Generation: gen, Radios: []Radio{},
			MAC:     strings.ToLower(firstOf(r, "base-mac", "radio-mac", "mac-address")),
			Address: hostOnly(r["address"]),
			Model:   firstOf(r, "board-name", "board"),
			Serial:  r["serial"],
			Version: r["version"],
			State:   capState(r["state"]),
			UptimeS: int64(rosDuration(firstOf(r, "uptime", "connected-time")).Seconds()),
		}
		w.APs = append(w.APs, ap)
		byName[name] = len(w.APs) - 1
	}
	// Which CAP an interface is on: the radio menu ("hapAX3@192.168.88.30", an identity).
	capOfIf := map[string]string{}
	for _, r := range radios {
		iface := r["interface"]
		cp := capName(firstOf(r, "cap", "remote-cap-identity", "remote-ap-ident", "remote-cap-name"))
		if iface != "" && cp != "" {
			capOfIf[iface] = cp
		}
	}
	clientsOn := map[string]int{}
	ifAP := map[string]string{}
	for _, r := range ifs {
		name := r["name"]
		apName := capOfIf[name]
		if apName == "" {
			// A slave interface is on its master's CAP.
			apName = capOfIf[r["master-interface"]]
		}
		ifAP[name] = apName
	}
	for _, r := range reg {
		ap := ifAP[r["interface"]]
		cl := WifiClient{
			MAC: strings.ToLower(r["mac-address"]), AP: ap, Interface: r["interface"], SSID: r["ssid"], Band: r["band"],
			TxRate: r["tx-rate"], RxRate: r["rx-rate"], UptimeS: int64(rosDuration(r["uptime"]).Seconds()),
		}
		if f, ok := atof(firstOf(r, "signal", "rx-signal", "signal-strength")); ok {
			cl.SignalDBm = &f
		}
		cl.BytesTx, cl.BytesRx = pair(r["bytes"])
		if cl.MAC == "" {
			continue
		}
		w.Clients = append(w.Clients, cl)
		clientsOn[cl.Interface]++
	}
	for _, r := range ifs {
		name := r["name"]
		k, ok := byName[ifAP[name]]
		if !ok {
			continue
		}
		ap := &w.APs[k]
		rd := Radio{
			Interface: name, SSID: firstOf(r, "configuration.ssid", "ssid"), Band: firstOf(r, "channel.band", "band"),
			Running: r["running"] == "true", Clients: clientsOn[name],
		}
		if n, err := strconv.Atoi(firstOf(r, "current-registered-clients", "registered-clients")); err == nil && n > rd.Clients {
			rd.Clients = n
		}
		freq, tx := channelOf(firstOf(r, "current-channel", "channel", "channel.frequency"))
		if freq > 0 {
			rd.FrequencyM, rd.Channel = freq, channelNumber(freq)
		}
		if f, ok := atof(firstOf(r, "tx-power", "current-tx-power")); ok {
			rd.TxPowerDBm = &f
		} else if tx != nil {
			rd.TxPowerDBm = tx
		}
		if f, ok := atof(r["noise-floor"]); ok {
			rd.NoiseDBm = &f
		}
		if rd.Band == "" && freq > 0 {
			rd.Band = bandOf(freq)
		}
		ap.Radios = append(ap.Radios, rd)
	}
}

// capState turns CAPsMAN's word into running, provisioning-failed or disconnected.
func capState(s string) string {
	l := strings.ToLower(s)
	switch {
	case l == "" || l == "ok" || l == "run" || l == "running":
		return "running"
	case strings.Contains(l, "fail"):
		return "provisioning-failed"
	case strings.Contains(l, "disconnect"):
		return "disconnected"
	}
	return l
}

var chanRe = regexp.MustCompile(`^(\d{4})(?:[^(]*\((\d+)dBm\))?`)

// channelOf reads "2412/20-Ce/gn(20dBm)", "5180/ax/Ceee" or a bare frequency.
func channelOf(s string) (int, *float64) {
	m := chanRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, nil
	}
	f, _ := strconv.Atoi(m[1])
	if m[2] != "" {
		p, _ := strconv.ParseFloat(m[2], 64)
		return f, &p
	}
	return f, nil
}

// channelNumber is the IEEE channel of a frequency in MHz.
func channelNumber(f int) int {
	switch {
	case f == 2484:
		return 14
	case f >= 2412 && f <= 2472:
		return (f - 2407) / 5
	case f >= 5000 && f < 5950:
		return (f - 5000) / 5
	case f >= 5955:
		return (f - 5950) / 5
	}
	return 0
}

func bandOf(f int) string {
	switch {
	case f < 3000:
		return "2ghz"
	case f < 5950:
		return "5ghz"
	}
	return "6ghz"
}

// pair reads RouterOS's "1234,5678" (the order as RouterOS prints it; see ADR-234).
func pair(s string) (float64, float64) {
	a, b, _ := strings.Cut(s, ",")
	x, _ := atof(a)
	y, _ := atof(b)
	return x, y
}

func hostOnly(s string) string {
	s, _, _ = strings.Cut(s, "/")
	if h, _, ok := strings.Cut(s, ":"); ok && strings.Count(s, ":") == 1 {
		return h
	}
	return s
}

func firstOf(r map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(r[k]); v != "" {
			return v
		}
	}
	return ""
}

// meshLinks: a registration whose station is another AP (its base or radio MAC) is a
// wireless backhaul (wifi mesh, WDS, a station-bridge), drawn between the two APs.
func meshLinks(w *Wireless) []MeshLink {
	apOfMAC := map[string]string{}
	for _, ap := range w.APs {
		if ap.MAC != "" {
			apOfMAC[ap.MAC] = ap.Name
		}
	}
	var out []MeshLink
	seen := map[string]bool{}
	for _, c := range w.Clients {
		to := apOfMAC[c.MAC]
		if to == "" || c.AP == "" || to == c.AP {
			continue
		}
		key := c.AP + ">" + to
		if seen[key] {
			continue
		}
		seen[key] = true
		rate := c.TxRate
		if rate == "" {
			rate = c.RxRate
		}
		out = append(out, MeshLink{From: c.AP, To: to, SignalDBm: c.SignalDBm, Rate: rate})
	}
	return out
}

// wirelessSamples are the counts per AP and SSID (never a client: they are rows).
func wirelessSamples(id string, w *Wireless) []Sample {
	if w == nil {
		return nil
	}
	var out []Sample
	count := map[[2]string]int{}
	for _, c := range w.Clients {
		count[[2]string{c.AP, c.SSID}]++
	}
	for _, ap := range w.APs {
		up := 0.0
		if ap.State == "running" {
			up = 1
		}
		out = append(out, Sample{Name: "watchlog_net_ap_up", Labels: []Label{{Name: "device", Value: id}, {Name: "ap", Value: ap.Name}}, Value: up})
		ssids := map[string]bool{}
		for _, r := range ap.Radios {
			if r.SSID != "" {
				ssids[r.SSID] = true
			}
		}
		for k := range count {
			if k[0] == ap.Name {
				ssids[k[1]] = true
			}
		}
		for ssid := range ssids {
			out = append(out, Sample{
				Name:   "watchlog_net_wifi_clients",
				Labels: []Label{{Name: "device", Value: id}, {Name: "ap", Value: ap.Name}, {Name: "ssid", Value: ssid}},
				Value:  float64(count[[2]string{ap.Name, ssid}]),
			})
		}
	}
	return out
}
