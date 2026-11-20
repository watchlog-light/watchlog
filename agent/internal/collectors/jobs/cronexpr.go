// SPDX-License-Identifier: AGPL-3.0-only

package jobs

import (
	"errors"
	"io/fs"
	"strconv"
	"strings"
	"time"
)

// Schedule is a cron schedule: five fields (minute hour day-of-month month day-of-week) or a
// macro (@hourly…), evaluated in the server's time zone as cron does.
type Schedule struct {
	min, hour, dom, mon, dow uint64 // bit sets
	domStar, dowStar         bool
	Spec                     string
}

var macros = map[string]string{
	"@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
	"@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
}

var monthNames = map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
var dayNames = map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}

// ErrReboot: an @reboot line runs once at boot; it has no schedule to miss.
var ErrReboot = errors.New("@reboot")

// ParseSchedule reads five cron fields or a macro.
func ParseSchedule(spec string) (Schedule, error) {
	spec = strings.TrimSpace(spec)
	if spec == "@reboot" {
		return Schedule{}, ErrReboot
	}
	if m, ok := macros[spec]; ok {
		s, err := ParseSchedule(m)
		s.Spec = spec
		return s, err
	}
	f := strings.Fields(spec)
	if len(f) != 5 {
		return Schedule{}, errors.New("five fields expected")
	}
	var s Schedule
	var err error
	if s.min, err = field(f[0], 0, 59, nil); err != nil {
		return s, err
	}
	if s.hour, err = field(f[1], 0, 23, nil); err != nil {
		return s, err
	}
	if s.dom, err = field(f[2], 1, 31, nil); err != nil {
		return s, err
	}
	if s.mon, err = field(f[3], 1, 12, monthNames); err != nil {
		return s, err
	}
	if s.dow, err = field(f[4], 0, 7, dayNames); err != nil {
		return s, err
	}
	if s.dow&(1<<7) != 0 { // 7 is Sunday too
		s.dow |= 1
	}
	s.domStar, s.dowStar = strings.HasPrefix(f[2], "*"), strings.HasPrefix(f[4], "*")
	s.Spec = strings.Join(f, " ")
	return s, nil
}

func field(f string, lo, hi int, names map[string]int) (uint64, error) {
	var bits uint64
	for _, part := range strings.Split(f, ",") {
		step := 1
		if r, st, ok := strings.Cut(part, "/"); ok {
			n, err := strconv.Atoi(st)
			if err != nil || n <= 0 {
				return 0, errors.New("bad step")
			}
			part, step = r, n
		}
		a, b := lo, hi
		if part != "*" {
			x, y, isRange := strings.Cut(part, "-")
			var err error
			if a, err = num(x, names); err != nil {
				return 0, err
			}
			b = a
			if isRange {
				if b, err = num(y, names); err != nil {
					return 0, err
				}
			} else if step > 1 {
				b = hi // "5/15": from 5 to the end
			}
		}
		if a < lo || b > hi || a > b {
			return 0, errors.New("out of range")
		}
		for i := a; i <= b; i += step {
			bits |= 1 << uint(i) //nolint:gosec // bounded by hi ≤ 59
		}
	}
	return bits, nil
}

func num(s string, names map[string]int) (int, error) {
	if n, ok := names[strings.ToLower(s)]; ok {
		return n, nil
	}
	return strconv.Atoi(s)
}

func (s Schedule) dayOK(t time.Time) bool {
	dom := s.dom&(1<<uint(t.Day())) != 0     //nolint:gosec // calendar values
	dow := s.dow&(1<<uint(t.Weekday())) != 0 //nolint:gosec // calendar values
	// cron's rule: when both are restricted, either one matching is enough.
	if !s.domStar && !s.dowStar {
		return dom || dow
	}
	return dom && dow
}

func (s Schedule) matches(t time.Time) bool {
	return s.mon&(1<<uint(t.Month())) != 0 && s.dayOK(t) && s.hour&(1<<uint(t.Hour())) != 0 && s.min&(1<<uint(t.Minute())) != 0 //nolint:gosec // calendar values
}

// Next is the first run after t, in loc; zero when none within a year (Feb 30th). A run in
// the hour around a daylight saving change is skipped: cron's handling of the skipped and
// the repeated hour differs between versions, so such a run is never counted as missed.
// Months, days and hours that can't match are skipped whole.
func (s Schedule) Next(t time.Time, loc *time.Location) time.Time {
	c := t.In(loc).Truncate(time.Minute).Add(time.Minute)
	end := c.AddDate(1, 1, 0)
	// A local time inside a daylight saving gap can resolve to before c: then the next whole
	// hour, by the clock, is used instead, so c always moves forward.
	ahead := func(n time.Time) time.Time {
		if n.After(c) {
			return n
		}
		return c.Add(time.Duration(60-c.Minute()) * time.Minute)
	}
	for c.Before(end) {
		switch {
		case s.mon&(1<<uint(c.Month())) == 0: //nolint:gosec // calendar values
			c = ahead(time.Date(c.Year(), c.Month()+1, 1, 0, 0, 0, 0, loc))
		case !s.dayOK(c):
			c = ahead(time.Date(c.Year(), c.Month(), c.Day()+1, 0, 0, 0, 0, loc))
		case s.hour&(1<<uint(c.Hour())) == 0: //nolint:gosec // calendar values
			c = ahead(time.Date(c.Year(), c.Month(), c.Day(), c.Hour()+1, 0, 0, 0, loc))
		case s.min&(1<<uint(c.Minute())) == 0 || nearDST(c): //nolint:gosec // calendar values
			c = c.Add(time.Minute)
		default:
			return c
		}
	}
	return time.Time{}
}

// nearDST: the zone's offset differs an hour before and an hour after.
func nearDST(t time.Time) bool {
	_, a := t.Add(-time.Hour).Zone()
	_, b := t.Add(time.Hour).Zone()
	return a != b
}

// Every is the time between two runs from t (0 when it can't be told).
func (s Schedule) Every(t time.Time, loc *time.Location) time.Duration {
	a := s.Next(t, loc)
	if a.IsZero() {
		return 0
	}
	b := s.Next(a, loc)
	if b.IsZero() {
		return 0
	}
	return b.Sub(a)
}

// HostLocation is the server's time zone, from its /etc/localtime (the agent's image has no
// zone database); UTC when it can't be read.
func HostLocation(root fs.FS) *time.Location {
	b, err := fs.ReadFile(root, "etc/localtime")
	if err != nil {
		return time.UTC
	}
	loc, err := time.LoadLocationFromTZData("Local", b)
	if err != nil {
		return time.UTC
	}
	return loc
}
