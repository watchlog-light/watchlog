// SPDX-License-Identifier: AGPL-3.0-only

package jobs

import (
	"bufio"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// CronEntry is one line of a crontab. Command stays on the server: only Name, the schedule
// and where the line was found are sent (ADR-223).
type CronEntry struct {
	Name     string
	Schedule Schedule
	Source   string // /etc/crontab, /etc/cron.d/<file>, "user crontab"
	Command  string // never sent
}

var systemCrontabs = []string{"etc/crontab", "etc/cron.d/*"}
var userCrontabs = []string{"var/spool/cron/crontabs/*", "var/spool/cron/*"}

// ParseCrontabs reads the server's crontabs under root (the host's filesystem). A user's
// crontab is read with the agent's CAP_DAC_READ_SEARCH (ADR-209); nothing of it leaves the
// server but each line's derived name and schedule.
func ParseCrontabs(root fs.FS) []CronEntry {
	var out []CronEntry
	read := func(globs []string, system bool) {
		for _, g := range globs {
			files, _ := fs.Glob(root, g)
			sort.Strings(files)
			for _, f := range files {
				if st, err := fs.Stat(root, f); err != nil || st.IsDir() || skipFile(f) {
					continue
				}
				src := "/" + f
				if !system {
					src = "user crontab"
				}
				out = append(out, parseCrontab(root, f, src, system)...)
			}
		}
	}
	read(systemCrontabs, true)
	read(userCrontabs, false)
	return numbered(out)
}

// numbered: two lines with the same name are numbered, so each is its own job.
func numbered(es []CronEntry) []CronEntry {
	seen := map[string]int{}
	for i := range es {
		seen[es[i].Name]++
		if n := seen[es[i].Name]; n > 1 {
			es[i].Name += " (" + strconv.Itoa(n) + ")"
		}
	}
	return es
}

// skipFile: cron ignores hidden, backup and package-manager files.
func skipFile(f string) bool {
	b := path.Base(f)
	return strings.HasPrefix(b, ".") || strings.HasSuffix(b, "~") || strings.Contains(b, ".dpkg-") ||
		strings.HasSuffix(b, ".rpmnew") || strings.HasSuffix(b, ".rpmsave") || b == "cron.deny" || b == "cron.allow"
}

func parseCrontab(root fs.FS, file, source string, system bool) []CronEntry {
	f, err := root.Open(file)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	var out []CronEntry
	sc := bufio.NewScanner(io.LimitReader(f, 1<<20))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || envRe.MatchString(line) {
			continue
		}
		var spec, rest string
		if strings.HasPrefix(line, "@") {
			spec, rest = cutWords(line, 1)
		} else {
			spec, rest = cutWords(line, 5)
		}
		if system {
			_, rest = cutWords(rest, 1) // the user the line runs as: never sent
		}
		if spec == "" || rest == "" {
			continue
		}
		sched, err := ParseSchedule(spec)
		if err != nil {
			continue // @reboot, and lines cron itself would refuse
		}
		cmd := commandOf(rest)
		out = append(out, CronEntry{Name: DeriveName(cmd), Schedule: sched, Source: source, Command: cmd})
	}
	return out
}

var envRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\s*=`)

// cutWords splits off the first n blank-separated words; rest keeps its own spacing.
func cutWords(s string, n int) (head, rest string) {
	rest = strings.TrimLeft(s, " \t")
	var words []string
	for i := 0; i < n; i++ {
		end := strings.IndexAny(rest, " \t")
		if end < 0 {
			if i == n-1 && rest != "" {
				return strings.Join(append(words, rest), " "), ""
			}
			return "", ""
		}
		words = append(words, rest[:end])
		rest = strings.TrimLeft(rest[end:], " \t")
	}
	return strings.Join(words, " "), rest
}

// commandOf is what cron hands the shell: the line's command up to its first unescaped %
// (the rest is the command's input), with \% turned into %.
func commandOf(rest string) string {
	var b strings.Builder
	for i := 0; i < len(rest); i++ {
		if rest[i] == '\\' && i+1 < len(rest) && rest[i+1] == '%' {
			b.WriteByte('%')
			i++
			continue
		}
		if rest[i] == '%' {
			break
		}
		b.WriteByte(rest[i])
	}
	return strings.TrimSpace(b.String())
}

// wrappers run another command; the value is the short options that take a value.
var wrappers = map[string]string{
	"nice": "n", "ionice": "cnpt", "flock": "wEc", "timeout": "sk", "chronic": "", "nohup": "",
	"sudo": "ugCDhprT", "runuser": "ugl", "env": "uSC", "exec": "a", "time": "fo", "setsid": "",
	"cronic": "", "stdbuf": "ioe", "systemd-cat": "tp", "taskset": "", "doas": "uC",
}

// interpreters run a script named after their options.
var interpreters = map[string]string{
	"sh": "o", "bash": "o", "dash": "o", "zsh": "o", "php": "dcf", "python": "WX", "python3": "WX",
	"node": "r", "ruby": "Ir", "perl": "IM", "java": "", "bun": "", "deno": "",
}

var subcommandRe = regexp.MustCompile(`^[a-z][a-z0-9:_-]{0,40}$`)
var versionedRe = regexp.MustCompile(`^(python|php|ruby|perl|node)[0-9.]+$`)

// DeriveName is a job's name from its command, redacted as a process group's is (ADR-208,
// ADR-223): the script's or the executable's file name, a framework's subcommand
// (artisan schedule:run, manage.py clearsessions), or run-parts' directory (cron.daily). No
// argument, directory, environment value or redirection is kept.
func DeriveName(cmd string) string {
	fallback := ""
	for _, words := range simpleCommands(cmd) {
		n, inline := nameOf(words)
		if n != "" {
			if len(n) > 80 {
				n = n[:80]
			}
			return n
		}
		if fallback == "" {
			fallback = inline
		}
	}
	if fallback != "" {
		return fallback
	}
	return "cron job"
}

// withSubcommand adds a framework's subcommand when it looks like one (never an argument).
func withSubcommand(name string, words []string, i int) string {
	if (name == "artisan" || name == "manage.py" || name == "console") && i < len(words) && subcommandRe.MatchString(words[i]) {
		return name + " " + words[i]
	}
	return name
}

// innerCommand is the command after -c (sh -c "…", su - user -c "…"), when there is one.
func innerCommand(words []string, from int) (string, bool) {
	for k := from; k+1 < len(words); k++ {
		if words[k] == "-c" {
			return words[k+1], true
		}
	}
	return "", false
}

// nameOf names one simple command; "" when it isn't the job (cd, test…), with the
// interpreter's name when it ran inline code (perl -e '…'), as a last resort.
func nameOf(words []string) (name, inline string) {
	i := 0
	next := func() string {
		for i < len(words) {
			w := words[i]
			i++
			if envRe.MatchString(w) {
				continue
			}
			if isRedirect(w) {
				switch w {
				case ">", ">>", "<", "1>", "2>", "2>>", "&>", "&>>":
					i++ // its target
				}
				continue
			}
			return w
		}
		return ""
	}
	// skipOptions passes a program's options, and the values of those listed in takes.
	skipOptions := func(takes string) {
		for i < len(words) && strings.HasPrefix(words[i], "-") && words[i] != "-" {
			w := words[i]
			i++
			if w == "--" {
				return
			}
			if len(w) == 2 && strings.ContainsRune(takes, rune(w[1])) {
				i++
			}
		}
	}
	for {
		w := next()
		if w == "" {
			return "", inline
		}
		if shellKeywords[w] {
			continue
		}
		b := path.Base(w)
		_, wrapper := wrappers[b]
		ib := b
		if m := versionedRe.FindStringSubmatch(b); m != nil {
			ib = m[1]
		}
		takes, interpreter := interpreters[ib]
		switch {
		case shellBuiltins[w] || b == "test" || b == "true" || b == "false" || b == "sleep":
			return "", inline // not the job: the next command in the list is
		case b == "run-parts":
			skipOptions("")
			if d := next(); d != "" {
				return path.Base(strings.TrimRight(d, "/")), ""
			}
			return "run-parts", ""
		case b == "su":
			if c, ok := innerCommand(words, i); ok {
				return DeriveName(c), ""
			}
			return "", inline
		case wrapper:
			skipOptions(wrappers[b])
			if b == "flock" || b == "timeout" {
				next() // the lock file, the duration
			}
		case interpreter:
			if c, ok := innerCommand(words, i); ok && (ib == "sh" || ib == "bash" || ib == "dash" || ib == "zsh") {
				return DeriveName(c), ""
			}
			if ib == "python" && i+1 < len(words) && words[i] == "-m" {
				return path.Base(words[i+1]), ""
			}
			if i < len(words) && (words[i] == "-e" || words[i] == "-c" || words[i] == "-r") {
				return "", b // inline code: no script to name
			}
			skipOptions(takes)
			s := next()
			if s == "" {
				return b, ""
			}
			return withSubcommand(path.Base(s), words, i), ""
		default:
			return withSubcommand(b, words, i), ""
		}
	}
}

// shellKeywords open or close a compound command; the command after them is the one.
var shellKeywords = map[string]bool{"if": true, "then": true, "else": true, "elif": true, "fi": true,
	"do": true, "done": true, "while": true, "until": true, "!": true}

// shellBuiltins set up the shell; the next command in the list is the job.
var shellBuiltins = map[string]bool{"cd": true, "[": true, "[[": true, ":": true, "export": true, "set": true,
	"umask": true, "source": true, ".": true, "ulimit": true, "unset": true, "trap": true, "wait": true}

func isRedirect(w string) bool {
	if w == "" {
		return false
	}
	if w[0] == '<' || w[0] == '>' || strings.HasPrefix(w, "&>") {
		return true
	}
	// 2>&1, 2>/dev/null, 1>>log
	return len(w) >= 2 && w[0] >= '0' && w[0] <= '9' && w[1] == '>'
}

// simpleCommands splits a shell line into its simple commands (at ;, &&, ||, | and &),
// each split into words, honouring quotes; expansions are left as written.
func simpleCommands(s string) [][]string {
	var out [][]string
	var words []string
	var cur strings.Builder
	quote := byte(0)
	inWord := false
	endWord := func() {
		if inWord {
			words = append(words, cur.String())
			cur.Reset()
			inWord = false
		}
	}
	endCmd := func() {
		endWord()
		if len(words) > 0 {
			out = append(out, words)
		}
		words = nil
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else {
				cur.WriteByte(c)
			}
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			inWord = true
		case c == '\'' || c == '"':
			quote, inWord = c, true
		case c == ' ' || c == '\t' || c == '(' || c == ')' || c == '{' || c == '}':
			endWord()
		case c == ';' || c == '|':
			endCmd()
		case (c == '>' || c == '<') && inWord && strings.Trim(cur.String(), "0123456789&") != "":
			endWord() // job>/dev/null: the redirect starts a word of its own
			cur.WriteByte(c)
			inWord = true
		case c == '&':
			switch {
			case i+1 < len(s) && s[i+1] == '>':
				cur.WriteByte(c) // &>
				inWord = true
			case inWord && strings.HasSuffix(cur.String(), ">"):
				cur.WriteByte(c) // 2>&1
			default:
				endCmd()
			}
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	endCmd()
	return out
}

// ------------------------------------------------------------------------------ runs

// Cron follows the runs cron starts (ADR-223): an exec by cron's child starts one, matched to
// a crontab line by its command; that process's exit ends it with its code. Without the exec
// program, cron's own log lines give each start (and with cronie its end), without a code.
type Cron struct {
	Entries func() []CronEntry
	Loc     *time.Location
	// Seen says whether runs can be seen at all (the exec program or cron's log): without it
	// no run is owed, so nothing is called missed.
	Seen func() bool

	mu      sync.Mutex
	entries []CronEntry
	read    time.Time
	running map[uint32]*started // by the pid of the run's shell, or cron's log pid
	runs    map[string][]Run    // runs not yet handed over, by name
	exited  [256]exitRec        // recent exits, for an exit read before its exec
	exitN   int
}

type started struct {
	name  string
	start int64
}

type exitRec struct {
	pid            uint32
	status, signal int
	at             time.Time
}

func (c *Cron) loc() *time.Location {
	if c.Loc != nil {
		return c.Loc
	}
	return time.Local
}

// refresh re-reads the crontabs at most once a minute.
func (c *Cron) refresh(now time.Time) {
	if c.entries != nil && now.Sub(c.read) < time.Minute && !now.Before(c.read) {
		return
	}
	c.entries, c.read = c.Entries(), now
	if c.entries == nil {
		c.entries = []CronEntry{}
	}
}

// Exec is a process cron's child started at `at` (args: its command line, cut at 256 bytes).
// The command is matched and dropped here.
func (c *Cron) Exec(pid uint32, args []string, at time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refresh(at)
	e := c.match(commandFromArgs(args), at)
	if e == nil {
		return
	}
	// Its exit may have been read first (two ring buffers).
	for k := range c.exited {
		x := c.exited[k]
		if x.pid == pid && x.pid != 0 && !x.at.Before(at.Add(-time.Second)) {
			c.exited[k] = exitRec{}
			c.add(e.Name, finished(at.Unix(), x.status, x.signal, x.at))
			return
		}
	}
	c.start(pid, e.Name, at, "running")
}

func (c *Cron) start(pid uint32, name string, at time.Time, result string) {
	if c.running == nil {
		c.running = map[uint32]*started{}
	}
	if len(c.running) >= 1000 {
		return
	}
	c.running[pid] = &started{name: name, start: at.Unix()}
	c.add(name, Run{Start: at.Unix(), Result: result})
}

// Exit is any process's end; true when it ended a cron run.
func (c *Cron) Exit(pid uint32, status, signal int, at time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.running[pid]
	if !ok {
		c.exited[c.exitN%len(c.exited)] = exitRec{pid: pid, status: status, signal: signal, at: at}
		c.exitN++
		return false
	}
	delete(c.running, pid)
	c.add(s.name, finished(s.start, status, signal, at))
	return true
}

func finished(start int64, status, signal int, at time.Time) Run {
	r := Run{Start: start, End: at.Unix(), Result: "success"}
	if signal != 0 || status != 0 {
		r.Result = "failed"
	}
	if signal == 0 {
		code := status
		r.Code = &code
	}
	return r
}

func (c *Cron) add(name string, r Run) {
	if c.runs == nil {
		c.runs = map[string][]Run{}
	}
	runs := c.runs[name]
	for i := range runs {
		if runs[i].Start == r.Start {
			runs[i] = r
			return
		}
	}
	runs = append(runs, r)
	if len(runs) > RunsKept {
		runs = runs[len(runs)-RunsKept:]
	}
	c.runs[name] = runs
}

// commandFromArgs is the command cron gave the shell: "sh -c <command>".
func commandFromArgs(args []string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-c" {
			return strings.Join(args[i+1:], " ")
		}
	}
	return ""
}

// cutAt is how long a command can be before the exec program cuts it (256 bytes, less
// "/bin/sh\0-c\0" and some room for a longer shell's path).
const cutAt = 230

// match finds the crontab line a command came from; with several, the one due that minute.
func (c *Cron) match(cmd string, at time.Time) *CronEntry {
	if cmd == "" {
		return nil
	}
	var cands []*CronEntry
	for i := range c.entries {
		e := &c.entries[i]
		if e.Command == cmd || (len(cmd) >= cutAt && strings.HasPrefix(e.Command, cmd)) {
			cands = append(cands, e)
		}
	}
	switch len(cands) {
	case 0:
		return nil
	case 1:
		return cands[0]
	}
	minute := at.In(c.loc()).Truncate(time.Minute)
	for _, e := range cands {
		if e.Schedule.matches(minute) {
			return e
		}
	}
	return cands[0]
}

// Observations are the cron jobs, each with the runs seen since the last call.
func (c *Cron) Observations(now time.Time) []Observation {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refresh(now)
	seen := c.Seen == nil || c.Seen()
	out := make([]Observation, 0, len(c.entries))
	for _, e := range c.entries {
		o := Observation{Kind: "cron", Name: e.Name, Schedule: e.Schedule.Spec, Source: e.Source, Enabled: true,
			Every: int64(e.Schedule.Every(now, c.loc()).Seconds()), Runs: append([]Run(nil), c.runs[e.Name]...)}
		if seen {
			if n := e.Schedule.Next(now, c.loc()); !n.IsZero() {
				o.Next = n.Unix()
			}
		}
		out = append(out, o)
	}
	// Ended runs are handed over once; running ones until they end.
	for name, runs := range c.runs {
		var keep []Run
		for _, r := range runs {
			if r.Result == "running" {
				keep = append(keep, r)
			}
		}
		if len(keep) == 0 {
			delete(c.runs, name)
		} else {
			c.runs[name] = keep
		}
	}
	return out
}

// ------------------------------------------------------------------------------ cron's log

// cronLogRe reads cron's log lines: Debian's and Ubuntu's `CRON[pid]: (user) CMD (command)`,
// cronie's `CROND[pid]: (user) CMD (command)` and `… CMDEND (command)`.
var cronLogRe = regexp.MustCompile(`\b(CROND?)\[(\d+)\]: \([^)]*\) (CMD|CMDEND) \((.*)\)\s*$`)

// LogLine applies one line of cron's log, read at now. The line's command is matched and
// dropped here. A run from the log has no exit code: its result is "unknown".
func (c *Cron) LogLine(line string, now time.Time) {
	m := cronLogRe.FindStringSubmatch(line)
	if m == nil {
		return
	}
	pid64, err := strconv.ParseUint(m[2], 10, 32)
	if err != nil {
		return
	}
	pid := uint32(pid64)
	at := now
	if f := strings.Fields(line); len(f) > 0 {
		if t, err := time.Parse(time.RFC3339Nano, f[0]); err == nil && !t.After(now) {
			at = t
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refresh(now)
	if m[3] == "CMDEND" {
		if s, ok := c.running[pid]; ok {
			delete(c.running, pid)
			c.add(s.name, Run{Start: s.start, End: at.Unix(), Result: "unknown"})
		}
		return
	}
	e := c.match(m[4], at)
	if e == nil {
		return
	}
	if m[1] == "CROND" {
		c.start(pid, e.Name, at, "running") // cronie logs the end too
		return
	}
	c.add(e.Name, Run{Start: at.Unix(), Result: "unknown"})
}

// CronLogs are where cron's lines land as text: rsyslog's /var/log/cron (Rocky) and
// /var/log/syslog (Ubuntu). A server with only the binary journal has neither.
var CronLogs = []string{"var/log/cron", "var/log/syslog"}

// LogTail follows a growing log file from its end, across rotation.
type LogTail struct {
	Path   string
	offset int64
	ino    uint64
	opened bool
}

// Lines returns the whole lines added since the last call (at most 1 MB a call); none on the
// first call, which starts at the file's end.
func (t *LogTail) Lines() ([]string, error) {
	f, err := os.Open(t.Path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var ino uint64
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		ino = uint64(s.Ino) //nolint:unconvert // Ino is uint32 on some platforms
	}
	if !t.opened {
		t.opened, t.offset, t.ino = true, st.Size(), ino
		return nil, nil
	}
	if ino != t.ino || st.Size() < t.offset {
		t.offset, t.ino = 0, ino // rotated
	}
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return nil, err
	}
	end := strings.LastIndexByte(string(b), '\n')
	if end < 0 {
		return nil, nil
	}
	t.offset += int64(end + 1)
	return strings.Split(string(b[:end]), "\n"), nil
}
