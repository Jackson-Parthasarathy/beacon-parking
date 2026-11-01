/* Beau on Beacon Hill UI. State lives in the shared backend (Google Apps Script)
   when configured, otherwise in this browser only. Planning, events and
   learning come from engine.js, which the backend runs too. */
(function () {
  'use strict';

  var P = window.Planner, E = window.Engine;
  var $ = function (id) { return document.getElementById(id); };
  var HOME_DEFAULT_VIEW = [42.3586, -71.0680];
  var EMPTY = { car: null, home: null, settings: {}, events: [], history: [], trips: [] };

  var data = null;          // segments.json
  var restrictions = null;  // restrictions.json (moving-truck permits)
  var curbsById = {};
  var cfg = loadJSON('bp.cfg', {});            // per device: api, key, name
  var state = Object.assign({}, EMPTY, loadJSON('bp.state', {}));
  var skipped = loadJSON('bp.skipped', {});    // feedback prompts dismissed on this phone
  var plan = null;
  var selectedMove = null;
  var pending = null;       // confirm-spot candidates
  var pickTarget = null;    // 'car' | 'home'

  var map, curbLayer, optLayer, permitLayer, carMarker, homeMarker, meMarker, snowLayer;
  var curbLines = {};

  // ------------------------------------------------------------ storage
  function loadJSON(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }
  function settings() { return E.settings(state); }
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
  var REACH_HELP = 'Could not reach your Google script. In Apps Script, check Deploy, then Manage deployments: ' +
    'Who has access must be Anyone. Then use Settings, then Test connection.';
  var PAGE_HELP = 'Your Google script answered with a web page instead of data. In Apps Script, go to Deploy, ' +
    'then Manage deployments, click the pencil, choose New version, and Deploy.';

  function api(action, payload) {
    var body = Object.assign({ action: action, key: cfg.key, by: cfg.name || '' }, payload || {});
    return fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).catch(function () { throw new Error(REACH_HELP); })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var res;
        try { res = JSON.parse(t); } catch (e) { throw new Error(PAGE_HELP); }
        if (!res.ok) throw new Error(res.error === 'wrong passphrase'
          ? 'The passphrase does not match. Paste the latest setup link from the Apps Script log.' : res.error || 'Backend error');
        return res.state;
      });
  }

  function testConnection() {
    if (!synced()) { setSyncStatus('Not connected yet. Paste a setup link first.'); return; }
    setSyncStatus('Testing...');
    fetch(cfg.api, { redirect: 'follow' })
      .catch(function () { throw new Error(REACH_HELP); })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var res;
        try { res = JSON.parse(t); } catch (e) { throw new Error(PAGE_HELP); }
        if (!res.ok || res.service !== 'beacon-parking') throw new Error('That URL is not the Beau backend.');
        if (!res.version || res.version < 2) {
          throw new Error('Reached the script, but it is running old code. Paste the new Code.gs, then deploy a New version.');
        }
        return api('state');
      })
      .then(function (s) { adopt(s); setSyncStatus('Connected. The script, passphrase, and calendar sync all work.'); })
      .catch(function (e) { setSyncStatus(e.message); });
  }

  function pull() {
    if (!synced()) return Promise.resolve();
    return api('state').then(function (s) {
      adopt(s);
      setSyncStatus('Synced ' + E.fmtTime(new Date()));
    }).catch(function (e) {
      setSyncStatus(e.message);
    });
  }

  function adopt(s) {
    if (!s) return;
    state = Object.assign({}, EMPTY, s);
    saveJSON('bp.state', state);
    render();
  }

  // Save locally first so the UI never waits on the network. The events the
  // phone computed go along as a fallback; the backend recomputes them.
  function commit(action, payload, msg) {
    plan = computePlan();
    state.events = E.buildEvents(plan, ctx());
    saveJSON('bp.state', state);
    render();
    if (!synced()) { if (msg) toast(msg); return Promise.resolve(); }
    var body = Object.assign({ events: state.events, plannedMove: state.plannedMove || null }, payload || {});
    return api(action, body).then(function (s) {
      adopt(s);
      if (msg) toast(msg);
    }).catch(function (e) {
      toast('Saved on this phone only. ' + e.message);
    });
  }

  function setSyncStatus(t) { var el = $('sync-status'); if (el) el.textContent = t; }

  // ------------------------------------------------------------ helpers
  function ctx() { return { data: data, state: state, restrictions: restrictions, appUrl: appUrl() }; }
  function opts() { return E.opts(data, settings()); }
  function appUrl() { return location.origin + location.pathname; }
  function fmtSpan(ms) {
    var h = ms / P.HOUR;
    if (h < 1) return Math.max(1, Math.round(ms / P.MIN)) + ' min';
    if (h < 36) return Math.round(h) + ' h';
    return Math.round(h / 24) + ' days';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var span = E.span, fmtWhen = E.fmtWhen, fmtTime = E.fmtTime, fmtDay = E.fmtDay;

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
  function permitsFor(curbId, from, to) {
    return P.permitsOn(E.permitIndex(restrictions), curbId, from, to);
  }
  function permitText(list) {
    var p = list[0];
    return 'Moving truck permit, likely ' + fmtDay(new Date(p.from)) + ' to ' + fmtDay(new Date(p.to));
  }
  function walkLink(lat, lng) {
    var ios = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
    return ios ? 'https://maps.apple.com/?daddr=' + lat + ',' + lng + '&dirflg=w'
      : 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=walking';
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
    permitLayer = L.layerGroup().addTo(map);
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
    var size = kind === 'car' ? 34 : kind === 'home' ? 26 : kind === 'me' ? 16 : kind === 'permit' ? 14 : 24;
    return L.divIcon({ className: '', html: '<div class="pin ' + kind + '">' + inner + '</div>', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function curbPopup(c, latlng) {
    var now = new Date(), st = P.status(c, now, opts());
    var next = P.occurrences(c, now, new Date(now.getTime() + 70 * P.DAY), opts()).slice(0, 3);
    var flags = [];
    if (c.metered) flags.push('Metered, not resident parking');
    if (c.daily) flags.push('Swept every night');
    if (c.snowArtery) flags.push('Snow emergency route');
    var permits = permitsFor(c.id, now, new Date(now.getTime() + 21 * P.DAY));
    if (permits.length) flags.push(permitText(permits));
    var html = '<b>' + esc(P.curbLabel(c)) + '</b><br><span>' + esc(span(c)) + '</span><br>' +
      esc(P.describe(c, settings())) +
      (flags.length ? '<br><span style="color:' + cssVar('var(--orange)') + '">' + esc(flags.join('. ')) + '</span>' : '') +
      '<br><br><b>' + (st.state === 'sweeping' ? 'Sweeping now' : 'Next sweeps') + '</b><br>' +
      (next.length ? next.map(function (o) {
        return esc(fmtWhen(o.start) + ' to ' + fmtTime(o.end)) + (o.holiday ? ' <i>(' + esc(o.holiday) + ': may be suspended)</i>' : '');
      }).join('<br>') : 'None scheduled before spring') +
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

    permitLayer.clearLayers();
    ((restrictions && restrictions.permits) || []).forEach(function (p) {
      if (new Date(p.to) < now) return;
      L.marker([p.lat, p.lng], { icon: svgPin('permit'), zIndexOffset: 200 })
        .bindPopup('<b>Moving truck permit</b><br>Likely ' + esc(fmtDay(new Date(p.from))) + ' to ' + esc(fmtDay(new Date(p.to))) +
          '<br><span style="color:#5b6878">' + esc(p.note || '') + '</span>')
        .addTo(permitLayer);
    });

    optLayer.clearLayers();
    E.moveList(plan).forEach(function (o, i) {
      L.marker(ll(o.curb.center), { icon: svgPin('opt', String(i + 1)), zIndexOffset: 500 - i })
        .on('click', function () { selectMove(i); })
        .addTo(optLayer);
    });
  }

  function nearestCurbs(latlng, n) {
    return { latlng: latlng, list: E.nearestCurbs(data.curbs, latlng.lng, latlng.lat, n) };
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
      var addr = E.nearestAddress(c, near.latlng.lng, near.latlng.lat);
      return '<li data-i="' + i + '" class="' + (i === 0 ? 'selected' : '') + '"><div class="t">' + esc(P.curbLabel(c)) + '</div>' +
        '<div class="s">' + (addr ? 'Near ' + esc(addr) + '. ' : esc(span(c)) + '. ') + Math.round(r.dist) + ' m away. ' + esc(next + warn) + '</div></li>';
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
    var lat = latlng ? +latlng.lat.toFixed(6) : c.center[1];
    var lng = latlng ? +latlng.lng.toFixed(6) : c.center[0];
    var car = {
      curbId: c.id, lat: lat, lng: lng, parkedAt: new Date().toISOString(),
      by: cfg.name || '', source: 'app', confirmed: true, address: E.nearestAddress(c, lng, lat)
    };
    E.recordPark(state, car);
    commit('park', { car: car }, 'Saved: ' + P.curbLabel(c) + (synced() ? '. Calendar updated.' : '.'));
  }

  function confirmSide(switchTo) {
    if (!state.car) return;
    if (switchTo) {
      state.car.curbId = switchTo.id;
      state.car.address = E.nearestAddress(switchTo, state.car.lng, state.car.lat);
      if (state.history[0] && state.history[0].parkedAt === state.car.parkedAt) state.history[0].curbId = switchTo.id;
    }
    state.car.confirmed = true;
    commit('confirm', { curbId: state.car.curbId }, switchTo ? 'Switched to ' + P.curbLabel(switchTo) + '.' : 'Thanks, confirmed.');
  }

  function sendFeedback(min) {
    var parkedAt = state.car.parkedAt;
    E.applyFeedback(state, parkedAt, min);
    commit('feedback', { parkedAt: parkedAt, searchMin: min }, 'Thanks. This tunes the rankings.');
  }

  function setHome(home) {
    state.home = home;
    endPick();
    $('settings').hidden = false;
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

  // ------------------------------------------------------------ plan
  function computePlan() { return E.plan(Object.assign(ctx(), { now: new Date() })); }

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
    var events = state.events && state.events.length ? state.events : E.buildEvents(plan, ctx());
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
    renderFeedback();
    renderNextMove();
    renderMoves();
    renderTrips();
    renderCalendar();
    renderSnow();
    renderConnect();
    paintMap();
    $('footnote').innerHTML = 'Schedule: City of Boston open data (retrieved ' + esc(String(data.sourceUpdated).slice(0, 10)) +
      '). Beacon Hill residential sweeping runs Mar 1 to Dec 31. City holidays are flagged but still counted. ' +
      (restrictions ? 'Moving-truck permits updated ' + esc(fmtWhen(new Date(restrictions.generated))) + '. ' : '') +
      'Always check the posted sign. Metered and nightly-swept curbs are shown dashed and never recommended.';
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
    var notes = [];
    if (settings().snowEmergency && car.snowArtery) {
      notes.push('<div class="banner alert">Snow emergency: this is a snow route. Move the car now.</div>');
    }
    if (st.next && st.next.holiday) {
      notes.push('<div class="banner note">' + esc(st.next.holiday) + ': the City sometimes suspends sweeping on holidays. Check the posted sign before skipping the move.</div>');
    }
    var permits = permitsFor(car.id, now, st.next ? st.next.start : new Date(now.getTime() + 14 * P.DAY));
    if (permits.length) notes.push('<div class="banner note">' + esc(permitText(permits)) + ' on this block. Look for posted no-parking signs near the car.</div>');
    var opp = E.oppositeCurb(data.curbs, car);
    var confirmBox = state.car.confirmed === false
      ? '<div class="confirm-side"><span>Logged automatically' + (state.car.by ? ' from ' + esc(state.car.by) + '\'s phone' : '') +
        '. Right side of the street?</span><div class="row"><button class="btn small primary" id="btn-side-ok">Yes</button>' +
        (opp ? '<button class="btn small" id="btn-side-switch">No, ' + esc(E.sideShort(opp)) + '</button>' : '') + '</div></div>'
      : '';
    var parked = new Date(state.car.parkedAt);
    var where = state.car.address ? 'Near ' + state.car.address : span(car);
    el.innerHTML = '<div class="label">Your car</div>' +
      '<div class="street">' + esc(P.curbLabel(car)) + '</div>' +
      '<div class="meta">' + esc(where) + '. Parked ' + esc(fmtWhen(parked)) + (state.car.by ? ' by ' + esc(state.car.by) : '') + '.' +
      (state.car.lat ? ' <a class="link" target="_blank" rel="noopener" href="' + walkLink(state.car.lat, state.car.lng) + '">Walk to car</a>' : '') + '</div>' +
      '<div class="meta">' + esc(P.describe(car, settings())) + '</div>' +
      confirmBox +
      '<div class="status-row"><span class="when">' + esc(when) + '</span><span class="pill ' + pillClass(st) + '">' + esc(pill) + '</span></div>' +
      notes.join('');
    if ($('btn-side-ok')) $('btn-side-ok').onclick = function () { confirmSide(null); };
    if ($('btn-side-switch')) $('btn-side-switch').onclick = function () { confirmSide(opp); };
  }

  function renderFeedback() {
    var el = $('feedback'), car = state.car;
    var recent = car && Date.now() - new Date(car.parkedAt) < 3 * P.DAY;
    el.hidden = !(recent && car.searchMin == null && !skipped[car.parkedAt]);
    if (el.hidden) return;
    el.innerHTML = '<b>How long did it take to find this spot?</b>' +
      '<div class="muted small" style="margin:3px 0 9px">One tap. Over time this teaches the app which curbs are actually easy to get.</div>' +
      '<div class="chips">' + E.SEARCH_BUCKETS.map(function (b) {
        return '<button class="chip-btn" data-min="' + b.min + '">' + esc(b.label) + '</button>';
      }).join('') + '<button class="chip-btn ghost" data-min="skip">Skip</button></div>';
    el.querySelectorAll('[data-min]').forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.min === 'skip') { skipped[car.parkedAt] = 1; saveJSON('bp.skipped', skipped); render(); return; }
        sendFeedback(+b.dataset.min);
      };
    });
  }

  function renderNextMove() {
    var el = $('next-move');
    var mv = state.car ? E.nextMove(plan) : null;
    el.hidden = !mv;
    if (!mv) return;
    var claim = E.activeClaim(state, plan);
    var mine = claim && claim.by === (cfg.name || '');
    var when = mv.kind === 'fresh' ? fmtWhen(mv.at) : 'Now';
    el.innerHTML = '<div class="row between"><div><div class="label">' + (plan.trip ? 'Before your trip' : 'Next move') + '</div>' +
      '<div class="nm-title">' + esc(when) + ': ' + esc(mv.curb.street) + ', ' + esc(E.sideShort(mv.curb)) + '</div>' +
      '<div class="muted small">' + (claim ? esc(claim.by) + (mine ? ' (you)' : '') + ' is moving it.' : 'Nobody has claimed this move yet.') + '</div></div>' +
      (claim ? '<button class="btn small" id="btn-unclaim">' + (mine ? 'Release' : 'Take over') + '</button>'
        : '<button class="btn small primary" id="btn-claim">I\'ll move it</button>') + '</div>';
    if ($('btn-claim')) $('btn-claim').onclick = function () { claimMove(mv); };
    if ($('btn-unclaim')) $('btn-unclaim').onclick = function () {
      if (mine) { state.claim = null; commit('unclaim', {}, 'Released. The other person will be nudged if nobody claims it.'); }
      else claimMove(mv);
    };
  }

  function claimMove(mv) {
    if (!cfg.name) { toast('Add your name in Settings first.'); return; }
    state.claim = { by: cfg.name, moveKey: E.moveKey(mv), at: new Date().toISOString() };
    commit('claim', { moveKey: state.claim.moveKey }, 'You have it. The invite now says ' + cfg.name + ' is moving the car.');
  }

  function renderMoves() {
    var list = E.moveList(plan), el = $('moves'), sub = $('moves-sub');
    if (!state.car) {
      sub.textContent = '';
      el.innerHTML = '<li class="empty">Save where the car is and the best next spots show up here.</li>';
      return;
    }
    if (plan.mustMoveNow) sub.textContent = 'Move now';
    else if (plan.trip) sub.textContent = plan.trip.covered ? 'Spots that last your trip first' : 'Nothing lasts the whole trip';
    else if (plan.options.length) sub.textContent = 'Right after a sweep ends';
    else sub.textContent = plan.deadline ? 'No fresh openings before your deadline' : '';
    if (!list.length) {
      el.innerHTML = '<li class="empty">' + (plan.deadline
        ? 'No better spot opens before ' + esc(fmtWhen(plan.leaveBy || plan.deadline)) + '. Stay put.'
        : 'No sweeping on your curb this season. Stay put.') + '</li>';
      return;
    }
    el.innerHTML = list.map(function (o, i) {
      var gainDays = Math.round((o.until - o.at) / P.DAY);
      var ease = o.learnedN ? 'Easy ' + Math.round(o.ease * 100) + '% (from ' + o.learnedN + ' logged)' :
        o.supplyM >= 1500 ? 'Lots of curb opening' : o.supplyM >= 700 ? 'Some curb opening' : o.kind === 'fresh' ? 'Small opening' : '';
      var facts = [
        '<span class="chip good">Good for ' + gainDays + ' days</span>',
        o.coversTrip === true ? '<span class="chip good">Lasts your trip</span>' : '',
        o.coversTrip === false ? '<span class="chip warn">Ends mid-trip</span>' : '',
        state.home ? '<span class="chip">' + E.walkText(o.walkM) + '</span>' : '',
        ease ? '<span class="chip">' + esc(ease) + '</span>' : '',
        o.permits && o.permits.length ? '<span class="chip warn">Moving truck ' + esc(fmtDay(new Date(o.permits[0].to))) + '</span>' : '',
        o.winterArtery ? '<span class="chip warn">Snow route</span>' : ''
      ].join('');
      return '<li class="move' + (selectedMove === i ? ' selected' : '') + '" data-i="' + i + '">' +
        '<div class="rank">' + (i + 1) + '</div><div>' +
        '<div class="title">' + esc(P.curbLabel(o.curb)) + '</div>' +
        '<div class="when">' + (o.kind === 'fresh' ? 'Opens ' + esc(fmtWhen(o.at)) : 'Open now') +
        '<span class="muted">. Next sweep ' + esc(fmtDay(o.until)) + '</span></div>' +
        '<div class="muted small">' + esc(span(o.curb)) + '</div>' +
        '<div class="facts">' + facts + '</div></div></li>';
    }).join('');
  }

  function selectMove(i) {
    selectedMove = i;
    var o = E.moveList(plan)[i];
    if (!o) return;
    map.fitBounds(L.polyline(o.curb.line.map(ll)).getBounds(), { padding: [60, 60], maxZoom: 18, animate: false });
    highlight(o.curb);
    renderMoves();
  }

  // ------------------------------------------------------------ trips
  function renderTrips() {
    var el = $('trips-card'), now = new Date();
    var trips = (state.trips || []).filter(function (t) { return new Date(t.end) > now; })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    var next = P.nextTrip(trips, now);
    var rows = trips.map(function (t) {
      var status = '';
      if (next && t.id === next.id && state.car) {
        if (plan.tripOk && plan.tripOk.id === t.id) {
          status = '<div class="trip-status ok">Covered. The car is good where it is through your return.</div>';
        } else if (plan.trip) {
          var mv = E.nextMove(plan), L1 = plan.trip.longest;
          status = plan.trip.covered && mv
            ? '<div class="trip-status ok">Move before you leave: ' + esc(P.curbLabel(mv.curb)) + ', ' +
              (mv.kind === 'fresh' ? 'opens ' + esc(fmtWhen(mv.at)) : 'any time before you go') + '. Good until ' + esc(fmtWhen(mv.until)) + '.</div>'
            : '<div class="trip-status warn">No curb lasts the whole trip (every-other-week streets top out near two weeks). ' +
              (L1 ? 'Longest option: ' + esc(P.curbLabel(L1.curb)) + ', good until ' + esc(fmtWhen(L1.until)) + '. Someone would need to move it by then, or use a garage: ' : 'Consider a garage: ') +
              esc(data.snowGarages.map(function (g) { return g.name; }).join(', ')) + '.</div>';
        } else if (new Date(t.start) <= now) {
          status = '<div class="trip-status ok">Trip in progress. No move invites until you are back.</div>';
        }
      } else if (next && t.id !== next.id) {
        status = '<div class="trip-status muted">Planned after your next trip.</div>';
      }
      return '<li><div class="row between"><div><b>' + esc(t.note || 'Trip') + '</b><div class="muted small">' +
        esc(fmtWhen(new Date(t.start))) + ' to ' + esc(fmtWhen(new Date(t.end))) + '</div></div>' +
        '<button class="btn small ghost" data-trip="' + esc(t.id) + '">Remove</button></div>' + status + '</li>';
    }).join('');
    el.innerHTML = '<h4>Trips</h4>' +
      '<div class="muted small" style="margin-bottom:8px">Add time away and the plan works around it: it finds a curb that lasts until you are back, and no invites land mid-trip.</div>' +
      (rows ? '<ul class="trips">' + rows + '</ul>' : '') +
      '<details class="trip-add"><summary>Add a trip</summary>' +
      '<label class="field"><span>Name</span><input id="trip-note" placeholder="e.g. Thanksgiving in NYC" autocomplete="off"></label>' +
      '<label class="field"><span>Leave</span><input id="trip-start" type="datetime-local"></label>' +
      '<label class="field"><span>Back</span><input id="trip-end" type="datetime-local"></label>' +
      '<button class="btn small primary" id="btn-trip-add">Save trip</button></details>';
    el.querySelectorAll('[data-trip]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.trip;
        state.trips = state.trips.filter(function (t) { return t.id !== id; });
        commit('tripRemove', { id: id }, 'Trip removed.');
      };
    });
    $('btn-trip-add').onclick = addTrip;
  }

  function addTrip() {
    var s = $('trip-start').value, e = $('trip-end').value;
    if (!s || !e) { toast('Pick when you leave and when you are back.'); return; }
    var start = localInputToDate(s), end = localInputToDate(e);
    if (!(end > start)) { toast('The return has to be after you leave.'); return; }
    var trip = { id: 'local' + Date.now(), start: start.toISOString(), end: end.toISOString(), note: $('trip-note').value.trim() };
    state.trips = (state.trips || []).concat([trip]);
    commit('tripAdd', { trip: trip }, 'Trip saved. The plan now works around it.');
  }

  // datetime-local values are Boston wall-clock time.
  function localInputToDate(v) {
    var m = v.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/);
    return P.etDate(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }

  // ------------------------------------------------------------ calendar, snow, settings
  function renderCalendar() {
    var el = $('cal-card'), ev = state.events || [];
    var upcoming = ev.filter(function (e) { return new Date(e.end) > new Date(); });
    var stats = E.searchStats(state.history);
    var head = '<h4>Calendar</h4>';
    var body = upcoming.length
      ? '<ul>' + upcoming.map(function (e) { return '<li>' + esc(fmtWhen(new Date(e.start))) + ': ' + esc(e.title) + '</li>'; }).join('') + '</ul>'
      : '<p class="muted small" style="margin:0">No reminders scheduled.</p>';
    var statLine = stats.n
      ? '<p class="small" style="margin:10px 0 0"><b>Search time:</b> median ' + Math.round(stats.medianRecent) + ' min over your last ' +
        Math.min(stats.n, 10) + ' logged moves' + (stats.targetTries ? '; got the suggested curb ' + stats.targetHits + ' of ' + stats.targetTries + ' times' : '') + '.</p>'
      : '';
    var foot = synced()
      ? '<p class="muted small" style="margin:10px 0 0">Invites go to both calendars automatically each time the car is saved.' +
        (state.updatedAt ? ' Last update ' + esc(fmtWhen(new Date(state.updatedAt))) + (state.updatedBy ? ' by ' + esc(state.updatedBy) : '') + '.' : '') + '</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn small" id="btn-resend">Recalculate and resend</button><button class="btn small" id="btn-ics">Add to this phone</button></div>'
      : '<p class="muted small" style="margin:10px 0 0">Shared sync is off, so invites are not sent automatically. Set it up in Settings, or add these to this phone now.</p>' +
        '<div class="row" style="margin-top:10px"><button class="btn small" id="btn-ics">Add to calendar</button></div>';
    el.innerHTML = head + body + statLine + foot;
    $('btn-ics').onclick = downloadIcs;
    if ($('btn-resend')) $('btn-resend').onclick = function () { commit('plan', {}, 'Calendar updated.'); };
  }

  function renderSnow() {
    var s = settings(), el = $('snow-card');
    var garages = data.snowGarages.map(function (g) {
      return '<li><b>' + esc(g.name) + '</b>, ' + esc(g.address) + ': ' + esc(g.fee) + '</li>';
    }).join('');
    var auto = state.snow && state.snow.auto;
    el.innerHTML = '<div class="switch-row"><div><h4>Snow emergency</h4>' +
      '<div class="muted small">' + (synced()
        ? 'Turns on by itself when boston.gov posts a snow emergency banner (checked every 15 minutes), and you both get an email. You can also flip it yourself.'
        : 'Flip on when the City declares one.') +
      ' Snow routes (blue dashes) are then excluded and the car gets a move-now alert if it is on one.</div></div>' +
      '<label class="toggle"><input type="checkbox" id="snow-toggle"' + (s.snowEmergency ? ' checked' : '') + '><span></span></label></div>' +
      (auto ? '<p class="small" style="margin:10px 0 0">Detected automatically: "' + esc(state.snow.text || 'snow emergency') + '"</p>' : '') +
      (s.snowEmergency ? '<p class="small" style="margin:12px 0 0">Discounted garages for Beacon Hill residents (City list; confirm rates):</p><ul>' + garages + '</ul>' : '');
    $('snow-toggle').onchange = function (e) {
      state.settings = Object.assign({}, state.settings, { snowEmergency: e.target.checked });
      if (!e.target.checked) state.snow = null;
      commit('settings', { settings: state.settings }, e.target.checked ? 'Snow emergency on. Plan updated.' : 'Snow emergency off.');
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
    renderShortcutHelp();
  }

  function renderShortcutHelp() {
    var el = $('shortcut-help');
    if (!synced()) { el.innerHTML = '<p class="muted small">Connect this phone first (paste your setup link above).</p>'; return; }
    function copy(label, value, secret) {
      return '<div class="copy-row"><span>' + label + '</span><code>' + esc(secret ? value.slice(0, 4) + '...' : value) +
        '</code><button class="btn small" data-copy="' + esc(value) + '">Copy</button></div>';
    }
    el.innerHTML = '<p class="small">When your phone disconnects from the car, this logs where you parked without opening the app. ' +
      'You then confirm the side of the street with one tap. Build it once in the Shortcuts app:</p>' +
      '<ol class="steps small">' +
      '<li>Shortcuts, then <b>Automation</b>, then <b>+</b>, then <b>Bluetooth</b> (or <b>CarPlay</b>). Choose your car, then <b>Is Disconnected</b>, then <b>Run Immediately</b>, then <b>Next</b>, then <b>New Blank Automation</b>.</li>' +
      '<li>Add <b>Get Current Location</b>.</li>' +
      '<li>Add <b>Get Contents of URL</b>. Paste the URL below. Tap the arrow: Method <b>POST</b>, Request Body <b>JSON</b>. Add text fields <b>action</b> = <code>parkGps</code>, <b>reply</b> = <code>text</code>, <b>key</b> and <b>by</b> from below. Add number fields <b>lat</b> and <b>lng</b>; for each, tap the value, choose Current Location, then Latitude (or Longitude).</li>' +
      '<li>Add <b>Show Notification</b> with <b>Contents of URL</b> as the text. Tap Done.</li></ol>' +
      copy('URL', cfg.api) + copy('key', cfg.key, true) + copy('by', cfg.name || 'Your name') +
      '<p class="muted small">If the phone also connects to the car while you are a passenger, the log may be wrong; the confirm prompt catches that.</p>';
    el.querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () {
        (navigator.clipboard ? navigator.clipboard.writeText(b.dataset.copy) : Promise.reject())
          .then(function () { toast('Copied.'); }, function () { prompt('Copy this:', b.dataset.copy); });
      };
    });
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
    state.settings = next;
    $('settings').hidden = true;
    var p = commit('settings', { settings: state.settings }, 'Settings saved.');
    if (synced()) p.then(pull);
  }

  function clamp(v, lo, hi, d) { return isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : d; }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, msg.length > 90 ? 9000 : 3600);
  }

  // ------------------------------------------------------------ wire up
  function wire() {
    $('btn-parked').onclick = parkedHere;
    $('btn-pick').onclick = function () { startPick('car'); };
    $('btn-settings').onclick = function () { renderSettings(); $('settings').hidden = false; };
    $('btn-close-settings').onclick = function () { $('settings').hidden = true; };
    $('btn-save-settings').onclick = saveSettings;
    $('btn-test').onclick = testConnection;
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
    var perms = fetch('data/restrictions.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    Promise.all([load, perms]).then(function (res) {
      data = res[0];
      restrictions = res[1];
      data.curbs.forEach(function (c) { curbsById[c.id] = c; });
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
