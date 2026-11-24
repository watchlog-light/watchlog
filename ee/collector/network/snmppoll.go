// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"errors"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DialFunc opens an SNMP reader; tests and the simulator pass their own.
type DialFunc func(address string, c *SNMPCred, v3Context, community string) (Reader, error)

// MaxVLANs bounds the per-VLAN MAC table reads of one inventory round (Cisco IOS).
const MaxVLANs = 64

// ifMeta is what the inventory learnt about a port, kept between rounds.
type ifMeta struct {
	Name, Descr, Alias, Kind string
}

// snmpState is one SNMP device's memory between rounds.
type snmpState struct {
	prof     *Profile
	counters *Counters
	uptime   float64 // seconds, the last round's
	ifs      map[int]ifMeta
	// busy are the ports with a neighbour or learnt endpoints (from the last inventory): their
	// series are sent even when the port is down and unnamed.
	busy map[string]bool
}

func newSNMPState() *snmpState {
	return &snmpState{counters: NewCounters(), ifs: map[int]ifMeta{}, busy: map[string]bool{}}
}

// pollSNMP is one round for one SNMP device: health and port counters always, the inventory
// when asked. It returns the report and the series.
func pollSNMP(ctx context.Context, dial DialFunc, profiles Profiles, dev Device, st *snmpState, now time.Time, inventory bool) (DeviceReport, []Sample) {
	rep := DeviceReport{ID: dev.ID, PolledAt: now.UnixMilli()}
	r, err := dial(dev.Address, dev.SNMP, "", "")
	if err != nil {
		rep.State, rep.Error = StateError, err.Error()
		return rep, nil
	}
	defer func() { _ = r.Close() }()

	sys, err := readSystem(ctx, r)
	if err != nil {
		rep.State, rep.Error = stateOf(err), err.Error()
		return rep, nil
	}
	if st.prof == nil || (dev.Profile != "" && st.prof.Name != dev.Profile) {
		st.prof = profiles[dev.Profile]
		if st.prof == nil {
			st.prof = profiles.For(sys.ObjectID, sys.Descr)
			if st.prof.Name == "generic" {
				st.prof = probe(ctx, r, profiles, st.prof)
			}
		}
	}
	p := st.prof
	rep.Profile = p.Name
	sys.Vendor, sys.Kind = p.Vendor, p.Kind
	// A reboot: sysUpTime went back. Every counter starts over.
	reset := st.uptime > 0 && float64(sys.UptimeS) < st.uptime
	st.uptime = float64(sys.UptimeS)

	if inventory || len(st.ifs) == 0 {
		inv := readInventory(ctx, r, dial, dev, p, st)
		rep.Inventory = inv
		readEntity(ctx, r, p, sys)
	}
	health := readHealth(ctx, r, p)
	ports, samples := readPorts(ctx, r, p, dev, st, reset)
	health.Ports = ports
	if p.Stack != nil && p.Stack.Number != "" {
		health.Stack = readStack(ctx, r, p)
	}
	// A NAS's storage and a UPS's power (0.17).
	if p.NAS != nil {
		rep.NAS = readNAS(ctx, r, p.NAS, sys, health)
		samples = append(samples, nasSamples(dev.ID, rep.NAS)...)
	}
	if p.UPS != nil {
		rep.UPS = readUPS(ctx, r, p.UPS, sys)
		samples = append(samples, upsSamples(dev.ID, rep.UPS)...)
	}
	rep.System, rep.Health, rep.State = sys, health, StateOK
	samples = append(samples, deviceSamples(dev.ID, sys, health)...)
	return rep, samples
}

// probe tries the profiles that have a probe OID: the first whose OID answers.
func probe(ctx context.Context, r Reader, ps Profiles, fallback *Profile) *Profile {
	for _, p := range ps.Probed() {
		vs, err := r.Get(ctx, []string{p.Match.Probe})
		if err == nil && len(vs) > 0 {
			return p
		}
	}
	return fallback
}

func stateOf(err error) string {
	switch {
	case errors.Is(err, errSNMPAuth):
		return StateAuthFailed
	case errors.Is(err, errNoAnswer):
		return StateUnreachable
	}
	return StateError
}

func readSystem(ctx context.Context, r Reader) (*System, error) {
	const descr, oid, up, name, loc = "1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0", "1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.6.0"
	vs, err := r.Get(ctx, []string{descr, oid, up, name, loc})
	if err != nil {
		return nil, err
	}
	s := &System{}
	got := 0
	for _, v := range vs {
		switch v.OID {
		case descr:
			s.Descr = str(v)
		case oid:
			s.ObjectID = strings.TrimPrefix(str(v), ".")
		case up:
			if f, ok := num(v); ok {
				s.UptimeS = int64(f / 100)
			}
		case name:
			s.Name = str(v)
		case loc:
			s.Location = str(v)
		default:
			continue
		}
		got++
	}
	if got == 0 {
		return nil, errNoAnswer
	}
	return s, nil
}

// readEntity fills model, serial and firmware from the first chassis in ENTITY-MIB.
func readEntity(ctx context.Context, r Reader, p *Profile, s *System) {
	e := p.Entity
	if e == nil || e.Class == "" {
		return
	}
	class, err := walkCol(ctx, r, e.Class)
	if err != nil {
		return
	}
	idxs := sortedIdx(class)
	for _, idx := range idxs {
		if c, _ := class.num(idx); c != 3 { // chassis
			continue
		}
		vs, err := r.Get(ctx, []string{e.Model + "." + idx, e.Serial + "." + idx, e.Software + "." + idx, e.Firmware + "." + idx, e.Descr + "." + idx})
		if err != nil {
			return
		}
		for _, v := range vs {
			t := str(v)
			switch {
			case strings.HasPrefix(v.OID, e.Model+"."):
				s.Model = t
			case strings.HasPrefix(v.OID, e.Serial+"."):
				s.Serial = t
			case strings.HasPrefix(v.OID, e.Software+"."):
				if t != "" {
					s.Firmware = t
				}
			case strings.HasPrefix(v.OID, e.Firmware+"."):
				if s.Firmware == "" {
					s.Firmware = t
				}
			case strings.HasPrefix(v.OID, e.Descr+"."):
				if s.Model == "" {
					s.Model = t
				}
			}
		}
		break
	}
	if s.Firmware == "" {
		s.Firmware = firmwareFromDescr(s.Descr)
	}
}

var versionRe = regexp.MustCompile(`(?i)version\s+([0-9][0-9A-Za-z.()_-]*)`)

// firmwareFromDescr finds "Version 15.2(7)E8" in a sysDescr.
func firmwareFromDescr(d string) string {
	if m := versionRe.FindStringSubmatch(d); m != nil {
		return strings.TrimRight(m[1], ",")
	}
	return ""
}

// readHealth reads CPU, memory, temperatures, fans and power supplies.
func readHealth(ctx context.Context, r Reader, p *Profile) *Health {
	h := &Health{}
	for _, c := range p.CPU {
		t, err := walkCol(ctx, r, c.OID)
		if err != nil || len(t) == 0 {
			continue
		}
		var sum, max float64
		for _, v := range t {
			f, _ := num(v)
			sum += f
			max = math.Max(max, f)
		}
		val := max
		if c.Aggregate == "avg" {
			val = sum / float64(len(t))
		}
		scale := c.Scale
		if scale == 0 {
			scale = 1
		}
		val *= scale
		h.CPU = &val
		break
	}
	for _, m := range p.Memory {
		if readMemory(ctx, r, m, h) {
			break
		}
	}
	for _, s := range p.Temperatures {
		readStates(ctx, r, s, func(name, state string, value, threshold *float64) {
			if value == nil {
				return
			}
			h.Sensors = append(h.Sensors, Sensor{Name: name, Celsius: *value, Threshold: threshold, State: state})
		})
	}
	for _, s := range p.Fans {
		readStates(ctx, r, s, func(name, state string, _, _ *float64) {
			h.Fans = append(h.Fans, Component{Name: name, State: state})
		})
	}
	for _, s := range p.PSUs {
		readStates(ctx, r, s, func(name, state string, _, _ *float64) {
			h.PSUs = append(h.PSUs, Component{Name: name, State: state})
		})
	}
	if p.Sensors != nil {
		readEntitySensors(ctx, r, p, h)
	}
	for _, s := range h.Sensors {
		if h.Temperature == nil || s.Celsius > *h.Temperature {
			c := s.Celsius
			h.Temperature = &c
		}
	}
	return h
}

func readMemory(ctx context.Context, r Reader, m MemorySource, h *Health) bool {
	if m.Percent != "" {
		vs, err := r.Get(ctx, []string{m.Percent})
		if err != nil || len(vs) == 0 {
			return false
		}
		f, ok := num(vs[0])
		if !ok {
			return false
		}
		// A percentage only: total 100, used the percentage, so used/total reads right.
		used, total := f, 100.0
		h.MemUsed, h.MemTotal = &used, &total
		return true
	}
	var names, types table
	var err error
	if m.Name != "" {
		if names, err = walkCol(ctx, r, m.Name); err != nil || len(names) == 0 {
			return false
		}
	}
	if m.Type != "" {
		if types, err = walkCol(ctx, r, m.Type); err != nil || len(types) == 0 {
			return false
		}
	}
	used, _ := walkCol(ctx, r, m.Used)
	free, _ := walkCol(ctx, r, m.Free)
	total, _ := walkCol(ctx, r, m.Total)
	units, _ := walkCol(ctx, r, m.Units)
	var match *regexp.Regexp
	if m.NameMatch != "" {
		match = regexp.MustCompile("(?i)" + m.NameMatch)
	}
	var u, t float64
	found := false
	for idx, v := range used {
		if names != nil && (match != nil && !match.MatchString(names.str(idx))) {
			continue
		}
		if types != nil && strings.TrimPrefix(str(types[idx]), ".") != m.TypeValue {
			continue
		}
		mul := 1.0
		if units != nil {
			if f, ok := units.num(idx); ok && f > 0 {
				mul = f
			}
		}
		uu, _ := num(v)
		u += uu * mul
		if tt, ok := total.num(idx); ok {
			t += tt * mul
		} else if ff, ok := free.num(idx); ok {
			t += (uu + ff) * mul
		}
		found = true
	}
	if !found || t == 0 {
		return false
	}
	h.MemUsed, h.MemTotal = &u, &t
	return true
}

// readStates reads a state table (CISCO-ENVMON-MIB, CISCO-ENTITY-FRU-CONTROL-MIB).
func readStates(ctx context.Context, r Reader, s StateTable, fn func(name, state string, value, threshold *float64)) {
	states, err := walkCol(ctx, r, s.State)
	if err != nil || len(states) == 0 {
		return
	}
	names, _ := walkCol(ctx, r, s.Name)
	values, _ := walkCol(ctx, r, s.Value)
	thresholds, _ := walkCol(ctx, r, s.Threshold)
	scale := s.Scale
	if scale == 0 {
		scale = 1
	}
	for _, idx := range sortedIdx(states) {
		code, _ := states.num(idx)
		state := s.States[int(code)]
		if state == "" {
			state = "unknown"
		}
		if state == "absent" && s.Value == "" {
			continue
		}
		name := names.str(idx)
		if name == "" {
			name = "#" + idx
		}
		var val, thr *float64
		if f, ok := values.num(idx); ok {
			f *= scale
			val = &f
		}
		if f, ok := thresholds.num(idx); ok && f > 0 {
			f *= scale
			thr = &f
		}
		fn(name, state, val, thr)
	}
}

// readEntitySensors reads CISCO-ENTITY-SENSOR-MIB: temperatures (when the environment MIB
// gave none) and SFP optics with their thresholds.
func readEntitySensors(ctx context.Context, r Reader, p *Profile, h *Health) {
	es := p.Sensors
	types, err := walkCol(ctx, r, es.Type)
	if err != nil || len(types) == 0 {
		return
	}
	scales, _ := walkCol(ctx, r, es.Scale)
	precs, _ := walkCol(ctx, r, es.Precision)
	values, _ := walkCol(ctx, r, es.Value)
	statuses, _ := walkCol(ctx, r, es.Status)
	var names table
	if p.Entity != nil {
		names, _ = walkCol(ctx, r, p.Entity.Name)
	}
	thr := table{}
	if es.Thresholds != "" {
		thr, _ = walkCol(ctx, r, es.Thresholds)
	}
	value := func(idx string, raw float64) float64 {
		sc, _ := scales.num(idx)
		pr, _ := precs.num(idx)
		exp := 0.0
		if sc != 0 {
			exp = (sc - 9) * 3
		}
		return round3(raw * math.Pow(10, exp-pr))
	}
	optics := map[string]*Optic{}
	var order []string
	hadTemps := len(h.Sensors) > 0
	for _, idx := range sortedIdx(types) {
		t, _ := types.num(idx)
		raw, ok := values.num(idx)
		if !ok {
			continue
		}
		if st, ok := statuses.num(idx); ok && st != 1 {
			continue // unavailable or nonoperational
		}
		v := value(idx, raw)
		name := names.str(idx)
		switch int(t) {
		case es.Celsius:
			if strings.Contains(strings.ToLower(name), "transceiver") || opticPort(name) != "" {
				port := opticPort(name)
				if port != "" {
					o := optic(optics, &order, port)
					o.Celsius = &v
				}
				continue
			}
			if !hadTemps {
				h.Sensors = append(h.Sensors, Sensor{Name: name, Celsius: v, State: "ok"})
			}
		case es.DBm:
			port := opticPort(name)
			if port == "" {
				continue
			}
			o := optic(optics, &order, port)
			low, high := sensorThresholds(thr, idx, func(f float64) float64 { return value(idx, f) })
			if strings.Contains(strings.ToLower(name), "transmit") || strings.Contains(strings.ToLower(name), " tx") {
				o.TxDBm, o.TxLow, o.TxHigh = &v, low, high
			} else {
				o.RxDBm, o.RxLow, o.RxHigh = &v, low, high
			}
		}
	}
	for _, port := range order {
		h.Optics = append(h.Optics, *optics[port])
	}
}

// round3 keeps three decimals (sensor values are scaled by powers of ten).
func round3(f float64) float64 { return math.Round(f*1000) / 1000 }

func optic(m map[string]*Optic, order *[]string, port string) *Optic {
	if o, ok := m[port]; ok {
		return o
	}
	o := &Optic{Port: port}
	m[port] = o
	*order = append(*order, port)
	return o
}

// opticPort finds the port in a sensor's name: "Te1/1/1 Receive Power Sensor" → "Te1/1/1".
func opticPort(name string) string {
	f := strings.Fields(name)
	if len(f) < 2 {
		return ""
	}
	l := strings.ToLower(name)
	if !strings.Contains(l, "power") && !strings.Contains(l, "transceiver") && !strings.Contains(l, "temperature sensor") {
		return ""
	}
	if !strings.ContainsAny(f[0], "/0123456789") {
		return ""
	}
	return f[0]
}

// sensorThresholds takes the warning band from a sensor's thresholds: the highest "below"
// and the lowest "above" (relations 1–2 and 3–4), the tightest the module itself declares.
func sensorThresholds(thr table, sensor string, scale func(float64) float64) (low, high *float64) {
	rel, val := map[string]float64{}, map[string]float64{}
	pre := sensor + "."
	for k, v := range thr {
		// k is column.sensor.threshold
		col, rest, ok := strings.Cut(k, ".")
		if !ok || !strings.HasPrefix(rest, pre) {
			continue
		}
		f, _ := num(v)
		switch col {
		case "3":
			rel[rest] = f
		case "4":
			val[rest] = f
		}
	}
	for k, r := range rel {
		v, ok := val[k]
		if !ok {
			continue
		}
		s := scale(v)
		switch r {
		case 1, 2:
			if low == nil || s > *low {
				low = &s
			}
		case 3, 4:
			if high == nil || s < *high {
				high = &s
			}
		}
	}
	return low, high
}

// readStack reads the stack's members (CISCO-STACKWISE-MIB).
func readStack(ctx context.Context, r Reader, p *Profile) []StackMember {
	s := p.Stack
	nums, err := walkCol(ctx, r, s.Number)
	if err != nil || len(nums) == 0 {
		return nil
	}
	roles, _ := walkCol(ctx, r, s.Role)
	states, _ := walkCol(ctx, r, s.State)
	var model, serial table
	if p.Entity != nil {
		model, _ = walkCol(ctx, r, p.Entity.Model)
		serial, _ = walkCol(ctx, r, p.Entity.Serial)
	}
	var out []StackMember
	for _, idx := range sortedIdx(nums) {
		n, _ := nums.num(idx)
		ro, _ := roles.num(idx)
		sta, _ := states.num(idx)
		m := StackMember{Number: int(n), Role: s.Roles[int(ro)], State: s.States[int(sta)], Model: model.str(idx), Serial: serial.str(idx)}
		if m.State == "" {
			m.State = "unknown"
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// Port columns read every round.
type portCols struct {
	oper, admin, highSpeed, speed, hcIn, hcOut, in, out, inErr, outErr, inDisc, outDisc, fcs table
}

// readPorts reads every port's link and counters, turns counters into totals, and makes the
// series for the ports worth a series: up, named (an alias), or with a neighbour or endpoints.
func readPorts(ctx context.Context, r Reader, p *Profile, dev Device, st *snmpState, reset bool) ([]PortState, []Sample) {
	i := p.Interfaces
	if i == nil {
		return nil, nil
	}
	var c portCols
	c.oper, _ = walkCol(ctx, r, i.OperStatus)
	c.admin, _ = walkCol(ctx, r, i.AdminStatus)
	c.highSpeed, _ = walkCol(ctx, r, i.HighSpeed)
	c.hcIn, _ = walkCol(ctx, r, i.HCInOctets)
	c.hcOut, _ = walkCol(ctx, r, i.HCOutOctets)
	if len(c.hcIn) == 0 {
		c.in, _ = walkCol(ctx, r, i.InOctets)
		c.out, _ = walkCol(ctx, r, i.OutOctets)
	}
	if len(c.highSpeed) == 0 {
		c.speed, _ = walkCol(ctx, r, i.Speed)
	}
	c.inErr, _ = walkCol(ctx, r, i.InErrors)
	c.outErr, _ = walkCol(ctx, r, i.OutErrors)
	c.inDisc, _ = walkCol(ctx, r, i.InDiscards)
	c.outDisc, _ = walkCol(ctx, r, i.OutDiscards)
	c.fcs, _ = walkCol(ctx, r, i.FCSErrors)

	linked := map[string]bool{}
	for _, n := range dev.Linked {
		linked[n] = true
	}
	var ports []PortState
	var samples []Sample
	seen := map[string]bool{}
	for _, idx := range sortedIdx(c.oper) {
		n, err := strconv.Atoi(idx)
		if err != nil {
			continue
		}
		meta, ok := st.ifs[n]
		if !ok || !portKind(meta.Kind) {
			continue
		}
		oper, _ := c.oper.num(idx)
		admin, _ := c.admin.num(idx)
		ps := PortState{Index: n, Name: meta.Name, OperUp: oper == 1, AdminUp: admin == 1}
		if f, ok := c.highSpeed.num(idx); ok {
			ps.SpeedMbps = int64(f)
		} else if f, ok := c.speed.num(idx); ok {
			ps.SpeedMbps = int64(f / 1e6)
		}
		total := func(t table, what string) (float64, bool) {
			v, ok := t[idx]
			if !ok {
				return 0, false
			}
			f, ok := num(v)
			if !ok {
				return 0, false
			}
			key := idx + "/" + what
			seen[key] = true
			return st.counters.Add(key, f, counterBits(v), reset), true
		}
		inB, okIn := total(c.hcIn, "in")
		outB, okOut := total(c.hcOut, "out")
		if !okIn {
			inB, okIn = total(c.in, "in")
			outB, okOut = total(c.out, "out")
		}
		inE, okIE := total(c.inErr, "ierr")
		outE, okOE := total(c.outErr, "oerr")
		inD, okID := total(c.inDisc, "idisc")
		outD, okOD := total(c.outDisc, "odisc")
		fcs, okF := total(c.fcs, "fcs")
		ps.Errors = inE + outE
		if okF && fcs > inE {
			ps.Errors = fcs + outE
		}
		ports = append(ports, ps)
		if !ps.OperUp && meta.Alias == "" && !st.busy[meta.Name] && !linked[meta.Name] {
			continue
		}
		lbl := []Label{{Name: "device", Value: dev.ID}, {Name: "ifname", Value: meta.Name}}
		add := func(ok bool, name string, v float64) {
			if ok {
				samples = append(samples, Sample{Name: name, Labels: lbl, Value: v})
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
	return ports, samples
}

// portKind says whether an interface is a port (ethernet, SFP or an aggregate).
func portKind(k string) bool { return k == "ethernet" || k == "sfp" || k == "lag" }

var sfpName = regexp.MustCompile(`(?i)^(te|tengig|twe|twentyfive|fo|fortygig|hu|hundredgig|sfp|xe-)|sfp`)

// ifKind turns IANAifType and the name into a kind.
func ifKind(ifType float64, name string, speedMbps int64) string {
	switch int(ifType) {
	case 6, 62, 69, 117: // ethernetCsmacd, fastEther, fastEtherFX, gigabitEthernet
		if sfpName.MatchString(name) || speedMbps >= 10000 {
			return "sfp"
		}
		return "ethernet"
	case 161: // ieee8023adLag
		return "lag"
	case 53, 135, 136: // propVirtual, l2vlan, l3ipvlan
		return "vlan"
	case 24, 131: // softwareLoopback, tunnel
		return "virtual"
	}
	return "other"
}

// deviceSamples are the device's own series.
func deviceSamples(id string, s *System, h *Health) []Sample {
	lbl := []Label{{Name: "device", Value: id}}
	out := []Sample{
		{Name: "watchlog_net_up", Labels: lbl, Value: 1},
		{Name: "watchlog_net_uptime_seconds", Labels: lbl, Value: float64(s.UptimeS)},
	}
	if h.CPU != nil {
		out = append(out, Sample{Name: "watchlog_net_cpu_utilization", Labels: lbl, Value: *h.CPU})
	}
	if h.MemUsed != nil && h.MemTotal != nil && *h.MemTotal > 0 {
		out = append(out, Sample{Name: "watchlog_net_memory_utilization", Labels: lbl, Value: *h.MemUsed / *h.MemTotal})
	}
	if h.Temperature != nil {
		out = append(out, Sample{Name: "watchlog_net_temperature_celsius", Labels: lbl, Value: *h.Temperature})
	}
	return out
}

func sortedIdx(t table) []string {
	out := make([]string, 0, len(t))
	for k := range t {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return oidLess(out[i], out[j]) })
	return out
}

// oidLess orders OID suffixes numerically, part by part.
func oidLess(a, b string) bool {
	ap, bp := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(ap) && i < len(bp); i++ {
		x, e1 := strconv.Atoi(ap[i])
		y, e2 := strconv.Atoi(bp[i])
		if e1 != nil || e2 != nil {
			if ap[i] != bp[i] {
				return ap[i] < bp[i]
			}
			continue
		}
		if x != y {
			return x < y
		}
	}
	return len(ap) < len(bp)
}
