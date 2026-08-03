/**
 * Dept code mapping + PD→PED merge regression tests.
 * Loads pure functions / const maps from public/index.html via vm (same pattern as stats-counts.test.cjs).
 * Production HTML must stay in sync — tests extract live source, not copies.
 */
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

function loadConst(name) {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  assert.notStrictEqual(start, -1, `${name} const should exist`);
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  const openCh = html[i];
  if (openCh !== '{' && openCh !== '[') {
    throw new Error(`${name}: expected object/array literal`);
  }
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === openCh) depth++;
    else if (html[j] === closeCh) depth--;
    if (depth === 0) {
      let end = j + 1;
      if (html[end] === ';') end++;
      // Use var so binding attaches to vm context global (const/let do not)
      return 'var ' + html.slice(start + 'const '.length, end);
    }
  }
  throw new Error(`${name} const body not found`);
}

const context = {
  state: {},
  Object: Object,
  Array: Array,
  String: String,
  console: console,
};
vm.createContext(context);

vm.runInContext(loadConst('DEPT_NORMALIZE'), context);
vm.runInContext(loadConst('BUILTIN_DEPT_NAMES'), context);
vm.runInContext(loadConst('BUILTIN_DOCTOR_DEPT_MAP'), context);
vm.runInContext(loadConst('DEFAULT_STATS_DEPT_ORDER'), context);
vm.runInContext(loadConst('REPORT_DEPT_FALLBACK'), context);
vm.runInContext(loadFunction('getActiveDoctorDeptMap'), context);
vm.runInContext(loadFunction('normalizeStatsDeptKey'), context);
vm.runInContext(loadFunction('getDeptCode'), context);
vm.runInContext(loadFunction('getAllDeptList'), context);
vm.runInContext(loadFunction('getMappedDeptFromEtcEntry'), context);
vm.runInContext(loadFunction('remapCachedAggregateDepts'), context);
vm.runInContext(loadFunction('sumDailyStats'), context);

// ── normalizeStatsDeptKey ──
assert.strictEqual(context.normalizeStatsDeptKey('PD'), 'PED');
assert.strictEqual(context.normalizeStatsDeptKey('PED'), 'PED');
assert.strictEqual(context.normalizeStatsDeptKey('OT'), 'OT');
assert.strictEqual(context.normalizeStatsDeptKey('OL'), 'OL');

// ── DEPT_NORMALIZE / getDeptCode Korean names ──
context.state = {};
assert.strictEqual(context.getDeptCode('', '안과'), 'OT', '안과 → OT');
assert.strictEqual(context.getDeptCode('', '이비인후과'), 'OL', '이비인후과 → OL');
assert.strictEqual(context.getDeptCode('', '소아청소년과'), 'PED', '소아청소년과 → PED');
assert.strictEqual(context.getDeptCode('', '소아과'), 'PED', '소아과 → PED');

// ── raw code aliases ──
assert.strictEqual(context.getDeptCode('', 'PD'), 'PED', 'raw PD → PED');
assert.strictEqual(context.getDeptCode('', 'PED'), 'PED');
assert.strictEqual(context.getDeptCode('', 'OT'), 'OT');
assert.strictEqual(context.getDeptCode('', 'OL'), 'OL');

// ── doctor map with legacy PD ──
context.state = { doctorDeptMap: { '정석호': 'PD', '오종현': 'OT' } };
assert.strictEqual(context.getDeptCode('정석호', ''), 'PED');
assert.strictEqual(context.getDeptCode('오종현', ''), 'OT');

// ── builtin map 정석호 is PED ──
context.state = {};
assert.strictEqual(context.BUILTIN_DOCTOR_DEPT_MAP['정석호'], 'PED');
assert.strictEqual(context.getDeptCode('정석호', ''), 'PED');

// ── getMappedDeptFromEtcEntry normalizes PD→PED ──
context.state = { doctorDeptMap: { '정석호': 'PD' } };
assert.strictEqual(context.getMappedDeptFromEtcEntry('정석호 / (진료과없음)'), 'PED');
assert.strictEqual(context.getMappedDeptFromEtcEntry('(처방의없음) / x'), '');

// ── getAllDeptList hides PD alias ──
context.state = { customDepts: [] };
const codes = context.getAllDeptList().map((d) => d.code);
assert.ok(codes.indexOf('PED') >= 0, 'PED present');
assert.ok(codes.indexOf('OT') >= 0, 'OT present');
assert.ok(codes.indexOf('OL') >= 0, 'OL present');
assert.ok(codes.indexOf('PD') < 0, 'PD alias hidden from UI list');
assert.strictEqual(context.BUILTIN_DEPT_NAMES.OT, '안과');
assert.strictEqual(context.BUILTIN_DEPT_NAMES.OL, '이비인후과');
assert.strictEqual(context.BUILTIN_DEPT_NAMES.PED, '소아청소년과');

// ── sumDailyStats merges PD + PED ──
const summed = context.sumDailyStats([
  {
    depts: { PD: { pts: 1, rx: 2 }, GS: { pts: 1, rx: 1 } },
    drugDept: { Opdivo: { code: 'XNIVOL1', PD: 3, GS: 1 } },
    drugDetail: {},
    etcDoctors: [],
  },
  {
    depts: { PED: { pts: 2, rx: 1 } },
    drugDept: { Opdivo: { code: 'XNIVOL1', PED: 4 } },
    drugDetail: {},
    etcDoctors: [],
  },
]);
assert.strictEqual(summed.depts.PED.pts, 3, 'PD+PED pts merge');
assert.strictEqual(summed.depts.PED.rx, 3, 'PD+PED rx merge');
assert.strictEqual(summed.depts.PD, undefined, 'no leftover PD key');
assert.strictEqual(summed.drugDept.Opdivo.PED, 7, 'drugDept PD+PED merge');
assert.strictEqual(summed.drugDept.Opdivo.PD, undefined);
assert.strictEqual(summed.depts.GS.pts, 1);

// ── remapCachedAggregateDepts with PD map + normalize ──
context.state = { doctorDeptMap: { '홍길동': 'PD' } };
const remapped = context.remapCachedAggregateDepts({
  depts: { '기타': { pts: 1, rx: 2 }, PD: { pts: 1, rx: 1 } },
  drugDept: {
    Opdivo: { code: 'XNIVOL1', '기타': 1, PD: 2 },
  },
  etcDoctors: ['홍길동 / (진료과없음)'],
});
assert.strictEqual(remapped.depts.PED.pts, 2, 'remap merges PD + 기타→PED');
assert.strictEqual(remapped.depts.PED.rx, 3);
assert.strictEqual(remapped.depts.PD, undefined);
assert.strictEqual(remapped.drugDept.Opdivo.PED, 3);
assert.strictEqual(remapped.etcDoctors.length, 0);

// ── REPORT_DEPT_FALLBACK no longer force-dumps OT/PD ──
assert.strictEqual(context.REPORT_DEPT_FALLBACK.OT, undefined);
assert.strictEqual(context.REPORT_DEPT_FALLBACK.PD, undefined);
assert.strictEqual(context.REPORT_DEPT_FALLBACK.OS, 'OR');

// ── button / help text present in HTML ──
assert.ok(html.includes('엑셀 다운로드 (매트릭스+보고용)'), 'button label updated');
assert.ok(html.includes('처방건수매트릭스=화면과 동일'), 'help text mentions matrix sheet');
assert.ok(html.includes('function normalizeStatsDeptKey'), 'helper exists');

console.log('dept-codes-matrix.test.cjs: all assertions passed');
