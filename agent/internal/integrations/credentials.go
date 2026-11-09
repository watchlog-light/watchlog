// SPDX-License-Identifier: AGPL-3.0-only

package integrations

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// SecretsDir is where a Docker host keeps passwords for the collector (ADR-134), mounted
// read-only: `-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro`.
const SecretsDir = "/etc/watchlog/secrets" //nolint:gosec // G101: a directory path, not a credential

// CredentialTTL is how long a password read from a Secret or a file is reused.
const CredentialTTL = time.Minute

// fileName is a file directly under SecretsDir: no path, no dot file.
var fileName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`)

// SecretReader reads one key of one Kubernetes Secret.
type SecretReader interface {
	Read(ctx context.Context, namespace, name, key string) (string, error)
}

// Credentials turns a Credential into a user and password. Passwords are kept in
// memory for CredentialTTL; nothing is written to disk or logged.
type Credentials struct {
	Secrets SecretReader // nil outside Kubernetes
	Dir     string       // SecretsDir; replaced in tests

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	password string
	at       time.Time
}

// Resolve returns the user and password to log in with; nil when none is needed.
func (c *Credentials) Resolve(ctx context.Context, cred *Credential) (*Auth, error) {
	if cred == nil {
		return nil, nil
	}
	if cred.Secret == nil && cred.File == "" {
		return &Auth{Username: cred.Username, Password: cred.Password}, nil
	}
	key := "file:" + cred.File
	if cred.Secret != nil {
		key = "secret:" + cred.Secret.Namespace + "/" + cred.Secret.Name + "/" + cred.Secret.Key
	}
	c.mu.Lock()
	if hit, ok := c.cache[key]; ok && time.Since(hit.at) < CredentialTTL {
		c.mu.Unlock()
		return &Auth{Username: cred.Username, Password: hit.password}, nil
	}
	c.mu.Unlock()

	var password string
	var err error
	if cred.Secret != nil {
		if c.Secrets == nil {
			return nil, errors.New("a Kubernetes Secret can only be read by the collector in a cluster")
		}
		password, err = c.Secrets.Read(ctx, cred.Secret.Namespace, cred.Secret.Name, cred.Secret.Key)
	} else {
		password, err = c.readFile(cred.File)
	}
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.cache == nil {
		c.cache = map[string]cached{}
	}
	c.cache[key] = cached{password: password, at: time.Now()}
	c.mu.Unlock()
	return &Auth{Username: cred.Username, Password: password}, nil
}

// Forget drops cached passwords that no target or probe uses any more.
func (c *Credentials) Forget(keep func(key string) bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.cache {
		if !keep(k) {
			delete(c.cache, k)
		}
	}
}

func (c *Credentials) readFile(name string) (string, error) {
	if !fileName.MatchString(name) {
		return "", fmt.Errorf("the password file must be a plain name under %s", SecretsDir)
	}
	dir := c.Dir
	if dir == "" {
		dir = SecretsDir
	}
	// G304: name matched fileName above (no separator, no dot file), so the path stays
	// directly under dir.
	b, err := os.ReadFile(filepath.Join(dir, name)) //nolint:gosec // see above
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "", fmt.Errorf("%s/%s doesn't exist: create it on the host and mount %s read-only into the collector", SecretsDir, name, SecretsDir)
	case errors.Is(err, os.ErrPermission):
		return "", fmt.Errorf("%s/%s can't be read by the collector: it runs as root without extra capabilities, so the folder and the file must belong to root (sudo install -d -m 0700 %s)", SecretsDir, name, SecretsDir)
	case err != nil:
		return "", fmt.Errorf("reading %s/%s failed", SecretsDir, name)
	}
	return strings.TrimRight(string(b), "\r\n"), nil
}

// KubeSecrets reads Secrets through the API server with the pod's ServiceAccount token,
// without client-go. It can read only what a Role grants it: by default nothing.
type KubeSecrets struct {
	Base      string // https://host:port
	Client    *http.Client
	TokenPath string
}

const saDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// InClusterSecrets returns a reader for the cluster the collector runs in.
func InClusterSecrets() (*KubeSecrets, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not running in a Kubernetes cluster")
	}
	ca, err := os.ReadFile(saDir + "/ca.crt")
	if err != nil {
		return nil, fmt.Errorf("reading the cluster CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("the cluster CA is not valid PEM")
	}
	return &KubeSecrets{
		Base: "https://" + net.JoinHostPort(host, port),
		Client: &http.Client{
			Timeout:   DialTimeout,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		},
		TokenPath: saDir + "/token",
	}, nil
}

// Namespace is the collector's own namespace, from its ServiceAccount.
func Namespace() string {
	if v := os.Getenv("WATCHLOG_POD_NAMESPACE"); v != "" {
		return v
	}
	b, err := os.ReadFile(saDir + "/namespace")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Read implements SecretReader.
func (k *KubeSecrets) Read(ctx context.Context, namespace, name, key string) (string, error) {
	where := namespace + "/" + name
	token, err := os.ReadFile(k.TokenPath) // re-read: the token rotates
	if err != nil {
		return "", errors.New("the collector has no ServiceAccount token")
	}
	u := k.Base + "/api/v1/namespaces/" + url.PathEscape(namespace) + "/secrets/" + url.PathEscape(name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Accept", "application/json")
	res, err := k.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("reading the Secret %s: the API server didn't answer", where)
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden:
		return "", fmt.Errorf("the collector may not read the Secret %s: run the role and rolebinding commands WatchLog shows", where)
	case http.StatusNotFound:
		return "", fmt.Errorf("the Secret %s doesn't exist", where)
	default:
		return "", fmt.Errorf("reading the Secret %s failed: HTTP %d", where, res.StatusCode)
	}
	var body struct {
		Data map[string]string `json:"data"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, res.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("the Secret %s couldn't be read", where)
	}
	enc, ok := body.Data[key]
	if !ok {
		return "", fmt.Errorf("the Secret %s has no key %q", where, key)
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", fmt.Errorf("the key %q of the Secret %s isn't valid", key, where)
	}
	return strings.TrimRight(string(raw), "\r\n"), nil
}
