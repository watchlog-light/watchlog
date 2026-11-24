// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ROSDialFunc opens a RouterOS connection; tests pass their own.
type ROSDialFunc func(ctx context.Context, address string, c *ROSCred) (ROS, error)

// rosState is one RouterOS device's memory between rounds.
type rosState struct {
	counters *Counters
	uptime   float64
	busy     map[string]bool
	ethIDs   []string
}

func newROSState() *rosState { return &rosState{counters: NewCounters(), busy: map[string]bool{}} }

// pollROS is one round for a MikroTik read over REST or the API.
func pollROS(ctx context.Context, dial ROSDialFunc, p *Profile, dev Device, st *rosState, now time.Time, inventory bool) (DeviceReport, []Sample) {
	rep := DeviceReport{ID: dev.ID, PolledAt: now.UnixMilli(), Profile: p.Name}
	paths := p.RouterOS
	if paths == nil {
		rep.State, rep.Error = StateError, "the profile has no RouterOS paths"
		return rep, nil
	}
	c, err := dial(ctx, dev.Address, dev.RouterOS)
	if err != nil {
		rep.State, rep.Error = rosStateOf(err), err.Error()
		var cc *CertChangedError
		if errors.As(err, &cc) {
			rep.Fingerprint = cc.Seen
		}
		return rep, nil
	}
	defer func() { _ = c.Close() }()
	rep.Fingerprint = c.Fingerprint()

	one := func(path string) map[string]string {
		rows, err := c.Print(ctx, path)
		if err != nil || len(rows) == 0 {
			return map[string]string{}
		}
		return rows[0]
	}
	res, err := c.Print(ctx, paths.Resource)
	if err != nil || len(res) == 0 {
		if err == nil {
			err = errors.New("no system resource")
		}
		rep.State, rep.Error = rosStateOf(err), err.Error()
		return rep, nil
	}
	r := res[0]
	id := one(paths.Identity)
	sys := &System{
		Name: id["name"], Vendor: p.Vendor, Kind: p.Kind, Descr: "RouterOS " + r["version"],
		Model: r["board-name"], UptimeS: int64(rosDuration(r["uptime"]).Seconds()),
	}
	sys.Firmware, _, _ = strings.Cut(r["version"], " ")
	if inventory || st.uptime == 0 {
		rb := one(paths.Routerboard)
		if rb["model"] != "" {
			sys.Model = rb["model"]
		}
		sys.Serial = rb["serial-number"]
		up := one(paths.Update)
		if up["channel"] != "" || up["installed-version"] != "" {
			sys.Update = &Update{Channel: up["channel"], Installed: up["installed-version"], Latest: up["latest-version"]}
		}
	}
	reset := st.uptime > 0 && float64(sys.UptimeS) < st.uptime
	st.uptime = float64(sys.UptimeS)

	h := &Health{}
	if f, ok := atof(r["cpu-load"]); ok {
		f /= 100
		h.CPU = &f
	}
	total, ok1 := atof(r["total-memory"])
	free, ok2 := atof(r["free-memory"])
	if ok1 && ok2 && total > 0 {
		used := total - free
		h.MemUsed, h.MemTotal = &used, &total
	}
	if rows, err := c.Print(ctx, paths.Health); err == nil {
		rosHealth(rows, h)
	}

	ifs, err := c.Print(ctx, paths.Interfaces)
	if err != nil {
		rep.State, rep.Error = rosStateOf(err), err.Error()
		return rep, nil
	}
	var eth []map[string]string
	if len(st.ethIDs) > 0 || inventory {
		ids := st.ethIDs
		if inventory || len(ids) == 0 {
			ids = nil
			for _, i := range ifs {
				if i["type"] == "ether" {
					ids = append(ids, i[".id"])
				}
			}
			st.ethIDs = ids
		}
		if len(ids) > 0 {
			eth, _ = c.Monitor(ctx, ids)
		}
	}
	mon := map[string]map[string]string{}
	for _, m := range eth {
		mon[m["name"]] = m
	}
	ports, samples, interfaces := rosPorts(dev, ifs, mon, st, reset)
	h.Ports = ports
	for _, i := range ifs {
		m := mon[i["name"]]
		if m == nil {
			continue
		}
		rx, okR := atof(m["sfp-rx-power"])
		tx, okT := atof(m["sfp-tx-power"])
		if !okR && !okT {
			continue
		}
		o := Optic{Port: i["name"]}
		if okR {
			o.RxDBm = &rx
		}
		if okT {
			o.TxDBm = &tx
		}
		if t, ok := atof(m["sfp-temperature"]); ok {
			o.Celsius = &t
		}
		h.Optics = append(h.Optics, o)
	}
	for _, s := range h.Sensors {
		if h.Temperature == nil || s.Celsius > *h.Temperature {
			c := s.Celsius
			h.Temperature = &c
		}
	}

	if inventory || len(st.busy) == 0 {
		inv := &Inventory{Interfaces: interfaces, Neighbours: []Neighbour{}, MACs: []MACEntry{}, ARP: []ARPEntry{}}
		if rows, err := c.Print(ctx, paths.Neighbours); err == nil {
			for _, n := range rows {
				local, _, _ := strings.Cut(n["interface"], ",")
				proto, _, _ := strings.Cut(n["discovered-by"], ",")
				if proto == "" {
					proto = "mndp"
				}
				inv.Neighbours = append(inv.Neighbours, Neighbour{
					LocalPort: local, Protocol: proto, RemoteName: n["identity"], RemotePort: n["interface-name"],
					RemoteAddr: n["address"], RemoteMAC: strings.ToLower(n["mac-address"]), Platform: strings.TrimSpace(n["platform"] + " " + n["board"]),
				})
			}
		}
		if rows, err := c.Print(ctx, paths.BridgeHosts); err == nil {
			for _, b := range rows {
				if b["local"] == "true" || b["mac-address"] == "" {
					continue
				}
				vlan, _ := strconv.Atoi(b["vid"])
				inv.MACs = append(inv.MACs, MACEntry{Port: b["on-interface"], MAC: strings.ToLower(b["mac-address"]), VLAN: vlan})
			}
		}
		if rows, err := c.Print(ctx, paths.ARP); err == nil {
			for _, a := range rows {
				if a["mac-address"] != "" && a["address"] != "" {
					inv.ARP = append(inv.ARP, ARPEntry{MAC: strings.ToLower(a["mac-address"]), IP: a["address"]})
				}
			}
		}
		if rows, err := c.Print(ctx, paths.Routes+"?.proplist=dst-address,gateway,active"); err == nil {
			n := 0
			for _, rt := range rows {
				if rt["active"] == "false" {
					continue
				}
				n++
				if rt["dst-address"] == "0.0.0.0/0" && inv.Gateway == "" {
					inv.Gateway = rt["gateway"]
				}
			}
			inv.Routes = &n
		}
		busy := map[string]bool{}
		for _, n := range inv.Neighbours {
			busy[n.LocalPort] = true
		}
		for _, m := range inv.MACs {
			busy[m.Port] = true
		}
		st.busy = busy
		rep.Inventory = inv
	}
	// CAPsMAN (0.17): the APs and their clients, every round.
	rep.Wireless = readWireless(ctx, c)
	samples = append(samples, wirelessSamples(dev.ID, rep.Wireless)...)
	rep.System, rep.Health, rep.State = sys, h, StateOK
	samples = append(samples, deviceSamples(dev.ID, sys, h)...)
	return rep, samples
}

func rosStateOf(err error) string {
	switch {
	case errors.Is(err, ErrCertChanged):
		return StateCertChanged
	case errors.Is(err, errROSAuth):
		return StateAuthFailed
	case errors.Is(err, ErrPlainRefused):
		return StateError
	}
	return StateUnreachable
}

// rosHealth reads /system/health (RouterOS 7: one row per sensor with name, value and type).
func rosHealth(rows []map[string]string, h *Health) {
	for _, r := range rows {
		name, val := r["name"], r["value"]
		switch {
		case strings.Contains(name, "temperature"):
			if f, ok := atof(val); ok {
				h.Sensors = append(h.Sensors, Sensor{Name: name, Celsius: f, State: "ok"})
			}
		case strings.HasPrefix(name, "psu") && strings.HasSuffix(name, "state"):
			h.PSUs = append(h.PSUs, Component{Name: strings.TrimSuffix(name, "-state"), State: okOrFailed(val)})
		case strings.HasPrefix(name, "fan") && strings.HasSuffix(name, "state"):
			h.Fans = append(h.Fans, Component{Name: strings.TrimSuffix(name, "-state"), State: okOrFailed(val)})
		case strings.HasPrefix(name, "fan") && strings.HasSuffix(name, "speed"):
			st := "ok"
			if f, ok := atof(val); ok && f == 0 {
				st = "failed"
			}
			h.Fans = append(h.Fans, Component{Name: strings.TrimSuffix(name, "-speed"), State: st})
		}
	}
	sort.Slice(h.Fans, func(i, j int) bool { return h.Fans[i].Name < h.Fans[j].Name })
}

func okOrFailed(v string) string {
	switch strings.ToLower(v) {
	case "ok", "true":
		return "ok"
	case "":
		return "unknown"
	}
	return "failed"
}

// rosPorts turns /interface rows into ports, inventory interfaces and series.
func rosPorts(dev Device, ifs []map[string]string, mon map[string]map[string]string, st *rosState, reset bool) ([]PortState, []Sample, []Interface) {
	linked := map[string]bool{}
	for _, n := range dev.Linked {
		linked[n] = true
	}
	var ports []PortState
	var samples []Sample
	var inv []Interface
	seen := map[string]bool{}
	for k, i := range ifs {
		name := i["name"]
		kind := rosKind(i["type"], name)
		speed := rosRate(mon[name]["rate"])
		up := i["running"] == "true"
		admin := i["disabled"] != "true"
		inv = append(inv, Interface{Index: k + 1, Name: name, Alias: i["comment"], Kind: kind, MAC: strings.ToLower(i["mac-address"]), SpeedMbps: speed, AdminUp: admin, OperUp: up})
		if !portKind(kind) {
			continue
		}
		total := func(field string) (float64, bool) {
			f, ok := atof(i[field])
			if !ok {
				return 0, false
			}
			key := name + "/" + field
			seen[key] = true
			return st.counters.Add(key, f, 64, reset), true
		}
		inB, okIn := total("rx-byte")
		outB, okOut := total("tx-byte")
		inE, okIE := total("rx-error")
		outE, okOE := total("tx-error")
		inD, okID := total("rx-drop")
		outD, okOD := total("tx-drop")
		ports = append(ports, PortState{Index: k + 1, Name: name, AdminUp: admin, OperUp: up, SpeedMbps: speed, Errors: inE + outE})
		if !up && i["comment"] == "" && !st.busy[name] && !linked[name] {
			continue
		}
		lbl := []Label{{Name: "device", Value: dev.ID}, {Name: "ifname", Value: name}}
		add := func(ok bool, n string, v float64) {
			if ok {
				samples = append(samples, Sample{Name: n, Labels: lbl, Value: v})
			}
		}
		add(okIn, "watchlog_net_if_in_bytes_total", inB)
		add(okOut, "watchlog_net_if_out_bytes_total", outB)
		add(okIE, "watchlog_net_if_in_errors_total", inE)
		add(okOE, "watchlog_net_if_out_errors_total", outE)
		add(okID, "watchlog_net_if_in_discards_total", inD)
		add(okOD, "watchlog_net_if_out_discards_total", outD)
	}
	st.counters.Forget(func(k string) bool { return seen[k] })
	return ports, samples, inv
}

func rosKind(t, name string) string {
	switch t {
	case "ether":
		if strings.HasPrefix(name, "sfp") || strings.HasPrefix(name, "qsfp") {
			return "sfp"
		}
		return "ethernet"
	case "bond":
		return "lag"
	case "vlan", "bridge":
		return "vlan"
	case "wlan", "wifi", "cap":
		return "wireless"
	}
	return "virtual"
}

var rateRe = regexp.MustCompile(`^([0-9.]+)\s*([GM])bps`)

// rosRate reads "1Gbps", "10Gbps", "100Mbps" as Mbit/s.
func rosRate(s string) int64 {
	m := rateRe.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	if m[2] == "G" {
		f *= 1000
	}
	return int64(f)
}

var durRe = regexp.MustCompile(`(\d+)([wdhms])`)

// rosDuration reads RouterOS's "4w2d10:11:12", "1d02:03:04" or "5h3m2s".
func rosDuration(s string) time.Duration {
	var d time.Duration
	var rest string
	if i := strings.LastIndexAny(s, "wd"); i >= 0 && strings.Contains(s[i+1:], ":") {
		rest = s[i+1:]
		s = s[:i+1]
	} else if strings.Contains(s, ":") {
		rest, s = s, ""
	} else {
		rest = ""
	}
	for _, m := range durRe.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.Atoi(m[1])
		switch m[2] {
		case "w":
			d += time.Duration(n) * 7 * 24 * time.Hour
		case "d":
			d += time.Duration(n) * 24 * time.Hour
		case "h":
			d += time.Duration(n) * time.Hour
		case "m":
			d += time.Duration(n) * time.Minute
		case "s":
			d += time.Duration(n) * time.Second
		}
	}
	if rest != "" {
		parts := strings.Split(rest, ":")
		if len(parts) == 3 {
			h, _ := strconv.Atoi(parts[0])
			m, _ := strconv.Atoi(parts[1])
			sec, _ := strconv.Atoi(parts[2])
			d += time.Duration(h)*time.Hour + time.Duration(m)*time.Minute + time.Duration(sec)*time.Second
		}
	}
	return d
}

func atof(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f, err == nil
}
