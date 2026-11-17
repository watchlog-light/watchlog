// SPDX-License-Identifier: AGPL-3.0-only

package procs

import (
	"bufio"
	"io/fs"
	"path"
	"strconv"
	"strings"
)

// ReadHints reads pm2's pid files and supervisord's programs below a root filesystem of an
// fs.FS ("" for os.DirFS("/"), or the host's root in a container). Missing files are fine.
func ReadHints(fsys fs.FS, root string) Hints {
	return Hints{PM2: pm2Apps(fsys, root), Supervisord: supervisorPrograms(fsys, root)}
}

// pm2Apps maps pids to app names from every user's ~/.pm2/pids/<app>-<id>.pid (measured:
// pm2 rewrites its apps' titles and drops their arguments, so /proc can't tell them apart).
func pm2Apps(fsys fs.FS, root string) map[int]string {
	out := map[int]string{}
	var homes []string
	if entries, err := fs.ReadDir(fsys, path.Join(root, "home")); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				homes = append(homes, path.Join(root, "home", e.Name()))
			}
		}
	}
	homes = append(homes, path.Join(root, "root"))
	for _, home := range homes {
		dir := path.Join(home, ".pm2", "pids")
		entries, err := fs.ReadDir(fsys, dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name, ok := strings.CutSuffix(e.Name(), ".pid")
			if !ok {
				continue
			}
			// "<app>-<id>": the app's name may hold dashes; the id is the last part.
			i := strings.LastIndexByte(name, '-')
			if i <= 0 {
				continue
			}
			if _, err := strconv.Atoi(name[i+1:]); err != nil {
				continue
			}
			b, err := fs.ReadFile(fsys, path.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
				out[pid] = name[:i]
			}
		}
	}
	return out
}

// supervisorPrograms reads [program:x] sections' commands from supervisord's usual
// configuration files (Debian's conf.d, RHEL's supervisord.d, the main file).
func supervisorPrograms(fsys fs.FS, root string) []Program {
	var files []string
	for _, pattern := range []string{
		"etc/supervisor/supervisord.conf", "etc/supervisord.conf",
		"etc/supervisor/conf.d/*.conf", "etc/supervisord.d/*.ini", "etc/supervisord.d/*.conf",
	} {
		m, _ := fs.Glob(fsys, path.Join(root, pattern))
		files = append(files, m...)
	}
	seen := map[string]bool{}
	var out []Program
	for _, f := range files {
		file, err := fsys.Open(f)
		if err != nil {
			continue
		}
		var prog string
		sc := bufio.NewScanner(file)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if strings.HasPrefix(line, "[") {
				prog = ""
				if name, ok := strings.CutPrefix(strings.Trim(line, "[]"), "program:"); ok {
					prog = strings.TrimSpace(name)
				}
				continue
			}
			if prog == "" {
				continue
			}
			if k, v, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) == "command" && !seen[prog] {
				seen[prog] = true
				out = append(out, Program{Name: prog, Command: strings.TrimSpace(v)})
			}
		}
		_ = file.Close()
	}
	return out
}
