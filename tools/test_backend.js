// Runs backend/Code.gs under node with fake Apps Script services. The fake
// UrlFetchApp serves app/ from disk for APP_URL, so the real planner, engine
// and street data are exercised. Usage: node tools/test_backend.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'backend', 'Code.gs'), 'utf8')
  .replace("APP_URL: 'https://YOUR-GITHUB-USERNAME.github.io/beacon-parking/'", "APP_URL: 'https://app.test/'")
  .replace("GUESTS: 'you@outlook.com, partner@gmail.com'", "GUESTS: 'you@outlook.com, partner@gmail.com, owner@example.com'")
  .replace("HOME: [0, 0]", "HOME: [-71.0705, 42.3587]");

const props = {}; let nextId = 1; const calendar = {}; const log = []; const mail = []; const triggers = [];
let bostonGov = '<div id="sa" class="d--n node-site-alert"><div>Boston.gov Search</div></div>';
function fetchFake(url) {
  let body, code = 200;
  if (url.startsWith('https://app.test/')) {
    const f = path.join(ROOT, 'app', url.slice('https://app.test/'.length).split('?')[0]);
    if (fs.existsSync(f)) body = fs.readFileSync(f, 'utf8'); else { body = 'not found'; code = 404; }
  } else if (url.startsWith('https://www.boston.gov/')) body = bostonGov;
  else { body = ''; code = 404; }
  return { getResponseCode: () => code, getContentText: () => body };
}
function makeEvent(title, start, end, o) {
  const id = 'ev' + nextId++;
  const ev = { id, title, start, end, o, reminders: [], description: o.description, location: o.location,
    getId: () => id, getEndTime: () => end, getTitle: () => ev.title, setTitle(t) { ev.title = t; log.push('retitled ' + t); },
    getDescription: () => ev.description, setDescription(d) { ev.description = d; },
    getLocation: () => ev.location, setLocation(l) { ev.location = l; },
    deleteEvent: () => { delete calendar[id]; log.push('deleted ' + ev.title); },
    setGuestsCanModify() {}, setGuestsCanInviteOthers() {}, removeAllReminders() { ev.reminders = []; },
    addPopupReminder(m) { ev.reminders.push(m); } };
  calendar[id] = ev; log.push('created ' + title); return ev;
}
const cache = {};
const ctx = {
  console,
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); },
    setProperties: o => Object.assign(props, o), deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
  ContentService: { MimeType: { JSON: 'json', TEXT: 'text' }, createTextOutput: t => ({ setMimeType: () => t }) },
  UrlFetchApp: { fetch: fetchFake },
  MailApp: { sendEmail: m => mail.push(m) },
  Utilities: { getUuid: () => 'abcd1234-efgh-5678-ijkl-9012' + nextId++, base64Encode: s => Buffer.from(s).toString('base64'),
    Charset: { UTF_8: 'utf8' }, formatDate: () => { throw new Error('Intl should be used under node'); } },
  Logger: { log: m => log.push(m) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'Owner@Example.com' }) },
  ScriptApp: {
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
    getProjectTriggers: () => triggers.slice(), deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: fn => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => triggers.push({ fn, m, getHandlerFunction: () => fn }) }) }) })
  },
  CalendarApp: { getDefaultCalendar: () => ({ createEvent: makeEvent, getEventById: id => calendar[id] || null }) },
};
vm.createContext(ctx); vm.runInContext(src, ctx);
const post = body => {
  const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return body.reply === 'text' ? out : JSON.parse(out);
};
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const events = () => Object.values(calendar);
const byKind = k => events().find(e => (ctx.load_().eventRefs || []).some(r => r.id === e.id && r.slot.startsWith(k + '|')));

// setup
ctx.setup();
const key = props.PASSPHRASE;
assert(key && key.length === 20, 'setup creates a passphrase');
assert(triggers.length === 1 && triggers[0].fn === 'tick' && triggers[0].m === 15, 'setup installs the 15-minute check');
ctx.setup();
assert(triggers.length === 1, 'running setup again does not duplicate the trigger');
assert(log.some(l => /#setup=/.test(l)) && log.some(l => /Street data loaded/.test(l)), 'setup logs links and loads street data');
assert(post({ action: 'state', key: 'nope' }).ok === false, 'wrong passphrase rejected');
assert(/wrong passphrase/.test(post({ action: 'parkGps', key: 'nope', reply: 'text' })), 'wrong passphrase rejected for the Shortcut');

// hands-free logging from the Shortcut
let txt = post({ action: 'parkGps', key, by: 'Jackson', lat: 42.35779, lng: -71.0668, reply: 'text' });
let s = ctx.load_();
assert(/logged near \d+ Chestnut St, odd side/.test(txt), 'Shortcut reply names the house number and side: ' + txt);
assert(s.car.curbId === 421 && s.car.source === 'auto' && s.car.confirmed === false, 'auto-logged car is unconfirmed');
assert(events().length === 2 && byKind('move') && byKind('deadline'), 'move and deadline invites created');
assert(!/owner@example.com/i.test(events()[0].o.guests) && /you@outlook.com/.test(events()[0].o.guests), 'script owner left off the guest list');
assert(/already logged/.test(post({ action: 'parkGps', key, by: 'Jackson', lat: 42.35779, lng: -71.0668, reply: 'text' })), 'duplicate fire within 10 minutes is ignored');
assert(/not near a Beacon Hill curb/.test(post({ action: 'parkGps', key, by: 'Jackson', lat: 42.3601, lng: -71.0942, reply: 'text' })), 'away from Beacon Hill nothing is logged');
assert(ctx.load_().car.curbId === 421, 'car unchanged after the far-away fire');

// wrong side: switch to the other side
let r = post({ action: 'confirm', key, by: 'Jackson', curbId: 5 });
assert(r.ok && r.state.car.curbId === 5 && r.state.car.confirmed && r.state.history[0].curbId === 5, 'switching sides updates car and history');

// claim updates the move invite in place
log.length = 0;
const moveBefore = byKind('move');
r = post({ action: 'claim', key, by: 'Caroline', moveKey: r.state.events.find(e => e.kind === 'move').moveKey });
const moveAfter = byKind('move');
assert(moveAfter.id === moveBefore.id && /^Caroline moves car/.test(moveAfter.title), 'claim retitles the same invite: ' + moveAfter.title);
assert(!log.some(l => /^created|^deleted/.test(l)), 'claim does not cancel and re-send');
r = post({ action: 'unclaim', key, by: 'Caroline' });
assert(/^Move car/.test(byKind('move').title), 'unclaim restores the title');

// feedback is stored for learning
const parkedAt = r.state.car.parkedAt;
r = post({ action: 'feedback', key, parkedAt, searchMin: 20 });
assert(r.state.history[0].searchMin === 20 && r.state.car.searchMin === 20, 'search time saved');

// trips
r = post({ action: 'tripAdd', key, by: 'Jackson', trip: { start: '2026-11-11T13:00:00Z', end: '2026-12-02T23:00:00Z', note: 'Thanksgiving' } });
assert(r.state.trips.length === 1 && /^Before your trip: move car/.test(byKind('move').title), 'trip changes the plan: ' + byKind('move').title);
const tripId = r.state.trips[0].id;
r = post({ action: 'tripRemove', key, id: tripId });
assert(r.state.trips.length === 0 && /^Move car/.test(byKind('move').title), 'removing the trip restores the plan');

// background check: unclaimed move nudge
const env = ctx.loadEngine_();
s = ctx.load_(); s.nudges = {};
let plan = ctx.Engine.plan({ data: env.data, state: s, restrictions: null, now: new Date() });
const mv = s.events.find(e => e.kind === 'move');
mail.length = 0;
assert(ctx.checkClaim_(s, plan, new Date(new Date(mv.start).getTime() - 60 * 60000)) && mail.length === 1, 'unclaimed move emails both the evening before');
assert(!ctx.checkClaim_(s, plan, new Date(new Date(mv.start).getTime() - 30 * 60000)), 'claim nudge sent only once');
assert(/you@outlook.com/.test(mail[0].to) && /owner@example.com/.test(mail[0].to), 'nudge goes to everyone including the owner');

// background check: car still logged before the sweep
mail.length = 0;
assert(ctx.checkDeadline_(s, plan, new Date(plan.deadline.getTime() - 60 * 60000)) && /still logged/.test(mail[0].subject), 'pre-sweep warning sent');

// snow emergency detection from the boston.gov banner
mail.length = 0;
bostonGov = '<div id="sa" class="node-site-alert"><p>A snow emergency and parking ban is in effect starting 6 PM Sunday.</p></div>';
s = ctx.load_(); s.nudges = {};
assert(ctx.checkSnow_(s, env, new Date()) && s.settings.snowEmergency === true && mail.length === 1, 'snow emergency detected and emailed');
bostonGov = '<div id="sa" class="d--n node-site-alert"><div>Boston.gov Search</div></div>';
ctx.checkSnow_(s, env, new Date());
assert(s.settings.snowEmergency === true, 'one clear check is not enough to turn snow off');
ctx.checkSnow_(s, env, new Date());
assert(s.settings.snowEmergency === false && mail.length === 2, 'snow turns off after two clear checks');
assert(ctx.detectSnow_().active === false, 'hidden banner is not a snow emergency');

// state larger than one property value is split and read back
s = ctx.load_();
for (let i = 0; i < 150; i++) s.history.push({ curbId: 421, parkedAt: 'x' + i, by: 'Jackson', searchMin: 20, target: 2015, onTarget: false });
ctx.save_(s);
assert(+props.STATE_N > 1 && ctx.load_().history.length === s.history.length, 'large state is chunked and restored (' + props.STATE_N + ' parts)');

ctx.resetEverything();
assert(events().length === 0 && !props.STATE_N, 'reset clears events and state');
