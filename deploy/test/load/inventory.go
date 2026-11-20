// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// A 0.10 server's certificates and scheduled jobs (ADR-222 to ADR-224), for run -servers: the
// series the rules read (three a job, one or two a certificate) and the inventory snapshot,
// shaped as the agent sends them. A measured server has 8–17 stock timers and 3–6 cron lines
// and a few certificates (ADR-224's amendment): here 18 timers, 6 cron lines (one every
// minute) and 3 certificates. Runs follow each job's period from the clock, so new runs appear
// as time passes and the backend writes them as it would.

type loadJob struct {
	id, kind, name, unit, schedule, source string
	every                                  int64 // seconds
	took                                   int64
}

var loadJobs = func() []loadJob {
	var out []loadJob
	timers := []string{"apt-daily", "apt-daily-upgrade", "logrotate", "man-db", "fstrim", "e2scrub_all",
		"systemd-tmpfiles-clean", "motd-news", "dpkg-db-backup", "sysstat-collect", "sysstat-summary",
		"certbot", "backup", "update-notifier-download", "phpsessionclean", "fwupd-refresh", "plocate-updatedb", "snapd.snap-repair"}
	for i, t := range timers {
		every := int64(86_400)
		if i%3 == 0 {
			every = 3600
		}
		out = append(out, loadJob{id: fmt.Sprintf("%016x", 0x1000+i), kind: "timer", name: t + ".timer",
			unit: t + ".service", schedule: "*-*-* 03:00:00", every: every, took: int64(5 + i*3)})
	}
	cron := []struct {
		name  string
		every int64
	}{{"artisan schedule:run", 60}, {"cron.hourly", 3600}, {"cron.daily", 86_400}, {"pg_dump", 86_400},
		{"export.php", 3600}, {"cleanup.sh", 86_400}}
	for i, c := range cron {
		out = append(out, loadJob{id: fmt.Sprintf("%016x", 0x2000+i), kind: "cron", name: c.name,
			source: "/etc/crontab", schedule: "17 * * * *", every: c.every, took: int64(1 + i*20)})
	}
	return out
}()

// withInventory adds the 0.10 series to a server's template: per job its failed streak,
// missed runs and slow flag; per certificate its expiry.
func withInventory(set []series) []series {
	out := append([]series(nil), set...)
	for _, j := range loadJobs {
		l := []Label{{"job", j.name}, {"job_id", j.id}, {"kind", j.kind}}
		for _, n := range []string{"watchlog_job_failed_streak", "watchlog_job_missed_runs", "watchlog_job_slow"} {
			out = append(out, series{name: n, labels: l, value: 0})
		}
	}
	for i := 0; i < 3; i++ {
		out = append(out, series{name: "watchlog_cert_expires_at_seconds",
			labels: []Label{{"cert", fmt.Sprintf("site-%d.example.test", i)}, {"cert_id", fmt.Sprintf("%016x", 0x3000+i)}},
			value:  float64(time.Now().Add(time.Duration(30+i*20) * 24 * time.Hour).Unix())})
	}
	return out
}

// serverInventory is the server's snapshot now: its certificates, and each job with its last
// runs (14 for the job every minute, 5 for the others).
func serverInventory(a *agent) []byte {
	now := time.Now().Unix()
	var certs []map[string]any
	for i := 0; i < 3; i++ {
		fp := fmt.Sprintf("%064x", 0x3000+i)
		notAfter := now + int64(30+i*20)*86_400
		certs = append(certs, map[string]any{
			"id": fmt.Sprintf("%016x", 0x3000+i), "names": []string{fmt.Sprintf("site-%d.example.test", i)},
			"subject": "site", "issuer": "R11", "issuerOrg": "Let's Encrypt", "serial": "1f",
			"notBefore": notAfter - 90*86_400, "notAfter": notAfter, "fingerprint": fp, "keyType": "ECDSA",
			"keyBits": 256, "chain": "complete",
			"endpoints": []map[string]any{{"kind": "Service", "workload": "nginx.service", "port": 443, "proto": "tls",
				"fingerprint": fp, "notAfter": notAfter}},
		})
	}
	var jobs []map[string]any
	for _, j := range loadJobs {
		keep := int64(5)
		if j.every <= 300 {
			keep = 14
		}
		last := now / j.every * j.every
		var runs []map[string]any
		for k := keep - 1; k >= 0; k-- {
			s := last - k*j.every
			if s+j.took > now {
				runs = append(runs, map[string]any{"start": s, "result": "running"})
				continue
			}
			runs = append(runs, map[string]any{"start": s, "end": s + j.took, "code": 0, "result": "success"})
		}
		jobs = append(jobs, map[string]any{
			"id": j.id, "kind": j.kind, "name": j.name, "unit": j.unit, "schedule": j.schedule, "source": j.source,
			"enabled": true, "next": last + j.every, "every": j.every, "runs": runs, "state": "working",
			"failedStreak": 0, "lastGood": last, "missedRuns": 0, "usualSeconds": j.took, "frequent": j.every <= 300,
		})
	}
	b, _ := json.Marshal(map[string]any{"source": "inventory", "node": a.id, "certificates": certs,
		"certificateCoverage": map[string]any{"ports": 6, "tlsPorts": 1, "at": now}, "jobs": jobs})
	return b
}
