// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/watchlog-light/watchlog/agent/internal/redact"
)

// MaxName is the longest group name (a label value).
const MaxName = 63

// Rule is a user's process-group rule (ADR-207's process-rules, evaluated on the server):
// every set field must match; Name is the group's name, where $1, $2 … are the Args
// pattern's captures. Patterns are Go regular expressions.
type Rule struct {
	Exe  string `json:"exe,omitempty"`  // a glob over the executable's base name
	Unit string `json:"unit,omitempty"` // a glob over the systemd unit
	Args string `json:"args,omitempty"` // a pattern over the arguments joined by spaces
	Name string `json:"name"`

	args *regexp.Regexp
}

// Compile checks a rule; a rule that doesn't compile is skipped with its error.
func (r *Rule) Compile() error {
	if r.Args == "" {
		return nil
	}
	re, err := regexp.Compile(r.Args)
	if err != nil {
		return err
	}
	r.args = re
	return nil
}

// Hints are what the built-in rules learn from outside /proc/<pid>: pm2's pid files and
// supervisord's programs.
type Hints struct {
	// PM2 maps a pid to its pm2 app's name (from ~/.pm2/pids/<app>-<id>.pid).
	PM2 map[int]string
	// Supervisord holds each program's name and command (from its configuration).
	Supervisord []Program
}

// Program is one supervisord [program:x].
type Program struct{ Name, Command string }

var interpreters = map[string]bool{
	"python": true, "python2": true, "python3": true, "node": true, "nodejs": true, "ruby": true,
	"perl": true, "php": true, "bun": true, "deno": true,
}

// base is an executable's or script's base name, without a version suffix on interpreters
// (python3.12 → python3).
func base(s string) string {
	b := path.Base(s)
	if strings.HasPrefix(b, "python") {
		if i := strings.IndexByte(b, '.'); i > 0 {
			b = b[:i]
		}
	}
	return b
}

func exeName(p Proc) string {
	if p.Exe != "" {
		return base(p.Exe)
	}
	if len(p.Args) > 0 && strings.HasPrefix(p.Args[0], "/") {
		return base(p.Args[0])
	}
	return p.Comm
}

// Name is the group a process belongs to and the rule that named it (for the preview and
// tests). parentComm is the parent process's comm.
func Name(p Proc, parentComm string, unit string, rules []Rule, h Hints) (name, by string) {
	exe := exeName(p)
	argline := strings.Join(p.Args, " ")
	for i := range rules {
		r := &rules[i]
		if r.Exe != "" && !glob(r.Exe, exe) || r.Unit != "" && !glob(r.Unit, unit) {
			continue
		}
		if r.args != nil {
			m := r.args.FindStringSubmatch(argline)
			if m == nil {
				continue
			}
			return clean(expand(r.Name, m)), "rule"
		}
		if r.Args == "" {
			return clean(r.Name), "rule"
		}
	}
	if app, ok := h.PM2[p.PID]; ok {
		return clean(app), "pm2"
	}
	if strings.HasPrefix(parentComm, "supervisord") || strings.Contains(parentComm, "supervisor") {
		if prog := matchProgram(p, h.Supervisord); prog != "" {
			return clean(prog), "supervisord"
		}
	}
	title := argline
	switch {
	case strings.HasPrefix(title, "php-fpm: pool "):
		return clean("pool " + strings.TrimSpace(strings.TrimPrefix(title, "php-fpm: pool "))), "php-fpm"
	case strings.HasPrefix(title, "php-fpm: master process"):
		return "php-fpm master", "php-fpm"
	case strings.HasPrefix(title, "gunicorn: "):
		if i, j := strings.IndexByte(title, '['), strings.LastIndexByte(title, ']'); i >= 0 && j > i {
			return clean("gunicorn " + title[i+1:j]), "gunicorn"
		}
	case strings.HasPrefix(title, "PM2 v") && strings.Contains(title, "God Daemon"):
		return "pm2", "pm2"
	}
	if n := wsgi(p, exe); n != "" {
		return clean(n), "gunicorn"
	}
	if exe == "java" {
		if n := javaName(p.Args); n != "" {
			return clean(n), "java"
		}
	}
	if interpreters[exe] {
		if s := script(p.Args); s != "" {
			return clean(s), "script"
		}
	}
	return clean(exe), "exe"
}

// wsgi names a gunicorn or uwsgi process by its application (gunicorn app:app,
// uwsgi --module app), whether started as a binary or through python.
func wsgi(p Proc, exe string) string {
	args := p.Args
	for i, a := range args {
		b := base(a)
		if b != "gunicorn" && b != "uwsgi" {
			continue
		}
		if i == 0 && exe != "gunicorn" && exe != "uwsgi" && !interpreters[exe] {
			continue
		}
		rest := args[i+1:]
		if b == "uwsgi" {
			for j, r := range rest {
				if (r == "--module" || r == "-w" || r == "--wsgi-file") && j+1 < len(rest) {
					return "uwsgi " + base(rest[j+1])
				}
			}
			return "uwsgi"
		}
		app := ""
		for j := 0; j < len(rest); j++ {
			r := rest[j]
			if strings.HasPrefix(r, "-") {
				// Options that take a value as the next argument.
				if !strings.Contains(r, "=") && j+1 < len(rest) && optWithValue[r] {
					j++
				}
				continue
			}
			app = r
		}
		if app == "" {
			return "gunicorn"
		}
		return "gunicorn " + app
	}
	return ""
}

var optWithValue = map[string]bool{
	"-b": true, "--bind": true, "-w": true, "--workers": true, "-k": true, "--worker-class": true,
	"-c": true, "--config": true, "--chdir": true, "-t": true, "--timeout": true, "--log-level": true,
	"--access-logfile": true, "--error-logfile": true, "-u": true, "-g": true, "--user": true, "--group": true,
}

// javaName is the -jar file's base name, else the main class (skipping options and the
// class path's value).
func javaName(args []string) string {
	for i := 1; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-jar" && i+1 < len(args):
			return base(args[i+1])
		case a == "-cp" || a == "-classpath" || a == "--class-path" || a == "-p" || a == "--module-path":
			i++
		case a == "-m" || a == "--module":
			if i+1 < len(args) {
				return args[i+1]
			}
		case strings.HasPrefix(a, "-"):
		default:
			return a
		}
	}
	return ""
}

// script is an interpreter's script or module: `python3 worker.py` → worker.py,
// `python3 -m celery …` → celery, `node dist/server.js` → server.js.
func script(args []string) string {
	for i := 1; i < len(args); i++ {
		a := args[i]
		if a == "-m" && i+1 < len(args) {
			return args[i+1]
		}
		if a == "-c" || a == "-e" || a == "--eval" {
			return ""
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		return base(a)
	}
	return ""
}

// matchProgram finds the supervisord program whose command this process runs: its
// arguments, compared with the command's words (interpreter paths may differ).
func matchProgram(p Proc, programs []Program) string {
	argline := strings.Join(p.Args, " ")
	best := ""
	for _, prog := range programs {
		words := strings.Fields(prog.Command)
		if len(words) == 0 {
			continue
		}
		if argline == strings.Join(words, " ") {
			return prog.Name
		}
		// "python3 /opt/app/worker.py" vs "/usr/bin/python3 /opt/app/worker.py".
		if len(words) == len(p.Args) && base(words[0]) == base(p.Args[0]) &&
			strings.Join(words[1:], " ") == strings.Join(p.Args[1:], " ") {
			best = prog.Name
		}
	}
	return best
}

func glob(pattern, s string) bool {
	ok, err := path.Match(pattern, s)
	return err == nil && ok
}

// expand fills $1 … $9 with a pattern's captures.
func expand(tmpl string, m []string) string {
	out := tmpl
	for i := min(len(m)-1, 9); i >= 1; i-- {
		out = strings.ReplaceAll(out, "$"+strconv.Itoa(i), m[i])
	}
	return out
}

// clean redacts secrets out of a derived name and keeps it to one short label value.
func clean(s string) string {
	s = redact.Text(strings.TrimSpace(s))
	if len(s) > MaxName {
		s = s[:MaxName]
	}
	if s == "" {
		return "unnamed"
	}
	return s
}
