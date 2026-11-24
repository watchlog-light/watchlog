// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

import (
	"embed"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Profiles are data, not code (ADR-233): one YAML file per vendor family in profiles/, written
// from the public MIB definitions, naming the OIDs each part of a device is read from. The
// code knows what a part means (a port, a CPU, a neighbour); a profile says where to read it.
// A profile names the profile it extends ("generic"); its parts replace the parent's.
//
//go:embed profiles/*.yaml
var profileFS embed.FS

// Profile is one vendor family.
type Profile struct {
	Name    string `yaml:"name"`
	Vendor  string `yaml:"vendor"`
	Extends string `yaml:"extends"`
	// Kind is what a matched device is drawn as unless its own facts say otherwise.
	Kind  string `yaml:"kind"`
	Match Match  `yaml:"match"`

	System       *SystemOIDs     `yaml:"system"`
	Interfaces   *InterfaceOIDs  `yaml:"interfaces"`
	Entity       *EntityOIDs     `yaml:"entity"`
	CPU          []CPUSource     `yaml:"cpu"`
	Memory       []MemorySource  `yaml:"memory"`
	Temperatures []StateTable    `yaml:"temperatures"`
	Fans         []StateTable    `yaml:"fans"`
	PSUs         []StateTable    `yaml:"psus"`
	Sensors      *EntitySensors  `yaml:"sensors"`
	Neighbours   []NeighbourOIDs `yaml:"neighbours"`
	MACs         *MACOIDs        `yaml:"macs"`
	ARP          *ARPOIDs        `yaml:"arp"`
	PoE          *PoEOIDs        `yaml:"poe"`
	Stack        *StackOIDs      `yaml:"stack"`
	// RouterOS lists what the RouterOS reader asks for (MikroTik): the only paths it reads.
	RouterOS *ROSPaths `yaml:"routeros"`
	// NAS and UPS (0.17, ADR-234): a storage device's disks, volumes and LUNs; a UPS's power.
	NAS *NASOIDs `yaml:"nas"`
	UPS *UPSOIDs `yaml:"ups"`
	// Lacks lists what the family doesn't have, for the docs and the ADR.
	Lacks []string `yaml:"lacks"`
}

// Match picks a profile for a device: one of the sysObjectID prefixes, then sysDescr.
type Match struct {
	SysObjectID []string `yaml:"sysObjectID"`
	SysDescr    []string `yaml:"sysDescr"`
	NotSysDescr []string `yaml:"notSysDescr"`
	// Probe is an OID that answers only on this kind of device (QNAP's model name, UPS-MIB's
	// identity): tried when no sysObjectID matches, as a QNAP or a UPS card may say "Linux".
	Probe string `yaml:"probe"`
}

// SystemOIDs are SNMPv2-MIB's system group.
type SystemOIDs struct {
	Descr    string `yaml:"descr"`
	ObjectID string `yaml:"objectID"`
	Uptime   string `yaml:"uptime"`
	Name     string `yaml:"name"`
	Location string `yaml:"location"`
}

// InterfaceOIDs are IF-MIB's columns (and EtherLike-MIB's FCS errors).
type InterfaceOIDs struct {
	Descr       string `yaml:"descr"`
	Type        string `yaml:"type"`
	Speed       string `yaml:"speed"`
	PhysAddress string `yaml:"physAddress"`
	AdminStatus string `yaml:"adminStatus"`
	OperStatus  string `yaml:"operStatus"`
	InOctets    string `yaml:"inOctets"`
	OutOctets   string `yaml:"outOctets"`
	InDiscards  string `yaml:"inDiscards"`
	InErrors    string `yaml:"inErrors"`
	OutDiscards string `yaml:"outDiscards"`
	OutErrors   string `yaml:"outErrors"`
	Name        string `yaml:"name"`
	HCInOctets  string `yaml:"hcInOctets"`
	HCOutOctets string `yaml:"hcOutOctets"`
	HighSpeed   string `yaml:"highSpeed"`
	Alias       string `yaml:"alias"`
	FCSErrors   string `yaml:"fcsErrors"`
	// VLANs: the port's VLAN (Q-BRIDGE-MIB dot1qPvid, by bridge port).
	PVID string `yaml:"pvid"`
}

// EntityOIDs are ENTITY-MIB's physical table: model, serial and firmware of the chassis.
type EntityOIDs struct {
	Descr    string `yaml:"descr"`
	Class    string `yaml:"class"`
	Name     string `yaml:"name"`
	Firmware string `yaml:"firmware"`
	Software string `yaml:"software"`
	Serial   string `yaml:"serial"`
	Mfg      string `yaml:"mfg"`
	Model    string `yaml:"model"`
}

// CPUSource is a CPU load column; the device's CPU is the aggregate of its rows, scaled to 0..1.
type CPUSource struct {
	OID       string  `yaml:"oid"`
	Scale     float64 `yaml:"scale"`
	Aggregate string  `yaml:"aggregate"` // max (default) or avg
}

// MemorySource is a memory table: used and free (or total) columns, the rows whose name or
// type matches, in units of bytes times the units column (hrStorage).
type MemorySource struct {
	Name      string `yaml:"name"`
	NameMatch string `yaml:"nameMatch"`
	Type      string `yaml:"type"`
	TypeValue string `yaml:"typeValue"`
	Used      string `yaml:"used"`
	Free      string `yaml:"free"`
	Total     string `yaml:"total"`
	Units     string `yaml:"units"`
	// Percent is a used-memory percentage (NX-OS's cseSysMemoryUtilization), when a device
	// gives no bytes.
	Percent string `yaml:"percent"`
}

// StateTable is a table of things with a state (fans, power supplies, temperatures): a name
// column, a state column and how its numbers read, and for temperatures a value and threshold.
type StateTable struct {
	Name      string         `yaml:"name"`
	State     string         `yaml:"state"`
	States    map[int]string `yaml:"states"`
	Value     string         `yaml:"value"`
	Threshold string         `yaml:"threshold"`
	Scale     float64        `yaml:"scale"`
}

// EntitySensors is CISCO-ENTITY-SENSOR-MIB: typed sensors named by ENTITY-MIB, with their
// own thresholds; SFP optics are the dBm sensors under a transceiver.
type EntitySensors struct {
	Type       string `yaml:"type"`
	Scale      string `yaml:"scale"`
	Precision  string `yaml:"precision"`
	Value      string `yaml:"value"`
	Status     string `yaml:"status"`
	Thresholds string `yaml:"thresholds"` // the threshold table's entry; .2 severity, .3 relation, .4 value
	// Celsius and DBm are the type values of a temperature and an optical power sensor.
	Celsius int `yaml:"celsius"`
	DBm     int `yaml:"dbm"`
}

// NeighbourOIDs are a neighbour table: CDP (by ifIndex) or LLDP (by local port number).
type NeighbourOIDs struct {
	Protocol   string `yaml:"protocol"` // cdp, lldp
	DeviceID   string `yaml:"deviceID"`
	SysName    string `yaml:"sysName"`
	Port       string `yaml:"port"`
	PortDescr  string `yaml:"portDescr"`
	Address    string `yaml:"address"`
	Platform   string `yaml:"platform"`
	ChassisID  string `yaml:"chassisID"`
	LocalPort  string `yaml:"localPort"`  // LLDP: lldpLocPortId, the local port's name
	LocalDescr string `yaml:"localDescr"` // LLDP: lldpLocPortDesc
	ManAddr    string `yaml:"manAddr"`    // LLDP: lldpRemManAddrTable entry
}

// MACOIDs are the forwarding tables: BRIDGE-MIB (per VLAN on Cisco, through the community or
// context), Q-BRIDGE-MIB (one table with the VLAN in the index).
type MACOIDs struct {
	BasePortIfIndex string `yaml:"basePortIfIndex"`
	FdbPort         string `yaml:"fdbPort"`
	FdbStatus       string `yaml:"fdbStatus"`
	QFdbPort        string `yaml:"qFdbPort"`
	QFdbStatus      string `yaml:"qFdbStatus"`
	// PerVLAN: "cisco" reads BRIDGE-MIB once per VLAN (v2c community@vlan, v3 context
	// vlan-<id>), the VLANs from VLANList (CISCO-VTP-MIB vtpVlanState).
	PerVLAN  string `yaml:"perVLAN"`
	VLANList string `yaml:"vlanList"`
}

// ARPOIDs are IP-MIB's address translation tables.
type ARPOIDs struct {
	NetToMediaPhys string `yaml:"netToMediaPhys"`
	NetToPhysPhys  string `yaml:"netToPhysPhys"`
}

// PoEOIDs read per-port power: POWER-ETHERNET-MIB's detection, and a vendor's consumption in
// milliwatts by the same group.port index.
type PoEOIDs struct {
	Detection   string `yaml:"detection"`
	Consumption string `yaml:"consumption"`
	// PortName maps group.port to a port name (Cisco: entPhysicalName of the PSE port).
	PortName string `yaml:"portName"`
}

// StackOIDs read a stack's members (CISCO-STACKWISE-MIB).
type StackOIDs struct {
	Number string         `yaml:"number"`
	Role   string         `yaml:"role"`
	State  string         `yaml:"state"`
	Roles  map[int]string `yaml:"roles"`
	States map[int]string `yaml:"states"`
}

// ROSPaths are the RouterOS menus read over REST or the API, by what they are for; each is
// printed, never set.
type ROSPaths struct {
	Identity    string `yaml:"identity"`
	Resource    string `yaml:"resource"`
	Routerboard string `yaml:"routerboard"`
	Health      string `yaml:"health"`
	Interfaces  string `yaml:"interfaces"`
	Ethernet    string `yaml:"ethernet"`
	Neighbours  string `yaml:"neighbours"`
	ARP         string `yaml:"arp"`
	BridgeHosts string `yaml:"bridgeHosts"`
	Routes      string `yaml:"routes"`
	Update      string `yaml:"update"`
	VLANs       string `yaml:"vlans"`
}

// Column is one column of a table: its OID, and how to read it.
type Column struct {
	OID string `yaml:"oid"`
	// States maps an integer value to WatchLog's word; Scale multiplies a number.
	States map[int]string `yaml:"states"`
	Scale  float64        `yaml:"scale"`
}

// NASTable is a table read column by column, rows by index.
type NASTable struct {
	Name     Column `yaml:"name"`
	Model    Column `yaml:"model"`
	Celsius  Column `yaml:"celsius"`
	SMART    Column `yaml:"smart"`
	Status   Column `yaml:"status"`
	Capacity Column `yaml:"capacity"`
	Total    Column `yaml:"total"`
	Free     Column `yaml:"free"`
	Used     Column `yaml:"usedPercent"`
	RAID     Column `yaml:"raid"`
	Mapped   Column `yaml:"mapped"`
	IQN      Column `yaml:"iqn"`
	Speed    Column `yaml:"speed"`
}

// NASOIDs are a storage device's tables: the newer ones first, the older as a fallback.
type NASOIDs struct {
	Model       string     `yaml:"model"`
	CPUCelsius  string     `yaml:"cpuCelsius"`
	SysCelsius  string     `yaml:"systemCelsius"`
	Disks       []NASTable `yaml:"disks"`
	Volumes     []NASTable `yaml:"volumes"`
	Pools       []NASTable `yaml:"pools"`
	RAID        []NASTable `yaml:"raid"`
	LUNs        []NASTable `yaml:"luns"`
	Targets     []NASTable `yaml:"targets"`
	Fans        []NASTable `yaml:"fans"`
	PowerSupply []NASTable `yaml:"powerSupplies"`
}

// UPSOIDs read a UPS (RFC 1628 UPS-MIB or APC PowerNet-MIB).
type UPSOIDs struct {
	Model       Column `yaml:"model"`
	Status      Column `yaml:"status"`
	Charge      Column `yaml:"charge"`
	Runtime     Column `yaml:"runtime"` // scaled to seconds
	Load        Column `yaml:"load"`
	InputVolts  Column `yaml:"inputVolts"`
	OutputVolts Column `yaml:"outputVolts"`
	Celsius     Column `yaml:"celsius"`
	// Replace: a scalar whose States say "replace", or an alarm table whose values include
	// ReplaceAlarm (UPS-MIB's upsAlarmBatteryBad).
	Replace      Column `yaml:"replace"`
	AlarmTable   string `yaml:"alarmTable"`
	ReplaceAlarm string `yaml:"replaceAlarm"`
}

// Profiles is the loaded set, each merged with what it extends.
type Profiles map[string]*Profile

// LoadProfiles reads the embedded profiles.
func LoadProfiles() (Profiles, error) {
	entries, err := profileFS.ReadDir("profiles")
	if err != nil {
		return nil, err
	}
	raw := map[string]*Profile{}
	for _, e := range entries {
		data, err := profileFS.ReadFile(path.Join("profiles", e.Name()))
		if err != nil {
			return nil, err
		}
		var p Profile
		dec := yaml.NewDecoder(strings.NewReader(string(data)))
		dec.KnownFields(true)
		if err := dec.Decode(&p); err != nil {
			return nil, fmt.Errorf("profile %s: %w", e.Name(), err)
		}
		if p.Name == "" || p.Name+".yaml" != e.Name() {
			return nil, fmt.Errorf("profile %s: its name must be the file's", e.Name())
		}
		raw[p.Name] = &p
	}
	out := Profiles{}
	for name := range raw {
		p, err := merged(raw, name, 0)
		if err != nil {
			return nil, err
		}
		out[name] = p
	}
	return out, nil
}

// merged copies a profile's parent's parts where the profile leaves them out.
func merged(raw map[string]*Profile, name string, depth int) (*Profile, error) {
	p, ok := raw[name]
	if !ok {
		return nil, fmt.Errorf("profile %q doesn't exist", name)
	}
	if p.Extends == "" {
		cp := *p
		return &cp, nil
	}
	if depth > 4 {
		return nil, fmt.Errorf("profile %q extends too deep", name)
	}
	parent, err := merged(raw, p.Extends, depth+1)
	if err != nil {
		return nil, err
	}
	out := *p
	if out.Vendor == "" {
		out.Vendor = parent.Vendor
	}
	if out.Kind == "" {
		out.Kind = parent.Kind
	}
	if out.System == nil {
		out.System = parent.System
	}
	if out.Interfaces == nil {
		out.Interfaces = parent.Interfaces
	}
	if out.Entity == nil {
		out.Entity = parent.Entity
	}
	if out.CPU == nil {
		out.CPU = parent.CPU
	}
	if out.Memory == nil {
		out.Memory = parent.Memory
	}
	if out.Temperatures == nil {
		out.Temperatures = parent.Temperatures
	}
	if out.Fans == nil {
		out.Fans = parent.Fans
	}
	if out.PSUs == nil {
		out.PSUs = parent.PSUs
	}
	if out.Sensors == nil {
		out.Sensors = parent.Sensors
	}
	if out.Neighbours == nil {
		out.Neighbours = parent.Neighbours
	}
	if out.MACs == nil {
		out.MACs = parent.MACs
	}
	if out.ARP == nil {
		out.ARP = parent.ARP
	}
	if out.PoE == nil {
		out.PoE = parent.PoE
	}
	if out.Stack == nil {
		out.Stack = parent.Stack
	}
	if out.RouterOS == nil {
		out.RouterOS = parent.RouterOS
	}
	if out.NAS == nil {
		out.NAS = parent.NAS
	}
	if out.UPS == nil {
		out.UPS = parent.UPS
	}
	return &out, nil
}

// For picks the profile for a device from its sysObjectID and sysDescr: the longest matching
// sysObjectID prefix whose sysDescr rules agree, else generic.
func (ps Profiles) For(objectID, descr string) *Profile {
	objectID = strings.TrimPrefix(objectID, ".")
	best, bestLen := (*Profile)(nil), -1
	names := make([]string, 0, len(ps))
	for n := range ps {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		p := ps[n]
		if !descrAllows(p.Match, descr) {
			continue
		}
		for _, pre := range p.Match.SysObjectID {
			if strings.HasPrefix(objectID, pre) && len(pre) > bestLen {
				best, bestLen = p, len(pre)
			}
		}
		if len(p.Match.SysObjectID) == 0 && len(p.Match.SysDescr) > 0 && bestLen < 0 {
			best = p
		}
	}
	if best == nil {
		return ps["generic"]
	}
	return best
}

// Probed returns the profiles that have a probe, by name (for a device no sysObjectID matched).
func (ps Profiles) Probed() []*Profile {
	var out []*Profile
	for _, p := range ps {
		if p.Match.Probe != "" {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func descrAllows(m Match, descr string) bool {
	for _, s := range m.NotSysDescr {
		if regexp.MustCompile("(?i)" + s).MatchString(descr) {
			return false
		}
	}
	if len(m.SysDescr) == 0 {
		return true
	}
	for _, s := range m.SysDescr {
		if regexp.MustCompile("(?i)" + s).MatchString(descr) {
			return true
		}
	}
	return false
}
