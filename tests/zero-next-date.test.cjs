/**
 * Zero-drug next-dose / calendar future-cycle regression tests.
 * Extracts live functions from public/index.html via vm.
 */
process.env.TZ = 'America/New_York';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function loadFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} function should exist`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} function body not found`);
}

const TODAY = '2026-08-20';

const context = {
  today: () => TODAY,
  getFilteredZeroDrugs: () => [],
  _moveData: null,
  state: { zeroDrugs: [] },
  saveState: () => {},
  renderZeroDrugs: () => {},
  toast: () => {},
  console: { log() {} },
  escapeHtml: (s) => String(s == null ? '' : s),
  escapeAttr: (s) => String(s == null ? '' : s).replace(/'/g, "\\'"),
};
vm.createContext(context);
vm.runInContext(loadFunction('parseLocalYmd'), context);
vm.runInContext(loadFunction('getDayList'), context);
vm.runInContext(loadFunction('getDayDate'), context);
vm.runInContext(loadFunction('getEffectiveNextDate'), context);
vm.runInContext(loadFunction('autoAdvanceCycle'), context);
vm.runInContext(loadFunction('countQtyInPeriod'), context);
vm.runInContext(loadFunction('getLastAdminDate'), context);
vm.runInContext(loadFunction('collectCalEvents'), context);
vm.runInContext(loadFunction('buildMonthTable'), context);
vm.runInContext(loadFunction('daysBetween'), context);
vm.runInContext(loadFunction('calClickDate'), context);

function makeZ(overrides) {
  return Object.assign({
    id: 1,
    patient: '테스트환자',
    regNo: '1234567',
    drugName: 'TestDrug',
    drugCode: 'XTEST',
    cycleWeeks: 3,
    qty: 1,
    dayType: 'single',
    nextDate: '2026-08-20',
    lastDate: '2026-07-30',
    donedays: [],
    pastUndone: [],
  }, overrides);
}

function findEvent(events, ymd, pred) {
  const list = events[ymd] || [];
  return list.find(pred);
}

// --- getEffectiveNextDate ---

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({ donedays: [1] })),
  '2026-09-10',
  'all current-cycle days done → next cycle D1'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({ donedays: [] })),
  '2026-08-20',
  'undone D1 today stays current-cycle D1'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({
    dayType: 'pick',
    dayPick: '1,8',
    donedays: [1],
  })),
  '2026-08-27',
  'D1 done, D8 remaining → Aug 27'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({
    nextDate: '2026-08-01',
    lastDate: '2026-07-11',
    donedays: [],
  })),
  '2026-08-01',
  'overdue undone D1 is not jumped to next cycle'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({
    dayType: 'pick',
    dayPick: '1,8',
    donedays: [1, 8],
  })),
  '2026-09-10',
  'all pick days done → next cycle first day (D1)'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({
    dayDates: { 1: '2026-08-22' },
    donedays: [],
  })),
  '2026-08-22',
  'undone current D1 uses dayDates override'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({
    dayDates: { 1: '2026-08-22' },
    donedays: [1],
  })),
  '2026-09-10',
  'all done: next cycle D1 ignores dayDates (not 2026-09-12)'
);

assert.strictEqual(
  context.getEffectiveNextDate(makeZ({
    dayType: 'pick',
    dayPick: '8,15',
    donedays: [8, 15],
  })),
  '2026-09-17',
  'pick D8,D15 all done → nextDate + 21 + 7, not D1'
);

assert.ok(
  !context.getEffectiveNextDate(makeZ({ nextDate: '' })),
  'empty nextDate → falsy effective next'
);

// --- autoAdvanceCycle (existing last-day guard, do not change formula) ---

{
  const z = makeZ({ donedays: [1], nextDate: '2026-08-20' });
  const advanced = context.autoAdvanceCycle(z);
  assert.strictEqual(advanced, false, 'last day == today must not advance');
  assert.strictEqual(z.nextDate, '2026-08-20');
  assert.deepStrictEqual([...z.donedays], [1]);
}

{
  const z = makeZ({ donedays: [1], nextDate: '2026-08-19', lastDate: '2026-07-29' });
  const advanced = context.autoAdvanceCycle(z);
  assert.strictEqual(advanced, true, 'last day yesterday → advance');
  assert.strictEqual(z.nextDate, '2026-09-09');
  assert.strictEqual(z.lastDate, '2026-08-19');
  assert.deepStrictEqual([...z.donedays], []);
}

// --- collectCalEvents ---

{
  const z = makeZ({ donedays: [1] });
  context.getFilteredZeroDrugs = () => [z];
  const sep = context.collectCalEvents(2026, 8);
  const ev = findEvent(sep, '2026-09-10', e => e.patient === z.patient && e.dayNum === 1);
  assert.ok(ev, 'September calendar must include next-cycle D1 2026-09-10 after today check-in');
  assert.strictEqual(ev.done, false, 'future-cycle D1 must not inherit current donedays');
  assert.ok(ev.future, 'Sep 10 must be marked as future cycle');
}

{
  const z = makeZ({ donedays: [] });
  context.getFilteredZeroDrugs = () => [z];
  const sep = context.collectCalEvents(2026, 8);
  const ev = findEvent(sep, '2026-09-10', e => e.patient === z.patient && e.dayNum === 1);
  assert.ok(ev, 'September calendar must include 2026-09-10 even if today is not checked in');
  assert.strictEqual(ev.done, false);
}

{
  const z = makeZ({ donedays: [1] });
  context.getFilteredZeroDrugs = () => [z];
  const aug = context.collectCalEvents(2026, 7);
  const ev = findEvent(aug, '2026-08-20', e => e.patient === z.patient && e.dayNum === 1);
  assert.ok(ev, 'today\'s checked dose must remain on August 20');
  assert.strictEqual(ev.done, true, 'current-cycle D1 stays done');
  assert.ok(!ev.future, 'Aug 20 is current cycle, not future');
  assert.ok(!ev.past, 'Aug 20 is not past cycle');
}

{
  const z = makeZ({
    dayType: 'range',
    dayEnd: 3,
    nextDate: '2026-08-30',
    lastDate: '2026-08-09',
    donedays: [1],
  });
  context.getFilteredZeroDrugs = () => [z];
  const sep = context.collectCalEvents(2026, 8);
  const d3 = findEvent(sep, '2026-09-01', e => e.dayNum === 3);
  assert.ok(d3, 'range D1-D3: Sep 1 (current D3) must appear');
  assert.ok(!d3.future, 'Sep 1 is still current cycle');
  assert.ok(findEvent(sep, '2026-09-20', e => e.dayNum === 1 && e.future), 'next-cycle D1 Sep 20');
  assert.ok(findEvent(sep, '2026-09-21', e => e.dayNum === 2 && e.future), 'next-cycle D2 Sep 21');
  assert.ok(findEvent(sep, '2026-09-22', e => e.dayNum === 3 && e.future), 'next-cycle D3 Sep 22');
}

{
  const z = makeZ({ lastDate: '2026-07-30', nextDate: '2026-08-20', donedays: [] });
  context.getFilteredZeroDrugs = () => [z];
  const jul = context.collectCalEvents(2026, 6);
  const ev = findEvent(jul, '2026-07-30', e => e.patient === z.patient && e.dayNum === 1);
  assert.ok(ev, 'past-cycle D1 on lastDate must appear on July 30 (parseLocalYmd, not UTC Date)');
  assert.ok(ev.past, 'July 30 is past cycle');
  assert.strictEqual(ev.pastCycleDate, '2026-07-30');
  assert.ok(!jul['2026-07-29'], 'UTC parse in America/New_York would land on July 29');
}

{
  const z = makeZ({ donedays: [1] });
  context.getFilteredZeroDrugs = () => [z];
  const sep = context.collectCalEvents(2026, 8);
  const list = (sep['2026-09-10'] || []).filter(e => e.zid === z.id && e.dayNum === 1);
  assert.strictEqual(list.length, 1, 'no duplicate events for same zid+dayNum+date');
}

{
  const a = makeZ({ id: 11, patient: '홍길동', regNo: '111', drugName: 'SameDrug', donedays: [] });
  const b = makeZ({ id: 22, patient: '홍길동', regNo: '222', drugName: 'SameDrug', donedays: [] });
  context.getFilteredZeroDrugs = () => [a, b];
  const aug = context.collectCalEvents(2026, 7);
  const list = (aug['2026-08-20'] || []).filter(e => e.drugName === 'SameDrug' && e.dayNum === 1);
  assert.strictEqual(list.length, 2, '동명이인 different zid both appear');
}

{
  const a = makeZ({ id: 31, drugName: 'DupName', drugCode: 'XA', qty: 1, donedays: [] });
  const b = makeZ({ id: 32, drugName: 'DupName', drugCode: 'XB', qty: 2, donedays: [] });
  context.getFilteredZeroDrugs = () => [a, b];
  const aug = context.collectCalEvents(2026, 7);
  const list = (aug['2026-08-20'] || []).filter(e => e.drugName === 'DupName' && e.dayNum === 1);
  assert.strictEqual(list.length, 2, 'same drugName different zid both appear');
}

{
  const z = makeZ({
    nextDate: '2026-08-28',
    lastDate: '2026-08-21',
    cycleWeeks: 1,
    donedays: [1],
  });
  context.getFilteredZeroDrugs = () => [z];
  const oct = context.collectCalEvents(2026, 9);
  assert.ok(findEvent(oct, '2026-10-02', e => e.dayNum === 1 && e.future), 'Oct 2 future D1');
  assert.ok(findEvent(oct, '2026-10-16', e => e.dayNum === 1 && e.future), 'Oct 16 future D1 (beyond ±3)');
  assert.ok(findEvent(oct, '2026-10-30', e => e.dayNum === 1 && e.future), 'Oct 30 future D1');
  const oct2 = findEvent(oct, '2026-10-02', e => e.dayNum === 1);
  assert.strictEqual(oct2.done, false);
}

{
  const z = makeZ({ cycleWeeks: 1, donedays: [1] });
  context.getFilteredZeroDrugs = () => [z];
  const feb = context.collectCalEvents(2027, 1);
  assert.ok(
    findEvent(feb, '2027-02-18', e => e.dayNum === 1 && e.future),
    '1-week cycle 6+ months ahead still fills Feb 2027 (maxCycles from month distance)'
  );
}

{
  const z = makeZ({
    dayDates: { 1: '2026-08-22' },
    donedays: [],
  });
  context.getFilteredZeroDrugs = () => [z];
  const aug = context.collectCalEvents(2026, 7);
  assert.ok(findEvent(aug, '2026-08-22', e => e.dayNum === 1 && !e.future), 'current D1 uses dayDates Aug 22');
  assert.ok(!findEvent(aug, '2026-08-20', e => e.dayNum === 1 && !e.past), 'raw nextDate Aug 20 not current');
  const sep = context.collectCalEvents(2026, 8);
  assert.ok(findEvent(sep, '2026-09-10', e => e.dayNum === 1 && e.future), 'future D1 stays Sep 10 not Sep 12');
  assert.ok(!findEvent(sep, '2026-09-12', e => e.dayNum === 1 && e.future));
}

{
  const z = makeZ({ nextDate: '2026-08-01', lastDate: '2026-07-25', cycleWeeks: 1, donedays: [] });
  context.getFilteredZeroDrugs = () => [z];
  const aug = context.collectCalEvents(2026, 7);
  assert.ok(findEvent(aug, '2026-08-01', e => e.dayNum === 1 && !e.future), 'current D1 Aug 1');
  assert.ok(!findEvent(aug, '2026-08-08', e => e.future), 'do not emit past future-cycle Aug 8');
  assert.ok(!findEvent(aug, '2026-08-15', e => e.future), 'do not emit past future-cycle Aug 15');
  assert.ok(findEvent(aug, '2026-08-22', e => e.dayNum === 1 && e.future), 'upcoming next-cycle Aug 22 >= today');
}

{
  const z = makeZ();
  delete z.lastDate;
  context.getFilteredZeroDrugs = () => [z];
  assert.doesNotThrow(() => context.collectCalEvents(2026, 6));
  const jul = context.collectCalEvents(2026, 6);
  assert.ok(!findEvent(jul, '2026-07-30', e => e.patient === z.patient), 'no lastDate → no past events');
}

{
  const z = makeZ({ nextDate: '' });
  context.getFilteredZeroDrugs = () => [z];
  assert.doesNotThrow(() => context.collectCalEvents(2026, 8));
  const sep = context.collectCalEvents(2026, 8);
  assert.ok(!findEvent(sep, '2026-09-10', e => e.patient === z.patient), 'empty nextDate → no future D1');
}

// --- countQtyInPeriod ---

assert.strictEqual(
  context.countQtyInPeriod(makeZ({ donedays: [1] }), '2026-09-01', '2026-09-30'),
  1,
  'Sep 1-30 still counts the Sep 10 future-cycle dose'
);

assert.strictEqual(
  context.countQtyInPeriod(makeZ({
    dayType: 'range',
    dayEnd: 3,
    nextDate: '2026-08-30',
    lastDate: '2026-08-09',
    donedays: [1],
  }), '2026-09-01', '2026-09-30'),
  4,
  'range spanning month: Sep 1 (current D3) + next-cycle D1-D3'
);

// --- buildMonthTable click / move guards ---

{
  context._moveData = null;
  const html = context.buildMonthTable(2026, 8, {
    '2026-09-10': [{
      patient: '테스트환자', regNo: '1234567', drugName: 'TestDrug',
      qty: 1, dayNum: 1, done: false, future: true, zid: 1,
    }],
  });
  assert.ok(html.includes("toast('다음 주기 예정'"), 'future cell toasts 다음 주기 예정');
  assert.ok(html.includes('(다음주기)'), 'future cell shows 다음주기 label');
  assert.ok(!html.includes('calToggleDose'), 'future-only cell must not toggle donedays');
  assert.ok(!html.includes('calStartMove'), 'future-only cell must not start 이동');
}

{
  context._moveData = null;
  const html = context.buildMonthTable(2026, 7, {
    '2026-08-20': [{
      patient: '테스트환자', regNo: '1234567', drugName: 'TestDrug',
      qty: 1, dayNum: 1, done: false, zid: 1,
    }],
  });
  assert.ok(html.includes('calToggleDose'), 'current undone cell still toggles');
  assert.ok(html.includes('calStartMove'), 'current undone cell still has 이동');
}

{
  context._moveData = null;
  const html = context.buildMonthTable(2026, 8, {
    '2026-09-10': [
      { patient: 'P', regNo: '1', drugName: 'DrugA', qty: 1, dayNum: 1, done: false, future: true, zid: 1 },
      { patient: 'P', regNo: '1', drugName: 'DrugB', qty: 1, dayNum: 1, done: true, zid: 2 },
    ],
  });
  assert.ok(!html.includes('calStartMove'), 'mixed cell with only future undone must not show 이동');
}

{
  context._moveData = null;
  const html = context.buildMonthTable(2026, 8, {
    '2026-09-10': [
      { patient: 'P', regNo: '1', drugName: 'DrugA', qty: 1, dayNum: 1, done: false, future: true, zid: 1 },
      { patient: 'P', regNo: '1', drugName: 'DrugB', qty: 1, dayNum: 1, done: false, zid: 2 },
    ],
  });
  assert.ok(html.includes('calStartMove'), 'mixed cell with current undone still has 이동');
  assert.ok(html.includes("toast('다음 주기 예정'"), 'future line still toasts');
  assert.ok(html.includes('calToggleDose'), 'current line still toggles');
}

// --- calClickDate: skip future-cycle drug on mixed-patient move ---

{
  const drugA = makeZ({
    id: 101,
    patient: '혼합환자',
    regNo: '999',
    drugName: 'DrugA',
    drugCode: 'XA',
    nextDate: '2026-08-20',
    lastDate: '2026-07-30',
    donedays: [1],
  });
  const drugB = makeZ({
    id: 102,
    patient: '혼합환자',
    regNo: '999',
    drugName: 'DrugB',
    drugCode: 'XB',
    nextDate: '2026-09-10',
    lastDate: '2026-08-20',
    donedays: [],
  });
  context.state = { zeroDrugs: [drugA, drugB] };
  context._moveData = { patient: '혼합환자', regNo: '999', fromDate: '2026-09-10' };
  context.calClickDate('2026-09-11');
  assert.strictEqual(drugA.nextDate, '2026-08-20', 'future-cycle drug nextDate unchanged');
  assert.deepStrictEqual([...drugA.donedays], [1], 'future-cycle drug donedays unchanged');
  assert.strictEqual(drugB.nextDate, '2026-09-11', 'current-cycle drug on that date still moves');
}

console.log('zero-next-date.test.cjs: all passed');
