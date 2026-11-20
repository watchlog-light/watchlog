// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/watchlog-light/watchlog/agent/internal/collectors/certs"
)

// CanWatchIngresses says whether the cluster-agent may list Ingresses (the chart's 0.10 RBAC,
// ADR-222). Without it certificates are read from TLS Services only.
func CanWatchIngresses(ctx context.Context, cs kubernetes.Interface) bool {
	_, err := cs.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{Limit: 1})
	return err == nil
}

// trimIngress keeps an Ingress's class, hosts and TLS hosts, and the addresses it is
// reached on; never the Secret a TLS section names, nor paths or backends.
func trimIngress(o *networkingv1.Ingress) *networkingv1.Ingress {
	in := &networkingv1.Ingress{ObjectMeta: trimMeta(o.ObjectMeta),
		Spec: networkingv1.IngressSpec{IngressClassName: o.Spec.IngressClassName}}
	for _, t := range o.Spec.TLS {
		in.Spec.TLS = append(in.Spec.TLS, networkingv1.IngressTLS{Hosts: t.Hosts})
	}
	for _, r := range o.Spec.Rules {
		in.Spec.Rules = append(in.Spec.Rules, networkingv1.IngressRule{Host: r.Host})
	}
	for _, l := range o.Status.LoadBalancer.Ingress {
		in.Status.LoadBalancer.Ingress = append(in.Status.LoadBalancer.Ingress, networkingv1.IngressLoadBalancerIngress{IP: l.IP, Hostname: l.Hostname})
	}
	return in
}

// tlsPort is a Service's TLS port: one named https, or 443.
func tlsPort(s *corev1.Service) (uint16, bool) {
	for _, p := range s.Spec.Ports {
		if p.Protocol != "" && p.Protocol != corev1.ProtocolTCP {
			continue
		}
		if p.Name == "https" || strings.HasSuffix(p.Name, "-https") || p.Port == 443 {
			return uint16(p.Port), true //nolint:gosec // a port number
		}
	}
	return 0, false
}

func serviceIP(s *corev1.Service) string {
	if s.Spec.Type == corev1.ServiceTypeExternalName || s.Spec.ClusterIP == "" || s.Spec.ClusterIP == corev1.ClusterIPNone {
		return ""
	}
	return s.Spec.ClusterIP
}

// controllerLabels name an Ingress controller's Service when the Ingress's own status says
// nothing that matches one (ingress-nginx, Traefik, HAProxy, Contour/Envoy, Kong, k3s).
func isController(s *corev1.Service) bool {
	l := s.Labels
	if l["app.kubernetes.io/component"] == "controller" {
		return true
	}
	switch l["app.kubernetes.io/name"] {
	case "ingress-nginx", "traefik", "haproxy-ingress", "kubernetes-ingress", "contour", "envoy", "kong":
		return true
	}
	return strings.Contains(s.Name, "ingress") || s.Name == "traefik"
}

// CertTargets are what the cluster-agent reads certificates from (ADR-222): each Service's
// TLS port at its cluster address, and each Ingress's TLS hosts, asked for by name on its
// controller's Service. No Secret is read: only what the port presents.
func (c *Cluster) CertTargets() []certs.Target {
	var out []certs.Target
	var services []*corev1.Service
	for _, obj := range c.Store("Service").List() {
		s, ok := obj.(*corev1.Service)
		if !ok {
			continue
		}
		port, ok := tlsPort(s)
		ip := serviceIP(s)
		if !ok || ip == "" {
			continue
		}
		services = append(services, s)
		out = append(out, certs.Target{Kind: "Service", Workload: s.Namespace + "/" + s.Name, Proto: "tcp", Port: port, Addr: ip})
	}
	sort.Slice(services, func(i, j int) bool {
		return services[i].Namespace+"/"+services[i].Name < services[j].Namespace+"/"+services[j].Name
	})
	store := c.Store("Ingress")
	if store == nil {
		return out
	}
	for _, obj := range store.List() {
		in, ok := obj.(*networkingv1.Ingress)
		if !ok {
			continue
		}
		var hosts []string
		for _, t := range in.Spec.TLS {
			for _, h := range t.Hosts {
				if h != "" && !contains(hosts, h) {
					hosts = append(hosts, h)
				}
			}
		}
		if len(hosts) == 0 {
			continue
		}
		// A wildcard host is asked for under a name it covers.
		for i, h := range hosts {
			if strings.HasPrefix(h, "*.") {
				hosts[i] = certs.WildcardProbe + h[1:]
			}
		}
		sort.Strings(hosts)
		addr, port := ingressAddr(in, services)
		if addr == "" {
			continue
		}
		out = append(out, certs.Target{Kind: "Ingress", Workload: in.Namespace + "/" + in.Name, Proto: "tcp", Port: port,
			Addr: addr, Names: hosts, SNIOnly: true})
	}
	return out
}

// ingressAddr is where an Ingress's hosts are read: the controller Service its status points
// to, else the address in its status, else the one controller Service in the cluster.
func ingressAddr(in *networkingv1.Ingress, services []*corev1.Service) (string, uint16) {
	status := map[string]bool{}
	for _, l := range in.Status.LoadBalancer.Ingress {
		if l.IP != "" {
			status[l.IP] = true
		}
		if l.Hostname != "" {
			status[l.Hostname] = true
		}
	}
	for _, s := range services {
		port, _ := tlsPort(s)
		match := status[s.Spec.ClusterIP]
		for _, ip := range s.Spec.ExternalIPs {
			match = match || status[ip]
		}
		for _, l := range s.Status.LoadBalancer.Ingress {
			match = match || status[l.IP] || (l.Hostname != "" && status[l.Hostname])
		}
		if match {
			return serviceIP(s), port
		}
	}
	for _, l := range in.Status.LoadBalancer.Ingress {
		if l.IP != "" {
			return l.IP, 443
		}
	}
	var ctl []*corev1.Service
	for _, s := range services {
		if isController(s) {
			ctl = append(ctl, s)
		}
	}
	if len(ctl) == 1 {
		port, _ := tlsPort(ctl[0])
		return serviceIP(ctl[0]), port
	}
	return "", 0
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
