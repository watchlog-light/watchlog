---
title: Network devices
description: Switches, routers and the map in WatchLog Pro and Enterprise: choosing the poller, the read-only setup for Cisco IOS, NX-OS and MikroTik RouterOS, the firewall line, the map, the alerts, what is read and never written, and how devices count.
---

# Network devices

WatchLog shows the network your servers and nodes sit on: every switch and router, what is
connected to what, which switch port each server or node is on, how busy each link is, and
what broke. A server's or node's page shows its port, for example
`sw-access-2 · Gi1/0/14 · 1 Gb/s`, and a port going down, an uplink dropping packets or a
switch rebooting shows in that place's Events, in What changed and in its probable cause.

It is part of **WatchLog Cloud Pro** and **self-hosted Enterprise** (a [licence key](license.md)
that lists `network`), and the live demo has a small simulated office network. On Cloud Free
and Community without a key, **Network** in the sidebar opens a short description instead.

WatchLog only **reads** your devices. It never changes a setting: SNMP is read with GET,
GETNEXT and GETBULK only (the client has no SET), and RouterOS with print and GET.

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

From the poller only: **UDP 161** (SNMP) to switches, and **TCP 443** (or **8729** for
API-SSL) to MikroTik routers.

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

## Alerts

These rules are added to **Alerts → Rules** with your first device, enabled. Each can be edited
(thresholds, for how long) and silenced like any other, and while a device is unreachable its
other alerts wait under that one.

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
| Certificate changed on a RouterOS device | the pinned certificate no longer matches                                                                                                                                     |

## How devices count

A network device is **one unit**, like a node or a server. **Wi-Fi access points managed by a
controller are free.**

- **WatchLog Cloud Pro:** devices are in the same 95th-percentile count as nodes and servers,
  at the same price per unit. Cloud Free has no network devices.
- **Enterprise:** the licence's units include devices. Over the limit for 30 days in a row, no
  new devices can be added; those already added keep working ([licence](license.md)).
