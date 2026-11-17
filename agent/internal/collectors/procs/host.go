// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// NewHostReader reads the host's /proc at procRoot (/proc natively, /host/proc in a
// container): the executable's path and identity come from /proc/<pid>/exe, which needs
// CAP_SYS_PTRACE for other users' processes (ADR-209); without it they stay empty.
func NewHostReader(procRoot string) *Reader {
	abs, _ := filepath.Abs(procRoot)
	return &Reader{
		FS:   os.DirFS("/"),
		Root: strings.TrimPrefix(abs, "/"),
		Readlink: func(pid int) (string, error) {
			return os.Readlink(filepath.Join(abs, strconv.Itoa(pid), "exe"))
		},
		ReadlinkFD: func(pid int, fd string) (string, error) {
			return os.Readlink(filepath.Join(abs, strconv.Itoa(pid), "fd", fd))
		},
		// The executable's size and modification time: replacing the file (a release)
		// changes them.
		ExeIdentity: func(pid int) string {
			fi, err := os.Stat(filepath.Join(abs, strconv.Itoa(pid), "exe"))
			if err != nil {
				return ""
			}
			return fmt.Sprintf("%d-%d", fi.Size(), fi.ModTime().UnixNano())
		},
	}
}

// HostRoot is the host's root filesystem for ReadHints: os.DirFS("/") and the root's path
// relative to it ("" natively, "host/root" in a container).
func HostRoot(rootFS string) string {
	abs, _ := filepath.Abs(rootFS)
	return strings.TrimPrefix(abs, "/")
}
