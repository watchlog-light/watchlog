// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// rows walks a table's columns; each row by index, each column by its key. Empty columns
// (an OID the device doesn't have) are left out.
func rows(ctx context.Context, r Reader, cols map[string]Column) (map[string]map[string]Var, []string) {
	out := map[string]map[string]Var{}
	for key, c := range cols {
		if c.OID == "" {
			continue
		}
		t, err := walkCol(ctx, r, c.OID)
		if err != nil {
			continue
		}
		for idx, v := range t {
			row := out[idx]
			if row == nil {
				row = map[string]Var{}
				out[idx] = row
			}
			row[key] = v
		}
	}
	tab := table{}
	for idx := range out {
		tab[idx] = Var{}
	}
	return out, sortedIdx(tab)
}

func columnsOf(t NASTable) map[string]Column {
	return map[string]Column{
		"name": t.Name, "model": t.Model, "celsius": t.Celsius, "smart": t.SMART, "status": t.Status,
		"capacity": t.Capacity, "total": t.Total, "free": t.Free, "used": t.Used, "raid": t.RAID,
		"mapped": t.Mapped, "iqn": t.IQN, "speed": t.Speed,
	}
}

var leadingNum = regexp.MustCompile(`-?[0-9]+(\.[0-9]+)?`)

// numberOf reads a number, or the first number in a string ("45 C/113 F", "12 %").
func numberOf(v Var, c Column) (float64, bool) {
	f, ok := num(v)
	if !ok {
		m := leadingNum.FindString(str(v))
		if m == "" {
			return 0, false
		}
		f, _ = strconv.ParseFloat(m, 64)
	}
	if c.Scale != 0 {
		f *= c.Scale
	}
	return f, true
}

// wordOf reads a state: the column's States for an integer, else the text, lower-cased.
func wordOf(v Var, c Column) string {
	if f, ok := num(v); ok && c.States != nil {
		if w, ok := c.States[int(f)]; ok {
			return w
		}
		return "unknown"
	}
	return strings.ToLower(strings.TrimSpace(str(v)))
}

// firstTable reads the first of the tables that has rows (newer MIBs first).
func firstTable(ctx context.Context, r Reader, ts []NASTable) (NASTable, map[string]map[string]Var, []string) {
	for _, t := range ts {
		rs, idx := rows(ctx, r, columnsOf(t))
		if len(idx) > 0 {
			return t, rs, idx
		}
	}
	return NASTable{}, nil, nil
}

// readNAS reads a storage device's disks, volumes, pools, LUNs and iSCSI targets, with its
// temperatures, fans and power supplies into the device's health.
func readNAS(ctx context.Context, r Reader, n *NASOIDs, sys *System, h *Health) *NAS {
	out := &NAS{Disks: []Disk{}, Volumes: []Volume{}, LUNs: []LUN{}}
	if n.Model != "" {
		if vs, err := r.Get(ctx, []string{n.Model}); err == nil && len(vs) > 0 && str(vs[0]) != "" {
			sys.Model = str(vs[0])
		}
	}
	for name, oid := range map[string]string{"CPU": n.CPUCelsius, "System": n.SysCelsius} {
		if oid == "" {
			continue
		}
		if vs, err := r.Get(ctx, []string{oid}); err == nil && len(vs) > 0 {
			if f, ok := numberOf(vs[0], Column{}); ok {
				h.Sensors = append(h.Sensors, Sensor{Name: name, Celsius: f, State: "ok"})
				if h.Temperature == nil || f > *h.Temperature {
					c := f
					h.Temperature = &c
				}
			}
		}
	}
	t, rs, idx := firstTable(ctx, r, n.Disks)
	for _, i := range idx {
		row := rs[i]
		d := Disk{Name: str(row["name"]), Model: str(row["model"]), SMART: "unknown", Status: "unknown"}
		d.Index, _ = strconv.Atoi(strings.Split(i, ".")[0])
		if v, ok := row["smart"]; ok {
			d.SMART = wordOf(v, t.SMART)
		}
		if v, ok := row["status"]; ok {
			d.Status = wordOf(v, t.Status)
		}
		if d.Status == "no-disk" {
			continue
		}
		if f, ok := numberOf(row["celsius"], t.Celsius); ok && row["celsius"].OID != "" {
			d.Celsius = &f
		}
		if f, ok := numberOf(row["capacity"], t.Capacity); ok {
			d.Capacity = f
		}
		if d.Name == "" {
			d.Name = "Disk " + strconv.Itoa(d.Index)
		}
		out.Disks = append(out.Disks, d)
	}
	vol := func(ts []NASTable) []Volume {
		var vs []Volume
		t, rs, idx := firstTable(ctx, r, ts)
		for _, i := range idx {
			row := rs[i]
			v := Volume{Name: str(row["name"]), Status: "unknown"}
			if x, ok := row["status"]; ok {
				v.Status = wordOf(x, t.Status)
			}
			v.Total, _ = numberOf(row["total"], t.Total)
			v.Free, _ = numberOf(row["free"], t.Free)
			v.RAID = str(row["raid"])
			if v.Name == "" {
				v.Name = "#" + i
			}
			vs = append(vs, v)
		}
		return vs
	}
	out.Volumes = append(out.Volumes, vol(n.Volumes)...)
	out.Pools = vol(n.Pools)
	// RAID groups carry the level and state (degraded, rebuilding) the volumes don't.
	if raid := vol(n.RAID); len(raid) > 0 {
		for k := range out.Pools {
			if k < len(raid) {
				if out.Pools[k].RAID == "" {
					out.Pools[k].RAID = raid[k].RAID
				}
				if raid[k].Status != "" && raid[k].Status != "ready" && raid[k].Status != "unknown" {
					out.Pools[k].Status = raid[k].Status
				}
			}
		}
		if len(out.Pools) == 0 {
			out.Pools = raid
		}
	}
	t, rs, idx = firstTable(ctx, r, n.LUNs)
	for _, i := range idx {
		row := rs[i]
		l := LUN{Name: str(row["name"]), Status: str(row["status"])}
		l.Capacity, _ = numberOf(row["capacity"], t.Capacity)
		if f, ok := numberOf(row["used"], t.Used); ok && row["used"].OID != "" {
			l.UsedPercent = &f
		}
		if f, ok := num(row["mapped"]); ok {
			l.Mapped = f == 1
		}
		out.LUNs = append(out.LUNs, l)
	}
	t, rs, idx = firstTable(ctx, r, n.Targets)
	for _, i := range idx {
		row := rs[i]
		tg := ISCSITarget{Name: str(row["name"]), IQN: str(row["iqn"]), Status: "unknown"}
		if v, ok := row["status"]; ok {
			tg.Status = wordOf(v, t.Status)
		}
		tg.Connected = tg.Status == "connected"
		out.Targets = append(out.Targets, tg)
	}
	for _, ts := range []struct {
		tables []NASTable
		into   *[]Component
	}{{n.Fans, &h.Fans}, {n.PowerSupply, &h.PSUs}} {
		t, rs, idx := firstTable(ctx, r, ts.tables)
		for _, i := range idx {
			row := rs[i]
			c := Component{Name: str(row["name"]), State: "ok"}
			if c.Name == "" {
				c.Name = "#" + i
			}
			if v, ok := row["status"]; ok {
				c.State = wordOf(v, t.Status)
			} else if f, ok := numberOf(row["speed"], t.Speed); ok && f == 0 {
				c.State = "failed"
			}
			*ts.into = append(*ts.into, c)
		}
	}
	return out
}

// readUPS reads a UPS's power.
func readUPS(ctx context.Context, r Reader, u *UPSOIDs, sys *System) *UPS {
	out := &UPS{Status: "unknown"}
	get := func(c Column) (Var, bool) {
		if c.OID == "" {
			return Var{}, false
		}
		vs, err := r.Get(ctx, []string{c.OID})
		if err != nil || len(vs) == 0 {
			return Var{}, false
		}
		return vs[0], true
	}
	if v, ok := get(u.Model); ok && str(v) != "" {
		sys.Model = str(v)
	}
	if v, ok := get(u.Status); ok {
		out.Status = wordOf(v, u.Status)
	}
	for _, f := range []struct {
		c    Column
		into **float64
	}{{u.Charge, &out.ChargePercent}, {u.Runtime, &out.RuntimeS}, {u.Load, &out.LoadPercent}, {u.InputVolts, &out.InputVolts}, {u.OutputVolts, &out.OutputVolts}, {u.Celsius, &out.Celsius}} {
		if v, ok := get(f.c); ok {
			if x, ok := numberOf(v, f.c); ok {
				*f.into = &x
			}
		}
	}
	if v, ok := get(u.Replace); ok {
		out.ReplaceBattery = wordOf(v, u.Replace) == "replace"
	}
	if u.AlarmTable != "" && u.ReplaceAlarm != "" {
		t, _ := walkCol(ctx, r, u.AlarmTable)
		for _, v := range t {
			if strings.TrimPrefix(str(v), ".") == strings.TrimPrefix(u.ReplaceAlarm, ".") {
				out.ReplaceBattery = true
			}
		}
	}
	return out
}

// nasSamples are a NAS's volumes, LUNs and disk temperatures (by name, never an address).
func nasSamples(id string, n *NAS) []Sample {
	var out []Sample
	lbl := func(k, v string) []Label { return []Label{{Name: "device", Value: id}, {Name: k, Value: v}} }
	for _, v := range n.Volumes {
		if v.Total > 0 {
			out = append(out, Sample{Name: "watchlog_net_volume_used_ratio", Labels: lbl("volume", v.Name), Value: 1 - v.Free/v.Total})
		}
	}
	for _, l := range n.LUNs {
		if l.UsedPercent != nil {
			out = append(out, Sample{Name: "watchlog_net_lun_used_ratio", Labels: lbl("lun", l.Name), Value: *l.UsedPercent / 100})
		}
	}
	for _, d := range n.Disks {
		if d.Celsius != nil {
			out = append(out, Sample{Name: "watchlog_net_disk_celsius", Labels: lbl("disk", strconv.Itoa(d.Index)), Value: *d.Celsius})
		}
	}
	return out
}

// upsSamples are a UPS's charge, runtime, load and whether it runs on battery.
func upsSamples(id string, u *UPS) []Sample {
	lbl := []Label{{Name: "device", Value: id}}
	var out []Sample
	add := func(name string, v *float64, scale float64) {
		if v != nil {
			out = append(out, Sample{Name: name, Labels: lbl, Value: *v * scale})
		}
	}
	add("watchlog_net_ups_charge_ratio", u.ChargePercent, 0.01)
	add("watchlog_net_ups_runtime_seconds", u.RuntimeS, 1)
	add("watchlog_net_ups_load_ratio", u.LoadPercent, 0.01)
	on := 0.0
	if u.Status == "on-battery" {
		on = 1
	}
	out = append(out, Sample{Name: "watchlog_net_ups_on_battery", Labels: lbl, Value: on})
	return out
}
