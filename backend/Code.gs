/**
 * Beau on Beacon Hill backend: shared car state for both phones, plus calendar
 * invites. Runs as a Google Apps Script web app under one Google account;
 * events are created on that account's calendar and everyone in GUESTS gets
 * a real invite (Outlook and Gmail both accept these).
 *
 * Setup is in README.md. In short: paste this file and appsscript.json into a
 * new Apps Script project, fill in CONFIG, deploy as a web app (Execute as:
 * Me, Who has access: Anyone), then run setup() once.
 */

var CONFIG = {
  // Calendar addresses that should receive invites, comma separated. Leave out
  // the Google account that owns this script; it gets the events directly.
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

var MAX_HISTORY = 40;

function doGet() {
  return json_({ ok: true, service: 'beacon-parking' });
}

function doPost(e) {
  var req = {};
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad request' }); }

  var props = PropertiesService.getScriptProperties();
  if (!req.key || req.key !== props.getProperty('PASSPHRASE')) {
    return json_({ ok: false, error: 'wrong passphrase' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var state = load_();
    var by = String(req.by || '').slice(0, 40);
    switch (req.action) {
      case 'state':
        return json_({ ok: true, state: state });
      case 'park':
        state.car = req.car;
        state.history = [req.car].concat(state.history || []).slice(0, MAX_HISTORY);
        syncEvents_(state, req.events || []);
        break;
      case 'plan':
        syncEvents_(state, req.events || []);
        break;
      case 'settings':
        state.settings = req.settings || state.settings;
        if (req.events) syncEvents_(state, req.events);
        break;
      case 'home':
        state.home = req.home;
        break;
      default:
        return json_({ ok: false, error: 'unknown action' });
    }
    state.updatedAt = new Date().toISOString();
    state.updatedBy = by;
    save_(state);
    return json_({ ok: true, state: state });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** Replace this app's upcoming events with the new plan. Unchanged events are
 *  kept so nobody gets a cancel-and-reinvite for the same thing. */
function syncEvents_(state, events) {
  var cal = CalendarApp.getDefaultCalendar();
  var now = new Date();
  var keep = {};
  var nextIds = [];
  var wanted = {};
  events.forEach(function (ev) { wanted[sig_(ev)] = ev; });

  (state.eventRefs || []).forEach(function (ref) {
    var ev = null;
    try { ev = cal.getEventById(ref.id); } catch (err) { ev = null; }
    if (!ev) return;
    if (wanted[ref.sig] && !keep[ref.sig]) {
      keep[ref.sig] = true;
      nextIds.push(ref);
    } else if (ev.getEndTime() > now) {
      ev.deleteEvent();
    }
  });

  events.forEach(function (ev) {
    var s = sig_(ev);
    if (keep[s]) return;
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
    nextIds.push({ id: created.getId(), sig: s });
  });

  state.eventRefs = nextIds;
  state.events = events;
}

/** GUESTS minus the account running the script, which owns the events. */
function guests_() {
  var me = '';
  try { me = Session.getEffectiveUser().getEmail().toLowerCase(); } catch (err) { me = ''; }
  return CONFIG.GUESTS.split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.toLowerCase() !== me; }).join(',');
}

function sig_(ev) {
  return [ev.title, ev.start, ev.end].join('|');
}

function load_() {
  var raw = PropertiesService.getScriptProperties().getProperty('STATE');
  var state = raw ? JSON.parse(raw) : {};
  state.car = state.car || null;
  state.home = state.home || (CONFIG.HOME[0] ? CONFIG.HOME : null);
  state.settings = state.settings || {};
  state.events = state.events || [];
  state.history = state.history || [];
  return state;
}

function save_(state) {
  PropertiesService.getScriptProperties().setProperty('STATE', JSON.stringify(state));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run once from the editor after filling in CONFIG and deploying. It creates
 * the passphrase (if missing), checks calendar access, and logs one setup
 * link per person. Open each link on that person's iPhone.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('PASSPHRASE');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('PASSPHRASE', key);
  }
  CalendarApp.getDefaultCalendar();
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
  Logger.log('Passphrase (also inside the links): ' + key);
}

/** Wipes the shared state and this app's upcoming events. */
function resetEverything() {
  var state = load_();
  syncEvents_(state, []);
  PropertiesService.getScriptProperties().deleteProperty('STATE');
  Logger.log('Cleared.');
}
