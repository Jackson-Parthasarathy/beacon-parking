/**
 * Beau on Beacon Hill backend: shared car state for both phones, calendar
 * invites, hands-free logging from an iPhone Shortcut, move claims, trips,
 * and a background check every 15 minutes that sends nudges.
 *
 * Runs as a Google Apps Script web app under one Google account; events are
 * created on that account's calendar and everyone in GUESTS gets a real
 * invite (Outlook and Gmail both accept these).
 *
 * The schedule math (planner.js, engine.js) and street data are loaded from
 * APP_URL at run time, so improvements to the app reach the backend without
 * pasting this file again.
 *
 * Setup is in README.md. In short: paste this file and appsscript.json into a
 * new Apps Script project, fill in CONFIG, deploy as a web app (Execute as:
 * Me, Who has access: Anyone), then run setup() once.
 */

var CONFIG = {
  // Calendar addresses that should receive invites, comma separated. The
  // Google account that owns this script is skipped; it owns the events.
  GUESTS: 'you@outlook.com, partner@gmail.com',

  // Where the web app is hosted, used to build the one-tap setup links.
  APP_URL: 'https://YOUR-GITHUB-USERNAME.github.io/beacon-parking/',

  // People who will use the app; each gets their own setup link from setup().
  PEOPLE: ['Jackson', 'Partner'],

  // Home as [longitude, latitude]; drives walking distance in the rankings.
  HOME: [0, 0],

  // Paste the web app URL (ends in /exec) after deploying.
  WEB_APP_URL: ''
};

var GLOBAL_ = this;
var CHUNK_ = 8000;            // Script Properties allow 9 KB per value

// ------------------------------------------------------------------ web app

function doGet() {
  return json_({ ok: true, service: 'beacon-parking', version: 2 });
}

function doPost(e) {
  var req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad request' }); }

  var props = PropertiesService.getScriptProperties();
  if (!req.key || req.key !== props.getProperty('PASSPHRASE')) {
    return req.reply === 'text' ? text_('Beau: wrong passphrase, nothing logged.') : json_({ ok: false, error: 'wrong passphrase' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var state = load_();
    var by = String(req.by || '').slice(0, 40);
    var now = new Date();
    var env = null;
    var message = '';

    switch (req.action) {
      case 'state':
        return json_({ ok: true, state: state });

      case 'park':                      // from the app, curb already chosen
        env = loadEngine_();
        if (env) Engine.recordPark(state, req.car);
        else { state.car = req.car; state.history = [req.car].concat(state.history || []).slice(0, 200); state.claim = null; }
        recompute_(state, env, req);
        break;

      case 'parkGps':                   // from the iPhone Shortcut
        env = loadEngine_();
        message = parkGps_(state, env, req, by, now);
        if (req.reply === 'text') {
          state.updatedAt = now.toISOString(); state.updatedBy = by; save_(state);
          return text_(message);
        }
        break;

      case 'confirm':                   // "yes, right side" or switch sides
        if (state.car) {
          if (req.curbId != null && req.curbId !== state.car.curbId) {
            state.car.curbId = req.curbId;
            if (state.history && state.history[0] && state.history[0].parkedAt === state.car.parkedAt) state.history[0].curbId = req.curbId;
          }
          state.car.confirmed = true;
          if (state.history && state.history[0]) state.history[0].confirmed = true;
          env = loadEngine_();
          recompute_(state, env, req);
        }
        break;

      case 'feedback':
        (state.history || []).forEach(function (h) { if (h.parkedAt === req.parkedAt) h.searchMin = req.searchMin; });
        if (state.car && state.car.parkedAt === req.parkedAt) state.car.searchMin = req.searchMin;
        break;

      case 'claim':
        state.claim = { by: by, moveKey: req.moveKey, parkedAt: req.parkedAt || (state.car && state.car.parkedAt), at: now.toISOString() };
        recompute_(state, loadEngine_(), req);
        break;

      case 'unclaim':
        state.claim = null;
        recompute_(state, loadEngine_(), req);
        break;

      case 'tripAdd':
        state.trips = (state.trips || []).filter(function (t) { return new Date(t.end) > now; });
        state.trips.push({ id: Utilities.getUuid().slice(0, 8), start: req.trip.start, end: req.trip.end,
          note: String(req.trip.note || '').slice(0, 60), by: by });
        recompute_(state, loadEngine_(), req);
        break;

      case 'tripRemove':
        state.trips = (state.trips || []).filter(function (t) { return t.id !== req.id; });
        recompute_(state, loadEngine_(), req);
        break;

      case 'plan':
        recompute_(state, loadEngine_(), req);
        break;

      case 'settings':
        state.settings = req.settings || state.settings;
        if (req.settings && req.settings.snowEmergency === false) state.snow = null;
        recompute_(state, loadEngine_(), req);
        break;

      case 'home':
        state.home = req.home;
        recompute_(state, loadEngine_(), req);
        break;

      default:
        return json_({ ok: false, error: 'unknown action' });
    }
    state.updatedAt = now.toISOString();
    state.updatedBy = by;
    save_(state);
    return json_({ ok: true, state: state, message: message });
  } catch (err) {
    return req.reply === 'text' ? text_('Beau: something went wrong (' + err + ').')
      : json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** Snap a GPS fix from the Shortcut to the nearest curb and log it. */
function parkGps_(state, env, req, by, now) {
  var lat = parseFloat(req.lat), lng = parseFloat(req.lng);
  if (!isFinite(lat) || !isFinite(lng)) return 'Beau: no location came through, nothing logged.';
  if (!env) return 'Beau: could not load the street data. Log the spot in the app instead.';
  var near = Engine.nearestCurbs(env.data.curbs, lng, lat, 3);
  if (!near.length || near[0].dist > 150) return 'Beau: not near a Beacon Hill curb, so nothing was logged.';
  var curb = near[0].curb;
  if (state.car && state.car.curbId === curb.id && now - new Date(state.car.parkedAt) < 10 * 60000) {
    return 'Beau: already logged on ' + Planner.curbLabel(curb) + '.';
  }
  var car = {
    curbId: curb.id, lat: +lat.toFixed(6), lng: +lng.toFixed(6), parkedAt: now.toISOString(), by: by,
    source: 'auto', confirmed: false, address: Engine.nearestAddress(curb, lng, lat)
  };
  Engine.recordPark(state, car);
  recompute_(state, env, null);
  var st = Planner.status(curb, now, Engine.opts(env.data, Engine.settings(state)));
  var next = st.state === 'sweeping' ? 'Sweeping there now, move it.'
    : st.next ? 'Next sweep ' + Engine.fmtWhen(st.next.start) + '.' : 'No sweeping until spring.';
  return 'Beau: logged ' + (car.address ? 'near ' + car.address + ', ' : 'on ' + curb.street + ', ') +
    Engine.sideShort(curb) + '. ' + next + ' Open the app to confirm the side.';
}

/** Rebuild the plan and calendar. Uses the shared engine when it loads, and
 *  otherwise falls back to the events the app computed. */
function recompute_(state, env, req) {
  if (env) {
    var plan = Engine.plan({ data: env.data, state: state, restrictions: env.restrictions, now: new Date() });
    var events = Engine.buildEvents(plan, { data: env.data, state: state, appUrl: CONFIG.APP_URL });
    syncEvents_(state, events);
  } else if (req && req.events) {
    if (req.plannedMove !== undefined) state.plannedMove = req.plannedMove;
    syncEvents_(state, req.events);
  }
}

/** Replace this app's upcoming events with the new plan. An event with the
 *  same kind and time is updated in place (one "updated" notice) instead of
 *  being cancelled and re-sent. */
function syncEvents_(state, events) {
  var cal = CalendarApp.getDefaultCalendar();
  var now = new Date();
  var wanted = {};
  events.forEach(function (ev) { wanted[slot_(ev)] = ev; });
  var kept = {};
  var refs = [];

  (state.eventRefs || []).forEach(function (ref) {
    var ev = null;
    try { ev = cal.getEventById(ref.id); } catch (err) { ev = null; }
    if (!ev) return;
    var want = wanted[ref.slot];
    if (want && !kept[ref.slot]) {
      kept[ref.slot] = true;
      if (ev.getTitle() !== want.title) ev.setTitle(want.title);
      if (ev.getDescription() !== (want.description || '')) ev.setDescription(want.description || '');
      if (ev.getLocation() !== (want.location || '')) ev.setLocation(want.location || '');
      refs.push({ id: ref.id, slot: ref.slot });
    } else if (ev.getEndTime() > now) {
      ev.deleteEvent();
    }
  });

  events.forEach(function (ev) {
    var s = slot_(ev);
    if (kept[s]) return;
    var created = cal.createEvent(ev.title, new Date(ev.start), new Date(ev.end), {
      description: ev.description || '',
      location: ev.location || '',
      guests: guests_(),
      sendInvites: true
    });
    created.setGuestsCanModify(false);
    created.setGuestsCanInviteOthers(false);
    created.removeAllReminders();
    (ev.reminders || []).slice(0, 5).forEach(function (m) { created.addPopupReminder(Math.max(0, Math.min(40320, m))); });
    refs.push({ id: created.getId(), slot: s });
  });

  state.eventRefs = refs;
  state.events = events;
}

function slot_(ev) {
  return [ev.kind || ev.title, ev.start, ev.end].join('|');
}

// ------------------------------------------------------------------ background check

/**
 * Runs every 15 minutes (installed by setup). Sends at most one email per
 * situation: nobody has claimed tomorrow's move, the car is still logged on
 * a curb about to be swept, a trip has no curb that lasts, a moving-truck
 * permit lands on the car's curb, or boston.gov shows a snow emergency.
 */
function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var state = load_();
    var now = new Date();
    var env = loadEngine_();
    state.nudges = state.nudges || {};
    var changed = checkSnow_(state, env, now);
    if (env && state.car) {
      var plan = Engine.plan({ data: env.data, state: state, restrictions: env.restrictions, now: now });
      changed = checkClaim_(state, plan, now) || changed;
      changed = checkDeadline_(state, plan, now) || changed;
      changed = checkTrip_(state, plan, env, now) || changed;
      changed = checkPermits_(state, plan, env, now) || changed;
    }
    if (changed) {
      var keys = Object.keys(state.nudges);
      if (keys.length > 150) keys.slice(0, keys.length - 150).forEach(function (k) { delete state.nudges[k]; });
      save_(state);
    }
  } finally {
    lock.releaseLock();
  }
}

function once_(state, key) {
  if (state.nudges[key]) return false;
  state.nudges[key] = new Date().toISOString();
  return true;
}

function checkClaim_(state, plan, now) {
  var move = (state.events || []).filter(function (e) { return e.kind === 'move'; })[0];
  if (!move) return false;
  var start = new Date(move.start);
  var nudgeAt = new Date(start.getTime() - Engine.eveningBefore(start) * 60000);
  var claimed = Engine.activeClaim(state);
  if (claimed || now < nudgeAt || now > start) return false;
  if (!once_(state, 'claim:' + move.moveKey)) return false;
  email_('Who is moving the car tomorrow?',
    move.title + '\n' + Engine.fmtWhen(start) + '\n\nNobody has claimed this move yet. Open the app and tap "I\'ll move it":\n' + CONFIG.APP_URL);
  return true;
}

function checkDeadline_(state, plan, now) {
  var car = plan.car, dl = plan.deadline;
  var where = state.car.address ? 'near ' + state.car.address : Planner.curbLabel(car);
  var snow = state.settings && state.settings.snowEmergency && car.snowArtery;
  if (plan.mustMoveNow) {
    var key = snow ? 'post:snow:' + Engine.fmtDay(now) : 'post:' + dl.toISOString();
    if (!once_(state, key)) return false;
    email_('The car may still be on ' + car.street,
      (snow ? 'A snow emergency is on and ' + car.street + ' is a snow route.'
        : 'Sweeping on ' + car.street + ' has started.') +
      ' The car is still logged ' + where + '.\n\nIf it already moved, log the new spot:\n' + CONFIG.APP_URL);
    return true;
  }
  if (dl && now >= new Date(dl.getTime() - 90 * 60000) && now < dl && once_(state, 'pre:' + dl.toISOString())) {
    email_('The car is still logged on ' + car.street,
      'Sweeping starts ' + Engine.fmtWhen(dl) + ' and the car is still logged ' + where + '.\n\n' +
      'If it already moved, log the new spot. Otherwise move it now:\n' + CONFIG.APP_URL);
    return true;
  }
  return false;
}

function checkTrip_(state, plan, env, now) {
  var t = plan.trip;
  if (!t || t.covered || t.trip.start - now > 7 * 86400000) return false;
  if (!once_(state, 'trip:' + t.trip.id)) return false;
  var longest = t.longest;
  var garages = (env.data.snowGarages || []).map(function (g) { return '- ' + g.name + ', ' + g.address; }).join('\n');
  email_('Trip heads-up: no curb lasts the whole trip',
    'You leave ' + Engine.fmtWhen(t.trip.start) + ' and get back ' + Engine.fmtWhen(t.trip.end) + '.\n\n' +
    (longest ? 'The longest-lasting option is ' + Planner.curbLabel(longest.curb) + ', good until ' +
      Engine.fmtWhen(longest.until) + '. Someone would need to move the car before then.\n\n' : '') +
    'Other options: a garage, or a friend who can move it. Garages near Beacon Hill from the City list:\n' + garages +
    '\n\nDetails in the Trips section:\n' + CONFIG.APP_URL);
  return true;
}

function checkPermits_(state, plan, env, now) {
  if (!env.restrictions || !state.car) return false;
  var until = plan.deadline || new Date(now.getTime() + 14 * 86400000);
  var hits = Planner.permitsOn(Engine.permitIndex(env.restrictions), state.car.curbId, now, until);
  var sent = false;
  hits.forEach(function (p) {
    if (!once_(state, 'permit:' + p.id)) return;
    email_('Moving truck permit on the car\'s block',
      'The City issued a moving-truck permit on ' + Planner.curbLabel(plan.car) + ', likely between ' +
      Engine.fmtDay(new Date(p.from)) + ' and ' + Engine.fmtDay(new Date(p.to)) + '. Check for posted no-parking signs near the car.\n\n' +
      CONFIG.APP_URL);
    sent = true;
  });
  return sent;
}

/** Best effort: boston.gov shows a site-wide alert banner during snow
 *  emergencies. Turns the app's snow switch on (and off when it clears) and
 *  emails both of you. The manual switch in the app still works. */
function checkSnow_(state, env, now) {
  var found = detectSnow_();
  if (found === null) return false;
  state.settings = state.settings || {};
  if (found.active && !state.settings.snowEmergency) {
    state.settings.snowEmergency = true;
    state.snow = { auto: true, since: now.toISOString(), text: found.text };
    recompute_(state, env, null);
    email_('Snow emergency declared in Boston',
      'The boston.gov alert banner says: "' + found.text + '"\n\n' +
      'Snow routes (Beacon, Cambridge and Charles Streets) are now excluded in the app' +
      (state.car && env && isArtery_(env, state.car.curbId) ? ', and the car is on one. Move it now.' : '.') +
      '\n\nThis was detected automatically; double-check on boston.gov/snow.\n' + CONFIG.APP_URL);
    return true;
  }
  if (!found.active && state.snow && state.snow.auto && state.settings.snowEmergency) {
    state.snow.clearChecks = (state.snow.clearChecks || 0) + 1;
    if (state.snow.clearChecks >= 2) {
      state.settings.snowEmergency = false;
      state.snow = null;
      recompute_(state, env, null);
      email_('Snow emergency appears to be over', 'The boston.gov alert banner is gone, so the app turned the snow switch off.\n' + CONFIG.APP_URL);
    }
    return true;
  }
  return false;
}

function detectSnow_() {
  try {
    var html = fetchText_('https://www.boston.gov/');
    var i = html.indexOf('id="sa"');
    if (i < 0) return null;
    var tag = html.slice(i, html.indexOf('>', i));
    var text = html.slice(i, i + 6000).replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    var m = text.match(/[^.]*snow emergency[^.]*\./i);
    var active = !/\bd--n\b/.test(tag) && !!m && /(declared|in effect|parking ban)/i.test(m[0]);
    return { active: active, text: m ? m[0].trim().slice(0, 200) : '' };
  } catch (err) {
    return null;
  }
}

function isArtery_(env, curbId) {
  return env.data.curbs.some(function (c) { return c.id === curbId && c.snowArtery; });
}

// ------------------------------------------------------------------ helpers

/** Loads planner.js, engine.js and the street data from the hosted app. */
function loadEngine_() {
  if (GLOBAL_.__beauEnv) return GLOBAL_.__beauEnv;
  try {
    var cache = CacheService.getScriptCache();
    ['planner.js', 'engine.js'].forEach(function (f) {
      var src = cache.get('src:' + f);
      if (!src) {
        src = fetchText_(CONFIG.APP_URL + f);
        cache.put('src:' + f, src, 3600);
      }
      (0, eval)(src);
    });
    var data = JSON.parse(fetchText_(CONFIG.APP_URL + 'data/segments.json'));
    var restrictions = null;
    try { restrictions = JSON.parse(fetchText_(CONFIG.APP_URL + 'data/restrictions.json')); } catch (err) { restrictions = null; }
    GLOBAL_.__beauEnv = { data: data, restrictions: restrictions };
    return GLOBAL_.__beauEnv;
  } catch (err) {
    console.error('engine load failed: ' + err);
    return null;
  }
}

function fetchText_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error(url + ' returned ' + res.getResponseCode());
  return res.getContentText();
}

/** GUESTS minus the account running the script, which owns the events. */
function guests_() {
  var me = ownerEmail_();
  return CONFIG.GUESTS.split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.toLowerCase() !== me; }).join(',');
}

function ownerEmail_() {
  try { return Session.getEffectiveUser().getEmail().toLowerCase(); } catch (err) { return ''; }
}

function email_(subject, body) {
  var to = CONFIG.GUESTS.split(',').map(function (s) { return s.trim(); }).filter(String);
  var me = ownerEmail_();
  if (me && to.map(function (s) { return s.toLowerCase(); }).indexOf(me) < 0) to.push(me);
  MailApp.sendEmail({ to: to.join(','), subject: 'Beau on Beacon Hill: ' + subject, body: body, name: 'Beau on Beacon Hill' });
}

// State is stored as JSON split across properties (each value max 9 KB).
function load_() {
  var props = PropertiesService.getScriptProperties();
  var n = +props.getProperty('STATE_N') || 0;
  var raw = '';
  if (n) { for (var i = 0; i < n; i++) raw += props.getProperty('STATE_' + i) || ''; }
  else raw = props.getProperty('STATE') || '';
  var state = raw ? JSON.parse(raw) : {};
  state.car = state.car || null;
  state.home = state.home || (CONFIG.HOME[0] ? CONFIG.HOME : null);
  state.settings = state.settings || {};
  state.events = state.events || [];
  state.history = state.history || [];
  state.trips = state.trips || [];
  return state;
}

function save_(state) {
  var props = PropertiesService.getScriptProperties();
  var raw = JSON.stringify(state);
  var parts = {};
  var n = Math.ceil(raw.length / CHUNK_);
  for (var i = 0; i < n; i++) parts['STATE_' + i] = raw.slice(i * CHUNK_, (i + 1) * CHUNK_);
  parts.STATE_N = String(n);
  var old = +props.getProperty('STATE_N') || 0;
  props.setProperties(parts);
  for (var j = n; j < old; j++) props.deleteProperty('STATE_' + j);
  props.deleteProperty('STATE');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function text_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

// ------------------------------------------------------------------ setup

/**
 * Run once from the editor after filling in CONFIG and deploying (and again
 * after pasting a new version). It creates the passphrase if missing, installs
 * the 15-minute background check, checks access, and logs one setup link per
 * person plus the values for the iPhone Shortcut.
 */
function setup() {
  // Google's consent screen lets each permission be unticked, and an unticked
  // one is never asked for again on its own; this re-asks for any missing.
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('PASSPHRASE');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('PASSPHRASE', key);
  }
  CalendarApp.getDefaultCalendar();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(15).create();
  var engineOk = !!loadEngine_();

  var url = CONFIG.WEB_APP_URL || ScriptApp.getService().getUrl();
  if (!url || !/\/exec$/.test(url)) {
    Logger.log('Deploy the web app first (Deploy > New deployment > Web app), paste its /exec URL into CONFIG.WEB_APP_URL, then run setup() again.');
    return;
  }
  CONFIG.PEOPLE.forEach(function (name) {
    var payload = { api: url, key: key, name: name, home: CONFIG.HOME[0] ? CONFIG.HOME : null };
    var token = Utilities.base64Encode(JSON.stringify(payload), Utilities.Charset.UTF_8);
    Logger.log(name + ': ' + CONFIG.APP_URL + '#setup=' + encodeURIComponent(token));
  });
  Logger.log('Shortcut URL: ' + url);
  Logger.log('Passphrase (for the Shortcut "key" field): ' + key);
  Logger.log('Background check installed (every 15 minutes). Street data ' + (engineOk ? 'loaded.' : 'did NOT load; check APP_URL.'));
}

/** Wipes the shared state and this app's upcoming events. */
function resetEverything() {
  var state = load_();
  syncEvents_(state, []);
  var props = PropertiesService.getScriptProperties();
  var n = +props.getProperty('STATE_N') || 0;
  for (var i = 0; i < n; i++) props.deleteProperty('STATE_' + i);
  props.deleteProperty('STATE_N');
  props.deleteProperty('STATE');
  Logger.log('Cleared.');
}
