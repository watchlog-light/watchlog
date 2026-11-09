/* SPDX-License-Identifier: GPL-2.0-only OR MIT */
/*
 * TCP flows of every container on the node (SPEC §6.4, ADR-099).
 *
 * The connecting task's cgroup id is taken in process context, when the socket enters
 * SYN_SENT inside connect(), and kept per socket. Later transitions (ESTABLISHED runs in
 * softirq), retransmits and bytes look the socket up. Counters are aggregated per CPU,
 * keyed by (cgroup id, destination address, port), in two maps: user space flips
 * `active` and drains the other one every 15 s, so nothing is lost between read and
 * delete. No per-event stream, no payload.
 *
 * Hooks: BTF raw tracepoints (tp_btf) for state changes and retransmits, fentry/fexit
 * for bytes (no tracepoint exists). None needs tracefs or pt_regs, so one little-endian
 * object serves amd64 and arm64.
 *
 * In Kubernetes mode only this node's pods are recorded (the pod filter, ADR-121).
 */
#include "types.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>

/* GPL-compatible for the kernel's GPL-only helpers; MIT keeps the embedded object
 * compatible with AGPL-3.0 and the ee/ licence (ADR-105). */
char LICENSE[] SEC("license") = "Dual MIT/GPL";

#define LAT_BUCKETS 12

struct flow_key {
	__u64 cgroup;
	__u8 daddr[16]; /* IPv4 as ::ffff:a.b.c.d */
	__u16 dport;
	__u16 pad[3];
};

struct flow_val {
	__u64 connects;    /* attempts (SYN_SENT) */
	__u64 failures;    /* SYN_SENT -> CLOSE */
	__u64 established; /* SYN_SENT -> ESTABLISHED */
	__u64 lat_sum_ns;  /* connect latency of the established ones */
	__u64 lat[LAT_BUCKETS];
	__u64 bytes_sent;
	__u64 bytes_recv;
	__u64 retransmits;
};

struct sock_info {
	struct flow_key key;
	__u64 start_ns;
};

/* Sockets this node connected, from SYN_SENT until CLOSE. */
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, __u64);
	__type(value, struct sock_info);
} socks SEC(".maps");

/* Allocated on demand: memory follows the number of active edges, not CPUs × max. */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_HASH);
	__uint(max_entries, 8192);
	__uint(map_flags, BPF_F_NO_PREALLOC);
	__type(key, struct flow_key);
	__type(value, struct flow_val);
} flows0 SEC(".maps"), flows1 SEC(".maps");

/* Which flows map the programs write to (0 or 1); user space drains the other. */
struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u32);
} active SEC(".maps");

/*
 * Pod filter (ADR-121): with `filter` on, a connection or DNS query is recorded only
 * when the task's cgroup or one of its ancestors is in `roots`, the node's kubepods
 * cgroups that user space fills. Everything else on the kernel (host daemons, plain
 * Docker containers, other nodes' pods when nodes are containers on one kernel) never
 * enters a map; it is only counted. Checked where the cgroup is taken in process
 * context: SYN_SENT, adoption and DNS queries.
 */
#define ROOTS_MAX 16
#define CGROUP_DEPTH_MAX 16
#define FILTERED_CONNECTS 0
#define FILTERED_DNS 1
#define FILTERED_UNCOUNTED 2

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, ROOTS_MAX);
	__type(key, __u64);
	__type(value, __u8);
} roots SEC(".maps");

/* 1: record only tasks below `roots`; 0 (default): record every task. */
struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u32);
} filter SEC(".maps");

/* Events left out by the filter: [0] connections (SYN_SENT), [1] DNS queries. */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 2);
	__type(key, __u32);
	__type(value, __u64);
} filtered SEC(".maps");

/*
 * in_scope says whether the current task may be recorded. The ancestors are walked
 * with CO-RE reads instead of bpf_get_current_ancestor_cgroup_id(), which tracing
 * programs may call only on newer kernels than the 5.8 minimum.
 */
static __always_inline int in_scope(__u32 what)
{
	__u32 zero = 0;
	__u32 *on = bpf_map_lookup_elem(&filter, &zero);
	if (!on || !*on)
		return 1;
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	struct cgroup *cg = BPF_CORE_READ(task, cgroups, dfl_cgrp);
	for (int i = 0; i < CGROUP_DEPTH_MAX && cg; i++) {
		__u64 id = BPF_CORE_READ(cg, kn, id);
		if (bpf_map_lookup_elem(&roots, &id))
			return 1;
		cg = (struct cgroup *)BPF_CORE_READ(cg, self.parent);
	}
	if (what == FILTERED_UNCOUNTED)
		return 0;
	__u64 *n = bpf_map_lookup_elem(&filtered, &what);
	if (n)
		(*n)++;
	return 0;
}

static __always_inline struct flow_val *flow_in(void *map, struct flow_key *k)
{
	struct flow_val *v = bpf_map_lookup_elem(map, k);
	if (v)
		return v;
	struct flow_val zero = {};
	bpf_map_update_elem(map, k, &zero, BPF_NOEXIST);
	return bpf_map_lookup_elem(map, k);
}

static __always_inline struct flow_val *flow(struct flow_key *k)
{
	__u32 idx = 0;
	__u32 *a = bpf_map_lookup_elem(&active, &idx);
	if (a && *a)
		return flow_in(&flows1, k);
	return flow_in(&flows0, k);
}

/* Upper bounds in ns: 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500 ms, 1 s, +Inf. */
static __always_inline __u32 lat_bucket(__u64 ns)
{
	if (ns <= 500000ULL) return 0;
	if (ns <= 1000000ULL) return 1;
	if (ns <= 2500000ULL) return 2;
	if (ns <= 5000000ULL) return 3;
	if (ns <= 10000000ULL) return 4;
	if (ns <= 25000000ULL) return 5;
	if (ns <= 50000000ULL) return 6;
	if (ns <= 100000000ULL) return 7;
	if (ns <= 250000000ULL) return 8;
	if (ns <= 500000000ULL) return 9;
	if (ns <= 1000000000ULL) return 10;
	return 11;
}

static __always_inline int read_dest(const struct sock *sk, struct flow_key *k)
{
	__u16 family = BPF_CORE_READ(sk, __sk_common.skc_family);
	if (family == AF_INET) {
		__be32 d = BPF_CORE_READ(sk, __sk_common.skc_daddr);
		k->daddr[10] = 0xff;
		k->daddr[11] = 0xff;
		__builtin_memcpy(&k->daddr[12], &d, 4);
	} else if (family == AF_INET6) {
		BPF_CORE_READ_INTO(&k->daddr, sk, __sk_common.skc_v6_daddr.in6_u.u6_addr8);
	} else {
		return -1;
	}
	k->dport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
	return 0;
}

/*
 * HTTP/1.x per edge (ADR-139): the first HTTP_PEEK bytes of each message on a TCP socket
 * say whether it starts a request ("GET /", "POST ") or a response ("HTTP/1.1 503").
 * Only the method's class, the status code and the time from a request's first byte to
 * its response's first byte are kept; paths, headers and bodies never leave the buffer
 * read here. TLS is never decrypted: an encrypted message matches neither. Both sides:
 * a client socket (one `socks` tracks, or adopts) and an accepted server socket, keyed
 * by the server's cgroup, the client's address and the local port.
 */
#define HTTP_PEEK 16
/* Powers of two: the indexes are masked, which the verifier always accepts; 21 status
 * slots and 15 buckets are used. */
#define HTTP_STATUS_SLOTS 32
#define HTTP_BUCKETS 16
#define HTTP_CLIENT 0
#define HTTP_SERVER 1

struct http_key {
	__u64 cgroup;
	__u8 addr[16]; /* client side: the server; server side: the client */
	__u16 port;    /* client side: the server's port; server side: the local port */
	__u8 side;
	__u8 pad[5];
};

struct http_val {
	__u64 reads;  /* GET, HEAD, OPTIONS */
	__u64 writes; /* POST, PUT, PATCH, DELETE */
	__u64 status[HTTP_STATUS_SLOTS];
	__u64 lat[HTTP_BUCKETS];
	__u64 lat_sum_ns;
};

#define HTTP_STATUS_LINE 12 /* "HTTP/1.1 503" */
#define HTTP_PENDING_NS 30000000000ULL

struct http_sock {
	struct http_key key;
	__u64 req_ns;   /* 0: no request waiting for its response */
	__u8 method;    /* 1 read, 2 write */
	__u8 resp_len;  /* bytes of a response's start gathered so far, client side */
	__u8 pad[6];
	__u8 resp[16]; /* a response's start read a few bytes at a time (busybox wget: 1) */
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, __u64);
	__type(value, struct http_sock);
} http_socks SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_HASH);
	__uint(max_entries, 8192);
	__uint(map_flags, BPF_F_NO_PREALLOC);
	__type(key, struct http_key);
	__type(value, struct http_val);
} http0 SEC(".maps"), http1 SEC(".maps");

/* A zeroed http_val to create an edge from: too large for the 512-byte stack. Never
 * written. */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct http_val);
} http_zero SEC(".maps");

/* A receive's user buffer, from tcp_recvmsg's entry to tcp_cleanup_rbuf, per thread. */
struct recv_buf {
	__u64 sk;
	__u64 buf;
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, __u64);
	__type(value, struct recv_buf);
} recv_bufs SEC(".maps");

SEC("tp_btf/inet_sock_set_state")
int BPF_PROG(on_state, const struct sock *sk, const int oldstate, const int newstate)
{
	if (BPF_CORE_READ(sk, sk_protocol) != IPPROTO_TCP)
		return 0;
	__u64 skp = (__u64)sk;

	if (newstate == TCP_SYN_SENT) {
		struct sock_info si = {};
		if (read_dest(sk, &si.key) < 0)
			return 0;
		if (!in_scope(FILTERED_CONNECTS))
			return 0;
		si.key.cgroup = bpf_get_current_cgroup_id();
		si.start_ns = bpf_ktime_get_ns();
		bpf_map_update_elem(&socks, &skp, &si, BPF_ANY);
		struct flow_val *v = flow(&si.key);
		if (v)
			v->connects++;
		return 0;
	}

	if (newstate == TCP_CLOSE)
		bpf_map_delete_elem(&http_socks, &skp);
	struct sock_info *si = bpf_map_lookup_elem(&socks, &skp);
	if (!si)
		return 0;
	if (oldstate == TCP_SYN_SENT) {
		struct flow_val *v = flow(&si->key);
		if (newstate == TCP_ESTABLISHED) {
			if (v) {
				__u64 lat = bpf_ktime_get_ns() - si->start_ns;
				v->established++;
				v->lat_sum_ns += lat;
				__u32 b = lat_bucket(lat);
				if (b < LAT_BUCKETS)
					v->lat[b]++;
			}
			return 0;
		}
		if (newstate == TCP_CLOSE && v)
			v->failures++;
	}
	if (newstate == TCP_CLOSE)
		bpf_map_delete_elem(&socks, &skp);
	return 0;
}

SEC("tp_btf/tcp_retransmit_skb")
int BPF_PROG(on_retransmit, const struct sock *sk, const struct sk_buff *skb)
{
	__u64 skp = (__u64)sk;
	struct sock_info *si = bpf_map_lookup_elem(&socks, &skp);
	if (!si)
		return 0;
	struct flow_val *v = flow(&si->key);
	if (v)
		v->retransmits++;
	return 0;
}

/*
 * Connections open before the agent started (a DB pool, HTTP keep-alive) were never
 * seen in SYN_SENT. When bytes flow on such a socket in process context, it is adopted
 * if it is the client side: local port in Linux's default ephemeral range and remote
 * port outside it. An accepted server socket has its listening port as the local port
 * and the client's ephemeral port as the remote one, so it is never adopted. Adopted
 * sockets count bytes and retransmits, not connects or latency.
 */
#define EPHEMERAL_LO 32768
#define EPHEMERAL_HI 60999

static __always_inline struct sock_info *known_or_adopt(struct sock *sk)
{
	__u64 skp = (__u64)sk;
	struct sock_info *si = bpf_map_lookup_elem(&socks, &skp);
	if (si)
		return si;
	if (BPF_CORE_READ(sk, __sk_common.skc_state) != TCP_ESTABLISHED)
		return 0;
	__u16 lport = BPF_CORE_READ(sk, __sk_common.skc_num);
	__u16 rport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
	if (lport < EPHEMERAL_LO || lport > EPHEMERAL_HI ||
	    (rport >= EPHEMERAL_LO && rport <= EPHEMERAL_HI))
		return 0;
	/* Not counted: this runs on every send and receive of such a socket. */
	if (!in_scope(FILTERED_UNCOUNTED))
		return 0;
	struct sock_info fresh = {};
	if (read_dest(sk, &fresh.key) < 0)
		return 0;
	fresh.key.cgroup = bpf_get_current_cgroup_id();
	bpf_map_update_elem(&socks, &skp, &fresh, BPF_NOEXIST);
	return bpf_map_lookup_elem(&socks, &skp);
}

SEC("fexit/tcp_sendmsg")
int BPF_PROG(on_send, struct sock *sk, struct msghdr *msg, __u64 size, int ret)
{
	if (ret <= 0)
		return 0;
	struct sock_info *si = known_or_adopt(sk);
	if (!si)
		return 0;
	struct flow_val *v = flow(&si->key);
	if (v)
		v->bytes_sent += ret;
	return 0;
}

SEC("fentry/tcp_cleanup_rbuf")
int BPF_PROG(on_recv, struct sock *sk, int copied)
{
	if (copied <= 0)
		return 0;
	struct sock_info *si = known_or_adopt(sk);
	if (!si)
		return 0;
	struct flow_val *v = flow(&si->key);
	if (v)
		v->bytes_recv += copied;
	return 0;
}

/* --- HTTP (ADR-139) --------------------------------------------------------------- */

static __always_inline struct http_val *http_in(void *map, struct http_key *k)
{
	struct http_val *v = bpf_map_lookup_elem(map, k);
	if (v)
		return v;
	__u32 z = 0;
	struct http_val *zero = bpf_map_lookup_elem(&http_zero, &z);
	if (!zero)
		return 0;
	bpf_map_update_elem(map, k, zero, BPF_NOEXIST);
	return bpf_map_lookup_elem(map, k);
}

static __always_inline struct http_val *http(struct http_key *k)
{
	__u32 idx = 0;
	__u32 *a = bpf_map_lookup_elem(&active, &idx);
	if (a && *a)
		return http_in(&http1, k);
	return http_in(&http0, k);
}

/*
 * The user buffer a message's first bytes are in: see struct iov_iter___old in types.h.
 * The iterator's first word is the buffer itself (ubuf, one buffer on 6.0+) or a kernel
 * pointer to an iovec array; a user read tells them apart. In an array the first
 * non-empty segment counts: musl's stdio reads with readv into {the caller's byte, 0}
 * and {its buffer, n}, so the data is in the second (busybox wget's responses).
 * 0 when there is none readable (a kernel send).
 */
/* The first word of the message's iov_iter: an iovec array (kernel memory) or one user
 * buffer (ubuf). Read at tcp_recvmsg's entry, told apart only after the copy (buf_of). */
static __always_inline void *iter_word(struct msghdr *msg)
{
	void *word = 0;
	struct iov_iter *it = __builtin_preserve_access_index(&msg->msg_iter);
	if (bpf_core_field_exists(((struct iov_iter___new *)0)->__iov))
		bpf_core_read(&word, sizeof(word), &((struct iov_iter___new *)it)->__iov);
	else
		bpf_core_read(&word, sizeof(word), &((struct iov_iter___old *)it)->iov);
	return word;
}

/* The user buffer behind an iter word. A ubuf is user memory and readable once data was
 * copied into it or out of it: a fresh receive buffer is not paged in before the copy,
 * which is why receives save the word and resolve it here only after (ADR-139). Anything
 * else is the kernel's iovec array: its first non-empty segment (musl's readv). */
static __always_inline void *buf_of(void *word)
{
	if (!word)
		return 0;
	__u8 probe;
	if (bpf_probe_read_user(&probe, 1, word) == 0)
		return word;
	struct iovec iov = {};
	for (int i = 0; i < 2; i++) {
		if (bpf_probe_read_kernel(&iov, sizeof(iov), (struct iovec *)word + i) < 0)
			return 0;
		if (iov.iov_len)
			return iov.iov_base;
	}
	return 0;
}

static __always_inline void *msg_buf(struct msghdr *msg)
{
	return buf_of(iter_word(msg));
}

/* Copies the first HTTP_PEEK bytes of a user buffer. */
static __always_inline int peek(void *buf, __u8 *out)
{
	if (!buf)
		return -1;
	return bpf_probe_read_user(out, HTTP_PEEK, buf);
}

/* 1: a request that reads (GET, HEAD, OPTIONS), 2: one that writes, 0: no request. */
static __always_inline __u8 method_of(const __u8 *b)
{
	if (b[0] == 'G' && b[1] == 'E' && b[2] == 'T' && b[3] == ' ')
		return 1;
	if (b[0] == 'H' && b[1] == 'E' && b[2] == 'A' && b[3] == 'D' && b[4] == ' ')
		return 1;
	if (b[0] == 'O' && b[1] == 'P' && b[2] == 'T' && b[3] == 'I' && b[7] == ' ')
		return 1;
	if (b[0] == 'P' && b[1] == 'O' && b[2] == 'S' && b[3] == 'T' && b[4] == ' ')
		return 2;
	if (b[0] == 'P' && b[1] == 'U' && b[2] == 'T' && b[3] == ' ')
		return 2;
	if (b[0] == 'P' && b[1] == 'A' && b[2] == 'T' && b[3] == 'C' && b[5] == ' ')
		return 2;
	if (b[0] == 'D' && b[1] == 'E' && b[2] == 'L' && b[3] == 'E' && b[6] == ' ')
		return 2;
	return 0;
}

/* The status of "HTTP/1.x NNN", else 0. */
static __always_inline __u32 status_of(const __u8 *b)
{
	if (b[0] != 'H' || b[1] != 'T' || b[2] != 'T' || b[3] != 'P' || b[4] != '/' ||
	    b[5] != '1' || b[6] != '.' || b[8] != ' ')
		return 0;
	if (b[9] < '1' || b[9] > '5' || b[10] < '0' || b[10] > '9' || b[11] < '0' || b[11] > '9')
		return 0;
	return (b[9] - '0') * 100 + (b[10] - '0') * 10 + (b[11] - '0');
}

/* The common codes exactly (ADR-139 amended), the rest by class: HTTP_STATUS_SLOTS. */
static __always_inline __u32 status_slot(__u32 code)
{
	switch (code) {
	case 200: return 0;
	case 201: return 1;
	case 204: return 2;
	case 301: return 3;
	case 302: return 4;
	case 304: return 5;
	case 400: return 6;
	case 401: return 7;
	case 403: return 8;
	case 404: return 9;
	case 409: return 10;
	case 429: return 11;
	case 500: return 12;
	case 502: return 13;
	case 503: return 14;
	case 504: return 15;
	}
	return 15 + code / 100; /* 1xx 16, 2xx 17, 3xx 18, 4xx 19, 5xx 20 */
}

/* ADR-106's buckets extended to 10 s: ..., 1 s, 2.5 s, 5 s, 10 s, +Inf. */
static __always_inline __u32 http_bucket(__u64 ns)
{
	if (ns <= 1000000000ULL)
		return lat_bucket(ns) > 10 ? 10 : lat_bucket(ns);
	if (ns <= 2500000000ULL) return 11;
	if (ns <= 5000000000ULL) return 12;
	if (ns <= 10000000000ULL) return 13;
	return 14;
}

static __always_inline void http_done(struct http_sock *hs, __u32 code)
{
	if (!hs->req_ns)
		return;
	struct http_val *v = http(&hs->key);
	if (v) {
		__u64 lat = bpf_ktime_get_ns() - hs->req_ns;
		if (hs->method == 2)
			v->writes++;
		else
			v->reads++;
		v->status[status_slot(code) & (HTTP_STATUS_SLOTS - 1)]++;
		v->lat[http_bucket(lat) & (HTTP_BUCKETS - 1)]++;
		v->lat_sum_ns += lat;
	}
	hs->req_ns = 0;
}

static __always_inline int ephemeral(__u16 port)
{
	return port >= EPHEMERAL_LO && port <= EPHEMERAL_HI;
}

/* A request starts on this socket: a client's send, or a server's receive. */
static __always_inline void http_request(struct sock *sk, __u8 method, __u8 side)
{
	__u64 skp = (__u64)sk;
	struct http_sock *hs = bpf_map_lookup_elem(&http_socks, &skp);
	if (!hs) {
		struct http_sock fresh = {};
		if (side == HTTP_CLIENT) {
			struct sock_info *si = known_or_adopt(sk);
			if (!si)
				return;
			fresh.key.cgroup = si->key.cgroup;
			__builtin_memcpy(fresh.key.addr, si->key.daddr, 16);
			fresh.key.port = si->key.dport;
		} else {
			/* An accepted socket: its local port is the service's, not ephemeral. */
			__u16 lport = BPF_CORE_READ(sk, __sk_common.skc_num);
			if (ephemeral(lport) || !in_scope(FILTERED_UNCOUNTED))
				return;
			struct flow_key peer = {};
			if (read_dest(sk, &peer) < 0)
				return;
			fresh.key.cgroup = bpf_get_current_cgroup_id();
			__builtin_memcpy(fresh.key.addr, peer.daddr, 16);
			fresh.key.port = lport;
		}
		fresh.key.side = side;
		bpf_map_update_elem(&http_socks, &skp, &fresh, BPF_NOEXIST);
		hs = bpf_map_lookup_elem(&http_socks, &skp);
		if (!hs)
			return;
	}
	if (hs->key.side != side)
		return;
	/* A request still waiting for its response: what looks like another one is its body
	 * ("GET / HTTP/1.1" posted as data); pipelining is practically unused. One missed
	 * response blocks no longer than HTTP_PENDING_NS. */
	__u64 now = bpf_ktime_get_ns();
	if (hs->req_ns && now - hs->req_ns < HTTP_PENDING_NS)
		return;
	hs->req_ns = now;
	hs->method = method;
	hs->resp_len = 0;
}

/*
 * A client that reads its response a few bytes at a time (busybox wget reads the status
 * line byte by byte): gather the first HTTP_STATUS_LINE bytes across reads, then parse.
 */
static __always_inline void http_gather(struct sock *sk, void *buf, int copied)
{
	__u64 skp = (__u64)sk;
	struct http_sock *hs = bpf_map_lookup_elem(&http_socks, &skp);
	if (!hs || hs->key.side != HTTP_CLIENT || !hs->req_ns)
		return;
	__u32 have = hs->resp_len;
	if (have >= HTTP_STATUS_LINE || copied <= 0)
		return;
	__u32 n = (__u32)copied;
	if (n > HTTP_STATUS_LINE - have)
		n = HTTP_STATUS_LINE - have;
	/* A fixed-size read (a variable one needs a bound clang optimises away); only the
	 * first n bytes are used. A buffer at the end of a mapping loses this sample. */
	__u8 tmp[HTTP_PEEK] = {};
	if (n == 0 || bpf_probe_read_user(tmp, HTTP_PEEK, buf) < 0)
		return;
	for (int i = 0; i < HTTP_STATUS_LINE; i++) {
		if (i >= n)
			break;
		hs->resp[(have + i) & (HTTP_PEEK - 1)] = tmp[i];
	}
	hs->resp_len = have + n;
	if (hs->resp_len < HTTP_STATUS_LINE)
		return;
	__u32 code = status_of(hs->resp);
	if (code)
		http_done(hs, code);
	else
		hs->req_ns = 0; /* not HTTP after all: stop gathering */
}

/* A response starts on this socket: a server's send, or a client's receive. */
static __always_inline void http_response(struct sock *sk, __u32 code, __u8 side)
{
	__u64 skp = (__u64)sk;
	struct http_sock *hs = bpf_map_lookup_elem(&http_socks, &skp);
	if (hs && hs->key.side == side)
		http_done(hs, code);
}

SEC("fentry/tcp_sendmsg")
int BPF_PROG(on_http_send, struct sock *sk, struct msghdr *msg, __u64 size)
{
	if (size < 4)
		return 0;
	__u8 b[HTTP_PEEK] = {};
	if (peek(msg_buf(msg), b) < 0)
		return 0;
	__u8 m = method_of(b);
	if (m) {
		http_request(sk, m, HTTP_CLIENT);
		return 0;
	}
	__u32 code = size >= 12 ? status_of(b) : 0;
	if (code)
		http_response(sk, code, HTTP_SERVER);
	return 0;
}

SEC("fentry/tcp_recvmsg")
int BPF_PROG(on_http_recv_buf, struct sock *sk, struct msghdr *msg)
{
	struct recv_buf rb = {.sk = (__u64)sk, .buf = (__u64)iter_word(msg)};
	if (!rb.buf)
		return 0;
	__u64 tid = bpf_get_current_pid_tgid();
	bpf_map_update_elem(&recv_bufs, &tid, &rb, BPF_ANY);
	return 0;
}

/*
 * A server between requests that reads a few bytes alone: Go's net/http keeps a one-byte
 * read open while a handler finishes, which can take the first byte of a keep-alive
 * client's next request ("G", then "ET /"). Such bytes are kept and joined to the next
 * read. 1 when this read was handled here.
 */
static __always_inline int server_split(struct sock *sk, void *buf, int copied)
{
	__u64 skp = (__u64)sk;
	struct http_sock *hs = bpf_map_lookup_elem(&http_socks, &skp);
	if (!hs || hs->key.side != HTTP_SERVER)
		return 0;
	if (hs->req_ns && bpf_ktime_get_ns() - hs->req_ns < HTTP_PENDING_NS)
		return 0; /* a request's body */
	__u8 b[HTTP_PEEK] = {};
	if (bpf_probe_read_user(b, HTTP_PEEK, buf) < 0)
		return 0;
	__u32 have = hs->resp_len;
	if (have > 0 && have < 8) {
		__u8 c[HTTP_PEEK] = {};
		for (int i = 0; i < HTTP_PEEK; i++)
			c[i] = i < have ? hs->resp[i & (HTTP_PEEK - 1)] : b[(i - have) & (HTTP_PEEK - 1)];
		hs->resp_len = 0;
		__u8 m = method_of(c);
		if (m)
			http_request(sk, m, HTTP_SERVER);
		return 1;
	}
	if (copied < 8) {
		for (int i = 0; i < 8; i++)
			if (i < copied)
				hs->resp[i] = b[i];
		hs->resp_len = copied;
		return 1;
	}
	return 0;
}

/*
 * After tcp_recvmsg copied the data: the same buffer, now filled. A blocking read with
 * nothing queued yet calls tcp_cleanup_rbuf(sk, 0) before it waits, then again with what
 * it copied: the buffer is kept until a call copied something (busybox wget).
 */
SEC("fentry/tcp_cleanup_rbuf")
int BPF_PROG(on_http_recv, struct sock *sk, int copied)
{
	if (copied <= 0)
		return 0;
	__u64 tid = bpf_get_current_pid_tgid();
	struct recv_buf *rb = bpf_map_lookup_elem(&recv_bufs, &tid);
	if (!rb)
		return 0;
	struct recv_buf saved = *rb;
	bpf_map_delete_elem(&recv_bufs, &tid);
	if (saved.sk != (__u64)sk)
		return 0;
	saved.buf = (__u64)buf_of((void *)saved.buf);
	if (!saved.buf)
		return 0;
	if (server_split(sk, (void *)saved.buf, copied))
		return 0;
	if (copied < HTTP_STATUS_LINE) {
		/* Short reads: a request is at least "GET /" (server side, rarely split), a
		 * response's status line is gathered across reads (client side). */
		http_gather(sk, (void *)saved.buf, copied);
		if (copied < 4)
			return 0;
	}
	__u8 b[HTTP_PEEK] = {};
	if (peek((void *)saved.buf, b) < 0)
		return 0;
	__u8 m = method_of(b);
	if (m) {
		http_request(sk, m, HTTP_SERVER);
		return 0;
	}
	__u32 code = copied >= 12 ? status_of(b) : 0;
	if (code)
		http_response(sk, code, HTTP_CLIENT);
	return 0;
}

/*
 * DNS errors per container (Phase 4 slice 5, ADR-102): queries to port 53 are counted
 * when sent (process context: the right cgroup) per socket; responses are classified
 * by the rcode in the 12-byte DNS header; queries still unanswered when the socket
 * closes are timeouts.
 *
 * Names of external destinations (ADR-104): a successful response with answers is
 * copied, at most DNS_MSG_MAX bytes of the DNS message, to user space, which reads only
 * the question and the A, AAAA and CNAME answers into memory and drops the bytes. Only
 * responses to sockets that sent a query to port 53 are copied; no other payload.
 *
 * Search-path misses (ADR-113): an NXDOMAIN response is copied up to the end of its
 * question (DNS_QUESTION_MAX), so user space can tell a resolver trying the name under
 * a search domain from a name that does not exist.
 */
#define DNS_MSG_MAX 512
#define DNS_QUESTION_MAX 272 /* 12-byte header, a 255-byte name, type and class */

struct dns_msg {
	__u64 cgroup;
	__u32 len;
	__u32 pad;
	__u8 data[DNS_MSG_MAX];
};

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} dns_answers SEC(".maps");
#define DNS_RCODES 4 /* NOERROR, SERVFAIL, NXDOMAIN, other */

struct dns_val {
	__u64 queries;
	__u64 rcode[DNS_RCODES];
	__u64 timeouts;
};

struct dns_sock {
	__u64 cgroup;
	__u32 outstanding;
	__u32 pad;
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 8192);
	__type(key, __u64);
	__type(value, struct dns_sock);
} dns_socks SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_HASH);
	__uint(max_entries, 4096);
	__uint(map_flags, BPF_F_NO_PREALLOC);
	__type(key, __u64);
	__type(value, struct dns_val);
} dns0 SEC(".maps"), dns1 SEC(".maps");

static __always_inline struct dns_val *dns_in(void *map, __u64 *cgroup)
{
	struct dns_val *v = bpf_map_lookup_elem(map, cgroup);
	if (v)
		return v;
	struct dns_val zero = {};
	bpf_map_update_elem(map, cgroup, &zero, BPF_NOEXIST);
	return bpf_map_lookup_elem(map, cgroup);
}

static __always_inline struct dns_val *dns(__u64 cgroup)
{
	__u32 idx = 0;
	__u32 *a = bpf_map_lookup_elem(&active, &idx);
	if (a && *a)
		return dns_in(&dns1, &cgroup);
	return dns_in(&dns0, &cgroup);
}

static __always_inline int dns_query(struct sock *sk, struct msghdr *msg)
{
	__u16 port = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));
	if (port == 0 && msg) {
		/* Unconnected socket (musl's sendto): the address is in the message. */
		void *name = BPF_CORE_READ(msg, msg_name);
		if (name) {
			struct sockaddr_in sa = {};
			bpf_probe_read_kernel(&sa, sizeof(sa), name);
			port = bpf_ntohs(sa.sin_port);
		}
	}
	if (port != 53)
		return 0;
	__u64 skp = (__u64)sk;
	struct dns_sock *ds = bpf_map_lookup_elem(&dns_socks, &skp);
	if (!ds && !in_scope(FILTERED_DNS))
		return 0;
	__u64 cg = bpf_get_current_cgroup_id();
	if (ds) {
		ds->outstanding++;
	} else {
		struct dns_sock fresh = {.cgroup = cg, .outstanding = 1};
		bpf_map_update_elem(&dns_socks, &skp, &fresh, BPF_ANY);
	}
	struct dns_val *v = dns(cg);
	if (v)
		v->queries++;
	return 0;
}

SEC("fentry/udp_sendmsg")
int BPF_PROG(on_dns_send, struct sock *sk, struct msghdr *msg, __u64 len)
{
	return dns_query(sk, msg);
}

SEC("fentry/udpv6_sendmsg")
int BPF_PROG(on_dns_send6, struct sock *sk, struct msghdr *msg, __u64 len)
{
	return dns_query(sk, msg);
}

SEC("fentry/__udp_enqueue_schedule_skb")
int BPF_PROG(on_dns_recv, struct sock *sk, struct sk_buff *skb)
{
	__u64 skp = (__u64)sk;
	struct dns_sock *ds = bpf_map_lookup_elem(&dns_socks, &skp);
	if (!ds)
		return 0;
	unsigned char *head = BPF_CORE_READ(skb, head);
	__u16 th = BPF_CORE_READ(skb, transport_header);
	/* UDP header (8 bytes) then the DNS header: id, flags, qdcount, ancount. */
	__u8 hdr[16] = {};
	if (bpf_probe_read_kernel(hdr, sizeof(hdr), head + th) < 0)
		return 0;
	__u16 sport = ((__u16)hdr[0] << 8) | hdr[1];
	if (sport != 53 || !(hdr[10] & 0x80)) /* from port 53, QR: a response */
		return 0;
	__u8 rcode = hdr[11] & 0x0f;
	__u32 slot = rcode == 0 ? 0 : rcode == 2 ? 1 : rcode == 3 ? 2 : 3;
	if (ds->outstanding > 0)
		ds->outstanding--;
	struct dns_val *v = dns(ds->cgroup);
	if (v && slot < DNS_RCODES)
		v->rcode[slot]++;

	__u16 ancount = ((__u16)hdr[14] << 8) | hdr[15];
	__u32 n = (((__u32)hdr[4] << 8) | hdr[5]) - 8; /* UDP length minus its header */
	if (n < 12 || n > 65535)
		return 0;
	if (rcode != 3 && (rcode != 0 || ancount == 0))
		return 0;
	/* The verifier needs the 512-byte bound first; NXDOMAIN only lowers it. */
	if (n > DNS_MSG_MAX)
		n = DNS_MSG_MAX;
	if (rcode == 3 && n > DNS_QUESTION_MAX)
		n = DNS_QUESTION_MAX;
	struct dns_msg *m = bpf_ringbuf_reserve(&dns_answers, sizeof(*m), 0);
	if (!m)
		return 0; /* full: user space is behind; the name falls back to /24 */
	m->cgroup = ds->cgroup;
	m->len = n;
	m->pad = 0;
	if (bpf_probe_read_kernel(m->data, n, head + th + 8) < 0) {
		bpf_ringbuf_discard(m, 0);
		return 0;
	}
	bpf_ringbuf_submit(m, 0);
	return 0;
}

SEC("fentry/udp_destroy_sock")
int BPF_PROG(on_dns_close, struct sock *sk)
{
	__u64 skp = (__u64)sk;
	struct dns_sock *ds = bpf_map_lookup_elem(&dns_socks, &skp);
	if (!ds)
		return 0;
	if (ds->outstanding > 0) {
		struct dns_val *v = dns(ds->cgroup);
		if (v)
			v->timeouts += ds->outstanding;
	}
	bpf_map_delete_elem(&dns_socks, &skp);
	return 0;
}
