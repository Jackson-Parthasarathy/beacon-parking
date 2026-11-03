/* Shared app logic on top of planner.js: settings, learning from logged search
   times, calendar events, claims, trips, and curb lookups. Runs in the browser,
   under node for tests, and inside the Apps Script backend, so it formats dates
   itself instead of relying on Intl formatting. */
(function (root) {
  'use strict';

  var P = root.Planner || (typeof require === 'function' ? require('./planner.js') : null);
  var WALK_M_PER_MIN = 80;
  var DEFAULTS = {
    searchMinutes: 60, leadMinutes: 10, walkMinutes: 12,
    skipFifthWeek: true, snowEmergency: false
  };
  var SEARCH_BUCKETS = [
    { label: 'Under 10 min', min: 5 },
    { label: '10 to 30 min', min: 20 },
    { label: '30 to 60 min', min: 45 },
    { label: 'Over an hour', min: 75 }
  ];

  function settings(state) {
    var s = {};
    var src = (state && state.settings) || {};
    Object.keys(DEFAULTS).forEach(function (k) { s[k] = k in src ? src[k] : DEFAULTS[k]; });
    s.maxWalkM = s.walkMinutes * WALK_M_PER_MIN;
    return s;
  }

  function opts(data, s) {
    return { season: data.season['Beacon Hill'], skipFifthWeek: s.skipFifthWeek };
  }

  // ------------------------------------------------------------ formatting
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDay(d) {
    var p = P.etParts(d);
    return WD[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] + ', ' + MO[p.m - 1] + ' ' + p.d;
  }
  function fmtTime(d) {
    var p = P.etParts(d);
    return (p.h % 12 || 12) + ':' + pad(p.mi) + ' ' + (p.h >= 12 ? 'PM' : 'AM');
  }
  function fmtWhen(d) { return fmtDay(d) + ', ' + fmtTime(d); }
  function span(c) { return c.from + ' to ' + c.to; }
  function walkText(m) { return Math.max(1, Math.round(m / WALK_M_PER_MIN)) + ' min walk'; }
  function sideShort(c) {
    return c.side === 'Odd' || c.side === 'Even' ? c.side.toLowerCase() + ' side' : c.side.toLowerCase();
  }

  // ------------------------------------------------------------ learning
  /* Per-curb ease from logged search times: under 10 minutes counts as easy
     (near 1), an hour or more as hard (0). Missing the planned target counts
     as a zero for that target. */
  function learn(history) {
    var out = {};
    function add(id, e, min) {
      if (id == null) return;
      var r = out[id] || (out[id] = { sum: 0, n: 0, minutes: [] });
      r.sum += e; r.n += 1;
      if (min != null) r.minutes.push(min);
    }
    (history || []).forEach(function (h) {
      if (h.searchMin == null) return;
      add(h.curbId, Math.max(0, Math.min(1, 1 - h.searchMin / 60)), h.searchMin);
      if (h.target != null && h.target !== h.curbId) add(h.target, 0, null);
    });
    return out;
  }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function searchStats(history) {
    var logged = (history || []).filter(function (h) { return h.searchMin != null; });
    var recent = logged.slice(0, 10).map(function (h) { return h.searchMin; });
    var hits = logged.filter(function (h) { return h.target != null; });
    return {
      n: logged.length,
      medianRecent: median(recent),
      medianAll: median(logged.map(function (h) { return h.searchMin; })),
      targetHits: hits.filter(function (h) { return h.onTarget; }).length,
      targetTries: hits.length
    };
  }

  // ------------------------------------------------------------ restrictions
  function permitIndex(restrictions) {
    var idx = {};
    ((restrictions && restrictions.permits) || []).forEach(function (p) {
      if (p.curbId == null) return;
      (idx[p.curbId] = idx[p.curbId] || []).push(p);
    });
    return idx;
  }

  // ------------------------------------------------------------ plan
  function plan(ctx) {
    var s = settings(ctx.state);
    return P.rank({
      curbs: ctx.data.curbs, now: ctx.now || new Date(), home: ctx.state.home, car: ctx.state.car,
      settings: s, season: ctx.data.season['Beacon Hill'], limit: 6,
      learned: learn(ctx.state.history), permits: permitIndex(ctx.restrictions),
      trips: ctx.state.trips || []
    });
  }

  function moveList(p) {
    if (!p || !p.car) return [];
    if (p.mustMoveNow) return p.options.concat(p.fallback).slice(0, 6);
    if (p.trip && !p.options.some(function (o) { return o.coversTrip; })) {
      return p.fallback.length ? p.fallback : p.options;
    }
    return p.options.length ? p.options : p.fallback;
  }

  function moveKey(o) { return o ? o.curb.id + '@' + new Date(o.at).toISOString() : ''; }

  // The move the calendar is built around, or null.
  function nextMove(p) {
    var top = moveList(p)[0];
    if (!top) return null;
    if (top.kind !== 'fresh' && !p.mustMoveNow && !p.trip) return null;
    return top;
  }

  /* A claim means "I'm handling the car until it is parked again". It is not
     tied to one ranked option, because each phone ranks on its own (permit
     data can differ by a few hours) and an option-level match would hide a
     claim on the other phone. Parking clears it. */
  function activeClaim(state) {
    var c = state.claim, car = state.car;
    if (!c || !c.by || !car) return null;
    if (c.parkedAt) return c.parkedAt === car.parkedAt ? c : null;
    return new Date(c.at) >= new Date(car.parkedAt) ? c : null;
  }

  /* Attach where the car was supposed to go, so learning can tell a hit from
     a miss. A park counts toward the planned move if it happens between two
     hours before and six hours after the curb opened. */
  function recordPark(state, car) {
    var pm = state.plannedMove;
    if (pm && pm.at) {
      var dt = new Date(car.parkedAt) - new Date(pm.at);
      if (dt > -2 * P.HOUR && dt < 6 * P.HOUR) {
        car.target = pm.curbId;
        car.onTarget = pm.curbId === car.curbId;
      }
    }
    state.car = car;
    state.history = [car].concat(state.history || []).slice(0, 200);
    state.claim = null;
    return state;
  }

  function applyFeedback(state, parkedAt, searchMin) {
    (state.history || []).forEach(function (h) { if (h.parkedAt === parkedAt) h.searchMin = searchMin; });
    if (state.car && state.car.parkedAt === parkedAt) state.car.searchMin = searchMin;
    return state;
  }

  // ------------------------------------------------------------ events
  // Minutes from 8 PM the evening before to the event start.
  function eveningBefore(start) {
    var p = P.etParts(start);
    var prev = new Date(P.etDate(p.y, p.m, p.d, 20, 0).getTime() - P.DAY);
    return Math.max(30, Math.round((start - prev) / P.MIN));
  }

  function moveTitle(o, claim, trip) {
    var who = claim ? claim.by + ' moves car' : trip ? 'move car' : 'Move car';
    return (trip ? 'Before your trip: ' : '') + who + ' to ' + o.curb.street + ' (' + sideShort(o.curb) +
      ') at ' + fmtTime(o.at);
  }

  /* Calendar events for the current plan. Each carries a kind ('move',
     'deadline' or 'now') so the backend can update an event in place when only
     its title changes, for example when someone claims the move. */
  function buildEvents(p, ctx) {
    var state = ctx.state, data = ctx.data, s = settings(state), o = opts(data, s);
    var appUrl = ctx.appUrl || '';
    var events = [], car = p.car;
    state.plannedMove = null;
    if (!car) return events;
    var list = moveList(p);
    var lines = list.slice(0, 3).map(function (x, i) {
      return (i + 1) + ') ' + P.curbLabel(x.curb) + ' (' + span(x.curb) + '): ' +
        (x.kind === 'fresh' ? 'opens ' + fmtWhen(x.at) : 'available now') +
        ', good until ' + fmtWhen(x.until) + ', ' + walkText(x.walkM);
    });
    var claim = activeClaim(state, p);
    var claimLine = claim ? claim.by + ' is taking this one.\n\n'
      : 'Open the app and tap "I\'ll move it" so the other person knows.\n\n';

    if (p.mustMoveNow) {
      var start = new Date((ctx.now || new Date()).getTime() + 5 * P.MIN);
      var why = s.snowEmergency && car.snowArtery ? 'Snow emergency: ' + car.street + ' is a snow route'
        : 'Sweeping on ' + car.street + ' now';
      if (list[0]) state.plannedMove = { curbId: list[0].curb.id, at: start.toISOString() };
      events.push({
        kind: 'now', moveKey: moveKey(list[0]),
        title: (claim ? claim.by + ': ' : '') + 'Move the car now: ' + why,
        start: start.toISOString(), end: new Date(start.getTime() + s.searchMinutes * P.MIN).toISOString(),
        location: P.curbLabel(car) + ', Beacon Hill, Boston, MA',
        description: why + '.\n\n' + claimLine + 'Best spots right now:\n' + lines.join('\n') + '\n\n' + appUrl,
        reminders: [0]
      });
      return events;
    }

    var top = nextMove(p);
    if (top) {
      var openAt = new Date(top.at);
      var st = top.kind === 'fresh' ? new Date(openAt.getTime() - s.leadMinutes * P.MIN) : openAt;
      state.plannedMove = { curbId: top.curb.id, at: openAt.toISOString() };
      var tripNote = p.trip ? 'You leave ' + fmtWhen(p.trip.trip.start) + ' and get back ' +
        fmtWhen(p.trip.trip.end) + '. ' + (top.coversTrip ? 'This spot lasts the whole trip.\n\n'
          : 'No curb lasts the whole trip; see the Trips section in the app.\n\n') : '';
      events.push({
        kind: 'move', moveKey: moveKey(top),
        title: moveTitle(top, claim, !!p.trip),
        start: st.toISOString(),
        end: new Date(openAt.getTime() + s.searchMinutes * P.MIN).toISOString(),
        location: P.curbLabel(top.curb) + ', ' + span(top.curb) + ', Boston, MA',
        description: (top.kind === 'fresh' ? 'Sweeping on ' + P.curbLabel(top.curb) + ' ends at ' + fmtTime(openAt) +
          ', so the curb opens up. ' : '') + 'Parking there is good until ' + fmtWhen(top.until) + '.\n\n' +
          tripNote + claimLine + 'Ranked options:\n' + lines.join('\n') + '\n\n' +
          'Current spot: ' + P.curbLabel(car) + ', must move by ' + fmtWhen(p.leaveBy || p.deadline) + '.\n' +
          'Log the new spot when parked: ' + appUrl,
        reminders: [30, eveningBefore(st)]
      });
    }
    var backstop = p.leaveBy || p.deadline;
    if (backstop) {
      var leavingFirst = p.trip && p.leaveBy && p.deadline && p.leaveBy < p.deadline;
      var sweep = P.nextSweep(car, new Date(p.deadline.getTime() - P.MIN), o);
      events.push({
        kind: 'deadline', moveKey: '',
        title: leavingFirst ? 'Last chance before your trip: move the car off ' + car.street
          : 'Car deadline: sweeping on ' + car.street + ' at ' + fmtTime(p.deadline),
        start: new Date(backstop.getTime() - 60 * P.MIN).toISOString(),
        end: backstop.toISOString(),
        location: P.curbLabel(car) + ', ' + span(car) + ', Boston, MA',
        description: 'Backstop reminder. The car is on ' + P.curbLabel(car) + ', swept ' + fmtWhen(p.deadline) +
          ' to ' + fmtTime(sweep ? sweep.end : new Date(p.deadline.getTime() + 4 * P.HOUR)) + '.' +
          (leavingFirst ? ' You leave ' + fmtWhen(p.leaveBy) + ', before then.' : '') +
          ' If it has not moved yet, move it now.\n\n' + appUrl,
        reminders: [60, eveningBefore(new Date(backstop.getTime() - 60 * P.MIN))]
      });
    }
    return events;
  }

  // ------------------------------------------------------------ geometry
  function nearestCurbs(curbs, lng, lat, n) {
    var lat0 = lat * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0), ky = 110540;
    function d2(p, a, b) {
      var px = p[0] * kx, py = p[1] * ky, ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
      var dx = bx - ax, dy = by - ay, t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1);
      t = Math.max(0, Math.min(1, t));
      var x = ax + t * dx - px, y = ay + t * dy - py;
      return x * x + y * y;
    }
    var p = [lng, lat];
    return curbs.map(function (c) {
      var best = Infinity;
      for (var i = 1; i < c.line.length; i++) best = Math.min(best, d2(p, c.line[i - 1], c.line[i]));
      return { curb: c, dist: Math.sqrt(best) };
    }).sort(function (a, b) { return a.dist - b.dist; }).slice(0, n || 5);
  }

  // "42 Chestnut St" for the house number on this curb closest to a point.
  function nearestAddress(curb, lng, lat) {
    var best = null, bestD = Infinity;
    (curb.addr || []).forEach(function (a) {
      var d = P.distanceM([lng, lat], [a[1], a[2]]);
      if (d < bestD) { bestD = d; best = a; }
    });
    return best && bestD < 60 ? best[0] + ' ' + curb.street : '';
  }

  // The other side of the same block, for "wrong side? switch".
  function oppositeCurb(curbs, curb) {
    var other = curb.side === 'Odd' ? 'Even' : curb.side === 'Even' ? 'Odd' : null;
    if (!other) return null;
    var same = curbs.filter(function (c) { return c.street === curb.street && c.side === other; });
    var exact = same.filter(function (c) { return c.from === curb.from && c.to === curb.to; })[0];
    if (exact) return exact;
    var near = same.map(function (c) { return { c: c, d: P.distanceM(c.center, curb.center) }; })
      .sort(function (a, b) { return a.d - b.d; })[0];
    return near && near.d < 120 ? near.c : null;
  }

  var api = {
    DEFAULTS: DEFAULTS, SEARCH_BUCKETS: SEARCH_BUCKETS, WALK_M_PER_MIN: WALK_M_PER_MIN,
    settings: settings, opts: opts, fmtDay: fmtDay, fmtTime: fmtTime, fmtWhen: fmtWhen,
    span: span, walkText: walkText, sideShort: sideShort, learn: learn, searchStats: searchStats,
    permitIndex: permitIndex, plan: plan, moveList: moveList, moveKey: moveKey, nextMove: nextMove,
    activeClaim: activeClaim, recordPark: recordPark, applyFeedback: applyFeedback,
    buildEvents: buildEvents, eveningBefore: eveningBefore, nearestCurbs: nearestCurbs,
    nearestAddress: nearestAddress, oppositeCurb: oppositeCurb
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(this);
