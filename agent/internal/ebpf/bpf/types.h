/* SPDX-License-Identifier: GPL-2.0-only OR MIT */
/*
 * The few kernel types the flow programs read, as CO-RE definitions: field offsets are
 * relocated against the running kernel's BTF at load time, so these need only the
 * names, not the real layout (ADR-100). Anonymous unions in the kernel are matched by
 * field name.
 */
#ifndef WATCHLOG_TYPES_H
#define WATCHLOG_TYPES_H

typedef unsigned char __u8;
typedef unsigned short __u16;
typedef unsigned int __u32;
typedef unsigned long long __u64;
typedef signed int __s32;
typedef signed long long __s64;
typedef __u16 __be16;
typedef __u32 __be32;
typedef __u32 __wsum;
typedef _Bool bool;
#define true 1
#define false 0

enum bpf_map_type {
	BPF_MAP_TYPE_HASH = 1,
	BPF_MAP_TYPE_ARRAY = 2,
	BPF_MAP_TYPE_PERCPU_HASH = 5,
	BPF_MAP_TYPE_PERCPU_ARRAY = 6,
	BPF_MAP_TYPE_LRU_HASH = 9,
	BPF_MAP_TYPE_RINGBUF = 27,
};
enum {
	BPF_ANY = 0,
	BPF_NOEXIST = 1,
	BPF_F_NO_PREALLOC = 1,
};

struct in6_addr {
	union {
		__u8 u6_addr8[16];
	} in6_u;
} __attribute__((preserve_access_index));

struct sock_common {
	__be32 skc_daddr;
	__be16 skc_dport;
	__u16 skc_num; /* local port, host order */
	unsigned short skc_family;
	volatile unsigned char skc_state;
	struct in6_addr skc_v6_daddr;
} __attribute__((preserve_access_index));

struct sock {
	struct sock_common __sk_common;
	__u16 sk_protocol;
} __attribute__((preserve_access_index));

/* DNS (Phase 4 slice 5): only the UDP and DNS headers are read, never the payload. */
struct sk_buff {
	unsigned char *head;
	__u16 transport_header;
} __attribute__((preserve_access_index));

struct msghdr {
	void *msg_name;
	int msg_namelen;
} __attribute__((preserve_access_index));

struct sockaddr_in {
	unsigned short sin_family;
	__be16 sin_port;
};

/*
 * The pod filter (ADR-121) walks the current task's cgroup v2 ancestors:
 * task->cgroups->dfl_cgrp, then cgroup->self.parent (self is struct cgroup's first
 * member, so the parent css is its cgroup). kn->id is the cgroup id
 * bpf_get_current_cgroup_id() returns and the cgroup directory's inode (5.5+).
 */
struct kernfs_node {
	__u64 id;
} __attribute__((preserve_access_index));

struct cgroup_subsys_state {
	struct cgroup_subsys_state *parent;
} __attribute__((preserve_access_index));

struct cgroup {
	struct cgroup_subsys_state self;
	struct kernfs_node *kn;
} __attribute__((preserve_access_index));

struct css_set {
	struct cgroup *dfl_cgrp;
} __attribute__((preserve_access_index));

struct task_struct {
	struct css_set *cgroups;
} __attribute__((preserve_access_index));

#define AF_INET 2
#define AF_INET6 10
#define IPPROTO_TCP 6
#define TCP_ESTABLISHED 1
#define TCP_SYN_SENT 2
#define TCP_CLOSE 7

#endif
