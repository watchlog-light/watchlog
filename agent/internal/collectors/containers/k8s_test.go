// SPDX-License-Identifier: AGPL-3.0-only

package containers

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Fixtures: testdata/k8s/<layout>/<node>/ holds the node's kubepods cgroup tree and
// /proc/<pid>/comm of each container cgroup, captured with deploy/test/k8s/capture.sh;
// pods.json is the ground truth from the API server at capture time.
type truthPod struct {
	Namespace, Name, UID, Node, QosClass string
	Mirror                               *string // static pods: the cgroup's pod ID
	Containers                           []struct {
		Name, ContainerID, State string
		Init                     bool
		Limits                   map[string]string
	}
}

// Pods that restart every few seconds by design: their cgroups and the API status
// can disagree at capture time.
var restarting = map[string]bool{"wl-test/crashloop": true, "wl-test/oom": true}

func loadTruth(t *testing.T, dir string) []truthPod {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "pods.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pods []truthPod
	if err := json.Unmarshal(b, &pods); err != nil {
		t.Fatal(err)
	}
	return pods
}

func runningIn(p truthPod, name string) bool {
	for _, c := range p.Containers {
		if c.Name == name && c.State == "running" {
			return true
		}
	}
	return false
}

func quantity(t *testing.T, q string, cpu bool) float64 {
	t.Helper()
	units := map[string]float64{"m": 1e-3, "Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30}
	for suffix, mul := range units {
		if n, ok := strings.CutSuffix(q, suffix); ok && (suffix != "m" || cpu) {
			v, err := strconv.ParseFloat(n, 64)
			if err != nil {
				t.Fatal(err)
			}
			return v * mul
		}
	}
	v, err := strconv.ParseFloat(q, 64)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestPodContainersMatchTheAPIServer(t *testing.T) {
	layouts, err := filepath.Glob("testdata/k8s/*")
	if err != nil || len(layouts) == 0 {
		t.Fatalf("no Kubernetes fixtures: %v", err)
	}
	for _, layout := range layouts {
		t.Run(filepath.Base(layout), func(t *testing.T) {
			pods := loadTruth(t, layout)
			type truth struct {
				pod  truthPod
				name string
				lim  map[string]string
			}
			byID := map[string]truth{}
			podsByUID := map[string]truthPod{}
			for _, p := range pods {
				podsByUID[p.UID] = p
				if p.Mirror != nil {
					podsByUID[*p.Mirror] = p
				}
				for _, c := range p.Containers {
					if _, id, ok := strings.Cut(c.ContainerID, "://"); ok {
						byID[id] = truth{p, c.Name, c.Limits}
					}
				}
			}
			nodes, _ := filepath.Glob(filepath.Join(layout, "*", "sys"))
			if len(nodes) == 0 {
				t.Fatal("no nodes captured")
			}
			for _, sys := range nodes {
				nodeDir := filepath.Dir(sys)
				node := filepath.Base(nodeDir)
				r := NewReader(filepath.Join(nodeDir, "proc"), sys)
				found, unrecognized, err := r.PodContainers()
				if err != nil {
					t.Fatalf("%s: %v", node, err)
				}
				if len(unrecognized) > 0 {
					t.Errorf("%s: %d container cgroups in no known layout: %v", node, len(unrecognized), unrecognized)
				}
				seen := map[string]bool{}
				containers := 0
				for _, pc := range found {
					pod, known := podsByUID[pc.PodID]
					if !known {
						t.Errorf("%s: pod %s not in the API (container %s)", node, pc.PodID, pc.ContainerID[:12])
						continue
					}
					if want := strings.ToLower(pod.QosClass); pc.QoS != want {
						t.Errorf("%s: %s/%s QoS = %s, want %s", node, pod.Namespace, pod.Name, pc.QoS, want)
					}
					if pc.Sandbox {
						// Exited containers may leave an empty cgroup behind; only a running
						// container must never be taken for a sandbox.
						if tr, isContainer := byID[pc.ContainerID]; isContainer && runningIn(tr.pod, tr.name) &&
							!restarting[pod.Namespace+"/"+pod.Name] {
							t.Errorf("%s: running container %s of %s taken for a sandbox", node, pc.ContainerID[:12], pod.Name)
						}
						continue
					}
					tr, ok := byID[pc.ContainerID]
					switch {
					case !ok && restarting[pod.Namespace+"/"+pod.Name]:
						continue
					case !ok:
						t.Errorf("%s: container %s of %s/%s is neither in the pod status nor a sandbox",
							node, pc.ContainerID[:12], pod.Namespace, pod.Name)
						continue
					case podsByUID[pc.PodID].UID != tr.pod.UID:
						t.Errorf("%s: container %s found under pod %s, API says %s", node, pc.ContainerID[:12], pc.PodID, tr.pod.UID)
					}
					seen[pc.ContainerID] = true
					containers++

					st, err := r.PodContainerStats(pc)
					if err != nil {
						t.Errorf("%s: stats %s/%s: %v", node, tr.pod.Name, tr.name, err)
						continue
					}
					if cpu, ok := tr.lim["cpu"]; ok {
						if st.CPULimitCores == nil || math.Abs(*st.CPULimitCores-quantity(t, cpu, true)) > 1e-6 {
							t.Errorf("%s: %s/%s CPU limit = %v, want %s", node, tr.pod.Name, tr.name, st.CPULimitCores, cpu)
						}
					}
					if mem, ok := tr.lim["memory"]; ok {
						if st.MemoryLimit == nil || *st.MemoryLimit != quantity(t, mem, false) {
							t.Errorf("%s: %s/%s memory limit = %v, want %s", node, tr.pod.Name, tr.name, st.MemoryLimit, mem)
						}
					}
				}
				for id, tr := range byID {
					c := tr
					if c.pod.Node != node || restarting[c.pod.Namespace+"/"+c.pod.Name] {
						continue
					}
					for _, pc := range c.pod.Containers {
						if pc.Name == c.name && pc.State == "running" && !seen[id] {
							t.Errorf("%s: running container %s/%s/%s (%s) not found", node, c.pod.Namespace, c.pod.Name, c.name, id[:12])
						}
					}
				}
				if containers == 0 {
					t.Errorf("%s: no containers found", node)
				}
				t.Logf("%s: %d containers, %d cgroups", node, containers, len(found))
			}
		})
	}
}

func TestParsePodContainer(t *testing.T) {
	const uid = "6a7775c9-1250-4125-80d2-d35716207e7e"
	const id = "da55a64b4064fb5901c0adda2985ab6901f48092f43467b1800c5c11ca554595"
	cases := []struct {
		rel     string
		ok      bool
		qos, rt string
	}{
		{"kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod6a7775c9_1250_4125_80d2_d35716207e7e.slice/cri-containerd-" + id + ".scope", true, "burstable", "containerd"},
		{"kubepods.slice/kubepods-pod6a7775c9_1250_4125_80d2_d35716207e7e.slice/crio-" + id + ".scope", true, "guaranteed", "crio"},
		{"kubepods/besteffort/pod" + uid + "/" + id, true, "besteffort", ""},
		{"kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod6a7775c9_1250_4125_80d2_d35716207e7e.slice", false, "", ""},
		{"kubepods.slice/kubepods-burstable.slice", false, "", ""},
		{"system.slice/docker-" + id + ".scope", false, "", ""},
	}
	// Static pod (kind control plane): the config hash, not a UID.
	if pc, ok := parsePodContainer("kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod510cef57815c6de24bfbfb0b4326d919.slice/cri-containerd-" + id + ".scope"); !ok || pc.PodID != "510cef57815c6de24bfbfb0b4326d919" {
		t.Errorf("static pod: %+v, %v", pc, ok)
	}
	for _, c := range cases {
		pc, ok := parsePodContainer(c.rel)
		if ok != c.ok || (ok && (pc.PodID != uid || pc.ContainerID != id || pc.QoS != c.qos || pc.Runtime != c.rt)) {
			t.Errorf("parsePodContainer(%s) = %+v, %v", c.rel, pc, ok)
		}
	}
}

// BenchmarkPodContainers measures one scrape's discovery plus stats on the largest
// captured node (cgroup v1 with Docker: four controllers per container).
func BenchmarkPodContainers(b *testing.B) {
	node := "testdata/k8s/k3s-docker-cgroupfs-v1/lima-watchlog-cgv1"
	r := NewReader(filepath.Join(node, "proc"), filepath.Join(node, "sys"))
	b.ReportAllocs()
	for b.Loop() {
		found, _, err := r.PodContainers()
		if err != nil {
			b.Fatal(err)
		}
		for _, pc := range found {
			if !pc.Sandbox {
				_, _ = r.PodContainerStats(pc)
			}
		}
	}
}

// An uncaptured layout (here: a made-up cgroupfs-on-v2 tree) is never labelled:
// its containers come back as unrecognized IDs for the unmapped counter.
func TestUnknownLayoutsAreReportedNotGuessed(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("ab", 32)
	cg := filepath.Join(dir, "sys", "fs", "cgroup")
	for _, p := range []string{"kubepods/burstable/podzz-not-a-uid/" + id, "kubepods/weird-" + id + ".scope"} {
		if err := os.MkdirAll(filepath.Join(cg, p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(cg, "cgroup.controllers"), []byte("cpu memory io"), 0o644); err != nil {
		t.Fatal(err)
	}
	found, unrecognized, err := NewReader(filepath.Join(dir, "proc"), filepath.Join(dir, "sys")).PodContainers()
	if err != nil || len(found) != 0 || len(unrecognized) != 2 {
		t.Fatalf("found=%v unrecognized=%v err=%v", found, unrecognized, err)
	}
}

// The pod filter's roots (ADR-121) on every captured layout: the kubepods cgroup at the
// top or, on kind, one level down; none on cgroup v1 (eBPF needs v2).
func TestKubepodsRoots(t *testing.T) {
	want := map[string][]string{
		"k3s-containerd":          {"kubepods.slice"},
		"k3s-containerd-cgroupv1": nil,
		"k3s-docker-cgroupfs-v1":  nil,
		"kind-containerd-systemd": {"kubelet.slice/kubelet-kubepods.slice"},
		"kubeadm-crio-systemd":    {"kubepods.slice"},
	}
	for layout, roots := range want {
		nodes, _ := filepath.Glob(filepath.Join("testdata/k8s", layout, "*", "sys"))
		if len(nodes) == 0 {
			t.Fatalf("%s: no nodes captured", layout)
		}
		for _, sys := range nodes {
			r := NewReader(filepath.Join(filepath.Dir(sys), "proc"), sys)
			var got []string
			for _, d := range r.KubepodsRoots() {
				rel, _ := filepath.Rel(r.cgroup, d)
				got = append(got, rel)
			}
			if strings.Join(got, ",") != strings.Join(roots, ",") {
				t.Errorf("%s/%s: roots = %v, want %v", layout, filepath.Base(filepath.Dir(sys)), got, roots)
			}
		}
	}
}
