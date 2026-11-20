// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/jobs"
)

// CronJobs are the cluster's CronJobs as scheduled jobs (ADR-223), named namespace/name: each
// Job one created is a run (its creation the start, Complete or Failed the end), and a failed
// Job's pod gives the exit code. Times are the CronJob's time zone (spec.timeZone), else the
// controller's, UTC.
func (c *Cluster) CronJobs(now time.Time) []jobs.Observation {
	cronStore, jobStore := c.Store("CronJob"), c.Store("Job")
	if cronStore == nil || jobStore == nil {
		return nil
	}
	byCron := map[string][]*batchv1.Job{}
	failed := false
	for _, obj := range jobStore.List() {
		j, ok := obj.(*batchv1.Job)
		if !ok {
			continue
		}
		if ref := metav1.GetControllerOfNoCopy(j); ref != nil && ref.Kind == "CronJob" {
			k := j.Namespace + "/" + ref.Name
			byCron[k] = append(byCron[k], j)
			failed = failed || jobCondition(j, batchv1.JobFailed) != nil
		}
	}
	var codes map[string]int
	if failed {
		codes = c.failedPodCodes()
	}
	var out []jobs.Observation
	for _, obj := range cronStore.List() {
		cj, ok := obj.(*batchv1.CronJob)
		if !ok {
			continue
		}
		name := cj.Namespace + "/" + cj.Name
		spec, loc := cronSchedule(cj)
		o := jobs.Observation{Kind: "cronjob", Name: name, Schedule: cj.Spec.Schedule, Source: "CronJob",
			Enabled: cj.Spec.Suspend == nil || !*cj.Spec.Suspend}
		if sched, err := jobs.ParseSchedule(spec); err == nil {
			o.Every = int64(sched.Every(now, loc).Seconds())
			if o.Enabled {
				if n := sched.Next(now, loc); !n.IsZero() {
					o.Next = n.Unix()
				}
			}
		}
		for _, j := range byCron[name] {
			o.Runs = append(o.Runs, jobRun(j, codes))
		}
		out = append(out, o)
	}
	return out
}

// cronSchedule is the schedule's five fields and its zone: spec.timeZone, or a CRON_TZ= or TZ=
// prefix (which Kubernetes still accepts).
func cronSchedule(cj *batchv1.CronJob) (string, *time.Location) {
	spec := strings.TrimSpace(cj.Spec.Schedule)
	zone := ""
	if cj.Spec.TimeZone != nil {
		zone = *cj.Spec.TimeZone
	}
	for _, p := range []string{"CRON_TZ=", "TZ="} {
		if strings.HasPrefix(spec, p) {
			z, rest, _ := strings.Cut(strings.TrimPrefix(spec, p), " ")
			zone, spec = z, strings.TrimSpace(rest)
		}
	}
	loc := time.UTC
	if zone != "" {
		if l, err := time.LoadLocation(zone); err == nil {
			loc = l
		}
	}
	return spec, loc
}

func jobCondition(j *batchv1.Job, t batchv1.JobConditionType) *batchv1.JobCondition {
	for i := range j.Status.Conditions {
		if c := &j.Status.Conditions[i]; c.Type == t && c.Status == corev1.ConditionTrue {
			return c
		}
	}
	return nil
}

func jobRun(j *batchv1.Job, codes map[string]int) jobs.Run {
	r := jobs.Run{Start: j.CreationTimestamp.Unix(), Result: "running"}
	switch {
	case jobCondition(j, batchv1.JobComplete) != nil:
		r.Result = "success"
		zero := 0
		r.Code = &zero
		if j.Status.CompletionTime != nil {
			r.End = j.Status.CompletionTime.Unix()
		} else {
			r.End = jobCondition(j, batchv1.JobComplete).LastTransitionTime.Unix()
		}
	case jobCondition(j, batchv1.JobFailed) != nil:
		r.Result = "failed"
		r.End = jobCondition(j, batchv1.JobFailed).LastTransitionTime.Unix()
		if code, ok := codes[j.Namespace+"/"+j.Name]; ok {
			r.Code = &code
		}
	}
	if r.End != 0 && r.End < r.Start {
		r.End = r.Start
	}
	return r
}

// failedPodCodes is each Job's last failed pod's exit code (namespace/job → code).
func (c *Cluster) failedPodCodes() map[string]int {
	out := map[string]int{}
	when := map[string]time.Time{}
	store := c.Store("Pod")
	if store == nil {
		return out
	}
	for _, obj := range store.List() {
		p, ok := obj.(*corev1.Pod)
		if !ok {
			continue
		}
		ref := metav1.GetControllerOfNoCopy(p)
		if ref == nil || ref.Kind != "Job" {
			continue
		}
		for _, s := range p.Status.ContainerStatuses {
			t := s.State.Terminated
			if t == nil || t.ExitCode == 0 {
				continue
			}
			k := p.Namespace + "/" + ref.Name
			if prev, ok := when[k]; !ok || t.FinishedAt.After(prev) {
				out[k], when[k] = int(t.ExitCode), t.FinishedAt.Time
			}
		}
	}
	return out
}
