// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"errors"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/watchlog-light/watchlog/agent/internal/logs"
)

// The API server's answers as measured on kind 1.35.
func TestLogErrorCodes(t *testing.T) {
	pods := schema.GroupResource{Resource: "pods"}
	cases := []struct {
		err      error
		previous bool
		code     string
	}{
		{apierrors.NewBadRequest(`previous terminated container "main" in pod "once-lwpzk" not found`), true, logs.CodeNoPrevious},
		{apierrors.NewBadRequest("container nope is not valid for pod postgres-0"), false, logs.CodeNotFound},
		{apierrors.NewNotFound(pods, "printer"), false, logs.CodeNotFound},
		{apierrors.NewForbidden(schema.GroupResource{Resource: "pods/log"}, "printer", errors.New("RBAC")), false, logs.CodeDisabled},
		{errors.New("connection refused"), false, logs.CodeReadFailed},
	}
	for _, c := range cases {
		var re *logs.ReadError
		if !errors.As(logError(c.err, c.previous), &re) || re.Code != c.code {
			t.Errorf("%v: got %v, want %s", c.err, re, c.code)
		}
	}
}

func TestLogReaderReadsThroughPodsLog(t *testing.T) {
	// client-go's fake answers every pods/log GET with "fake logs".
	cs := fake.NewClientset()
	var got []logs.Raw
	err := LogReader{Client: cs}.Read(context.Background(),
		logs.Request{Namespace: "logs-e2e", Pod: "printer", Container: "main", Lines: 10}, func(r logs.Raw) { got = append(got, r) })
	if err != nil || len(got) != 1 || got[0].Text != "fake logs" {
		t.Fatalf("err=%v got=%+v", err, got)
	}
	if err := (LogReader{Client: cs}).Read(context.Background(), logs.Request{Container: "main"}, func(logs.Raw) {}); err == nil {
		t.Fatal("a request without namespace and pod must fail")
	}
}
