/* SPDX-License-Identifier: GPL-2.0-only OR MIT */
/*
 * Process exits on a server (ADR-208, ADR-210): when a process (a thread group's leader)
 * ends, its tgid, exit status, terminating signal, whether the OOM killer chose it, its
 * cgroup and its comm go to user space through a ring buffer. User space attributes the
 * exit to a service or a process group and drops the pid: none leaves the agent.
 *
 * Measured (0.9 slice 1): systemd's D-Bus reports exit status 0 again once a unit is
 * restarted, and a restarted unit's memory.events reads oom_kill 0, so exit codes and OOM
 * kills come from here. Only the BTF raw tracepoint sched_process_exit is used: no tracefs,
 * no pt_regs, one little-endian object for amd64 and arm64. The OOM mark is the victim's
 * signal->oom_mm (mark_oom_victim, kernel 4.11+), not the oom/mark_victim tracepoint,
 * whose arguments changed in 6.8.
 */
#include "types.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

char LICENSE[] SEC("license") = "Dual MIT/GPL";

struct exit_event {
	__u32 tgid;
	__s32 exit_code; /* the kernel's wait status: (status << 8) | signal, 0x80 for a core */
	__u64 cgroup;    /* the cgroup v2 id of the exiting task */
	__u32 ppid;      /* the parent's tgid: 1 for a systemd service's main process */
	__u8 oom;        /* 1 when the OOM killer chose it */
	__u8 _pad[3];
	char comm[16];
	/* The cgroup's own name (orders.service): a unit is recreated with a new cgroup id on
	 * every restart, and several restarts can fall between two scrapes (measured). */
	char cgroup_name[64];
};

/* Keeps exit_event in the object's BTF for bpf2go's Go type (ring buffers carry no type). */
const struct exit_event *unused_exit_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} exits SEC(".maps");

/* Events lost because the ring buffer was full: a self-metric. */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u64);
} exits_dropped SEC(".maps");

/*
 * Cgroup filter (ADR-211): with `exit_filter` on, an exit is recorded only when the task's
 * cgroup or one of its ancestors is in `exit_roots` (a server inside a container records
 * none of the machine it runs on). Off by default: every exit on the kernel.
 */
#define EXIT_ROOTS_MAX 16
#define EXIT_CGROUP_DEPTH_MAX 16

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, EXIT_ROOTS_MAX);
	__type(key, __u64);
	__type(value, __u8);
} exit_roots SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u32);
} exit_filter SEC(".maps");

static __always_inline int exit_in_scope(struct task_struct *p)
{
	__u32 zero = 0;
	__u32 *on = bpf_map_lookup_elem(&exit_filter, &zero);
	if (!on || !*on)
		return 1;
	struct cgroup *cg = BPF_CORE_READ(p, cgroups, dfl_cgrp);
	for (int i = 0; i < EXIT_CGROUP_DEPTH_MAX && cg; i++) {
		__u64 id = BPF_CORE_READ(cg, kn, id);
		if (bpf_map_lookup_elem(&exit_roots, &id))
			return 1;
		cg = (struct cgroup *)BPF_CORE_READ(cg, self.parent);
	}
	return 0;
}

/*
 * A task's pid in its innermost pid namespace: the one an agent in that namespace (a
 * server inside a container) reads in /proc; the same as tgid on the host.
 */
static __always_inline int ns_pid(struct task_struct *t)
{
	struct pid *pp = BPF_CORE_READ(t, thread_pid);
	if (!pp)
		return BPF_CORE_READ(t, tgid);
	unsigned int level = BPF_CORE_READ(pp, level);
	if (level > 32)
		return BPF_CORE_READ(t, tgid);
	struct upid up = {};
	if (bpf_probe_read_kernel(&up, sizeof(up), &pp->numbers[level]) < 0)
		return BPF_CORE_READ(t, tgid);
	return up.nr;
}

SEC("tp_btf/sched_process_exit")
int BPF_PROG(on_process_exit, struct task_struct *p)
{
	int pid = BPF_CORE_READ(p, pid);
	int tgid = BPF_CORE_READ(p, tgid);
	if (pid != tgid) /* a thread, not the process */
		return 0;
	if (!exit_in_scope(p))
		return 0;
	struct exit_event *e = bpf_ringbuf_reserve(&exits, sizeof(*e), 0);
	if (!e) {
		__u32 zero = 0;
		__u64 *n = bpf_map_lookup_elem(&exits_dropped, &zero);
		if (n)
			*n += 1;
		return 0;
	}
	e->tgid = ns_pid(p);
	e->exit_code = BPF_CORE_READ(p, exit_code);
	e->cgroup = bpf_get_current_cgroup_id();
	e->oom = BPF_CORE_READ(p, signal, oom_mm) != 0;
	struct task_struct *parent = BPF_CORE_READ(p, real_parent);
	e->ppid = parent ? ns_pid(parent) : 0;
	__builtin_memset(e->_pad, 0, sizeof(e->_pad));
	bpf_get_current_comm(e->comm, sizeof(e->comm));
	const char *name = BPF_CORE_READ(p, cgroups, dfl_cgrp, kn, name);
	if (bpf_probe_read_kernel_str(e->cgroup_name, sizeof(e->cgroup_name), name) < 0)
		e->cgroup_name[0] = 0;
	bpf_ringbuf_submit(e, 0);
	return 0;
}
