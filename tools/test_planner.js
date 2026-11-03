// Regression checks for app/planner.js. Usage: node tools/test_planner.js
const P = require('../app/planner.js');
const D = require('../app/data/segments.json');
const byId = Object.fromEntries(D.curbs.map(c => [c.id, c]));
const season = D.season['Beacon Hill'];
const et = d => d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

const chestnutOdd = byId[421];
const occ = P.occurrences(chestnutOdd, new Date('2026-10-01T04:00:00Z'), new Date('2027-03-31T04:00:00Z'), { season });
const days = occ.map(o => et(o.start));
assert(days[0] === 'Fri, Oct 2, 8:00 AM', '1st Friday of October at 8 AM EDT');
assert(!days.some(d => d.startsWith('Fri, Oct 30')), '5th Friday skipped on an every-other-week street');
assert(days.includes('Fri, Nov 6, 8:00 AM'), '8 AM stays 8 AM after DST ends');
assert(!days.some(d => /Jan|Feb/.test(d)), 'no sweeping in January and February');
assert(days.includes('Fri, Mar 5, 8:00 AM'), 'season restarts March 1');
assert(P.occurrences(chestnutOdd, new Date('2026-10-01T04:00:00Z'), new Date('2026-11-01T04:00:00Z'), { season, skipFifthWeek: false })
  .some(o => et(o.start).startsWith('Fri, Oct 30')), '5th week included when the setting is off');

const home = [-71.0705, 42.3587];   // Louisburg Square, a neutral test point
const r = P.rank({ curbs: D.curbs, now: new Date('2026-10-30T14:00:00Z'), home, car: { curbId: 421 }, settings: {}, season });
assert(et(r.deadline) === 'Fri, Nov 6, 8:00 AM', 'deadline is the next sweep of the car curb');
assert(r.options.length > 0 && r.options.every(o => o.at < r.deadline && o.until > r.deadline), 'every option is before the deadline and outlasts it');
assert(r.options.every(o => !o.curb.metered && !o.curb.daily), 'metered and nightly curbs never recommended');

const winter = P.rank({ curbs: D.curbs, now: new Date('2026-12-20T15:00:00Z'), home, car: { curbId: 421 }, settings: {}, season });
assert(winter.options.every(o => o.until > winter.deadline), 'winter: no move that ends sooner than staying put');

const snow = P.rank({ curbs: D.curbs, now: new Date('2027-01-10T15:00:00Z'), home, car: { curbId: 519 }, settings: { snowEmergency: true }, season });
assert(snow.mustMoveNow && snow.fallback.length > 0 && snow.fallback.every(o => !o.curb.snowArtery), 'snow emergency on a snow route: move now, off snow routes');

// Trips, learning, permits, holidays
const E = require('../app/engine.js');
const base = { car: { curbId: 421, parkedAt: '2026-10-30T14:00:00Z' }, home, settings: {}, history: [] };
const now0 = new Date('2026-10-30T14:00:00Z');
let st = Object.assign({}, base, { trips: [{ id: 'a', start: '2026-11-03T13:00:00Z', end: '2026-11-20T23:00:00Z' }] });
let tp = E.plan({ data: D, state: st, now: now0 });
assert(tp.trip && +tp.leaveBy === +new Date('2026-11-03T13:00:00Z'), 'trip that outlasts the curb moves the deadline to departure');
assert(!tp.trip.covered && E.moveList(tp)[0].until >= Math.max(...E.moveList(tp).map(o => +o.until)), 'uncovered trip: longest-lasting spot ranks first');
assert(E.moveList(tp).every(o => o.at < tp.leaveBy), 'every trip option happens before departure');
st = Object.assign({}, base, { trips: [{ id: 'b', start: '2026-11-07T13:00:00Z', end: '2026-11-10T23:00:00Z' }] });
tp = E.plan({ data: D, state: st, now: now0 });
assert(tp.trip.covered && E.moveList(tp)[0].coversTrip, 'short trip: top option lasts the whole trip');
st = Object.assign({}, base, { trips: [{ id: 'c', start: '2026-11-01T13:00:00Z', end: '2026-11-03T23:00:00Z' }] });
tp = E.plan({ data: D, state: st, now: now0 });
assert(tp.tripOk && !tp.trip, 'trip the car already outlasts needs no move');
assert(E.moveList(tp).every(o => !(o.at >= new Date('2026-11-01T13:00:00Z') && o.at <= new Date('2026-11-03T23:00:00Z'))), 'no move suggested while away');

const plain = E.plan({ data: D, state: Object.assign({}, base, { trips: [] }), now: now0 });
const topId = E.moveList(plain)[0].curb.id;
const hard = Object.assign({}, base, { trips: [], history: [1, 2, 3, 4].map(i => ({ curbId: topId, searchMin: 75, parkedAt: 'h' + i })) });
assert(E.moveList(E.plan({ data: D, state: hard, now: now0 }))[0].curb.id !== topId, 'logged slow searches push a curb down');

const permitR = { permits: [{ id: 'p1', curbId: topId, from: '2026-11-04T05:00:00Z', to: '2026-11-06T04:59:00Z' }] };
const withPermit = E.moveList(E.plan({ data: D, state: Object.assign({}, base, { trips: [] }), restrictions: permitR, now: now0 }));
const hit = withPermit.find(o => o.curb.id === topId);
assert(!hit || hit.permits.length === 1, 'permit overlapping a stay is attached to the option');
assert(withPermit[0].curb.id !== topId, 'a moving-truck permit on the top curb drops it');

assert(P.holidayName(new Date('2026-11-26T17:00:00Z')) === 'Thanksgiving' && P.holidayName(new Date('2026-07-03T16:00:00Z')) === 'Independence Day', 'holidays computed, including observed dates');

// Claims hold across phones that rank differently, and parking clears them
const cs = Object.assign({}, base, { trips: [], car: { curbId: 421, parkedAt: '2026-10-30T14:00:00Z' } });
const planA = E.plan({ data: D, state: cs, now: now0 });
cs.claim = { by: 'Jackson', moveKey: E.moveKey(E.nextMove(planA)), parkedAt: cs.car.parkedAt, at: '2026-10-30T15:00:00Z' };
const otherTop = { permits: [{ id: 'px', curbId: E.nextMove(planA).curb.id, from: '2026-11-01T05:00:00Z', to: '2026-11-30T04:59:00Z' }] };
const planB = E.plan({ data: D, state: cs, restrictions: otherTop, now: now0 });
assert(E.moveKey(E.nextMove(planB)) !== cs.claim.moveKey && E.activeClaim(cs, planB) && E.activeClaim(cs, planB).by === 'Jackson',
  'claim shows on a phone whose top pick differs');
assert(/^Jackson moves car/.test(E.buildEvents(planB, { data: D, state: cs }).find(e => e.kind === 'move').title), 'invite says who is moving it on either ranking');
const legacy = Object.assign({}, cs, { claim: { by: 'Caroline', moveKey: 'old', at: '2026-10-30T15:00:00Z' } });
assert(E.activeClaim(legacy) && E.activeClaim(legacy).by === 'Caroline', 'claim saved by the older script (no parkedAt) still counts');
const moved = Object.assign({}, cs); E.recordPark(moved, { curbId: 3785, parkedAt: '2026-11-04T17:30:00Z' });
assert(!E.activeClaim(moved), 'parking again clears the claim');
