/* Sweep schedule and move ranking. No DOM access, so it also runs under node
   for tests and inside the Apps Script backend. All wall-clock times are
   Boston time regardless of device zone. */
(function (root) {
  'use strict';

  var TZ = 'America/New_York';
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // Boston wall-clock parts. Uses Intl where it works; Apps Script can fall
  // back to Utilities.formatDate.
  var etParts = (function () {
    function viaIntl() {
      var fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      return function (date) {
        var o = {};
        fmt.formatToParts(date).forEach(function (p) { o[p.type] = p.value; });
        return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
      };
    }
    function viaUtilities() {
      return function (date) {
        var a = Utilities.formatDate(date, TZ, 'yyyy M d H m').split(' ');  // eslint-disable-line no-undef
        return { y: +a[0], m: +a[1], d: +a[2], h: +a[3], mi: +a[4] };
      };
    }
    try {
      var f = viaIntl();
      var probe = f(new Date(Date.UTC(2026, 6, 1, 16, 0)));   // noon EDT
      if (probe.h === 12 && probe.d === 1) return f;
    } catch (e) { /* fall through */ }
    return viaUtilities();
  })();

  function etOffset(date) {
    var p = etParts(date);
    var wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    return wall - Math.floor(date.getTime() / MIN) * MIN;
  }

  // Boston wall-clock time to an absolute Date (m is 1-based).
  function etDate(y, m, d, h, mi) {
    var guess = Date.UTC(y, m - 1, d, h, mi);
    var t = guess - etOffset(new Date(guess));
    var t2 = guess - etOffset(new Date(t));
    return new Date(t2);
  }

  function hm(s) {
    var a = s.split(':');
    return [+a[0], +a[1]];
  }

  function inSeason(curb, season, m, d) {
    if (curb.yearRound) return true;
    var md = m * 100 + d;
    var lo = +season[0].replace('-', ''), hi = +season[1].replace('-', '');
    return md >= lo && md <= hi;
  }

  function isAlternating(curb) {
    return [1, 2, 3, 4].some(function (w) { return curb.weeks.indexOf(w) < 0; });
  }

  /* City of Boston holidays. The City suspends daytime sweeping on some of
     them, so sweeps on these days are flagged, never skipped. */
  function nthWeekday(y, m, wd, n) {
    var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  function lastWeekday(y, m, wd) {
    var last = new Date(Date.UTC(y, m, 0));
    return last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7);
  }
  function observed(y, m, d) {
    var wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    var t = Date.UTC(y, m - 1, d) + (wd === 6 ? -DAY : wd === 0 ? DAY : 0);
    var o = new Date(t);
    return [o.getUTCMonth() + 1, o.getUTCDate()];
  }
  var holidayCache = {};
  function holidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    var h = {};
    function add(md, name) { h[md[0] * 100 + md[1]] = name; }
    add(observed(y, 1, 1), "New Year's Day");
    add([1, nthWeekday(y, 1, 1, 3)], 'Martin Luther King Jr. Day');
    add([2, nthWeekday(y, 2, 1, 3)], "Presidents' Day");
    add([4, nthWeekday(y, 4, 1, 3)], "Patriots' Day");
    add([5, lastWeekday(y, 5, 1)], 'Memorial Day');
    add(observed(y, 6, 19), 'Juneteenth');
    add(observed(y, 7, 4), 'Independence Day');
    add([9, nthWeekday(y, 9, 1, 1)], 'Labor Day');
    add([10, nthWeekday(y, 10, 1, 2)], "Indigenous Peoples' Day");
    add(observed(y, 11, 11), 'Veterans Day');
    add([11, nthWeekday(y, 11, 4, 4)], 'Thanksgiving');
    add(observed(y, 12, 25), 'Christmas Day');
    holidayCache[y] = h;
    return h;
  }
  function holidayName(date) {
    var p = etParts(date);
    return holidays(p.y)[p.m * 100 + p.d] || '';
  }

  /* Sweep windows for a curb that overlap [from, to]. City rule: streets swept
     every other week are not enforced in the fifth week of the month. */
  function occurrences(curb, from, to, opts) {
    opts = opts || {};
    var season = opts.season || ['03-01', '12-31'];
    var skipFifth = opts.skipFifthWeek !== false && isAlternating(curb);
    var out = [];
    var s = hm(curb.start), e = hm(curb.end);
    var p = etParts(new Date(from.getTime() - DAY));
    var day = Date.UTC(p.y, p.m - 1, p.d);
    var stop = to.getTime() + DAY;
    for (; day <= stop; day += DAY) {
      var dt = new Date(day);
      var y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
      if (curb.days.indexOf(dt.getUTCDay()) < 0) continue;
      var nth = Math.ceil(d / 7);
      if (curb.weeks.indexOf(nth) < 0) continue;
      if (nth === 5 && skipFifth) continue;
      if (!inSeason(curb, season, m, d)) continue;
      var start = etDate(y, m, d, s[0], s[1]);
      var end = etDate(y, m, d, e[0], e[1]);
      if (end <= start) end = new Date(end.getTime() + DAY);
      if (end > from && start < to) {
        out.push({ start: start, end: end, holiday: holidays(y)[m * 100 + d] || '' });
      }
    }
    return out;
  }

  function nextSweep(curb, after, opts) {
    var horizon = new Date(after.getTime() + 400 * DAY);
    var step = 45 * DAY;
    for (var a = after; a < horizon; a = new Date(a.getTime() + step)) {
      var occ = occurrences(curb, a, new Date(a.getTime() + step), opts)
        .filter(function (o) { return o.end > after; });
      if (occ.length) return occ[0];
    }
    return null;
  }

  function status(curb, now, opts) {
    var n = nextSweep(curb, now, opts);
    if (!n) return { state: 'none', next: null, hours: Infinity };
    if (n.start <= now) return { state: 'sweeping', next: n, hours: 0 };
    return { state: 'clear', next: n, hours: (n.start - now) / HOUR };
  }

  function distanceM(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function eligible(curb, settings) {
    if (curb.metered || curb.daily || !curb.sideKnown) return false;
    if (settings.snowEmergency && curb.snowArtery) return false;
    return true;
  }

  // The first trip that has not ended yet, as Dates.
  function nextTrip(trips, now) {
    var list = (trips || []).map(function (t) {
      return { id: t.id, note: t.note || '', start: new Date(t.start), end: new Date(t.end) };
    }).filter(function (t) { return t.end > now && t.end > t.start; })
      .sort(function (a, b) { return a.start - b.start; });
    return list[0] || null;
  }

  function inAnyTrip(trips, t) {
    return (trips || []).some(function (x) { return t >= new Date(x.start) && t <= new Date(x.end); });
  }

  // Permits on a curb that overlap [from, to].
  function permitsOn(permits, curbId, from, to) {
    return ((permits || {})[curbId] || []).filter(function (p) {
      return new Date(p.from) < to && new Date(p.to) > from;
    });
  }

  /* Rank where to move the car next.
     The strategy: a curb is easiest to get right after its sweep ends, because
     everyone moved off it. Each option is the end of one curb's sweep window
     that falls before the car's own deadline (minus search time), scored on how
     long the car could then stay (half), walking distance from home (a quarter),
     and how easy the curb is to get (a quarter). Ease starts as the amount of
     curb opening nearby at the same moment and shifts toward your own logged
     search times as they come in.
     A trip that the car would not last through moves the deadline up to the
     departure and puts curbs that cover the whole trip first. */
  function rank(args) {
    var curbs = args.curbs, now = args.now, settings = args.settings || {};
    var opts = { season: args.season, skipFifthWeek: settings.skipFifthWeek };
    var searchMs = (settings.searchMinutes || 60) * MIN;
    var maxWalk = settings.maxWalkM || 900;
    var home = args.home;
    var learned = args.learned || {};
    var permits = args.permits || {};
    var trips = args.trips || [];
    var car = args.car ? curbs.filter(function (c) { return c.id === args.car.curbId; })[0] : null;

    var deadline = null, mustMoveNow = false;
    if (car) {
      var st = status(car, now, opts);
      if (st.next) deadline = st.next.start;
      if (st.state === 'sweeping') mustMoveNow = true;
      if (settings.snowEmergency && car.snowArtery) { mustMoveNow = true; deadline = now; }
    }

    var trip = nextTrip(trips, now);
    var tripMode = null, tripOk = null;
    if (car && trip && !mustMoveNow && trip.start > now) {
      if (deadline && deadline < trip.end) tripMode = trip;
      else tripOk = trip;
    }
    var leaveBy = tripMode && tripMode.start < deadline ? tripMode.start : deadline;

    // Moving now: only sweeps ending in the next few hours are worth waiting for.
    var horizonEnd = mustMoveNow ? new Date(now.getTime() + 3 * HOUR)
      : leaveBy ? new Date(leaveBy.getTime() - searchMs)
        : new Date(now.getTime() + 14 * DAY);
    var horizonStart = new Date(now.getTime() - 90 * MIN);

    var pool = curbs.filter(function (c) {
      if (!eligible(c, settings)) return false;
      if (car && c.id === car.id) return false;
      c._walk = home ? distanceM(home, c.center) * 1.25 : 0;
      return !home || c._walk <= maxWalk;
    });

    var windows = [];
    pool.forEach(function (c) {
      occurrences(c, horizonStart, horizonEnd, opts).forEach(function (o) {
        if (o.end < horizonStart || o.end > horizonEnd) return;
        if (inAnyTrip(trips, o.end)) return;        // nobody is home to move it
        windows.push({ curb: c, open: o.end });
      });
    });

    function ease(curbId, prior) {
      var l = learned[curbId];
      if (!l || !l.n) return prior;
      return (3 * prior + l.sum) / (3 + l.n);
    }

    function score(o, prior) {
      var stayDays = (o.until - now) / DAY;
      o.stayDays = stayDays;
      o.ease = ease(o.curb.id, prior);
      o.learnedN = learned[o.curb.id] ? learned[o.curb.id].n : 0;
      o.permits = permitsOn(permits, o.curb.id, o.at, o.until);
      o.coversTrip = tripMode ? o.until > tripMode.end : null;
      o.winterArtery = o.curb.snowArtery && isWinter(o.at);
      o.score = 0.5 * Math.min(stayDays / 35, 1) +
        0.25 * (home ? 1 - Math.min(o.walkM / maxWalk, 1) : 0.5) +
        0.25 * o.ease -
        (o.winterArtery ? 0.1 : 0) -
        (o.permits.length ? 0.15 : 0);
      return o;
    }

    var options = windows.map(function (w) {
      var n = nextSweep(w.curb, new Date(w.open.getTime() + MIN), opts);
      var supply = 0;
      windows.forEach(function (x) {
        if (Math.abs(x.open - w.open) <= 30 * MIN && distanceM(x.curb.center, w.curb.center) <= 350) {
          supply += x.curb.lengthM;
        }
      });
      return score({
        curb: w.curb, kind: 'fresh', at: w.open,
        until: n ? n.start : new Date(w.open.getTime() + 120 * DAY), untilKnown: !!n,
        walkM: w.curb._walk, supplyM: supply
      }, Math.min(supply / 1500, 1));
    });

    // A move only helps if the new curb lasts longer than the current one.
    if (deadline && !mustMoveNow) {
      options = options.filter(function (o) { return o.until > deadline; });
    }

    // On a trip nothing covers, the spot that lasts longest wins: it delays
    // the mid-trip move (or garage) as long as possible.
    function byRank(a, b) {
      if (tripMode && a.coversTrip !== b.coversTrip) return a.coversTrip ? -1 : 1;
      if (tripMode && !a.coversTrip && Math.abs(a.until - b.until) > DAY / 2) return b.until - a.until;
      return b.score - a.score;
    }

    // Keep the best window per curb.
    var best = {};
    options.forEach(function (o) {
      if (!best[o.curb.id] || byRank(o, best[o.curb.id]) < 0) best[o.curb.id] = o;
    });
    options = Object.keys(best).map(function (k) { return best[k]; }).sort(byRank);

    // When no sweep ends in time (or the car must go now, or nothing covers a
    // trip), fall back to any legal curb right now, without the opening bonus.
    var fallback = [];
    var tripUncovered = tripMode && !options.some(function (o) { return o.coversTrip; });
    if (mustMoveNow || !options.length || tripUncovered) {
      fallback = pool.filter(function (c) { return status(c, now, opts).state !== 'sweeping'; })
        .map(function (c) {
          var n = nextSweep(c, now, opts);
          return score({
            curb: c, kind: 'anytime', at: now,
            until: n ? n.start : new Date(now.getTime() + 120 * DAY), untilKnown: !!n,
            walkM: c._walk, supplyM: 0
          }, 0);
        })
        .filter(function (o) { return o.until - now > searchMs; })
        .filter(function (o) { return !tripUncovered || o.coversTrip; })
        .sort(byRank);
    }

    var tripInfo = null;
    if (tripMode) {
      var all = options.concat(fallback);
      var longest = all.reduce(function (m, o) { return !m || o.until > m.until ? o : m; }, null);
      tripInfo = {
        trip: tripMode, covered: all.some(function (o) { return o.coversTrip; }),
        leaveBy: leaveBy, longest: longest
      };
    }

    return {
      car: car, deadline: deadline, mustMoveNow: mustMoveNow, leaveBy: leaveBy,
      trip: tripInfo, tripOk: tripOk,
      options: options.slice(0, args.limit || 8),
      fallback: fallback.slice(0, args.limit || 8)
    };
  }

  function isWinter(d) {
    var m = etParts(d).m;
    return m === 12 || m <= 3;
  }

  /* Plain-language schedule, e.g. "1st and 3rd Friday, 8 AM to 12 PM". */
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var ORD = ['', '1st', '2nd', '3rd', '4th', '5th'];

  function clock(s) {
    var a = hm(s), h = a[0], m = a[1];
    if (h === 0 && m <= 1) return 'midnight';
    var suf = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + suf;
  }

  function describe(curb, opts) {
    var skipFifth = (!opts || opts.skipFifthWeek !== false) && isAlternating(curb);
    var weeks = curb.weeks.filter(function (w) { return !(w === 5 && skipFifth); });
    var days = curb.days.map(function (d) { return DAYS[d]; });
    var when;
    if (curb.days.length === 7) when = 'Every night';
    else if (weeks.length >= 4) when = 'Every ' + days.join(' and ');
    else when = weeks.map(function (w) { return ORD[w]; }).join(' and ') + ' ' + days.join(' and ');
    var season = curb.yearRound ? 'year-round' : 'Mar 1 to Dec 31';
    return when + ', ' + clock(curb.start) + ' to ' + clock(curb.end) + ' (' + season + ')';
  }

  function curbLabel(curb) {
    var side = curb.side === 'Both' ? 'both sides'
      : curb.side === 'Odd' || curb.side === 'Even'
        ? curb.side.toLowerCase() + ' side' + (curb.sideDir ? ' (' + curb.sideDir + ')' : '')
        : curb.side + ' side';
    return curb.street + ', ' + side;
  }

  var api = {
    TZ: TZ, etParts: etParts, etDate: etDate, occurrences: occurrences, nextSweep: nextSweep,
    status: status, rank: rank, describe: describe, curbLabel: curbLabel, clock: clock,
    distanceM: distanceM, eligible: eligible, isWinter: isWinter, holidayName: holidayName,
    nextTrip: nextTrip, permitsOn: permitsOn, MIN: MIN, HOUR: HOUR, DAY: DAY
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(this);
