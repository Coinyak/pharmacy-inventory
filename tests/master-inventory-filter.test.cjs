/**
 * 특수조제 1.xlsx + 항암제 마스터 합집합 필터, 마스터 목록 약품명 정렬.
 * Extracts live functions from public/index.html via vm.
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

const failures = [];
function test(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log('FAIL: ' + name + ' — ' + e.message);
  }
}

const BUILTIN_A = 'X5FU1';
const BUILTIN_B = 'XCISP10';
const MANUAL_CODE = 'XMANUAL99';
const OTHER_CODE = 'XOTHER01';

function invRow(code, name) {
  return { code, name: name || code, qty: 1, barcode: '123' };
}

function loadFilterContext(overrides) {
  overrides = overrides || {};
  const defaultState = {
    inventoryFileType: '특수조제',
    inventory: [],
    drugMaster: [],
    generalDrugMaster: [],
  };
  const { state: stateOverride, ...rest } = overrides;
  const context = Object.assign({
    ANTICANCER_CODES: new Set([BUILTIN_A, BUILTIN_B]),
    appDataType: 'chemo',
    Set,
    Array,
    String,
    Object,
  }, rest);
  context.state = Object.assign({}, defaultState, stateOverride);
  vm.createContext(context);
  vm.runInContext(loadFunction('getCurrentMasterCodes'), context);
  vm.runInContext(loadFunction('getFilteredInventory'), context);
  return context;
}

function codesOf(rows) {
  return rows.map(r => r.code).sort();
}

function loadRenderMaster(overrides) {
  overrides = overrides || {};
  const masterBody = { innerHTML: '' };
  const masterCount = { textContent: '' };
  const masterSearch = { value: '' };
  const elements = { masterSearch, masterBody, masterCount };
  const defaultState = { drugMaster: [], generalDrugMaster: [] };
  const { state: stateOverride, ...rest } = overrides;
  const context = Object.assign({
    document: {
      getElementById(id) {
        return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null;
      },
    },
    _masterType: '항암제',
    state: Object.assign({}, defaultState, stateOverride),
  }, rest);
  vm.createContext(context);
  vm.runInContext(loadFunction('getAllMasterList'), context);
  vm.runInContext(loadFunction('renderMasterList'), context);
  return { context, masterBody, masterCount, masterSearch };
}

function masterRowNames(innerHTML) {
  const rows = innerHTML.match(/<tr[\s\S]*?<\/tr>/g) || [];
  return rows.map(row => {
    const tds = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    return tds[1];
  });
}

test('특수조제 + 항암제 모드: 마스터에 넣은 비내장 코드는 재고에 포함', () => {
  const ctx = loadFilterContext({
    appDataType: 'chemo',
    state: {
      inventoryFileType: '특수조제',
      inventory: [
        invRow(BUILTIN_A, 'Fluorouracil'),
        invRow(MANUAL_CODE, '수동추가약'),
        invRow(OTHER_CODE, '미등록약'),
      ],
      drugMaster: [{ code: MANUAL_CODE, name: '수동추가약' }],
    },
  });
  const codes = codesOf(ctx.getFilteredInventory());
  assert.ok(codes.includes(MANUAL_CODE), 'manually added master drug should appear');
  assert.ok(codes.includes(BUILTIN_A), 'builtin anticancer code should still appear');
});

test('특수조제 + 항암제 모드: 마스터에도 내장코드에도 없으면 미포함', () => {
  const ctx = loadFilterContext({
    appDataType: 'chemo',
    state: {
      inventoryFileType: '특수조제',
      inventory: [
        invRow(BUILTIN_A, 'Fluorouracil'),
        invRow(OTHER_CODE, '미등록약'),
      ],
      drugMaster: [{ code: MANUAL_CODE, name: '수동추가약' }],
    },
  });
  const codes = codesOf(ctx.getFilteredInventory());
  assert.ok(!codes.includes(OTHER_CODE), 'unregistered non-builtin code must not leak');
  assert.ok(codes.includes(BUILTIN_A));
});

test('특수조제 + 항암제 모드: 내장 ANTICANCER_CODES는 마스터 없어도 포함', () => {
  const ctx = loadFilterContext({
    appDataType: 'chemo',
    state: {
      inventoryFileType: '특수조제',
      inventory: [invRow(BUILTIN_A, 'Fluorouracil'), invRow(BUILTIN_B, 'Cisplatin')],
      drugMaster: [],
    },
  });
  const codes = codesOf(ctx.getFilteredInventory());
  assert.deepStrictEqual(codes, [BUILTIN_A, BUILTIN_B].sort());
});

test('일반약 모드 + 특수조제: 항암제 마스터만 있는 비내장 코드는 재고에 안 나옴', () => {
  const ctx = loadFilterContext({
    appDataType: 'general',
    state: {
      inventoryFileType: '특수조제',
      inventory: [
        invRow(BUILTIN_A, 'Fluorouracil'),
        invRow(MANUAL_CODE, '수동추가약'),
      ],
      drugMaster: [{ code: MANUAL_CODE, name: '수동추가약' }],
      generalDrugMaster: [],
    },
  });
  const codes = codesOf(ctx.getFilteredInventory());
  assert.ok(!codes.includes(MANUAL_CODE), 'chemo-master-only code must not pollute general mode');
});

test('일반약 모드 + 특수조제: 일반약 마스터의 비내장 코드도 선필터에서 제외 (누수 방지)', () => {
  const ctx = loadFilterContext({
    appDataType: 'general',
    state: {
      inventoryFileType: '특수조제',
      inventory: [
        invRow(BUILTIN_A, 'Fluorouracil'),
        invRow(OTHER_CODE, '일반품목대량'),
      ],
      drugMaster: [],
      generalDrugMaster: [{ code: OTHER_CODE, name: '일반품목대량' }],
    },
  });
  const codes = codesOf(ctx.getFilteredInventory());
  assert.ok(!codes.includes(OTHER_CODE), 'non-builtin general items must not leak from 특수조제');
});

test('빈 inventory / 빈 마스터는 예외 없이 빈 배열', () => {
  const ctx = loadFilterContext({
    appDataType: 'chemo',
    state: { inventoryFileType: '특수조제', inventory: [], drugMaster: [] },
  });
  assert.deepStrictEqual(ctx.getFilteredInventory(), []);
});

test('마스터가 비어도 masterExcluded 코드는 재고현황에 다시 나타나지 않음', () => {
  const ctx = loadFilterContext({
    appDataType: 'general',
    state: {
      inventoryFileType: '일반조제',
      inventory: [invRow(OTHER_CODE, '제외약'), invRow(MANUAL_CODE, '표시약')],
      drugMaster: [], generalDrugMaster: [], masterExcluded: [OTHER_CODE],
    },
  });
  assert.deepStrictEqual(codesOf(ctx.getFilteredInventory()), [MANUAL_CODE]);
});

test('renderMasterList 행은 푸시 순서가 아니라 약품명 localeCompare ko 순', () => {
  const pushed = [
    { code: 'C3', name: '젬시타빈' },
    { code: 'A1', name: '가티플로' },
    { code: 'B2', name: '아바스틴' },
  ];
  const { context, masterBody } = loadRenderMaster({
    _masterType: '항암제',
    state: { drugMaster: pushed.slice(), generalDrugMaster: [] },
  });
  context.renderMasterList();
  const names = masterRowNames(masterBody.innerHTML);
  const expected = pushed.map(d => d.name).sort((a, b) => a.localeCompare(b, 'ko'));
  assert.deepStrictEqual(names, expected);
  assert.notDeepStrictEqual(names, pushed.map(d => d.name), 'must not keep push order');
});

test('renderMasterList 검색 필터 후에도 이름순', () => {
  const pushed = [
    { code: 'C3', name: '젬시타빈주사' },
    { code: 'A1', name: '가티플로정' },
    { code: 'B2', name: '아바스틴주사' },
    { code: 'D4', name: '나프록센' },
  ];
  const { context, masterBody, masterSearch } = loadRenderMaster({
    _masterType: '항암제',
    state: { drugMaster: pushed.slice(), generalDrugMaster: [] },
  });
  masterSearch.value = '주사';
  context.renderMasterList();
  const names = masterRowNames(masterBody.innerHTML);
  const expected = ['아바스틴주사', '젬시타빈주사'].sort((a, b) => a.localeCompare(b, 'ko'));
  assert.deepStrictEqual(names, expected);
});

function loadLookupContext(overrides) {
  overrides = overrides || {};
  const defaultState = { inventory: [], drugMaster: [], generalDrugMaster: [] };
  const { state: stateOverride, ...rest } = overrides;
  const context = Object.assign({
    BUILTIN_DRUGS: [],
    state: Object.assign({}, defaultState, stateOverride),
    String,
    Array,
  }, rest);
  vm.createContext(context);
  vm.runInContext(loadFunction('lookupMasterDrug'), context);
  return context;
}

const INV_CODE = 'XGEMCIT1L';
const INV_BARCODE = '8801234567';
const INV_ROW = {
  code: INV_CODE,
  barcode: INV_BARCODE,
  name: 'Gemzar liquid 1g inj',
  spec: '1g/25ml',
  unit: 'vial',
  qty: 4,
};

test('lookupMasterDrug: 대표물품코드로 name/spec/unit 조회', () => {
  const ctx = loadLookupContext({ state: { inventory: [INV_ROW] } });
  const found = ctx.lookupMasterDrug(INV_CODE);
  assert.ok(found, 'code should match inventory');
  assert.strictEqual(found.code, INV_CODE);
  assert.strictEqual(found.name, INV_ROW.name);
  assert.strictEqual(found.spec, INV_ROW.spec);
  assert.strictEqual(found.unit, INV_ROW.unit);
  assert.strictEqual(found.barcode, undefined, 'must return canonical fields only, not the inventory row');
});

test('lookupMasterDrug: barcode 조회 시 canonical code는 대표물품코드', () => {
  const ctx = loadLookupContext({ state: { inventory: [INV_ROW] } });
  const found = ctx.lookupMasterDrug(INV_BARCODE);
  assert.ok(found, 'barcode should match inventory');
  assert.strictEqual(found.code, INV_CODE);
  assert.notStrictEqual(found.code, INV_BARCODE);
  assert.strictEqual(found.name, INV_ROW.name);
  assert.strictEqual(found.spec, INV_ROW.spec);
  assert.strictEqual(found.unit, INV_ROW.unit);
});

test('lookupMasterDrug: 일치 없으면 null', () => {
  const ctx = loadLookupContext({ state: { inventory: [INV_ROW] } });
  assert.strictEqual(ctx.lookupMasterDrug('NOSUCH'), null);
  assert.strictEqual(ctx.lookupMasterDrug(INV_CODE.slice(0, 4)), null, 'no partial match');
});

test('lookupMasterDrug: 빈값/공백이면 null', () => {
  const ctx = loadLookupContext({ state: { inventory: [INV_ROW] } });
  assert.strictEqual(ctx.lookupMasterDrug(''), null);
  assert.strictEqual(ctx.lookupMasterDrug('   '), null);
  assert.strictEqual(ctx.lookupMasterDrug(null), null);
  assert.strictEqual(ctx.lookupMasterDrug(undefined), null);
});

test('lookupMasterDrug: inventory에 없으면 BUILTIN_DRUGS 폴백', () => {
  const ctx = loadLookupContext({
    state: { inventory: [INV_ROW] },
    BUILTIN_DRUGS: [{ code: 'X5FU1', name: 'Fluorouracil-5 1000mg inj' }],
  });
  const found = ctx.lookupMasterDrug('X5FU1');
  assert.ok(found);
  assert.strictEqual(found.code, 'X5FU1');
  assert.strictEqual(found.name, 'Fluorouracil-5 1000mg inj');
  assert.strictEqual(found.spec, '');
  assert.strictEqual(found.unit, '');
});

function loadAddMasterContext(overrides) {
  overrides = overrides || {};
  const fields = {
    newDrugCode: { value: '' },
    newDrugName: { value: '' },
    newDrugSpec: { value: '' },
    newDrugUnit: { value: 'via' },
    masterSearch: { value: '' },
    masterBody: { innerHTML: '' },
    masterCount: { textContent: '' },
  };
  const toasts = [];
  const defaultState = { inventory: [], drugMaster: [], generalDrugMaster: [] };
  const { state: stateOverride, ...rest } = overrides;
  const context = Object.assign({
    document: {
      getElementById(id) {
        return Object.prototype.hasOwnProperty.call(fields, id) ? fields[id] : null;
      },
    },
    BUILTIN_DRUGS: [],
    _masterType: '항암제',
    state: Object.assign({}, defaultState, stateOverride),
    toast(msg, type) { toasts.push({ msg, type }); },
    saveState() {},
    renderMasterList() {},
    populateDrugSelects() {},
    renderInventory() {},
    renderUsage() {},
    renderDashboard() {},
  }, rest);
  vm.createContext(context);
  vm.runInContext(loadFunction('lookupMasterDrug'), context);
  vm.runInContext(loadFunction('fillMasterDrugFromCode'), context);
  vm.runInContext(loadFunction('addMasterDrug'), context);
  return { context, fields, toasts };
}

test('addMasterDrug: 코드만 입력해도 inventory에 있으면 추가됨', () => {
  const { context, fields, toasts } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [], generalDrugMaster: [] },
  });
  fields.newDrugCode.value = INV_CODE;
  fields.newDrugName.value = '';
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 1, 'should add one chemo master row');
  assert.strictEqual(context.state.drugMaster[0].code, INV_CODE);
  assert.strictEqual(context.state.drugMaster[0].name, INV_ROW.name);
  assert.strictEqual(context.state.drugMaster[0].spec, INV_ROW.spec);
  assert.strictEqual(context.state.drugMaster[0].unit, INV_ROW.unit);
  assert.ok(toasts.every(t => t.msg !== '약품코드와 약품명은 필수입니다.'), 'must not require typed name when lookup hits');
});

test('addMasterDrug: barcode만 입력하면 대표물품코드로 저장', () => {
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [], generalDrugMaster: [] },
  });
  fields.newDrugCode.value = INV_BARCODE;
  fields.newDrugName.value = '';
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 1);
  assert.strictEqual(context.state.drugMaster[0].code, INV_CODE);
  assert.strictEqual(context.state.drugMaster[0].name, INV_ROW.name);
});

test('addMasterDrug/removeMasterDrug는 renderUsage를 호출하고 renderUsageSurplus는 없음', () => {
  const addSrc = loadFunction('addMasterDrug');
  const removeSrc = loadFunction('removeMasterDrug');
  assert.ok(/\brenderUsage\(/.test(addSrc), 'addMasterDrug should call renderUsage');
  assert.ok(!/renderUsageSurplus/.test(addSrc), 'addMasterDrug must not call missing renderUsageSurplus');
  assert.ok(/\brenderUsage\(/.test(removeSrc), 'removeMasterDrug should call renderUsage');
  assert.ok(!/renderUsageSurplus/.test(removeSrc), 'removeMasterDrug must not call missing renderUsageSurplus');
});

test('addMasterDrug: 성공 시 renderUsage 호출', () => {
  let usageCalls = 0;
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [], generalDrugMaster: [] },
    renderUsage() { usageCalls++; },
  });
  fields.newDrugCode.value = INV_CODE;
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 1);
  assert.strictEqual(usageCalls, 1);
});

test('fillMasterDrugFromCode: 빈 필드만 채우고 코드는 대표물품코드로 정규화', () => {
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [] },
  });
  fields.newDrugCode.value = INV_BARCODE;
  fields.newDrugName.value = '';
  fields.newDrugSpec.value = '';
  fields.newDrugUnit.value = 'via';
  context.fillMasterDrugFromCode();
  assert.strictEqual(fields.newDrugCode.value, INV_CODE);
  assert.strictEqual(fields.newDrugName.value, INV_ROW.name);
  assert.strictEqual(fields.newDrugSpec.value, INV_ROW.spec);
  assert.strictEqual(fields.newDrugUnit.value, INV_ROW.unit, 'default via is a placeholder; fill from inventory');
});

test('fill then add: 코드만 입력 + 기본 via → 저장 unit은 inventory unit', () => {
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [], generalDrugMaster: [] },
  });
  fields.newDrugCode.value = INV_CODE;
  fields.newDrugName.value = '';
  fields.newDrugSpec.value = '';
  fields.newDrugUnit.value = 'via';
  context.fillMasterDrugFromCode();
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 1);
  assert.strictEqual(context.state.drugMaster[0].code, INV_CODE);
  assert.strictEqual(context.state.drugMaster[0].name, INV_ROW.name);
  assert.strictEqual(context.state.drugMaster[0].spec, INV_ROW.spec);
  assert.strictEqual(context.state.drugMaster[0].unit, INV_ROW.unit);
  assert.notStrictEqual(context.state.drugMaster[0].unit, 'via');
});

test('fill then add: barcode만 입력 + 기본 via → 대표코드와 inventory unit 저장', () => {
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [], generalDrugMaster: [] },
  });
  fields.newDrugCode.value = INV_BARCODE;
  fields.newDrugName.value = '';
  fields.newDrugSpec.value = '';
  fields.newDrugUnit.value = 'via';
  context.fillMasterDrugFromCode();
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 1);
  assert.strictEqual(context.state.drugMaster[0].code, INV_CODE);
  assert.strictEqual(context.state.drugMaster[0].unit, INV_ROW.unit);
});

test('연속 fill-then-add: 두 번째 약은 첫 약 unit을 물려받지 않음', () => {
  const rowA = {
    code: INV_CODE,
    barcode: INV_BARCODE,
    name: INV_ROW.name,
    spec: INV_ROW.spec,
    unit: 'vial',
    qty: 4,
  };
  const rowB = {
    code: 'XCISP10',
    barcode: '8809999000',
    name: 'Cisplan 10mg inj',
    spec: '10mg',
    unit: 'amp',
    qty: 2,
  };
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [rowA, rowB], drugMaster: [], generalDrugMaster: [] },
  });
  fields.newDrugCode.value = rowA.code;
  fields.newDrugName.value = '';
  fields.newDrugSpec.value = '';
  fields.newDrugUnit.value = 'via';
  context.fillMasterDrugFromCode();
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster[0].unit, 'vial');
  assert.strictEqual(fields.newDrugUnit.value, 'via', 'form unit should reset to HTML default after add');

  fields.newDrugCode.value = rowB.code;
  context.fillMasterDrugFromCode();
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 2);
  const b = context.state.drugMaster.find(d => d.code === rowB.code);
  assert.ok(b);
  assert.strictEqual(b.unit, 'amp');
  assert.notStrictEqual(b.unit, 'vial');
});

test('fill then add: 사용자가 via에서 바꾼 unit은 유지', () => {
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [], generalDrugMaster: [] },
  });
  fields.newDrugCode.value = INV_CODE;
  fields.newDrugName.value = '';
  fields.newDrugSpec.value = '';
  fields.newDrugUnit.value = 'tab';
  context.fillMasterDrugFromCode();
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 1);
  assert.strictEqual(context.state.drugMaster[0].unit, 'tab');
});

test('fillMasterDrugFromCode: 이미 입력된 name/spec/unit은 덮어쓰지 않음', () => {
  const { context, fields } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [] },
  });
  fields.newDrugCode.value = INV_BARCODE;
  fields.newDrugName.value = '사용자지정명';
  fields.newDrugSpec.value = '직접규격';
  fields.newDrugUnit.value = 'tab';
  context.fillMasterDrugFromCode();
  assert.strictEqual(fields.newDrugCode.value, INV_CODE);
  assert.strictEqual(fields.newDrugName.value, '사용자지정명');
  assert.strictEqual(fields.newDrugSpec.value, '직접규격');
  assert.strictEqual(fields.newDrugUnit.value, 'tab');
});

test('addMasterDrug: 조회 실패 시 기존 필수값 토스트', () => {
  const { context, fields, toasts } = loadAddMasterContext({
    state: { inventory: [INV_ROW], drugMaster: [] },
  });
  fields.newDrugCode.value = 'NOSUCH';
  fields.newDrugName.value = '';
  context.addMasterDrug();
  assert.strictEqual(context.state.drugMaster.length, 0);
  assert.ok(toasts.some(t => t.msg === '약품코드와 약품명은 필수입니다.'));
});

if (failures.length) {
  console.error('\n' + failures.length + ' failed');
  process.exit(1);
}
console.log('master-inventory-filter.test.cjs: all passed');
