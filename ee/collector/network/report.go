// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package network

// Report is what the poller posts to /ingest/v1/network/report after each round: each
// device's state, health and, every 5 minutes, its inventory (ports, neighbours, MAC and ARP
// tables). Counters go to VictoriaMetrics as watchlog_net_* series, not here.
type Report struct {
	Host      string            `json:"host"`
	Devices   []DeviceReport    `json:"devices"`
	Discovery []DiscoveryReport `json:"discovery,omitempty"`
}

// Device states.
const (
	StateOK          = "ok"
	StateUnreachable = "unreachable"
	StateAuthFailed  = "auth_failed"
	// StateCertChanged: a RouterOS device's certificate no longer matches its pin; it isn't
	// polled until an Owner accepts the new one.
	StateCertChanged = "cert_changed"
	StateError       = "error"
)

// DeviceReport is one device's round.
type DeviceReport struct {
	ID       string `json:"id"`
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
	PolledAt int64  `json:"polledAt"`
	// Failures counts the polls in a row that failed (an alert after 3).
	Failures int    `json:"failures,omitempty"`
	Profile  string `json:"profile,omitempty"`
	// Fingerprint is a RouterOS device's certificate as seen (pinned on first contact).
	Fingerprint string     `json:"fingerprint,omitempty"`
	System      *System    `json:"system,omitempty"`
	Health      *Health    `json:"health,omitempty"`
	Inventory   *Inventory `json:"inventory,omitempty"`
	// 0.17 (ADR-234): what a controller, a NAS, a recorder or a UPS adds.
	Wireless *Wireless `json:"wireless,omitempty"`
	NAS      *NAS      `json:"nas,omitempty"`
	Recorder *Recorder `json:"recorder,omitempty"`
	UPS      *UPS      `json:"ups,omitempty"`
}

// System is what identifies the device and how long it has been up.
type System struct {
	Name     string `json:"name,omitempty"`
	Descr    string `json:"descr,omitempty"`
	ObjectID string `json:"objectId,omitempty"`
	UptimeS  int64  `json:"uptimeS"`
	Location string `json:"location,omitempty"`
	Vendor   string `json:"vendor,omitempty"`
	Model    string `json:"model,omitempty"`
	Serial   string `json:"serial,omitempty"`
	Firmware string `json:"firmware,omitempty"`
	Kind     string `json:"kind,omitempty"`
	// MAC is the device's own address, for the switch port it is behind (0.17): a NAS's or a
	// UPS card's from IF-MIB, a recorder's from its network config.
	MAC string `json:"mac,omitempty"`
	// Update is RouterOS's channel and whether a newer version is there.
	Update *Update `json:"update,omitempty"`
}

// Update is a RouterOS package update state.
type Update struct {
	Channel   string `json:"channel,omitempty"`
	Installed string `json:"installed,omitempty"`
	Latest    string `json:"latest,omitempty"`
}

// Health is the device's live numbers, each round.
type Health struct {
	CPU         *float64      `json:"cpu,omitempty"`         // 0..1
	MemUsed     *float64      `json:"memUsed,omitempty"`     // bytes
	MemTotal    *float64      `json:"memTotal,omitempty"`    // bytes
	Temperature *float64      `json:"temperature,omitempty"` // the hottest sensor, °C
	Sensors     []Sensor      `json:"sensors,omitempty"`
	Fans        []Component   `json:"fans,omitempty"`
	PSUs        []Component   `json:"psus,omitempty"`
	Ports       []PortState   `json:"ports,omitempty"`
	Optics      []Optic       `json:"optics,omitempty"`
	Stack       []StackMember `json:"stack,omitempty"`
}

// Sensor is a temperature reading.
type Sensor struct {
	Name      string   `json:"name"`
	Celsius   float64  `json:"celsius"`
	Threshold *float64 `json:"threshold,omitempty"`
	State     string   `json:"state,omitempty"` // ok, warning, critical
}

// Component is a fan or a power supply.
type Component struct {
	Name  string `json:"name"`
	State string `json:"state"` // ok, warning, failed, absent
}

// PortState is one port's link, each round (for down/up, speed changes).
type PortState struct {
	Index     int    `json:"index"`
	Name      string `json:"name"`
	AdminUp   bool   `json:"adminUp"`
	OperUp    bool   `json:"operUp"`
	SpeedMbps int64  `json:"speedMbps,omitempty"`
	// Errors is the port's total input, FCS and output errors (a counter, for "errors started").
	Errors float64 `json:"errors,omitempty"`
}

// Optic is an SFP's DOM values against its own thresholds.
type Optic struct {
	Port    string   `json:"port"`
	RxDBm   *float64 `json:"rxDbm,omitempty"`
	TxDBm   *float64 `json:"txDbm,omitempty"`
	RxLow   *float64 `json:"rxLow,omitempty"`
	RxHigh  *float64 `json:"rxHigh,omitempty"`
	TxLow   *float64 `json:"txLow,omitempty"`
	TxHigh  *float64 `json:"txHigh,omitempty"`
	Celsius *float64 `json:"celsius,omitempty"`
}

// StackMember is one switch of a stack (a stackable Catalyst).
type StackMember struct {
	Number int    `json:"number"`
	Role   string `json:"role"`  // active, standby, member
	State  string `json:"state"` // ready, removed, ...
	Model  string `json:"model,omitempty"`
	Serial string `json:"serial,omitempty"`
}

// Inventory is what changes slowly, every 5 minutes.
type Inventory struct {
	Interfaces []Interface `json:"interfaces"`
	Neighbours []Neighbour `json:"neighbours"`
	MACs       []MACEntry  `json:"macs"`
	ARP        []ARPEntry  `json:"arp"`
	// Routes is RouterOS's route count; Gateway its default gateway.
	Routes  *int   `json:"routes,omitempty"`
	Gateway string `json:"gateway,omitempty"`
}

// Interface is one port.
type Interface struct {
	Index     int      `json:"index"`
	Name      string   `json:"name"`
	Descr     string   `json:"descr,omitempty"`
	Alias     string   `json:"alias,omitempty"`
	Kind      string   `json:"kind"` // ethernet, sfp, lag, vlan, virtual, other
	MAC       string   `json:"mac,omitempty"`
	SpeedMbps int64    `json:"speedMbps,omitempty"`
	AdminUp   bool     `json:"adminUp"`
	OperUp    bool     `json:"operUp"`
	VLANs     []int    `json:"vlans,omitempty"`
	PoEWatts  *float64 `json:"poeWatts,omitempty"`
}

// Neighbour is a device seen on a port through CDP, LLDP or MNDP.
type Neighbour struct {
	LocalPort  string `json:"localPort"`
	Protocol   string `json:"protocol"` // cdp, lldp, mndp
	RemoteName string `json:"remoteName,omitempty"`
	RemotePort string `json:"remotePort,omitempty"`
	RemoteAddr string `json:"remoteAddr,omitempty"`
	RemoteMAC  string `json:"remoteMac,omitempty"`
	Platform   string `json:"platform,omitempty"`
}

// MACEntry is a MAC address learnt behind a port.
type MACEntry struct {
	Port string `json:"port"`
	MAC  string `json:"mac"`
	VLAN int    `json:"vlan,omitempty"`
}

// ARPEntry ties a MAC address to an IP address.
type ARPEntry struct {
	MAC string `json:"mac"`
	IP  string `json:"ip"`
}

// DiscoveryReport is what one discovery found so far.
type DiscoveryReport struct {
	ID    string  `json:"id"`
	Done  bool    `json:"done"`
	Found []Found `json:"found"`
}

// Found is one address that answered (or a neighbour proposed).
type Found struct {
	Address    string `json:"address"`
	Name       string `json:"name,omitempty"`
	Model      string `json:"model,omitempty"`
	Vendor     string `json:"vendor,omitempty"`
	Profile    string `json:"profile,omitempty"`
	Credential string `json:"credential,omitempty"`
	Protocol   string `json:"protocol,omitempty"`
	// Answered: the credential worked; ViaNeighbour names who reported it.
	Answered     bool   `json:"answered"`
	Error        string `json:"error,omitempty"`
	ViaNeighbour string `json:"viaNeighbour,omitempty"`
	// Tried are the candidates "Find what works" tried, in order (1.0.4).
	Tried []string `json:"tried,omitempty"`
}

// Wireless is what a CAPsMAN controller (a RouterOS router) says about its access points and
// their clients (0.17, ADR-234), read every round. Clients are rows, never series labels.
type Wireless struct {
	// Generations read: "wifi" (/interface/wifi/capsman) and/or "legacy" (/caps-man).
	Generations []string     `json:"generations"`
	APs         []AP         `json:"aps"`
	Clients     []WifiClient `json:"clients"`
	// Mesh is the wireless backhaul between APs (wifi mesh or WDS).
	Mesh []MeshLink `json:"mesh,omitempty"`
}

// AP is one access point CAPsMAN manages.
type AP struct {
	// Name is the CAP's identity; MAC its base MAC (to find its switch port).
	Name       string  `json:"name"`
	MAC        string  `json:"mac,omitempty"`
	Address    string  `json:"address,omitempty"`
	Model      string  `json:"model,omitempty"`
	Serial     string  `json:"serial,omitempty"`
	Version    string  `json:"version,omitempty"`
	State      string  `json:"state"` // running, disconnected, provisioning-failed
	UptimeS    int64   `json:"uptimeS,omitempty"`
	Generation string  `json:"generation"`
	Radios     []Radio `json:"radios"`
}

// Radio is one of an AP's interfaces.
type Radio struct {
	Interface  string   `json:"interface"`
	SSID       string   `json:"ssid,omitempty"`
	Band       string   `json:"band,omitempty"` // 2ghz-ax, 5ghz-ac, ...
	Channel    int      `json:"channel,omitempty"`
	FrequencyM int      `json:"frequencyMhz,omitempty"`
	TxPowerDBm *float64 `json:"txPowerDbm,omitempty"`
	NoiseDBm   *float64 `json:"noiseDbm,omitempty"`
	Clients    int      `json:"clients"`
	Running    bool     `json:"running"`
}

// WifiClient is one station in a registration table.
type WifiClient struct {
	MAC       string   `json:"mac"`
	AP        string   `json:"ap"`
	Interface string   `json:"interface,omitempty"`
	SSID      string   `json:"ssid,omitempty"`
	Band      string   `json:"band,omitempty"`
	SignalDBm *float64 `json:"signalDbm,omitempty"`
	TxRate    string   `json:"txRate,omitempty"`
	RxRate    string   `json:"rxRate,omitempty"`
	UptimeS   int64    `json:"uptimeS,omitempty"`
	BytesTx   float64  `json:"bytesTx,omitempty"`
	BytesRx   float64  `json:"bytesRx,omitempty"`
}

// MeshLink is a wireless backhaul between two APs.
type MeshLink struct {
	From      string   `json:"from"`
	To        string   `json:"to"`
	SignalDBm *float64 `json:"signalDbm,omitempty"`
	Rate      string   `json:"rate,omitempty"`
}

// NAS is a storage device's disks, volumes, LUNs and iSCSI targets (QNAP's NAS-MIB, 0.17).
type NAS struct {
	Disks   []Disk        `json:"disks"`
	Volumes []Volume      `json:"volumes"`
	Pools   []Volume      `json:"pools,omitempty"`
	LUNs    []LUN         `json:"luns"`
	Targets []ISCSITarget `json:"targets,omitempty"`
}

// Disk is one physical disk.
type Disk struct {
	Index    int      `json:"index"`
	Name     string   `json:"name,omitempty"`
	Model    string   `json:"model,omitempty"`
	Capacity float64  `json:"capacity,omitempty"`
	Celsius  *float64 `json:"celsius,omitempty"`
	// SMART: good, warning, abnormal, error, unknown. Status: ready, no-disk, rw-error, ...
	SMART  string `json:"smart"`
	Status string `json:"status"`
}

// Volume is a volume (or a storage pool) with its use and state.
type Volume struct {
	Name   string  `json:"name"`
	Total  float64 `json:"total"`
	Free   float64 `json:"free"`
	Status string  `json:"status"` // ready, degraded, rebuilding, ... (as the NAS says)
	RAID   string  `json:"raid,omitempty"`
}

// LUN is an iSCSI LUN.
type LUN struct {
	Name        string   `json:"name"`
	Capacity    float64  `json:"capacity"`
	UsedPercent *float64 `json:"usedPercent,omitempty"`
	Status      string   `json:"status,omitempty"`
	Mapped      bool     `json:"mapped"`
}

// ISCSITarget is a target and whether an initiator is connected.
type ISCSITarget struct {
	Name      string `json:"name"`
	IQN       string `json:"iqn,omitempty"`
	Connected bool   `json:"connected"`
	Status    string `json:"status,omitempty"`
}

// Recorder is an NVR's own view (Dahua's HTTP API, 0.17): its disks, cameras and events.
type Recorder struct {
	Disks   []RecorderDisk `json:"disks"`
	Cameras []Camera       `json:"cameras"`
	// Events are the attach stream's events since the last round, and Active what is still on
	// (Start without Stop): StorageFailure, StorageNotExist, StorageLowSpace, RecordFailure,
	// NetAbort, VideoLoss (per channel).
	Events []RecorderEvent `json:"events,omitempty"`
	Active []RecorderEvent `json:"active,omitempty"`
	// Stream says whether the event stream is connected now.
	Stream bool `json:"stream"`
}

// RecorderDisk is one of the recorder's disks, local or iSCSI.
type RecorderDisk struct {
	Name    string  `json:"name"`
	ISCSI   bool    `json:"iscsi"`
	State   string  `json:"state"` // the recorder's word ("Success" is healthy)
	Healthy bool    `json:"healthy"`
	Total   float64 `json:"total"`
	Used    float64 `json:"used"`
}

// Camera is one channel.
type Camera struct {
	Channel int    `json:"channel"`
	Name    string `json:"name,omitempty"`
	Online  bool   `json:"online"`
}

// RecorderEvent is one event from the stream.
type RecorderEvent struct {
	Code   string `json:"code"`
	Action string `json:"action"` // Start, Stop, Pulse
	Index  int    `json:"index"`
	At     int64  `json:"at"`
}

// UPS is a UPS's state (RFC 1628 UPS-MIB or APC PowerNet-MIB, 0.17).
type UPS struct {
	// Status: online, on-battery, bypass, off, unknown.
	Status         string   `json:"status"`
	ChargePercent  *float64 `json:"chargePercent,omitempty"`
	RuntimeS       *float64 `json:"runtimeS,omitempty"`
	LoadPercent    *float64 `json:"loadPercent,omitempty"`
	InputVolts     *float64 `json:"inputVolts,omitempty"`
	OutputVolts    *float64 `json:"outputVolts,omitempty"`
	Celsius        *float64 `json:"celsius,omitempty"`
	ReplaceBattery bool     `json:"replaceBattery"`
}
