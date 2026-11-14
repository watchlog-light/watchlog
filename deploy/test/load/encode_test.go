// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"os"
	"testing"
)

// The copy encodes the agent's golden samples to the agent's golden body, byte for byte.
func TestEncodeMatchesTheAgentsGoldenFile(t *testing.T) {
	want, err := os.ReadFile("../../../agent/internal/remotewrite/testdata/write-request.snappy")
	if err != nil {
		t.Fatal(err)
	}
	host := Label{"host", "web-01"}
	got := Encode([]Sample{
		{Name: "watchlog_node_load1", Value: 0.26, Labels: []Label{host}},
		{Name: "watchlog_node_cpu_seconds_total", Value: 18.8, Labels: []Label{{"mode", "user"}, host}},
		{Name: "watchlog_node_filesystem_bytes", Value: 3.0083776512e10, Labels: []Label{{"state", "size"}, {"mount", "/"}, host}},
	}, 1793404800000)
	if !bytes.Equal(got, want) {
		t.Fatalf("encoded %d bytes, the agent's golden file has %d; they differ", len(got), len(want))
	}
}

func TestTemplatesLoadAndLookLikeAgents(t *testing.T) {
	tpl, err := loadTemplates("templates.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	for kind, sets := range map[string][][]series{"k8s_node": tpl.K8sNode, "docker_host": tpl.DockerHost, "cluster_agent": tpl.ClusterAgent} {
		if len(sets) == 0 {
			t.Fatalf("%s: no template", kind)
		}
		for _, set := range sets {
			if len(set) < 100 {
				t.Errorf("%s: only %d series", kind, len(set))
			}
			for _, s := range set {
				for _, l := range s.labels {
					if l.Name == "cluster_id" || l.Name == "tenant_id" {
						t.Fatalf("%s carries the reserved label %s: the backend answers 400", kind, l.Name)
					}
				}
			}
		}
	}
}

func TestPlanMixesTiersAndKinds(t *testing.T) {
	orgs := plan(150, 50, 1000, 0.3, 1)
	free, pro, nodes, docker, clusters := 0, 0, 0, 0, 0
	for _, o := range orgs {
		if o.Plan == "pro" {
			pro++
		} else {
			free++
			if len(o.Clusters) != 1 || len(o.Clusters[0].Nodes) > 5 {
				t.Fatalf("a Free org over its plan: %+v", o)
			}
		}
		for _, c := range o.Clusters {
			clusters++
			nodes += len(c.Nodes)
			if c.Kind == "docker" {
				docker++
			}
		}
	}
	if free != 150 || pro != 50 || nodes != 1000 {
		t.Fatalf("free %d, pro %d, nodes %d", free, pro, nodes)
	}
	if docker == 0 || docker == clusters {
		t.Fatalf("docker fleets %d of %d clusters", docker, clusters)
	}
}
