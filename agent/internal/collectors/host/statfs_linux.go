// SPDX-License-Identifier: AGPL-3.0-only

//go:build linux

package host

import "syscall"

func statfs(path string) (fsUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return fsUsage{}, err
	}
	bsize := float64(st.Bsize)
	return fsUsage{
		size:  float64(st.Blocks) * bsize,
		free:  float64(st.Bfree) * bsize,
		avail: float64(st.Bavail) * bsize,
	}, nil
}
