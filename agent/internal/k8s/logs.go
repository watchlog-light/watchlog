// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"errors"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"

	"github.com/watchlog-light/watchlog/agent/internal/logs"
)

// LogReader reads a pod container's log through the API server's pods/log (ADR-167),
// which asks the kubelet: `get` on pods/log is the cluster-agent's only grant for it. No
// nodes/proxy (ADR-049), no host paths.
type LogReader struct {
	Client kubernetes.Interface
}

// Read implements logs.Reader.
func (k LogReader) Read(ctx context.Context, req logs.Request, emit func(logs.Raw)) error {
	if req.Namespace == "" || req.Pod == "" {
		return &logs.ReadError{Code: logs.CodeNotFound, Detail: "a pod log needs the namespace and the pod"}
	}
	tail := int64(req.Lines)
	opts := &corev1.PodLogOptions{
		Container:  req.Container,
		TailLines:  &tail,
		Timestamps: true,
		Previous:   req.Previous,
		Follow:     req.Follow && !req.Previous,
	}
	stream, err := k.Client.CoreV1().Pods(req.Namespace).GetLogs(req.Pod, opts).Stream(ctx)
	if err != nil {
		return logError(err, req.Previous)
	}
	defer func() { _ = stream.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()
	err = logs.ScanLines(stream, func(s string) { emit(logs.Raw{Text: s}) })
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// logError maps the API server's answers (measured on kind 1.35: 400 "container X is not
// valid for pod Y", 400 `previous terminated container "X" in pod "Y" not found`, 404 for
// a pod that is gone, 403 without the pods/log grant).
func logError(err error, previous bool) error {
	msg := err.Error()
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		msg = status.Status().Message
	}
	switch {
	case apierrors.IsForbidden(err):
		return &logs.ReadError{Code: logs.CodeDisabled, Detail: "the cluster-agent may not read pods/log (logs.enabled is false)"}
	case apierrors.IsNotFound(err):
		return &logs.ReadError{Code: logs.CodeNotFound, Detail: "the pod is gone"}
	case previous && strings.Contains(msg, "previous terminated container"):
		return &logs.ReadError{Code: logs.CodeNoPrevious, Detail: msg}
	case strings.Contains(msg, "is not valid for pod"):
		return &logs.ReadError{Code: logs.CodeNotFound, Detail: msg}
	}
	return &logs.ReadError{Code: logs.CodeReadFailed, Detail: msg}
}
