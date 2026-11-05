// SPDX-License-Identifier: AGPL-3.0-only

// Package redact removes credentials from health check commands and probe output
// before they leave the host (ADR-047). It errs on the side of redacting too much;
// variable references such as $DB_PASSWORD are names, not secrets, and are kept.
package redact

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Mask replaces every redacted value.
const Mask = "***"

// value matches a secret value: up to whitespace, a quote or a separator. A value
// that is a shell variable reference ($X, ${X}) is matched by keep below instead.
const value = `[^\s'"&;,|]+`

// Each rule runs only when one of its hints occurs in the lower-cased text; most probe
// output contains none, which keeps redaction cheap (BenchmarkLine).
var rules = []struct {
	hints []string
	re    *regexp.Regexp
	repl  string
}{
	// Authorization-style headers: keep the scheme (Bearer, Basic, …), drop the credential.
	{[]string{"authorization"}, regexp.MustCompile(`(?i)\b((?:proxy-)?authorization\s*:\s*)((?:bearer|basic|token|digest|negotiate)\s+)?` + value), "${1}${2}" + Mask},
	{[]string{"api-key", "auth-token", "access-token"}, regexp.MustCompile(`(?i)\b((?:x-)?(?:api-key|auth-token|access-token)\s*:\s*)` + value), "${1}" + Mask},
	{[]string{"cookie"}, regexp.MustCompile(`(?i)\b(cookie\s*:\s*)[^'"]+`), "${1}" + Mask},
	// user:password@ in URLs (with or without a scheme); the user name stays.
	{[]string{"@"}, regexp.MustCompile(`((?:^|[\s'"=(/])[^\s'"/:@()]*):[^\s'"/@]+@`), "${1}:" + Mask + "@"},
	// curl/wget style -u user:pass, --user user:pass, --user=user:pass, -uuser:pass; a
	// quoted password may contain spaces. A value starting with "//" is a URL, not a password.
	{[]string{"-u"}, regexp.MustCompile(`((?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=)?'[^\s':]+):[^']*'`), "${1}:" + Mask + "'"},
	{[]string{"-u"}, regexp.MustCompile(`((?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=)?"[^\s":]+):[^"]*"`), "${1}:" + Mask + `"`},
	{[]string{"-u"}, regexp.MustCompile(`((?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=)?[^\s'":/]+):[^\s'"/*][^\s'"]*`), "${1}:" + Mask},
	// mysql/mysqladmin -p<password> (attached form) and redis-cli -a <password>.
	{[]string{"mysql"}, regexp.MustCompile(`(\bmysql\w*\b[^|;&]*?\s-p)[^\s'"$|;&][^\s'"|;&]*`), "${1}" + Mask},
	{[]string{"redis-cli"}, regexp.MustCompile(`(\bredis-cli\b[^|;&]*?\s(?:-a|--pass)\s+)[^\s'"$|;&][^\s'"|;&]*`), "${1}" + Mask},
	// --password value / --password=value and similar flags.
	{[]string{"pass", "pwd", "secret", "token", "key"}, regexp.MustCompile(`(?i)((?:^|\s)--?(?:password|passwd|pass|pwd|secret|token|api-?key|access-?key|auth-token)(?:\s+|=))[^\s'"$-][^\s'"]*`), "${1}" + Mask},
	// key=value pairs in query strings and environment-style assignments.
	{[]string{"pass", "pwd", "secret", "token", "key", "credential"}, regexp.MustCompile(`(?i)\b([\w.-]*(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?key|credential)[\w.-]*=)[^\s'"&;,|$][^\s'"&;,|]*`), "${1}" + Mask},
	// Well-known token formats.
	{[]string{"akia", "asia"}, regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`), Mask},
	{[]string{"gh"}, regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{36,}\b`), Mask},
	{[]string{"xox"}, regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), Mask},
	{[]string{"eyj"}, regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), Mask},
}

// Text redacts credentials in s.
func Text(s string) string {
	lower := strings.ToLower(s)
	for _, r := range rules {
		for _, h := range r.hints {
			if strings.Contains(lower, h) {
				s = r.re.ReplaceAllString(s, r.repl)
				lower = strings.ToLower(s)
				break
			}
		}
	}
	return s
}

// maxInput bounds the work per string; the daemon keeps at most 4 KiB of probe output.
const maxInput = 8 << 10

// Line redacts s, folds it onto one line (control characters and runs of
// whitespace become one space) and truncates it to at most max bytes on a UTF-8
// boundary, ending in "…" when cut.
func Line(s string, max int) string {
	if len(s) > maxInput {
		s = s[:maxInput]
	}
	s = strings.Join(strings.FieldsFunc(Text(s), func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}), " ")
	if len(s) <= max {
		return s
	}
	const ellipsis = "…"
	cut := max - len(ellipsis)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return strings.TrimRight(s[:cut], " ") + ellipsis
}
