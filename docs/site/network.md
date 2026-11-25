---
title: Network devices
description: Switches, routers, Wi-Fi, storage, video recorders and UPSes in WatchLog Pro and Enterprise: choosing the poller, the read-only setup for Cisco IOS, NX-OS, MikroTik RouterOS and CAPsMAN, QNAP, Dahua recorders and UPSes, the firewall lines, the map, how WatchLog knows a recorder is recording, the alerts, and how devices count.
---

# Network devices

WatchLog shows the network your servers and nodes sit on: every switch and router, what is
connected to what, which switch port each server or node is on, how busy each link is, and
what broke. It also reads the Wi-Fi a MikroTik router manages, a QNAP NAS and its iSCSI LUNs,
Dahua video recorders (and whether they are recording), and UPSes. A server's or node's page shows its port, for example
`sw-access-2 · Gi1/0/14 · 1 Gb/s`, and a port going down, an uplink dropping packets or a
switch rebooting shows in that place's Events, in What changed and in its probable cause.

It is part of **WatchLog Cloud Pro** and **self-hosted Enterprise** (a [licence key](license.md)
that lists `network`), and the live demo has a small simulated office network. On Cloud Free
and Community without a key, **Network** in the sidebar opens a short description instead.

WatchLog only **reads** your devices. It never changes a setting: SNMP is read with GET,
GETNEXT and GETBULK only (the client has no SET), RouterOS with print and GET, and recorders
with a fixed list of HTTP GET calls.

## Choosing the poller

Devices are read from inside your network by the **integrations collector** you already run:

- **Kubernetes:** the collector Deployment in the cluster polls them.
- **Servers:** the collector on one of the fleet's servers polls them. A server installed before
  the collector was part of the agent gets it with the install script's upgrade:
  `curl -fsSL https://<your WatchLog>/install.sh | sudo sh -s -- --upgrade`.

**Network → Add devices** starts by asking which cluster or server polls the devices. Each
device has one poller; you can move it later on the device's page. The poller needs to reach
each device on the ports below, and nothing else needs to reach the poller.

## Adding devices

1. **The poller.**
2. **Credential profiles.** One profile serves many devices:
   - **SNMP v3** (the default and the recommendation): a user with authentication and privacy
     (`authPriv`), SHA-2 (or SHA) and AES.
   - **SNMP v2c** works too, but its community string travels in clear text: use it only on a
     management network you trust.
   - **RouterOS** (MikroTik): a read-only user. WatchLog uses the REST API over HTTPS, and falls
     back to API-SSL (port 8729). The plain API (8728) is used only when you tick "allow
     unencrypted on this network".

   Secrets are stored encrypted (AES-256-GCM with the installation's secret key), can't be read
   back, and are sent only to the poller of the devices that use them.

3. **Addresses:** one per line, and optionally a range of a /24 or smaller, swept with SNMP
   GETs at no more than 20 addresses a second. **Find neighbours** reads CDP, LLDP and MNDP
   from the devices that answer and proposes what they see; nothing is added on its own.
4. **What was found:** each address with the profile it matched and whether it answered.
5. **Add N devices.**

## Setup on the devices

Add devices shows these commands with your poller's address filled in. Type the same keys,
community or password you gave the profile. Replace `10.0.0.50` with your poller's address.

### Cisco IOS and IOS XE (Catalyst)

```
ip access-list standard WATCHLOG-SNMP
 permit host 10.0.0.50
 deny any log
snmp-server view WATCHLOG-RO iso included
snmp-server group watchlog-ro v3 priv read WATCHLOG-RO access WATCHLOG-SNMP
! The MAC table per VLAN (contexts vlan-<id>).
snmp-server group watchlog-ro v3 priv context vlan- match prefix read WATCHLOG-RO access WATCHLOG-SNMP
snmp-server user watchlog watchlog-ro v3 auth sha <auth-key> priv aes 128 <privacy-key> access WATCHLOG-SNMP
```

On IOS XE 17 and later you can use `auth sha-2 256` instead of `auth sha`; IOS 15 (the
Catalyst 2960 family) has SHA only. Catalyst switches keep their MAC table per VLAN: WatchLog
reads each VLAN through its context (`vlan-<id>` with v3, `community@<id>` with v2c), which is
what the `context` line allows.

### Cisco NX-OS (Nexus)

```
ip access-list WATCHLOG-SNMP
  10 permit udp 10.0.0.50/32 any eq snmp
snmp-server user watchlog network-operator auth sha-256 <auth-key> priv aes-128 <privacy-key>
snmp-server user watchlog use-ipv4acl WATCHLOG-SNMP
```

`network-operator` is NX-OS's read-only role.

### MikroTik RouterOS 7

```
/user group add name=watchlog-read policy=read,api,rest-api
/user add name=watchlog group=watchlog-read address=10.0.0.50/32 password="<password>"
/certificate add name=watchlog common-name=watchlog key-usage=digital-signature,key-encipherment,tls-server days-valid=3650
/certificate sign watchlog
/ip service set www-ssl certificate=watchlog disabled=no address=10.0.0.50/32
/ip service set api-ssl certificate=watchlog disabled=no address=10.0.0.50/32
```

`/user group add` grants only the policies it lists: `read`, `api` and `rest-api`, which
MikroTik documents for a read-only REST user. WatchLog **pins the router's certificate the
first time it connects**. If the certificate changes later, the device shows the problem, an
alert fires, and the router isn't read again until an Owner accepts the new certificate on its
page.

A MikroTik device can also be read over SNMP instead, with less detail (no update channel, no
health menu).

### The firewall line

From the poller only: **UDP 161** (SNMP) to switches, NASes and UPSes; **TCP 443** (or **8729**
for API-SSL) to MikroTik routers; **TCP 80** or **443** to recorders. Wi-Fi access points need
nothing: WatchLog reads them from the router.

## What is read

| Every 60 seconds                                                                                                                            | Every 5 minutes                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each port's state, speed and counters (bytes, errors, discards), CPU, memory, temperatures, fans, power supplies, SFP optics, stack members | Ports (names, descriptions, VLANs, PoE), neighbours (CDP, LLDP, MNDP), MAC tables, ARP, routes count and default gateway, the RouterOS version and its update channel |

Requests use GETBULK, at most two at a time per device, with a 5-second timeout and two
retries. A device that doesn't answer three times in a row is tried less and less often, up
to once an hour, until it answers.

Vendor support is data: one YAML profile per family (generic SNMP, Cisco IOS, Cisco NX-OS,
MikroTik) maps the public MIBs to what WatchLog shows. Any SNMP device gets the generic
profile: interfaces, CPU and memory where HOST-RESOURCES-MIB has them, model and serial from
ENTITY-MIB, LLDP, MAC tables and ARP. The Nexus profile lacks PoE and stacks (a Nexus 3064 has
neither) and reads memory as a percentage.

Counters become series named `watchlog_net_*`, labelled by the device's id and the port's name
only: never an address. Ports get series only when they are up, have a description, or have a
learnt link or a WatchLog server or node behind them, so 50 switches of 52 ports stay well
under the collector's 20,000 series.

## The map

**Network → Map** draws the devices in bands, from the Internet at the top through the edge
router, the core and the access switches to the servers and nodes behind them. Links come from
CDP, LLDP and MNDP (both ends merged into one), or from the MAC tables for switches that speak
none of them; nothing is drawn by hand.

- A device's ring shows its state: up, warning (an alert open), down.
- A link is thicker the faster it is; moving dashes show current traffic; it turns amber when
  it carries errors or is over 80% used, and red and dashed when it is down.
- Hover a device for its model and top numbers. Click it: its path to the Internet lights up
  and its details open on the right: live numbers, its ports with problems, what's behind it,
  recent events, and links to its page and to the WatchLog server or node.
- Click a link for both ends' ports, its speed, its use each way, errors and how it was learnt.
- Layers: utilisation, and endpoints (off by default), grouped per switch until you open them.
  Zoom, fit and search are in the corner.
- Owners and Admins can drag devices; the layout is kept for the organisation.

Servers and nodes are recognised by the MAC addresses their agents report: a Kubernetes node or
a server whose network card is seen behind a switch port is drawn as that node or server.

## The device page

The front panel shows each port by state (odd ports on top, the SFP cages on the side, PoE
marked); a stack shows one panel per member. Click a port for its traffic both ways against its
speed, its errors and discards, its neighbour or the devices behind it, its VLANs and its PoE
draw. Below: CPU, memory and temperature, fans and power supplies, the SFP optics against their
own thresholds, events, and for MikroTik the RouterOS version and whether its channel has an
update.

A device's page shows only what that device reports. An access point read through CAPsMAN has no
CPU, memory or ports of its own to read: its page shows its clients, its radios (band and channel)
and its weak clients, with its clients over time, and links to the Wireless page. A UPS shows its
charge, runtime and load; a recorder whether it is recording, its cameras and the days of
recording left. The status beside the name is the device's own (up, down); open alerts show as a
separate count.

## Wi-Fi (MikroTik CAPsMAN)

When a MikroTik router runs CAPsMAN, WatchLog reads its access points and their clients over the
connection it already has to the router, with the **same read-only user**: nothing to set up on
the access points. Both generations are read: the `wifi` package's CAPsMAN
(`/interface/wifi/capsman`) and the legacy `/caps-man`; if a router runs both, both are read.

- **Each access point:** its identity, model, address, RouterOS version, state (running,
  disconnected, provisioning failed), uptime, its radios (band, channel, frequency, tx power, noise
  where reported, clients on each), and the switch port it hangs off, from the switches' MAC
  tables, so the map draws it under its switch.
- **Each client:** MAC and vendor, access point, SSID and band, signal, tx and rx rate, how long
  it has been connected, and bytes. Clients are refreshed every minute; they are never series
  labels. The number of clients per access point and SSID is.
- **Mesh and WDS:** an access point connected to another over the air is drawn with a dotted
  link, with its signal and rate.
- **Access points are free**: they don't count as units.

**Network → Wireless** shows the access points up, the clients now, the weak ones (below
−75 dBm) and the busiest access point; each access point with its clients over the day; the
traffic through the access points' switch ports with its usual band; and the clients, which you
can filter, search by MAC or vendor, and sort by signal. The tab shows once the network has an
access point.

## Storage: a QNAP NAS

A QNAP is read over **SNMPv3**, like a switch: model, system and CPU temperature, fans and power
supplies, each disk's model, temperature and SMART status, volumes and storage pools with their
use and RAID state, LUNs with their use, and the iSCSI targets.

In QTS: **Control Panel → Network & File Services → SNMP**: enable SNMP, choose **SNMPv3**, give
it a user with authentication (SHA) and privacy (AES), and use the same in a WatchLog SNMPv3
profile. QTS's SNMP is read-only; this user can't change anything. Add the NAS by address with
that profile; it is recognised as a QNAP.

QTS doesn't give a read-only account its iSCSI sessions (only administrators can open Storage &
Snapshots), so WatchLog doesn't ask for one. It works out which recorder uses which LUN from the
recorders' own view of their iSCSI disks and from the switch ports between them, and says so on
the page: **seen from the recorder and the network, not from the NAS**. A LUN or iSCSI target
named after its recorder (`nvr-1-rec`) is matched to it.

**Network → Storage** shows one card per NAS (disks, volumes, LUNs) and the iSCSI sessions:
which recorder is connected to which LUN, since when, its throughput, and the switch path
between them, which the map's **iSCSI paths** layer draws.

## Recorders (Dahua)

WatchLog reads Dahua recorders over their **HTTP API**, with HTTP digest authentication and only
these GET calls: the device (`magicBox.cgi`: model, serial, firmware, name), its storage
(`storageDevice.cgi?action=getDeviceAllInfo`: every disk, local and iSCSI, its state, size and
use), its cameras (`LogicDeviceManager.cgi?action=getCameraState` and the channel names), its
network card's MAC (to find its switch port), and its **event stream**
(`eventManager.cgi?action=attach`) for storage failures, storage full, record failures, video
loss and network disconnects. The stream stays open and reconnects on its own, waiting longer
each time it fails.

1. On the recorder, create a **dedicated user** in a group with view rights only: no settings, no
   playback control, no PTZ. Dahua locks a user out after a few wrong passwords; WatchLog waits
   10 minutes before trying again when the password is refused.
2. In WatchLog, add a **Recorder (Dahua HTTP API)** profile with that user and password. Choose
   HTTPS if the recorder serves it: WatchLog pins its certificate on first contact, as for
   RouterOS.
3. Add the recorder by address with that profile (recorders aren't found by discovery).

The firewall line: TCP 80 (HTTP) or 443 (HTTPS) from the poller to the recorder.

**Network → Storage** shows a Recording card per recorder: recording or not, its three signals,
the cameras online of total, its disk (which LUN on which NAS, the free space, the days of
recording left at the current rate), and today's write rate against its usual one; then its
cameras with their channel, name, state and since when. **Network → Overview** has a Recording
card with one line per recorder.

## UPSes

UPSes are read over SNMP (v3 or v2c, read-only) on their network card: the standard UPS-MIB
(RFC 1628) for most makes, and APC's PowerNet-MIB for APC. WatchLog shows the status (online, on
battery, bypass), the battery's charge and runtime, the load, input and output voltage, the
temperature and whether the battery needs replacing, on a UPS card on **Storage** and with its
own icon on the map.

On the UPS card, Owners and Admins can say which WatchLog servers or nodes it **feeds**. When it
goes on battery (and back), that shows in those servers' and nodes' Events.

## How WatchLog knows a recorder is recording

A recorder can look fine (it answers, its cameras are online) and still not be writing anything.
WatchLog checks three things, every minute, and shows each on the recorder's card:

1. **The recorder's own word:** it reports at least one healthy disk, and no storage failure,
   missing disk or record failure is open on its event stream.
2. **Its iSCSI disk:** every iSCSI disk it has had is still there and healthy. (A recorder that
   records to its own disks has no iSCSI signal.)
3. **Its writes:** the traffic from the recorder's switch port (or to the NAS's) stays inside its
   usual range for this hour of the week, the same baseline What changed uses. It fails only when
   it falls under that range and under half the usual: a quiet hour isn't a stop. For its first
   week it is learning and doesn't count.

If any one of them fails for **5 minutes**, the recorder is **not recording**, and the card, the
Overview and the alert name which. A camera going offline doesn't make a recorder "not
recording": that is its own alert, one per recorder for all its cameras.

## Alerts

These rules are added to **Alerts → Rules** with your first device, enabled. Each can be edited
(thresholds, for how long) and silenced like any other, and while a device is unreachable its
other alerts wait under that one. A NAS or a recorder that stops answering is "Network device
unreachable".

| Alert                                    | When                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network device unreachable               | 3 polls in a row fail (or the credentials are refused)                                                                                                                       |
| Network device rebooted                  | its uptime started over (for its first 10 minutes)                                                                                                                           |
| Uplink down                              | a port with a learnt link to another network device, or with a WatchLog server or node behind it, goes down. Ports with only unknown devices behind them (desks) don't alert |
| Port errors                              | errors and discards above 1 a minute, for 10 minutes                                                                                                                         |
| Port speed dropped                       | a linked port runs below the speed it usually has (1 Gb/s → 100 Mb/s), for 5 minutes                                                                                         |
| Link busy                                | a linked port over 90% either way, for 10 minutes                                                                                                                            |
| Network device CPU high                  | over 90% for 10 minutes                                                                                                                                                      |
| Network device memory high               | over 90% for 10 minutes                                                                                                                                                      |
| Network device too hot                   | a sensor over its own threshold, or over 70 °C (critical at 80 °C), for 10 minutes                                                                                           |
| Fan or power supply failed               | from the environment MIBs or RouterOS health                                                                                                                                 |
| SFP optics out of range                  | rx or tx power outside the module's own thresholds, for 5 minutes                                                                                                            |
| Stack member lost                        | a member of a stack isn't ready, or the stack has fewer members than it had                                                                                                  |
| Certificate changed on a RouterOS device | the pinned certificate no longer matches (a recorder's over HTTPS too)                                                                                                       |
| Access point disconnected                | CAPsMAN no longer runs it, for 2 minutes                                                                                                                                     |
| Access point has no clients              | none, at a time of the week when it usually has at least 3, for 15 minutes                                                                                                   |
| Many weak Wi-Fi clients                  | at least 5 clients below −75 dBm and at least 40% of an access point's clients, for 10 minutes                                                                               |
| Wi-Fi channels overlap (2.4 GHz)         | two access points of one controller on 2.4 GHz channels 1 to 4 apart (use 1, 6 and 11), for 10 minutes                                                                       |
| NAS disk SMART not good                  | a disk reports SMART warning (warning) or abnormal (critical)                                                                                                                |
| NAS disk hot                             | over 55 °C (critical at 60 °C), for 10 minutes                                                                                                                               |
| NAS RAID degraded or rebuilding          | a volume or storage pool degraded (critical) or rebuilding (warning)                                                                                                         |
| NAS volume or LUN over 90%               | critical at 95%, for 10 minutes                                                                                                                                              |
| iSCSI session lost                       | a recorder's iSCSI disk is gone, or the NAS's target lost its session, for 2 minutes                                                                                         |
| Recorder not recording                   | one of the three signals failed for 5 minutes (above)                                                                                                                        |
| Recorder lost its iSCSI disk             | for 1 minute                                                                                                                                                                 |
| Recorder storage full soon               | under 3 days left at the current write rate (critical under 1 day), for 10 minutes                                                                                           |
| Camera offline                           | for 5 minutes; one alert per recorder listing its cameras                                                                                                                    |
| UPS on battery                           | at once                                                                                                                                                                      |
| UPS runtime low                          | under 10 minutes of battery                                                                                                                                                  |
| UPS battery needs replacing              | the UPS says so                                                                                                                                                              |
| UPS overload                             | load over 90% (critical at 100%), for 2 minutes                                                                                                                              |

## How devices count

A network device is **one unit**, like a node or a server. **Wi-Fi access points managed by a
controller are free.**

- **WatchLog Cloud Pro:** devices are in the same 95th-percentile count as nodes and servers,
  at the same price per unit. Cloud Free has no network devices.
- **Enterprise:** the licence's units include devices. Over the limit for 30 days in a row, no
  new devices can be added; those already added keep working ([licence](license.md)).
