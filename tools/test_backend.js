// Runs backend/Code.gs under node with fake Apps Script services.
// Usage: node tools/test_backend.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');

const props = {}; let nextId = 1; const calendar = {}; const log = [];
const ctx = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => t }) },
  Utilities: { getUuid: () => 'abcd-1234-efgh-5678-ijkl-9012', base64Encode: s => Buffer.from(s).toString('base64'), Charset: { UTF_8: 'utf8' } },
  Logger: { log: m => log.push(m) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'Owner@Example.com' }) },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
  CalendarApp: { getDefaultCalendar: () => ({
    createEvent: (title, start, end, o) => {
      const id = 'ev' + nextId++; const ev = { id, title, start, end, o, reminders: [],
        getId: () => id, getEndTime: () => end, deleteEvent: () => { delete calendar[id]; log.push('deleted ' + title); },
        setGuestsCanModify() {}, setGuestsCanInviteOthers() {}, removeAllReminders() { ev.reminders = []; },
        addPopupReminder(m) { ev.reminders.push(m); } };
      calendar[id] = ev; log.push('created ' + title + ' guests=' + o.guests); return ev; },
    getEventById: id => calendar[id] || null }) },
};
vm.createContext(ctx); vm.runInContext(src, ctx);
const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

ctx.setup();
const key = props.PASSPHRASE;
assert(key && key.length === 20, 'setup creates a passphrase');
assert(log.some(l => /#setup=/.test(l)), 'setup logs setup links');
assert(post({ action: 'state', key: 'nope' }).ok === false, 'wrong passphrase rejected');

const t = h => new Date(Date.now() + h * 3600e3).toISOString();
const evA = { title: 'Move car A', start: t(48), end: t(49), reminders: [30, 900] };
const evB = { title: 'Deadline B', start: t(90), end: t(91), reminders: [60] };
let r = post({ action: 'park', key, by: 'Jackson', car: { curbId: 421 }, events: [evA, evB] });
assert(r.ok && r.state.car.curbId === 421 && r.state.updatedBy === 'Jackson', 'park saves car and author');
assert(Object.keys(calendar).length === 2, 'two invites created');
assert(Object.values(calendar).find(e => e.title === 'Move car A').reminders.join() === '30,900', 'reminders applied');
assert(!/owner@example.com/i.test(Object.values(calendar)[0].o.guests), 'script owner left off the guest list');

log.length = 0;
r = post({ action: 'plan', key, by: 'Partner', events: [evA, { ...evB, title: 'Deadline C' }] });
assert(!log.some(l => /Move car A/.test(l)), 'unchanged event kept, no re-invite');
assert(log.includes('deleted Deadline B') && log.some(l => /created Deadline C/.test(l)), 'changed event replaced');
assert(Object.keys(calendar).length === 2, 'still two events');

r = post({ action: 'state', key });
assert(r.ok && r.state.history.length === 1 && r.state.events.length === 2, 'state readable by the other phone');
r = post({ action: 'settings', key, settings: { snowEmergency: true } });
assert(r.state.settings.snowEmergency === true, 'settings shared');
ctx.resetEverything();
assert(Object.keys(calendar).length === 0 && !props.STATE, 'reset clears events and state');
