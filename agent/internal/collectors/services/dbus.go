// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/godbus/dbus/v5"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/jobs"
)

// DefaultSocket is the system bus; WATCHLOG_DBUS_SOCKET overrides it (docker run mounts it).
const DefaultSocket = "/run/dbus/system_bus_socket"

const (
	dest       = "org.freedesktop.systemd1"
	managerObj = dbus.ObjectPath("/org/freedesktop/systemd1")
)

// DBus talks to systemd over the system bus. It reconnects after an error.
type DBus struct {
	Socket string
	mu     sync.Mutex
	conn   *dbus.Conn
}

// NewDBus returns a client for the socket (DefaultSocket when empty).
func NewDBus(socket string) *DBus {
	if socket == "" {
		socket = os.Getenv("WATCHLOG_DBUS_SOCKET")
	}
	if socket == "" {
		socket = DefaultSocket
	}
	return &DBus{Socket: socket}
}

// Available reports whether systemd answers on the bus (no systemd: process groups only).
func (b *DBus) Available() bool {
	_, err := b.Units()
	return err == nil
}

func (b *DBus) connection() (*dbus.Conn, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn != nil && b.conn.Connected() {
		return b.conn, nil
	}
	conn, err := dbus.Dial("unix:path=" + b.Socket)
	if err != nil {
		return nil, err
	}
	if err := conn.Auth(nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("dbus auth: %w", err)
	}
	if err := conn.Hello(); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("dbus hello: %w", err)
	}
	b.conn = conn
	return conn, nil
}

func (b *DBus) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn != nil {
		_ = b.conn.Close()
		b.conn = nil
	}
}

// Units lists every unit systemd has loaded.
func (b *DBus) Units() ([]UnitStatus, error) {
	conn, err := b.connection()
	if err != nil {
		return nil, err
	}
	var raw [][]any
	call := conn.Object(dest, managerObj).Call("org.freedesktop.systemd1.Manager.ListUnits", 0)
	if call.Err != nil {
		b.reset()
		return nil, call.Err
	}
	if err := call.Store(&raw); err != nil {
		return nil, err
	}
	out := make([]UnitStatus, 0, len(raw))
	for _, r := range raw {
		// (name, description, load, active, sub, following, path, job id, job type, job path)
		if len(r) < 7 {
			continue
		}
		name, _ := r[0].(string)
		load, _ := r[2].(string)
		active, _ := r[3].(string)
		sub, _ := r[4].(string)
		path, _ := r[6].(dbus.ObjectPath)
		out = append(out, UnitStatus{Name: name, LoadState: load, ActiveState: active, SubState: sub, Path: string(path)})
	}
	return out, nil
}

// Props reads a service unit's properties.
func (b *DBus) Props(u UnitStatus) (Props, error) {
	conn, err := b.connection()
	if err != nil {
		return Props{}, err
	}
	obj := conn.Object(dest, dbus.ObjectPath(u.Path))
	var svc, unit map[string]dbus.Variant
	if err := obj.Call("org.freedesktop.DBus.Properties.GetAll", 0, "org.freedesktop.systemd1.Service").Store(&svc); err != nil {
		return Props{}, fmt.Errorf("%s: %w", u.Name, err)
	}
	if err := obj.Call("org.freedesktop.DBus.Properties.GetAll", 0, "org.freedesktop.systemd1.Unit").Store(&unit); err != nil {
		return Props{}, fmt.Errorf("%s: %w", u.Name, err)
	}
	p := Props{
		NRestarts:       u32(svc["NRestarts"]),
		ExecMainCode:    i32(svc["ExecMainCode"]),
		ExecMainStatus:  i32(svc["ExecMainStatus"]),
		ControlGroup:    str(svc["ControlGroup"]),
		MainPID:         u32(svc["MainPID"]),
		ActiveEnterUsec: u64(unit["ActiveEnterTimestamp"]),
		MemoryMax:       bytesLimit(u64(svc["MemoryMax"])),
		CPUQuotaCores:   usecToCores(u64(svc["CPUQuotaPerSecUSec"])),
		Result:          str(svc["Result"]),
		NeedReload:      boolean(unit["NeedDaemonReload"]),
	}
	return p, nil
}

// Timers lists the server's timers (loaded, and disabled ones from their unit files) with
// what each schedules and the last run of the unit it starts (ADR-223).
func (b *DBus) Timers() ([]jobs.TimerInfo, error) {
	conn, err := b.connection()
	if err != nil {
		return nil, err
	}
	mgr := conn.Object(dest, managerObj)
	paths := map[string]dbus.ObjectPath{}
	units, err := b.Units()
	if err != nil {
		return nil, err
	}
	for _, u := range units {
		if strings.HasSuffix(u.Name, ".timer") && u.LoadState == "loaded" {
			paths[u.Name] = dbus.ObjectPath(u.Path)
		}
	}
	// Disabled timers aren't loaded until asked for: their unit files say they exist.
	var files [][]any
	if mgr.Call("org.freedesktop.systemd1.Manager.ListUnitFilesByPatterns", 0, []string{"disabled"}, []string{"*.timer"}).Store(&files) == nil {
		for _, f := range files {
			if len(f) < 1 {
				continue
			}
			p, _ := f[0].(string)
			name := p[strings.LastIndex(p, "/")+1:]
			if _, ok := paths[name]; ok || name == "" {
				continue
			}
			var path dbus.ObjectPath
			if mgr.Call("org.freedesktop.systemd1.Manager.LoadUnit", 0, name).Store(&path) == nil {
				paths[name] = path
			}
		}
	}
	out := make([]jobs.TimerInfo, 0, len(paths))
	for name, path := range paths {
		obj := conn.Object(dest, path)
		var tp, up map[string]dbus.Variant
		if obj.Call("org.freedesktop.DBus.Properties.GetAll", 0, "org.freedesktop.systemd1.Timer").Store(&tp) != nil {
			continue
		}
		_ = obj.Call("org.freedesktop.DBus.Properties.GetAll", 0, "org.freedesktop.systemd1.Unit").Store(&up)
		t := jobs.TimerInfo{
			Name: name, Unit: str(tp["Unit"]), Persistent: boolean(tp["Persistent"]),
			RandomDelayUsec: u64(tp["RandomizedDelayUSec"]), NextUsec: u64(tp["NextElapseUSecRealtime"]),
			LastUsec: u64(tp["LastTriggerUSec"]),
		}
		state := str(up["UnitFileState"])
		t.Enabled = str(up["ActiveState"]) == "active" && state != "disabled"
		if cal, ok := tp["TimersCalendar"].Value().([][]any); ok {
			for _, c := range cal {
				if len(c) >= 2 {
					if spec, ok := c[1].(string); ok {
						t.Calendar = append(t.Calendar, spec)
					}
				}
			}
		}
		if mono, ok := tp["TimersMonotonic"].Value().([][]any); ok && len(mono) > 0 {
			t.Monotonic = true
		}
		if t.Unit != "" {
			var upath dbus.ObjectPath
			if mgr.Call("org.freedesktop.systemd1.Manager.LoadUnit", 0, t.Unit).Store(&upath) == nil {
				var svc, sunit map[string]dbus.Variant
				uobj := conn.Object(dest, upath)
				if uobj.Call("org.freedesktop.DBus.Properties.GetAll", 0, "org.freedesktop.systemd1.Service").Store(&svc) == nil {
					_ = uobj.Call("org.freedesktop.DBus.Properties.GetAll", 0, "org.freedesktop.systemd1.Unit").Store(&sunit)
					t.Run = jobs.RunInfo{
						StartUsec: u64(svc["ExecMainStartTimestamp"]), ExitUsec: u64(svc["ExecMainExitTimestamp"]),
						Code: i32(svc["ExecMainCode"]), Status: i32(svc["ExecMainStatus"]), Result: str(svc["Result"]),
						Active: str(sunit["ActiveState"]),
					}
				}
			}
		}
		out = append(out, t)
	}
	return out, nil
}

func u32(v dbus.Variant) uint32   { x, _ := v.Value().(uint32); return x }
func i32(v dbus.Variant) int32    { x, _ := v.Value().(int32); return x }
func u64(v dbus.Variant) uint64   { x, _ := v.Value().(uint64); return x }
func str(v dbus.Variant) string   { x, _ := v.Value().(string); return x }
func boolean(v dbus.Variant) bool { x, _ := v.Value().(bool); return x }

// Version is systemd's version ("255" from "255.4-1ubuntu8"), or "" when unknown.
func (b *DBus) Version() string {
	conn, err := b.connection()
	if err != nil {
		return ""
	}
	v, err := conn.Object(dest, managerObj).GetProperty("org.freedesktop.systemd1.Manager.Version")
	if err != nil {
		return ""
	}
	s, _ := v.Value().(string)
	if i := strings.IndexAny(s, ".-~ "); i > 0 {
		s = s[:i]
	}
	return s
}
