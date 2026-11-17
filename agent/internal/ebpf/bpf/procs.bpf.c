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

SEC("tp_btf/sched_process_exit")
int BPF_PROG(on_process_exit, struct task_struct *p)
{
	int pid = BPF_CORE_READ(p, pid);
	int tgid = BPF_CORE_READ(p, tgid);
	if (pid != tgid) /* a thread, not the process */
		return 0;
	struct exit_event *e = bpf_ringbuf_reserve(&exits, sizeof(*e), 0);
	if (!e) {
		__u32 zero = 0;
		__u64 *n = bpf_map_lookup_elem(&exits_dropped, &zero);
		if (n)
			*n += 1;
		return 0;
	}
	e->tgid = tgid;
	e->exit_code = BPF_CORE_READ(p, exit_code);
	e->cgroup = bpf_get_current_cgroup_id();
	e->oom = BPF_CORE_READ(p, signal, oom_mm) != 0;
	e->ppid = BPF_CORE_READ(p, real_parent, tgid);
	__builtin_memset(e->_pad, 0, sizeof(e->_pad));
	bpf_get_current_comm(e->comm, sizeof(e->comm));
	const char *name = BPF_CORE_READ(p, cgroups, dfl_cgrp, kn, name);
	if (bpf_probe_read_kernel_str(e->cgroup_name, sizeof(e->cgroup_name), name) < 0)
		e->cgroup_name[0] = 0;
	bpf_ringbuf_submit(e, 0);
	return 0;
}
