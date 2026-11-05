// SPDX-License-Identifier: AGPL-3.0-only

//go:build !linux

package host

import "errors"

// The agent only runs on Linux; other platforms build for development and tests.
func statfs(string) (fsUsage, error) {
	return fsUsage{}, errors.New("statfs is only implemented on linux")
}
