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

// StackMember is one switch of a stack (Catalyst 3850).
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
}
