// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"bufio"
	"io/fs"
	"path"
	"strings"
)

// GroupInfo is a process group's unit and the rule that named it, from the last scrape.
func (c *Collector) GroupInfo(name string) (unit, by string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, g := range c.groups {
		if g.name == name {
			return g.unit, g.by, true
		}
	}
	return "", "", false
}

// LogFiles are the files a process group's manager writes its output to (ADR-208's logs on
// demand): pm2's ~/.pm2/logs/<app>-out.log and -error.log, supervisord's stdout_logfile and
// stderr_logfile. Paths are relative to fsys (root is the host's root inside it); only
// files that exist are returned, as stream name → path.
func LogFiles(fsys fs.FS, root, group, by string) map[string]string {
	out := map[string]string{}
	switch by {
	case "pm2":
		homes := userHomes(fsys, root)
		// pm2 names the files after the app, its spaces and slashes as dashes.
		file := strings.NewReplacer(" ", "-", "/", "-").Replace(group)
		for _, home := range homes {
			for stream, suffix := range map[string]string{"stdout": "-out.log", "stderr": "-error.log"} {
				p := path.Join(home, ".pm2", "logs", file+suffix)
				if _, err := fs.Stat(fsys, p); err == nil {
					out[stream] = p
				}
			}
			if len(out) > 0 {
				return out
			}
		}
	case "supervisord":
		for stream, key := range map[string]string{"stdout": "stdout_logfile", "stderr": "stderr_logfile"} {
			if p := supervisorSetting(fsys, root, group, key); p != "" {
				p = strings.TrimPrefix(strings.ReplaceAll(p, "%(program_name)s", group), "/")
				if _, err := fs.Stat(fsys, path.Join(root, p)); err == nil {
					out[stream] = path.Join(root, p)
				}
			}
		}
	}
	return out
}

// supervisorSetting is a [program:<name>] setting, or "" (AUTO, NONE and syslog included).
func supervisorSetting(fsys fs.FS, root, program, key string) string {
	var files []string
	for _, pattern := range []string{
		"etc/supervisor/supervisord.conf", "etc/supervisord.conf",
		"etc/supervisor/conf.d/*.conf", "etc/supervisord.d/*.ini", "etc/supervisord.d/*.conf",
	} {
		m, _ := fs.Glob(fsys, path.Join(root, pattern))
		files = append(files, m...)
	}
	for _, f := range files {
		file, err := fsys.Open(f)
		if err != nil {
			continue
		}
		in := false
		sc := bufio.NewScanner(file)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if strings.HasPrefix(line, "[") {
				name, ok := strings.CutPrefix(strings.Trim(line, "[]"), "program:")
				in = ok && strings.TrimSpace(name) == program
				continue
			}
			if !in {
				continue
			}
			if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == key {
				_ = file.Close()
				v = strings.TrimSpace(v)
				switch strings.ToUpper(v) {
				case "", "AUTO", "NONE", "SYSLOG":
					return ""
				}
				return v
			}
		}
		_ = file.Close()
	}
	return ""
}
