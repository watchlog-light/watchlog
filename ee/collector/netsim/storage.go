// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise

package netsim

import (
	"strconv"
	"time"

	"github.com/gosnmp/gosnmp"
)

// A simulated QNAP (0.17): NAS-MIB's storage-manager and "EX" tables as QNAP publishes them,
// four disks, one RAID 5 pool with a volume, two LUNs for the recorders and their targets.
// Values are invented; the layout follows the MIB, not a recorded walk (ADR-234).
const (
	qnapEX   = "1.3.6.1.4.1.24681.1.3"
	qnapDisk = "1.3.6.1.4.1.24681.1.4.1.1.1.1.5.2.1"
	qnapVol  = "1.3.6.1.4.1.24681.1.4.1.1.1.2.3.2.1"
	qnapPool = "1.3.6.1.4.1.24681.1.4.1.1.1.2.2.2.1"
	qnapRAID = "1.3.6.1.4.1.24681.1.4.1.1.1.2.1.2.1"
	qnapLUN  = "1.3.6.1.4.1.24681.1.4.1.1.2.1.10.2.1"
	qnapTgt  = "1.3.6.1.4.1.24681.1.4.1.1.2.1.11.2.1"
	qnapFan  = "1.3.6.1.4.1.24681.1.4.1.1.1.1.2.2.1"
	qnapPSU  = "1.3.6.1.4.1.24681.1.4.1.1.1.1.3.2.1"
)

// QNAP builds the simulated NAS.
func QNAP(name string, start time.Time) *Agent {
	a := NewAgent(name, start)
	s := Spec{Name: name}
	system(a, s, "1.3.6.1.4.1.8072.3.2.10", "Linux "+name+" 5.10.60-qnap #1 SMP x86_64")
	for p := 1; p <= 2; p++ {
		port(a, s, p+1, "eth"+strconv.Itoa(p-1), "eth"+strconv.Itoa(p-1), 6, 2500, true, 30_000_000)
	}
	a.Int(hrProc+".196608", 9)
	a.Str(qnapEX+".12.0", "TS-433")
	a.Int(qnapEX+".5.0", 48)
	a.Int(qnapEX+".6.0", 36)
	const tb = 1 << 40
	for d := 1; d <= 4; d++ {
		i := strconv.Itoa(d)
		a.Int(qnapDisk+".1."+i, d)
		a.Int(qnapDisk+".5."+i, 0) // good
		a.Int(qnapDisk+".6."+i, 33+d)
		a.Str(qnapDisk+".8."+i, "WDC WD80EFPX-68C4ZN0")
		a.Set(qnapDisk+".9."+i, Value{Type: gosnmp.Counter64, Base: 8 * tb})
	}
	a.Set(qnapRAID+".3.1", Value{Type: gosnmp.Counter64, Base: 21.8 * tb})
	a.Set(qnapRAID+".4.1", Value{Type: gosnmp.Counter64, Base: 3.1 * tb})
	a.Str(qnapRAID+".5.1", "Ready")
	a.Str(qnapRAID+".7.1", "RAID 5")
	a.Set(qnapPool+".3.1", Value{Type: gosnmp.Counter64, Base: 21.8 * tb})
	a.Set(qnapPool+".4.1", Value{Type: gosnmp.Counter64, Base: 3.1 * tb})
	a.Int(qnapPool+".5.1", 0)
	a.Set(qnapVol+".3.1", Value{Type: gosnmp.Counter64, Base: 2 * tb})
	a.Set(qnapVol+".4.1", Value{Type: gosnmp.Counter64, Base: 1.4 * tb})
	a.Str(qnapVol+".5.1", "Ready")
	a.Str(qnapVol+".8.1", "DataVol1")
	for l, n := range []string{"nvr-1-rec", "nvr-2-rec"} {
		i := strconv.Itoa(l + 1)
		a.Int(qnapLUN+".1."+i, l+1)
		a.Set(qnapLUN+".3."+i, Value{Type: gosnmp.Counter64, Base: 8 * tb})
		a.Int(qnapLUN+".4."+i, 71+l*5)
		a.Str(qnapLUN+".5."+i, "Enabled")
		a.Str(qnapLUN+".6."+i, n)
		a.Int(qnapLUN+".8."+i, 1)
		a.Str(qnapTgt+".3."+i, n+"-target")
		a.Str(qnapTgt+".4."+i, "iqn.2004-04.com.qnap:ts-433:iscsi."+n)
		a.Int(qnapTgt+".5."+i, 1) // connected
	}
	for f := 1; f <= 2; f++ {
		a.Int(qnapFan+".4."+strconv.Itoa(f), 0)
	}
	a.Int(qnapPSU+".4.1", 0)
	return a
}

// SetTarget connects or disconnects a LUN's iSCSI target (index from 1).
func (a *Agent) SetTarget(lun int, connected bool) {
	v := 0
	if connected {
		v = 1
	}
	a.Int(qnapTgt+".5."+strconv.Itoa(lun), v)
}

// SetDiskSMART sets a disk's SMART (0 good, 1 warning, 2 abnormal).
func (a *Agent) SetDiskSMART(disk, v int) { a.Int(qnapDisk+".5."+strconv.Itoa(disk), v) }

// UPS builds a simulated UPS: RFC 1628's UPS-MIB, or APC's PowerNet-MIB with apc.
func UPS(name string, start time.Time, apc bool) *Agent {
	a := NewAgent(name, start)
	s := Spec{Name: name}
	// Its network card: the office's switch sees this MAC (MACString(name, 2)) on its port.
	port(a, s, 2, "eth0", "eth0", 6, 100, true, 2_000)
	if apc {
		system(a, s, "1.3.6.1.4.1.318.1.3.27", "APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.9.6)")
		b := "1.3.6.1.4.1.318.1.1.1"
		a.Str(b+".1.1.1.0", "Smart-UPS 1500")
		a.Int(b+".4.1.1.0", 2) // onLine
		a.Gauge(b+".2.2.1.0", 100)
		a.Set(b+".2.2.3.0", Value{Type: gosnmp.TimeTicks, V: uint32(3_960_000)})
		a.Gauge(b+".4.2.3.0", 38)
		a.Gauge(b+".3.2.1.0", 229)
		a.Gauge(b+".4.2.1.0", 230)
		a.Gauge(b+".2.2.2.0", 27)
		a.Int(b+".2.2.4.0", 1)
		return a
	}
	system(a, s, "1.3.6.1.4.1.8072.3.2.10", "Linux "+name+" UPS network card")
	b := "1.3.6.1.2.1.33.1"
	a.Str(b+".1.2.0", "5PX 1500")
	a.Int(b+".4.1.0", 3) // normal
	a.Int(b+".2.4.0", 100)
	a.Int(b+".2.3.0", 52)
	a.Int(b+".4.4.1.5.1", 31)
	a.Int(b+".3.3.1.3.1", 231)
	a.Int(b+".4.4.1.2.1", 230)
	a.Int(b+".2.7.0", 26)
	return a
}

// SetOnBattery switches a UPS-MIB UPS to battery (runtime falls) or back.
func (a *Agent) SetOnBattery(on bool, minutesLeft int) {
	b := "1.3.6.1.2.1.33.1"
	if on {
		a.Int(b+".4.1.0", 5)
		a.Int(b+".2.3.0", minutesLeft)
		return
	}
	a.Int(b+".4.1.0", 3)
	a.Int(b+".2.3.0", 52)
}

// SetReplaceBattery raises UPS-MIB's upsAlarmBatteryBad.
func (a *Agent) SetReplaceBattery() {
	a.OID("1.3.6.1.2.1.33.1.6.2.1.2.1", ".1.3.6.1.2.1.33.1.6.3.1")
}
