// SPDX-License-Identifier: AGPL-3.0-only

package redact

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestText(t *testing.T) {
	cases := []struct{ name, in, want string }{
		// Captured from the Lima VM (fx-unhealthy's health check).
		{"captured check", `wget -qO- --header 'Authorization: Bearer fixture-token-123' http://admin:s3cret@127.0.0.1:9/health || exit 1`,
			`wget -qO- --header 'Authorization: Bearer ***' http://admin:***@127.0.0.1:9/health || exit 1`},
		{"url userinfo", `curl -f https://user:p4ss@example.com/health`, `curl -f https://user:***@example.com/health`},
		{"empty user", `redis-cli -u redis://:hunter2@localhost:6379 ping`, `redis-cli -u redis://:***@localhost:6379 ping`},
		{"encoded @ in password", `curl http://bob:p%40ss@db/health`, `curl http://bob:***@db/health`},
		{"no scheme", `mongosh admin:pw@mongo:27017/test`, `mongosh admin:***@mongo:27017/test`},
		{"curl -u", `curl -u admin:s3cret http://localhost/`, `curl -u admin:*** http://localhost/`},
		// Container log lines (ADR-167), measured on the e2e stack.
		{"log key=value", `connecting with password=hunter2 to db`, `connecting with password=*** to db`},
		{"json fields", `{"level":"info","user":"bob","password":"hunter2","token":"abc123"}`, `{"level":"info","user":"bob","password":"***","token":"***"}`},
		{"json spaced", `{"api_key": "sk live 123", "n": 1}`, `{"api_key": "***", "n": 1}`},
		{"yaml field", `  password: hunter2`, `  password: ***`},
		{"log field", `level=info db_password: hunter2 retry`, `level=info db_password: *** retry`},
		{"json variable kept", `{"password":"$DB_PASSWORD"}`, `{"password":"$DB_PASSWORD"}`},
		{"no value", `token:`, `token:`},
		{"curl --user=", `curl --user=admin:s3cret localhost`, `curl --user=admin:*** localhost`},
		{"curl -u quoted with space", `curl -u 'admin:s e' localhost`, `curl -u 'admin:***' localhost`},
		{"curl --user double-quoted", `curl --user "admin:p w" localhost`, `curl --user "admin:***" localhost`},
		{"curl -uattached", `curl -uadmin:s3cret localhost`, `curl -uadmin:*** localhost`},
		{"password flag =", `pg_isready --password=hunter2 -h db`, `pg_isready --password=*** -h db`},
		{"password flag space", `healthcheck --token abc.def --verbose`, `healthcheck --token *** --verbose`},
		{"query token", `wget -qO- "http://localhost/health?token=abc123&x=1"`, `wget -qO- "http://localhost/health?token=***&x=1"`},
		{"env assignment", `PGPASSWORD=hunter2 psql -h db -c 'select 1'`, `PGPASSWORD=*** psql -h db -c 'select 1'`},
		{"api_key", `check api_key=XYZ`, `check api_key=***`},
		{"mysql -p attached", `mysqladmin ping -h localhost -uroot -phunter2`, `mysqladmin ping -h localhost -uroot -p***`},
		{"redis-cli -a", `redis-cli -a hunter2 ping`, `redis-cli -a *** ping`},
		{"x-api-key header", `curl -H "X-Api-Key: abc123" localhost`, `curl -H "X-Api-Key: ***" localhost`},
		{"basic header", `Authorization: Basic dXNlcjpwYXNz`, `Authorization: Basic ***`},
		{"bare authorization", `authorization:abc`, `authorization:***`},
		{"aws access key", `aws s3 ls --profile x AKIAIOSFODNN7EXAMPLE`, `aws s3 ls --profile x ***`},
		{"aws secret env", `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls`, `AWS_SECRET_ACCESS_KEY=*** aws s3 ls`},
		{"github token", `git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y`, `git clone https://***@github.com/x/y`},
		{"jwt", `got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`, `got ***`},

		// Must stay unchanged.
		{"plain url", `curl -f http://localhost:8080/health`, `curl -f http://localhost:8080/health`},
		{"image digest", `nginx@sha256:abcdef0123456789`, `nginx@sha256:abcdef0123456789`},
		{"email", `notify admin@example.com`, `notify admin@example.com`},
		{"user without password", `postgres://postgres@db:5432/app`, `postgres://postgres@db:5432/app`},
		{"uid flag", `pg_isready -U postgres -u 1000`, `pg_isready -U postgres -u 1000`},
		{"time with colon", `started 12:30:45 ok`, `started 12:30:45 ok`},
		{"variable reference", `mysqladmin ping -uroot -p$MYSQL_ROOT_PASSWORD`, `mysqladmin ping -uroot -p$MYSQL_ROOT_PASSWORD`},
		{"variable in flag", `redis-cli -a "$REDIS_PASSWORD" ping`, `redis-cli -a "$REDIS_PASSWORD" ping`},
		{"variable assignment", `PGPASSWORD=$DB_PASS psql`, `PGPASSWORD=$DB_PASS psql`},
		{"git sha", `commit 0123456789abcdef0123456789abcdef01234567`, `commit 0123456789abcdef0123456789abcdef01234567`},
		{"passive flag", `ftp --passive host`, `ftp --passive host`},
		{"prose about tokens", `invalid token for user`, `invalid token for user`},
		{"captured output", "wget: can't connect to remote host (127.0.0.1): Connection refused\n", "wget: can't connect to remote host (127.0.0.1): Connection refused\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Text(tc.in); got != tc.want {
				t.Errorf("\n in: %s\ngot: %s\nwant: %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestLine(t *testing.T) {
	cases := []struct {
		name, in string
		max      int
		want     string
	}{
		{"folds lines and controls", "Connecting to db\r\n\twget: error\x00 here\n", 512, "Connecting to db wget: error here"},
		{"redacts before folding", "GET /?token=abc\nok", 512, "GET /?token=*** ok"},
		{"short stays", "ok", 2, "ok"},
		{"truncates with ellipsis", "abcdefghij", 8, "abcde…"},
		{"utf-8 boundary", "ééééé", 8, "éé…"}, // é is 2 bytes; "…" is 3
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Line(tc.in, tc.max)
			if got != tc.want || len(got) > tc.max || !utf8.ValidString(got) {
				t.Errorf("Line(%q, %d) = %q (%d bytes), want %q", tc.in, tc.max, got, len(got), tc.want)
			}
		})
	}
	long := Line(strings.Repeat("x", 5000)+" token=abc", 512)
	if len(long) > 512 || strings.Contains(long, "abc") {
		t.Errorf("long output not bounded: %d bytes", len(long))
	}
}

func BenchmarkLine(b *testing.B) {
	// 4 KiB, the most the daemon keeps per probe, typical connection-error output.
	out := strings.Repeat("Connecting to 127.0.0.1:9 (127.0.0.1:9)\nwget: can't connect: Connection refused\n", 60)[:4096]
	b.ReportAllocs()
	for b.Loop() {
		_ = Line(out, 512)
	}
}
