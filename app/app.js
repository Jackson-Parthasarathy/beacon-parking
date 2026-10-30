/* Beau on Beacon Hill UI. State lives in the shared backend (Google Apps Script)
   when configured, otherwise in this browser only. */
(function () {
  'use strict';

  var P = window.Planner;
  var $ = function (id) { return document.getElementById(id); };
  var HOME_DEFAULT_VIEW = [42.3586, -71.0680];
  var WALK_M_PER_MIN = 80;

  var DEFAULT_SETTINGS = {
    searchMinutes: 60, leadMinutes: 10, walkMinutes: 12,
    skipFifthWeek: true, snowEmergency: false
  };

  var data = null;          // segments.json
  var curbsById = {};
  var cfg = loadJSON('bp.cfg', {});            // per device: api, key, name
  var state = loadJSON('bp.state', { car: null, home: null, settings: {}, events: [], history: [] });
  var plan = null;
  var selectedMove = null;
  var pending = null;       // confirm-spot candidates
  var pickTarget = null;    // 'car' | 'home'

  var map, curbLayer, optLayer, carMarker, homeMarker, meMarker, snowLayer;
  var curbLines = {};

  // ------------------------------------------------------------ storage
  function loadJSON(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }
  function settings() {
    var s = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    s.maxWalkM = s.walkMinutes * WALK_M_PER_MIN;
    return s;
  }
  function synced() { return !!(cfg.api && cfg.key); }

  // ------------------------------------------------------------ setup link
  // #setup=<base64 JSON {api, key, name, home}> configures a phone in one tap.
  // An iPhone home-screen app keeps its own storage apart from the browser,
  // so the same link can also be pasted into the app.
  function applySetupLink(text) {
    var m = String(text || '').match(/setup=([^&\s]+)/);
    if (!m) return false;
    try {
      var s = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
      if (!s.api || !s.key) return false;
      cfg.api = s.api;
      cfg.key = s.key;
      if (s.name) cfg.name = s.name;
      saveJSON('bp.cfg', cfg);
      if (s.home && !state.home) { state.home = s.home; saveJSON('bp.state', state); }
      toast('This phone is connected' + (s.name ? ' for ' + s.name : '') + '.');
      return true;
    } catch (e) {
      return false;
    }
  }

  function readSetupLink() {
    if (!/setup=/.test(location.hash)) return;
    if (!applySetupLink(location.hash)) toast('That setup link could not be read.');
    history.replaceState(null, '', location.pathname + location.search);
  }

  function renderConnect() {
    var el = $('connect');
    el.hidden = synced();
    if (el.hidden) return;
    el.innerHTML = '<b>Connect this phone</b><div class="muted small" style="margin:4px 0 8px">' +
      'Paste the setup link you were sent so both phones share the car and calendar.</div>' +
      '<div class="row"><input id="connect-link" placeholder="Paste setup link" autocomplete="off">' +
      '<button class="btn small primary" id="btn-connect">Connect</button></div>';
    $('btn-connect').onclick = function () {
      if (applySetupLink($('connect-link').value)) { render(); pull(); }
      else toast('That does not look like a setup link.');
    };
  }

  // ------------------------------------------------------------ backend
  function api(action, payload) {
    var body = Object.assign({ action: action, key: cfg.key, by: cfg.name || '' }, payload || {});
    return fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Backend error');
      return res.state;
    });
  }

  function pull() {
    if (!synced()) return Promise.resolve();
    return api('state').then(function (s) {
      adopt(s);
      setSyncStatus('Synced ' + fmtTime(new Date()));
    }).catch(function (e) {
      setSyncStatus('Could not reach the backend: ' + e.message);
    });
  }

  function adopt(s) {
    if (!s) return;
    state = Object.assign({ car: null, home: null, settings: {}, events: [], history: [] }, s);
    saveJSON('bp.state', state);
    render();
  }

  // Save locally first so the UI never waits on the network.
  function commit(action, payload, msg) {
    saveJSON('bp.state', state);
    render();
    if (!synced()) { if (msg) toast(msg); return Promise.resolve(); }
    return api(action, payload).then(function (s) {
      adopt(s);
      if (msg) toast(msg);
    }).catch(function (e) {
      toast('Saved on this phone only. Sync failed: ' + e.message);
    });
  }

  function setSyncStatus(t) { var el = $('sync-status'); if (el) el.textContent = t; }

  // ------------------------------------------------------------ formatting
  var fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: P.TZ, weekday: 'short', month: 'short', day: 'numeric' });
  var fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: P.TZ, hour: 'numeric', minute: '2-digit' });
  function fmtTime(d) { return fmtClock.format(d); }
  function fmtWhen(d) { return fmtDay.format(d) + ', ' + fmtClock.format(d); }
  function fmtSpan(ms) {
    var h = ms / P.HOUR;
    if (h < 1) return Math.max(1, Math.round(ms / P.MIN)) + ' min';
    if (h < 36) return Math.round(h) + ' h';
    return Math.round(h / 24) + ' days';
  }
  function walkText(m) { return Math.max(1, Math.round(m / WALK_M_PER_MIN)) + ' min walk'; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function span(c) { return c.from + ' to ' + c.to; }

  function curbColor(st) {
    if (st.state === 'sweeping') return 'var(--red)';
    if (st.state === 'none') return 'var(--gray)';
    if (st.hours < 24) return 'var(--orange)';
    if (st.hours < 72) return 'var(--amber)';
    return 'var(--green)';
  }
  function pillClass(st) {
    if (st.state === 'sweeping') return 'red';
    if (st.state === 'none') return 'gray';
    if (st.hours < 24) return 'orange';
    if (st.hours < 72) return 'amber';
    return '';
  }
  function cssVar(v) {
    var m = v.match(/var\((--[a-z]+)\)/);
    return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : v;
  }

  // ------------------------------------------------------------ map
  function initMap() {
    map = L.map('map', { zoomControl: false, tap: true }).setView(HOME_DEFAULT_VIEW, 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    snowLayer = L.layerGroup().addTo(map);
    data.snowRoutes.forEach(function (r) {
      L.polyline(r.line.map(ll), { color: cssVar('var(--snow)'), weight: 3, opacity: 0.7, dashArray: '6 6', interactive: false }).addTo(snowLayer);
    });

    curbLayer = L.layerGroup().addTo(map);
    optLayer = L.layerGroup().addTo(map);

    data.curbs.forEach(function (c) {
      var line = L.polyline(c.line.map(ll), { weight: 6, opacity: 0.95, lineCap: 'round' }).addTo(curbLayer);
      var hit = L.polyline(c.line.map(ll), { weight: 22, opacity: 0 }).addTo(curbLayer);
      hit.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        // Both sides' hit lines overlap, so rank by true distance to the tap.
        if (pickTarget === 'car') { openConfirm(nearestCurbs(e.latlng, 5)); return; }
        if (pickTarget === 'home') { setHome([e.latlng.lng, e.latlng.lat]); return; }
        curbPopup(c, e.latlng);
      });
      curbLines[c.id] = line;
    });

    map.on('click', function (e) {
      if (pickTarget === 'car') openConfirm(nearestCurbs(e.latlng, 5));
      else if (pickTarget === 'home') setHome([e.latlng.lng, e.latlng.lat]);
    });
  }

  function ll(p) { return [p[1], p[0]]; }

  function svgPin(kind, label) {
    var inner = kind === 'car'
      ? '<svg viewBox="0 0 24 24"><path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM7.2 10h9.6l-1-2.7a.8.8 0 0 0-.8-.5H9a.8.8 0 0 0-.8.5zM7.5 14a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zm9 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z"/></svg>'
      : kind === 'home'
        ? '<svg viewBox="0 0 24 24"><path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z"/></svg>'
        : (label || '');
    var size = kind === 'car' ? 34 : kind === 'home' ? 26 : kind === 'me' ? 16 : 24;
    return L.divIcon({ className: '', html: '<div class="pin ' + kind + '">' + inner + '</div>', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function curbPopup(c, latlng) {
    var now = new Date(), st = P.status(c, now, opts());
    var next = P.occurrences(c, now, new Date(now.getTime() + 70 * P.DAY), opts()).slice(0, 3);
    var flags = [];
    if (c.metered) flags.push('Metered, not resident parking');
    if (c.daily) flags.push('Swept every night');
    if (c.snowArtery) flags.push('Snow emergency route');
    var html = '<b>' + esc(P.curbLabel(c)) + '</b><br><span>' + esc(span(c)) + '</span><br>' +
      esc(P.describe(c, settings())) +
      (flags.length ? '<br><span style="color:' + cssVar('var(--orange)') + '">' + esc(flags.join('. ')) + '</span>' : '') +
      '<br><br><b>' + (st.state === 'sweeping' ? 'Sweeping now' : 'Next sweeps') + '</b><br>' +
      (next.length ? next.map(function (o) { return esc(fmtWhen(o.start) + ' to ' + fmtTime(o.end)); }).join('<br>') : 'None scheduled before spring') +
      '<button class="btn primary" data-park="' + c.id + '">Car is parked here</button>';
    var pop = L.popup({ maxWidth: 270 }).setLatLng(latlng).setContent(html).openOn(map);
    var btn = pop.getElement().querySelector('[data-park]');
    btn.addEventListener('click', function () { map.closePopup(); saveCar(c, latlng); });
  }

  function paintMap() {
    var now = new Date();
    data.curbs.forEach(function (c) {
      var line = curbLines[c.id];
      var ineligible = c.metered || c.daily;
      var st = P.status(c, now, opts());
      line.setStyle({
        color: ineligible ? cssVar('var(--gray)') : cssVar(curbColor(st)),
        weight: state.car && state.car.curbId === c.id ? 9 : 6,
        dashArray: ineligible ? '2 8' : null,
        opacity: ineligible ? 0.7 : 0.95
      });
    });

    if (carMarker) { map.removeLayer(carMarker); carMarker = null; }
    if (state.car && curbsById[state.car.curbId]) {
      var pos = state.car.lat ? [state.car.lat, state.car.lng] : ll(curbsById[state.car.curbId].center);
      carMarker = L.marker(pos, { icon: svgPin('car'), zIndexOffset: 1000 }).addTo(map);
      carMarker.on('click', function () { curbPopup(curbsById[state.car.curbId], carMarker.getLatLng()); });
    }
    if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
    if (state.home) homeMarker = L.marker(ll(state.home), { icon: svgPin('home'), interactive: false }).addTo(map);

    optLayer.clearLayers();
    moveList().forEach(function (o, i) {
      L.marker(ll(o.curb.center), { icon: svgPin('opt', String(i + 1)), zIndexOffset: 500 - i })
        .on('click', function () { selectMove(i); })
        .addTo(optLayer);
    });
  }

  function opts() { return { season: data.season['Beacon Hill'], skipFifthWeek: settings().skipFifthWeek }; }

  // ------------------------------------------------------------ geometry
  function nearestCurbs(latlng, n, preferId) {
    var lat0 = latlng.lat * Math.PI / 180;
    var kx = 111320 * Math.cos(lat0), ky = 110540;
    function d2(p, a, b) {
      var px = p[0] * kx, py = p[1] * ky, ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
      var dx = bx - ax, dy = by - ay, t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1);
      t = Math.max(0, Math.min(1, t));
      var x = ax + t * dx - px, y = ay + t * dy - py;
      return x * x + y * y;
    }
    var p = [latlng.lng, latlng.lat];
    var ranked = data.curbs.map(function (c) {
      var best = Infinity;
      for (var i = 1; i < c.line.length; i++) best = Math.min(best, d2(p, c.line[i - 1], c.line[i]));
      return { curb: c, dist: Math.sqrt(best) };
    }).sort(function (a, b) { return a.dist - b.dist; });
    if (preferId) {
      var idx = ranked.findIndex(function (r) { return r.curb.id === preferId; });
      if (idx > 0) ranked.unshift(ranked.splice(idx, 1)[0]);
    }
    return { latlng: latlng, list: ranked.slice(0, n) };
  }

  // ------------------------------------------------------------ actions
  function locate() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Location is not available'));
      navigator.geolocation.getCurrentPosition(function (p) {
        var latlng = L.latLng(p.coords.latitude, p.coords.longitude);
        if (meMarker) map.removeLayer(meMarker);
        meMarker = L.marker(latlng, { icon: svgPin('me'), interactive: false }).addTo(map);
        resolve(latlng);
      }, function (e) { reject(new Error(e.message || 'Location denied')); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
    });
  }

  function parkedHere() {
    var btn = $('btn-parked');
    btn.disabled = true; btn.textContent = 'Finding you...';
    locate().then(function (latlng) {
      map.setView(latlng, 18);
      var near = nearestCurbs(latlng, 5);
      if (near.list[0].dist > 250) {
        toast('You look far from Beacon Hill. Tap the curb on the map instead.');
        startPick('car');
        return;
      }
      openConfirm(near);
    }).catch(function (e) {
      toast(e.message + '. Tap the curb on the map instead.');
      startPick('car');
    }).then(function () {
      btn.disabled = false; btn.textContent = 'I just parked here';
    });
  }

  function openConfirm(near) {
    endPick();
    pending = { latlng: near.latlng, list: near.list, sel: 0 };
    var now = new Date();
    $('choices').innerHTML = near.list.map(function (r, i) {
      var c = r.curb, st = P.status(c, now, opts());
      var warn = c.metered ? ' Metered.' : c.daily ? ' Swept nightly.' : '';
      var next = st.state === 'sweeping' ? 'Sweeping now.' : st.next ? 'Next sweep ' + fmtWhen(st.next.start) + '.' : 'No sweep until spring.';
      return '<li data-i="' + i + '" class="' + (i === 0 ? 'selected' : '') + '"><div class="t">' + esc(P.curbLabel(c)) + '</div>' +
        '<div class="s">' + esc(span(c)) + ', ' + Math.round(r.dist) + ' m away. ' + esc(next + warn) + '</div></li>';
    }).join('');
    highlight(near.list[0].curb);
    $('confirm').hidden = false;
  }

  function highlight(c) {
    var line = curbLines[c.id];
    if (!line) return;
    line.setStyle({ weight: 11 });
    line.bringToFront();
    setTimeout(paintMap, 1600);
  }

  function saveCar(c, latlng) {
    state.car = {
      curbId: c.id,
      lat: latlng ? +latlng.lat.toFixed(6) : c.center[1],
      lng: latlng ? +latlng.lng.toFixed(6) : c.center[0],
      parkedAt: new Date().toISOString(),
      by: cfg.name || ''
    };
    state.history = [state.car].concat(state.history || []).slice(0, 40);
    plan = computePlan();
    var events = buildEvents(plan);
    state.events = events;
    commit('park', { car: state.car, events: events },
      'Saved: ' + P.curbLabel(c) + (synced() && events.length ? '. Calendar invites updated.' : '.'));
  }

  function setHome(home) {
    state.home = home;
    endPick();
    $('settings').hidden = false;
    plan = computePlan();
    commit('home', { home: home }, 'Home saved.');
    renderSettings();
  }

  function startPick(target) {
    pickTarget = target;
    document.body.classList.add('pick-mode');
    setTimeout(function () { map.invalidateSize(); }, 280);
    var hint = document.createElement('div');
    hint.className = 'pick-hint';
    hint.id = 'pick-hint';
    hint.innerHTML = '<span>' + (target === 'car' ? 'Tap the curb where the car is parked.' : 'Tap your home on the map.') +
      '</span><button class="btn small" id="btn-pick-cancel">Cancel</button>';
    document.body.appendChild(hint);
    $('btn-pick-cancel').onclick = function () {
      endPick();
      if (target === 'home') $('settings').hidden = false;
    };
  }

  function endPick() {
    pickTarget = null;
    document.body.classList.remove('pick-mode');
    var h = $('pick-hint'); if (h) h.remove();
    setTimeout(function () { map.invalidateSize(); }, 280);
  }

  // ------------------------------------------------------------ plan + events
  function computePlan() {
    var s = settings();
    return P.rank({
      curbs: data.curbs, now: new Date(), home: state.home, car: state.car,
      settings: s, season: data.season['Beacon Hill'], limit: 6
    });
  }

  function moveList() {
    if (!plan || !plan.car) return [];
    if (plan.mustMoveNow) return plan.options.concat(plan.fallback).slice(0, 6);
    return plan.options.length ? plan.options : plan.fallback;
  }

  function appUrl() { return location.origin + location.pathname; }

  function buildEvents(p) {
    var s = settings(), events = [], car = p.car;
    if (!car) return events;
    var list = p.mustMoveNow ? p.options.concat(p.fallback) : p.options.length ? p.options : p.fallback;
    var lines = list.slice(0, 3).map(function (o, i) {
      return (i + 1) + ') ' + P.curbLabel(o.curb) + ' (' + span(o.curb) + '): ' +
        (o.kind === 'fresh' ? 'opens ' + fmtWhen(o.at) : 'available now') +
        ', good until ' + fmtWhen(o.until) + ', ' + walkText(o.walkM);
    });

    if (p.mustMoveNow) {
      var start = new Date(Date.now() + 5 * P.MIN);
      var why = s.snowEmergency && car.snowArtery ? 'Snow emergency: ' + car.street + ' is a snow route' : 'Sweeping on ' + car.street + ' now';
      events.push({
        title: 'Move the car now: ' + why,
        start: start.toISOString(), end: new Date(start.getTime() + s.searchMinutes * P.MIN).toISOString(),
        location: P.curbLabel(car) + ', Beacon Hill, Boston, MA',
        description: why + '.\n\nBest spots right now:\n' + lines.join('\n') + '\n\n' + appUrl(),
        reminders: [0]
      });
      return events;
    }

    var top = list[0];
    if (top && top.kind === 'fresh') {
      var openAt = top.at;
      var st = new Date(openAt.getTime() - s.leadMinutes * P.MIN);
      events.push({
        title: 'Move car to ' + top.curb.street + ' (' + sideShort(top.curb) + ') at ' + fmtTime(openAt),
        start: st.toISOString(),
        end: new Date(openAt.getTime() + s.searchMinutes * P.MIN).toISOString(),
        location: P.curbLabel(top.curb) + ', ' + span(top.curb) + ', Boston, MA',
        description: 'Sweeping on ' + P.curbLabel(top.curb) + ' ends at ' + fmtTime(openAt) +
          ', so the curb opens up. Parking there is good until ' + fmtWhen(top.until) + '.\n\n' +
          'Ranked options:\n' + lines.join('\n') + '\n\n' +
          'Current spot: ' + P.curbLabel(car) + ', must move by ' + fmtWhen(p.deadline) + '.\n' +
          'Log the new spot when parked: ' + appUrl(),
        reminders: [30, eveningBefore(st)]
      });
    }
    if (p.deadline) {
      var dl = p.deadline;
      var sweep = P.nextSweep(car, new Date(dl.getTime() - P.MIN), opts());
      var dlEnd = sweep ? sweep.end : new Date(dl.getTime() + 4 * P.HOUR);
      events.push({
        title: 'Car deadline: sweeping on ' + car.street + ' at ' + fmtTime(dl),
        start: new Date(dl.getTime() - 60 * P.MIN).toISOString(),
        end: dl.toISOString(),
        location: P.curbLabel(car) + ', ' + span(car) + ', Boston, MA',
        description: 'Backstop reminder. The car is on ' + P.curbLabel(car) + ', swept ' +
          fmtWhen(dl) + ' to ' + fmtTime(dlEnd) + '. If it has not moved yet, move it now.\n\n' + appUrl(),
        reminders: [60, eveningBefore(new Date(dl.getTime() - 60 * P.MIN))]
      });
    }
    return events;
  }

  // Minutes from 8 PM the evening before to the event start.
  function eveningBefore(start) {
    var p = P.etParts(start);
    var prev = P.etDate(p.y, p.m, p.d, 20, 0);
    prev = new Date(prev.getTime() - P.DAY);
    return Math.max(30, Math.round((start - prev) / P.MIN));
  }

  function sideShort(c) {
    return c.side === 'Odd' || c.side === 'Even' ? c.side.toLowerCase() + ' side' : c.side.toLowerCase();
  }

  function icsFor(events) {
    function t(iso) { return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
    function e(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
    var out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Beau on Beacon Hill//EN', 'METHOD:PUBLISH'];
    events.forEach(function (ev, i) {
      out.push('BEGIN:VEVENT', 'UID:bp-' + t(ev.start) + '-' + i + '@beacon-parking', 'DTSTAMP:' + t(new Date().toISOString()),
        'DTSTART:' + t(ev.start), 'DTEND:' + t(ev.end), 'SUMMARY:' + e(ev.title),
        'LOCATION:' + e(ev.location || ''), 'DESCRIPTION:' + e(ev.description || ''));
      (ev.reminders || []).forEach(function (m) {
        out.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + e(ev.title), 'TRIGGER:-PT' + m + 'M', 'END:VALARM');
      });
      out.push('END:VEVENT');
    });
    out.push('END:VCALENDAR');
    // RFC 5545: fold lines longer than 75 octets.
    return out.map(function (line) {
      var parts = [];
      while (line.length > 73) { parts.push(line.slice(0, 73)); line = ' ' + line.slice(73); }
      parts.push(line);
      return parts.join('\r\n');
    }).join('\r\n');
  }

  function downloadIcs() {
    var events = state.events && state.events.length ? state.events : buildEvents(plan);
    if (!events.length) { toast('Nothing to add yet. Save where the car is first.'); return; }
    var blob = new Blob([icsFor(events)], { type: 'text/calendar' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'move-the-car.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!data) return;
    plan = computePlan();
    renderCar();
    renderMoves();
    renderCalendar();
    renderSnow();
    renderConnect();
    paintMap();
    $('footnote').innerHTML = 'Schedule: City of Boston open data (retrieved ' + esc(String(data.sourceUpdated).slice(0, 10)) +
      '). Beacon Hill residential sweeping runs Mar 1 to Dec 31; holidays are not excluded. Always check the posted sign. ' +
      'Metered and nightly-swept curbs are shown dashed and never recommended.';
  }

  function renderCar() {
    var el = $('car-card');
    var car = state.car && curbsById[state.car.curbId];
    if (!car) {
      el.innerHTML = '<div class="label">Your car</div><div class="street">Not set yet</div>' +
        '<div class="meta">Tap "I just parked here" next time you park, or pick the curb on the map.</div>';
      return;
    }
    var now = new Date(), st = P.status(car, now, opts());
    var when = st.state === 'sweeping' ? 'Sweeping now until ' + fmtTime(st.next.end)
      : st.next ? 'Next sweep ' + fmtWhen(st.next.start) : 'No sweeping until spring';
    var pill = st.state === 'sweeping' ? 'Move now' : st.next ? 'in ' + fmtSpan(st.next.start - now) : 'Clear';
    var snowWarn = settings().snowEmergency && car.snowArtery
      ? '<div class="banner alert" style="margin:12px 0 0">Snow emergency: this is a snow route. Move the car now.</div>' : '';
    var parked = new Date(state.car.parkedAt);
    el.innerHTML = '<div class="label">Your car</div>' +
      '<div class="street">' + esc(P.curbLabel(car)) + '</div>' +
      '<div class="meta">' + esc(span(car)) + '. Parked ' + esc(fmtWhen(parked)) + (state.car.by ? ' by ' + esc(state.car.by) : '') + '.</div>' +
      '<div class="meta">' + esc(P.describe(car, settings())) + '</div>' +
      '<div class="status-row"><span class="when">' + esc(when) + '</span><span class="pill ' + pillClass(st) + '">' + esc(pill) + '</span></div>' +
      snowWarn;
  }

  function renderMoves() {
    var list = moveList(), el = $('moves'), sub = $('moves-sub');
    if (!state.car) {
      sub.textContent = '';
      el.innerHTML = '<li class="empty">Save where the car is and the best next spots show up here.</li>';
      return;
    }
    if (plan.mustMoveNow) sub.textContent = 'Move now';
    else if (plan.options.length) sub.textContent = 'Right after a sweep ends';
    else sub.textContent = plan.deadline ? 'No fresh openings before your deadline' : '';
    if (!list.length) {
      el.innerHTML = '<li class="empty">' + (plan.deadline
        ? 'No better spot opens before ' + esc(fmtWhen(plan.deadline)) + '. Stay put.'
        : 'No sweeping on your curb this season. Stay put.') + '</li>';
      return;
    }
    el.innerHTML = list.map(function (o, i) {
      var gainDays = Math.round((o.until - o.at) / P.DAY);
      var supply = o.supplyM >= 1500 ? 'Lots of curb opening' : o.supplyM >= 700 ? 'Some curb opening' : o.kind === 'fresh' ? 'Small opening' : '';
      var facts = [
        '<span class="chip good">Good for ' + gainDays + ' days</span>',
        state.home ? '<span class="chip">' + walkText(o.walkM) + '</span>' : '',
        supply ? '<span class="chip">' + supply + '</span>' : '',
        o.winterArtery ? '<span class="chip warn">Snow route</span>' : ''
      ].join('');
      return '<li class="move' + (selectedMove === i ? ' selected' : '') + '" data-i="' + i + '">' +
        '<div class="rank">' + (i + 1) + '</div><div>' +
        '<div class="title">' + esc(P.curbLabel(o.curb)) + '</div>' +
        '<div class="when">' + (o.kind === 'fresh' ? 'Opens ' + esc(fmtWhen(o.at)) : 'Open now') +
        '<span class="muted">. Next sweep ' + esc(fmtDay.format(o.until)) + '</span></div>' +
        '<div class="muted small">' + esc(span(o.curb)) + '</div>' +
        '<div class="facts">' + facts + '</div></div></li>';
    }).join('');
  }

  function selectMove(i) {
    selectedMove = i;
    var o = moveList()[i];
    if (!o) return;
    map.fitBounds(L.polyline(o.curb.line.map(ll)).getBounds(), { padding: [60, 60], maxZoom: 18, animate: false });
    highlight(o.curb);
    renderMoves();
  }

  function renderCalendar() {
    var el = $('cal-card'), ev = state.events || [];
    var upcoming = ev.filter(function (e) { return new Date(e.end) > new Date(); });
    var head = '<h4>Calendar</h4>';
    var body = upcoming.length
      ? '<ul>' + upcoming.map(function (e) { return '<li>' + esc(fmtWhen(new Date(e.start))) + ': ' + esc(e.title) + '</li>'; }).join('') + '</ul>'
      : '<p class="muted small" style="margin:0">No reminders scheduled.</p>';
    var foot = synced()
      ? '<p class="muted small" style="margin:10px 0 0">Invites go to both calendars automatically each time the car is saved.' +
        (state.updatedAt ? ' Last update ' + esc(fmtWhen(new Date(state.updatedAt))) + (state.updatedBy ? ' by ' + esc(state.updatedBy) : '') + '.' : '') + '</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn small" id="btn-resend">Recalculate and resend</button><button class="btn small" id="btn-ics">Add to this phone</button></div>'
      : '<p class="muted small" style="margin:10px 0 0">Shared sync is off, so invites are not sent automatically. Set it up in Settings, or add these to this phone now.</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn small" id="btn-ics">Add to calendar</button></div>';
    el.innerHTML = head + body + foot;
    $('btn-ics').onclick = downloadIcs;
    if ($('btn-resend')) $('btn-resend').onclick = function () {
      plan = computePlan();
      state.events = buildEvents(plan);
      commit('plan', { events: state.events }, 'Calendar updated.');
    };
  }

  function renderSnow() {
    var s = settings(), el = $('snow-card');
    var garages = data.snowGarages.map(function (g) {
      return '<li><b>' + esc(g.name) + '</b>, ' + esc(g.address) + ': ' + esc(g.fee) + '</li>';
    }).join('');
    el.innerHTML = '<div class="switch-row"><div><h4>Snow emergency</h4>' +
      '<div class="muted small">Flip on when the City declares one. Snow routes (blue dashes) are then excluded and the car gets a move-now alert if it is on one.</div></div>' +
      '<label class="toggle"><input type="checkbox" id="snow-toggle"' + (s.snowEmergency ? ' checked' : '') + '><span></span></label></div>' +
      (s.snowEmergency ? '<p class="small" style="margin:12px 0 0">Discounted garages for Beacon Hill residents (City list; confirm rates):</p><ul>' + garages + '</ul>' : '') +
      '<p class="muted small" style="margin:10px 0 0">The City announces snow emergencies through AlertBoston and boston.gov/snow.</p>';
    $('snow-toggle').onchange = function (e) {
      state.settings = Object.assign({}, state.settings, { snowEmergency: e.target.checked });
      plan = computePlan();
      state.events = buildEvents(plan);
      commit('settings', { settings: state.settings, events: state.events },
        e.target.checked ? 'Snow emergency on. Plan updated.' : 'Snow emergency off.');
    };
    var b = $('snow-banner');
    b.hidden = !s.snowEmergency;
    b.textContent = 'Snow emergency is on. Snow routes are excluded from recommendations.';
  }

  function renderSettings() {
    var s = settings();
    $('set-name').value = cfg.name || '';
    $('set-search').value = s.searchMinutes;
    $('set-lead').value = s.leadMinutes;
    $('set-walk').value = s.walkMinutes;
    $('set-fifth').checked = s.skipFifthWeek;
    $('set-api').value = cfg.api || '';
    $('set-key').value = cfg.key || '';
    $('home-label').textContent = state.home ? 'Set (' + state.home[1].toFixed(4) + ', ' + state.home[0].toFixed(4) + ')' : 'Not set';
    setSyncStatus(synced() ? 'Connected. Changes sync between phones.' : 'Not connected. Data stays on this phone.');
  }

  function saveSettings() {
    var link = $('set-link').value.trim();
    if (link && !applySetupLink(link)) { toast('That does not look like a setup link.'); return; }
    if (!link) {
      cfg.api = $('set-api').value.trim();
      cfg.key = $('set-key').value.trim();
    }
    cfg.name = $('set-name').value.trim() || cfg.name;
    $('set-link').value = '';
    saveJSON('bp.cfg', cfg);
    var next = Object.assign({}, state.settings, {
      searchMinutes: clamp(+$('set-search').value, 15, 240, 60),
      leadMinutes: clamp(+$('set-lead').value, 0, 60, 10),
      walkMinutes: clamp(+$('set-walk').value, 3, 25, 12),
      skipFifthWeek: $('set-fifth').checked
    });
    var changed = JSON.stringify(next) !== JSON.stringify(state.settings);
    state.settings = next;
    $('settings').hidden = true;
    plan = computePlan();
    if (changed && state.car) state.events = buildEvents(plan);
    var p = commit('settings', { settings: state.settings, events: changed && state.car ? state.events : undefined }, 'Settings saved.');
    if (synced()) p.then(pull);
  }

  function clamp(v, lo, hi, d) { return isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : d; }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3600);
  }

  // ------------------------------------------------------------ wire up
  function wire() {
    $('btn-parked').onclick = parkedHere;
    $('btn-pick').onclick = function () { startPick('car'); };
    $('btn-settings').onclick = function () { renderSettings(); $('settings').hidden = false; };
    $('btn-close-settings').onclick = function () { $('settings').hidden = true; };
    $('btn-save-settings').onclick = saveSettings;
    $('btn-home-here').onclick = function () {
      locate().then(function (latlng) { setHome([+latlng.lng.toFixed(6), +latlng.lat.toFixed(6)]); })
        .catch(function (e) { toast(e.message); });
    };
    $('btn-home-map').onclick = function () { $('settings').hidden = true; startPick('home'); };
    $('btn-locate').onclick = function () {
      locate().then(function (latlng) { map.setView(latlng, 18); }).catch(function (e) { toast(e.message); });
    };
    $('btn-cancel').onclick = function () { $('confirm').hidden = true; pending = null; paintMap(); };
    $('btn-confirm').onclick = function () {
      if (!pending) return;
      var c = pending.list[pending.sel].curb;
      $('confirm').hidden = true;
      saveCar(c, pending.latlng);
      pending = null;
    };
    $('choices').onclick = function (e) {
      var li = e.target.closest('li'); if (!li || !pending) return;
      pending.sel = +li.dataset.i;
      Array.prototype.forEach.call($('choices').children, function (x, i) { x.classList.toggle('selected', i === pending.sel); });
      paintMap();
      highlight(pending.list[pending.sel].curb);
    };
    $('moves').onclick = function (e) {
      var li = e.target.closest('li.move'); if (li) selectMove(+li.dataset.i);
    };
    $('grabber').onclick = function () { $('sheet').classList.toggle('expanded'); };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { pull(); render(); }
    });
    setInterval(function () { if (document.visibilityState === 'visible') render(); }, 60000);
    setInterval(function () { if (document.visibilityState === 'visible') pull(); }, 120000);
  }

  function boot() {
    readSetupLink();
    var load = window.BP_DATA ? Promise.resolve(window.BP_DATA)
      : fetch('data/segments.json').then(function (r) { return r.json(); });
    load.then(function (d) {
      data = d;
      d.curbs.forEach(function (c) { curbsById[c.id] = c; });
      initMap();
      wire();
      render();
      if (state.car && curbsById[state.car.curbId]) map.setView(ll(curbsById[state.car.curbId].center), 17);
      pull();
    }).catch(function (e) {
      toast('Could not load the street schedule: ' + e.message);
    });
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is optional */ });
    }
  }

  boot();
})();
