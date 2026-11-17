// SPDX-License-Identifier: AGPL-3.0-only

package services

import (
	"fmt"
	"os"
	"sync"

	"github.com/godbus/dbus/v5"
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
	}
	return p, nil
}

func u32(v dbus.Variant) uint32 { x, _ := v.Value().(uint32); return x }
func i32(v dbus.Variant) int32  { x, _ := v.Value().(int32); return x }
func u64(v dbus.Variant) uint64 { x, _ := v.Value().(uint64); return x }
func str(v dbus.Variant) string { x, _ := v.Value().(string); return x }
