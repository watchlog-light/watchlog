// SPDX-License-Identifier: AGPL-3.0-only

package network

import "strings"

// DefaultClusterDomain is Kubernetes' default, used when the search list names none.
const DefaultClusterDomain = "cluster.local"

// ClusterDomain finds the cluster domain in a pod's search list: kubelet gives every
// pod "<ns>.svc.<domain> svc.<domain> <domain>", so it is the entry after "svc.".
func ClusterDomain(search []string) string {
	for _, d := range search {
		if rest, ok := strings.CutPrefix(d, "svc."); ok && rest != "" {
			return rest
		}
	}
	return DefaultClusterDomain
}

// ClusterService reports whether a DNS name is under svc.<domain>: a Service
// ("<service>.<ns>.svc.<domain>") or one of its pods ("<pod>.<service>.<ns>.svc.<domain>",
// headless). Such a destination is inside the cluster, never external, even while the
// IP map does not know its address yet. under is true for any name under svc.<domain>;
// service and namespace are set when the name has both.
func ClusterService(name, domain string) (service, namespace string, under bool) {
	name = strings.Trim(strings.ToLower(name), ".")
	if domain == "" {
		domain = DefaultClusterDomain
	}
	rest, ok := strings.CutSuffix(name, ".svc."+strings.Trim(strings.ToLower(domain), "."))
	if !ok {
		return "", "", false
	}
	labels := strings.Split(rest, ".")
	if len(labels) < 2 || labels[len(labels)-1] == "" || labels[len(labels)-2] == "" {
		return "", "", true
	}
	return labels[len(labels)-2], labels[len(labels)-1], true
}
