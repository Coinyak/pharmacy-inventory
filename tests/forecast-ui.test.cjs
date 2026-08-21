/**
 * Forecast tab UI: 월평균 column order + 제로관리약 mint row highlight.
 * Extracts live functions / markup from public/index.html via vm.
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

function parseForecastThead() {
  const m = html.match(/<table id="forecastTable">[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  assert.ok(m, 'forecastTable thead should exist');
  return [...m[1].matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)].map(mm => ({
    attrs: mm[1],
    text: mm[2].trim(),
    key: (mm[1].match(/data-key="([^"]*)"/) || [])[1] || null,
  }));
}

function parseRowTds(trHtml) {
  return trHtml.match(/<td[\s\S]*?<\/td>/g) || [];
}

function mintCssRules() {
  return (html.match(/[^{}]*forecast-zero-row[^{]*\{[^}]*\}/g) || []).map(raw => {
    const m = raw.match(/^([\s\S]*)\{([^}]*)\}/);
    return { raw, selector: ((m && m[1]) || '').trim(), body: ((m && m[2]) || '').trim() };
  });
}

function makeTbody() {
  const el = {
    innerHTML: '',
    hideBtnListeners: 0,
    orderInputListeners: 0,
    querySelectorAll(selector) {
      const src = el.innerHTML || '';
      if (selector === '.order-input') {
        const out = [];
        const re = /<input\b[^>]*class="[^"]*order-input[^"]*"[^>]*>/gi;
        let m;
        while ((m = re.exec(src))) {
          const tag = m[0];
          out.push({
            value: (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '',
            dataset: { code: (tag.match(/data-code="([^"]*)"/) || [])[1] || '' },
            addEventListener() { el.orderInputListeners++; },
          });
        }
        return out;
      }
      if (selector === '.forecast-hide-btn') {
        const out = [];
        const re = /<button\b[^>]*class="[^"]*forecast-hide-btn[^"]*"[^>]*>/gi;
        let m;
        while ((m = re.exec(src))) {
          const tag = m[0];
          out.push({
            dataset: { code: (tag.match(/data-code="([^"]*)"/) || [])[1] || '' },
            addEventListener() { el.hideBtnListeners++; },
          });
        }
        return out;
      }
      if (selector === 'tr') {
        return (src.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(rowHtml => ({
          outerHTML: rowHtml,
          className: ((rowHtml.match(/<tr\b[^>]*\bclass="([^"]*)"/i) || [])[1] || ''),
        }));
      }
      return [];
    },
  };
  return el;
}

function loadRenderContext(overrides) {
  overrides = overrides || {};
  const tbody = makeTbody();
  const elements = {
    forecastBody: tbody,
    forecastInfo: { textContent: '' },
    forecastQueryFrom: { value: '' },
    forecastQueryTo: { value: '' },
    forecastHiddenCard: null,
    forecastHiddenBody: null,
  };
  const defaultState = { forecastUsage: { items: [] }, hiddenDrugs: [], zeroDrugs: [] };
  const context = {
    document: {
      getElementById(id) { return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null; },
    },
    window: {},
    state: Object.assign({}, defaultState),
    orderDraft: {},
    getDemandForecast: () => [],
    applySortToArray: (arr) => arr,
    getRealInventory: () => [],
    getFilteredZeroDrugs: () => [],
    hideDrug() {},
    Date,
    Set,
    Math,
    parseInt,
    parseFloat,
    Object,
    Array,
    String,
    Number,
    console,
  };
  const { state: stateOverride, ...rest } = overrides;
  Object.assign(context, rest);
  context.state = Object.assign({}, defaultState, stateOverride);
  vm.createContext(context);
  const helperSrc = loadFunction('isZeroManagedForecastDrug');
  vm.runInContext(helperSrc, context);
  const renderSrc = loadFunction('renderForecast');
  vm.runInContext(renderSrc, context);
  assert.strictEqual(typeof context.isZeroManagedForecastDrug, 'function');
  assert.strictEqual(typeof context.renderForecast, 'function');
  return { context, tbody, elements, renderSrc, helperSrc };
}

// --- thead column order ---

test('thead: 월평균 immediately precedes 발주수량', () => {
  const ths = parseForecastThead();
  const avgIdx = ths.findIndex(t => t.key === 'monthlyAvg');
  const orderIdx = ths.findIndex(t => t.text === '발주수량');
  assert.ok(avgIdx >= 0, '월평균 th[data-key=monthlyAvg] should exist');
  assert.ok(orderIdx >= 0, '발주수량 header should exist');
  assert.strictEqual(orderIdx, avgIdx + 1, '월평균 should immediately precede 발주수량');
});

test('thead: 월평균 keeps sortable forecast key', () => {
  const ths = parseForecastThead();
  const avg = ths.find(t => t.key === 'monthlyAvg');
  assert.ok(avg, 'monthlyAvg th should exist');
  assert.ok(/\bclass="sortable"/.test(avg.attrs), 'monthlyAvg th should stay sortable');
  assert.ok(/\bdata-table="forecast"/.test(avg.attrs), 'monthlyAvg th should stay data-table=forecast');
  assert.strictEqual(avg.text, '월평균');
});

test('thead: hide-button column stays last and column count is 14', () => {
  const ths = parseForecastThead();
  assert.strictEqual(ths.length, 14, 'forecast thead should have 14 columns');
  assert.strictEqual(ths[ths.length - 1].text, '', 'hide-button header should be last (empty)');
});

test('renderForecast empty-state keeps colspan="14"', () => {
  const src = loadFunction('renderForecast');
  assert.ok(
    /innerHTML\s*=\s*'<tr><td colspan="14"/.test(src),
    'empty-state assignment inside renderForecast should use colspan="14"'
  );
});

// --- mint CSS ---

test('CSS: rest-state forecast-zero-row mint overrides stock-highlight', () => {
  const rest = mintCssRules().filter(r =>
    /#forecastTable/.test(r.selector) &&
    /\.forecast-zero-row/.test(r.selector) &&
    !/:hover/.test(r.selector)
  );
  assert.ok(
    rest.some(r => /background-color:\s*#e6f9f2/i.test(r.body) && /td\.stock-highlight/.test(r.raw)),
    'rest-state (non-hover) rule must set #e6f9f2 and mention td.stock-highlight'
  );
});

test('CSS: forecast-zero-row hover stays pale mint', () => {
  const hover = mintCssRules().filter(r => /:hover/.test(r.selector));
  assert.ok(
    hover.some(r => /background-color:\s*#d1fae5/i.test(r.body)),
    'hover rule may use #d1fae5 and must not satisfy rest-state assertions'
  );
});

// --- extract completeness ---

test('renderForecast extract is complete (not truncated by brace matching)', () => {
  const src = loadFunction('renderForecast');
  assert.ok(src.includes('forecast-zero-row'), 'extract should include forecast-zero-row');
  assert.ok(src.includes('monthlyAvg'), 'extract should include monthlyAvg');
  const mapIdx = src.indexOf('forecast.map');
  assert.ok(mapIdx >= 0, 'extract should include forecast.map');
  assert.ok(src.indexOf("querySelectorAll('.forecast-hide-btn')", mapIdx) > mapIdx);
  assert.ok(src.indexOf("querySelectorAll('.order-input')", mapIdx) > mapIdx);
  const { context } = loadRenderContext();
  assert.strictEqual(typeof context.renderForecast, 'function');
});

// --- isZeroManagedForecastDrug ---

test('isZeroManagedForecastDrug: true when drugCode === code', () => {
  const { context } = loadRenderContext();
  assert.strictEqual(
    context.isZeroManagedForecastDrug({ code: 'XZERO', barcode: '880111' }, [{ drugCode: 'XZERO' }]),
    true
  );
});

test('isZeroManagedForecastDrug: true when drugCode === barcode and code differs', () => {
  const { context } = loadRenderContext();
  assert.strictEqual(
    context.isZeroManagedForecastDrug({ code: 'XREP', barcode: '880222' }, [{ drugCode: '880222' }]),
    true
  );
});

test('isZeroManagedForecastDrug: true when drugCode === resolvedCode (EDI vs PHS barcode)', () => {
  const { context } = loadRenderContext();
  assert.strictEqual(
    context.isZeroManagedForecastDrug(
      { code: '880222', barcode: '880222', resolvedCode: 'X5FU1' },
      [{ drugCode: 'X5FU1' }]
    ),
    true,
    'zero drugs store EDI; PHS rows keyed by 물품코드 need resolvedCode'
  );
  assert.strictEqual(
    context.isZeroManagedForecastDrug(
      { code: '880222', barcode: '880222' },
      [{ drugCode: 'X5FU1' }]
    ),
    false,
    'without resolvedCode, EDI must not match a barcode-only row'
  );
});

test('isZeroManagedForecastDrug: false when not registered', () => {
  const { context } = loadRenderContext();
  assert.strictEqual(
    context.isZeroManagedForecastDrug({ code: 'XNORM', barcode: '880999' }, [{ drugCode: 'XZERO' }]),
    false
  );
});

test('isZeroManagedForecastDrug: false when drugCode is empty/undefined', () => {
  const { context } = loadRenderContext();
  const item = { code: 'X1', barcode: 'B1' };
  assert.strictEqual(context.isZeroManagedForecastDrug(item, [{ drugCode: '' }]), false);
  assert.strictEqual(context.isZeroManagedForecastDrug(item, [{ drugCode: undefined }]), false);
  assert.strictEqual(context.isZeroManagedForecastDrug(item, [{}]), false);
  assert.strictEqual(context.isZeroManagedForecastDrug({ code: '', barcode: '' }, [{ drugCode: '' }]), false);
  assert.strictEqual(context.isZeroManagedForecastDrug({ code: 'X1', barcode: 'B1' }, [{ drugCode: '   ' }]), false);
  assert.strictEqual(
    context.isZeroManagedForecastDrug({ code: '   ', barcode: '' }, [{ drugCode: '   ' }]),
    false,
    'whitespace-only code vs whitespace-only drugCode must stay false'
  );
});

test('isZeroManagedForecastDrug: null item, non-array list, numeric/padded codes', () => {
  const { context } = loadRenderContext();
  const fn = context.isZeroManagedForecastDrug;
  assert.strictEqual(fn(null, [{ drugCode: 'X1' }]), false);
  assert.strictEqual(fn(undefined, [{ drugCode: 'X1' }]), false);
  assert.strictEqual(fn({ code: 'X1' }, null), false);
  assert.strictEqual(fn({ code: 'X1' }, { drugCode: 'X1' }), false);
  assert.strictEqual(fn({ code: 'XREP', barcode: '880222' }, [{ drugCode: 880222 }]), true);
  assert.strictEqual(fn({ code: 'XZERO', barcode: '880111' }, [{ drugCode: '  XZERO  ' }]), true);
  assert.strictEqual(
    fn({ code: 'XZERO' }, [null, { drugCode: 'XZERO' }]),
    true,
    'null entry next to a real match should still return true'
  );
});

test('isZeroManagedForecastDrug: multiple patients on same drug still match once', () => {
  const { context } = loadRenderContext();
  assert.strictEqual(
    context.isZeroManagedForecastDrug(
      { code: 'XZERO', barcode: '880111' },
      [{ drugCode: 'XZERO' }, { drugCode: 'XZERO' }]
    ),
    true
  );
});

// --- renderForecast ---

const FORECAST_ROWS = [
  {
    code: 'XZERO', barcode: '880111', name: 'ZeroDrug',
    periodTotal: 10, dailyAvg: 1.1, monthlyAvg: 33,
    systemStock: 5, systemStockUsed: 4, currentStock: 3,
    queryNeed: 0, diff: 1, diffSystem: 2, status: 'ok',
  },
  {
    code: 'XNORM', barcode: '880999', name: 'NormalDrug',
    periodTotal: 20, dailyAvg: 2.2, monthlyAvg: 66,
    systemStock: 10, systemStockUsed: 8, currentStock: 7,
    queryNeed: 0, diff: 5, diffSystem: 6, status: 'ok',
  },
];

function renderWithZeroDrugs(zeroDrugs) {
  return loadRenderContext({
    getDemandForecast: () => FORECAST_ROWS.map(r => Object.assign({}, r)),
    getFilteredZeroDrugs: () => zeroDrugs,
    state: { zeroDrugs },
  });
}

test('renderForecast: monthlyAvg cell is immediately before .order-input', () => {
  const ths = parseForecastThead();
  const theadMonthlyIdx = ths.findIndex(t => t.key === 'monthlyAvg');
  const { context, tbody } = renderWithZeroDrugs([]);
  context.renderForecast();
  const rows = tbody.innerHTML.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  assert.strictEqual(rows.length, 2, 'should render two forecast rows');
  rows.forEach((rowHtml, i) => {
    const tds = parseRowTds(rowHtml);
    assert.strictEqual(tds.length, 14, 'each forecast row should have 14 cells');
    const orderIdx = tds.findIndex(td => td.includes('order-input'));
    assert.ok(orderIdx > 0, 'order-input cell should exist');
    const monthlyTd = tds[orderIdx - 1];
    assert.ok(
      monthlyTd.includes('>' + FORECAST_ROWS[i].monthlyAvg + '<'),
      'cell immediately before .order-input should be monthlyAvg'
    );
    assert.strictEqual(orderIdx - 1, theadMonthlyIdx, 'tbody monthlyAvg index should match thead');
  });
});

test('renderForecast: forecast-zero-row only on matching drugs', () => {
  const { context, tbody } = renderWithZeroDrugs([{ drugCode: 'XZERO' }, { drugCode: 'XZERO' }]);
  context.renderForecast();
  const rows = tbody.innerHTML.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  assert.strictEqual(rows.length, 2);
  assert.ok(/<tr class="forecast-zero-row">/.test(rows[0]), 'zero-managed drug row should have forecast-zero-row');
  assert.ok(/XZERO/.test(rows[0]));
  assert.ok(!/forecast-zero-row/.test(rows[1]), 'non-zero-managed row should be unchanged');
  assert.ok(/XNORM/.test(rows[1]));
});

test('renderForecast: barcode match highlights row when code differs', () => {
  const { context, tbody } = loadRenderContext({
    getDemandForecast: () => [{
      code: 'XREP', barcode: '880222', name: 'BarcodeDrug',
      periodTotal: 1, dailyAvg: 0.1, monthlyAvg: 3,
      systemStock: 1, systemStockUsed: 1, currentStock: 1,
      queryNeed: 0, diff: 0, diffSystem: 0, status: 'ok',
    }],
    getFilteredZeroDrugs: () => [{ drugCode: '880222' }],
  });
  context.renderForecast();
  assert.ok(/forecast-zero-row/.test(tbody.innerHTML), 'barcode match should highlight the row');
});

test('renderForecast: empty drugCode does not highlight every row', () => {
  const { context, tbody } = renderWithZeroDrugs([{ drugCode: '' }, { drugCode: undefined }]);
  context.renderForecast();
  assert.ok(!/forecast-zero-row/.test(tbody.innerHTML), 'empty drugCode must not match every forecast row');
});

test('renderForecast: prefers getFilteredZeroDrugs over raw state.zeroDrugs', () => {
  const { context, tbody } = loadRenderContext({
    getDemandForecast: () => FORECAST_ROWS.map(r => Object.assign({}, r)),
    getFilteredZeroDrugs: () => [],
    state: { zeroDrugs: [{ drugCode: 'XZERO' }] },
  });
  context.renderForecast();
  assert.ok(!/forecast-zero-row/.test(tbody.innerHTML), 'filtered-empty must not highlight from raw list');
});

test('renderForecast: falls back to state.zeroDrugs when filter fn is omitted', () => {
  const { context, tbody } = loadRenderContext({
    getDemandForecast: () => FORECAST_ROWS.map(r => Object.assign({}, r)),
    getFilteredZeroDrugs: undefined,
    state: { zeroDrugs: [{ drugCode: 'XZERO' }] },
  });
  context.renderForecast();
  assert.ok(/forecast-zero-row/.test(tbody.innerHTML), 'missing filter fn should use state.zeroDrugs');
});

test('renderForecast: missing zeroDrugs must not throw', () => {
  const { context, tbody } = loadRenderContext({
    getDemandForecast: () => FORECAST_ROWS.map(r => Object.assign({}, r)),
    getFilteredZeroDrugs: undefined,
    state: { zeroDrugs: undefined },
  });
  context.renderForecast();
  assert.ok((tbody.innerHTML.match(/<tr[\s\S]*?<\/tr>/gi) || []).length === 2);
  assert.ok(!/forecast-zero-row/.test(tbody.innerHTML));
});

test('renderForecast: getFilteredZeroDrugs throw does not abort table', () => {
  const { context, tbody } = loadRenderContext({
    getDemandForecast: () => FORECAST_ROWS.map(r => Object.assign({}, r)),
    getFilteredZeroDrugs: () => { throw new Error('zeroDrugs null'); },
  });
  context.renderForecast();
  const rows = tbody.innerHTML.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  assert.strictEqual(rows.length, 2, 'forecast rows should still render if zero-drug lookup throws');
  assert.ok(!/forecast-zero-row/.test(tbody.innerHTML));
});

test('renderForecast: still binds hide and order-input listeners after class/column change', () => {
  const { context, tbody } = renderWithZeroDrugs([{ drugCode: 'XZERO' }]);
  context.renderForecast();
  assert.strictEqual(tbody.hideBtnListeners, 2);
  assert.strictEqual(tbody.orderInputListeners, 2);
});

test('getDemandForecast: attaches resolvedCode from barcode→EDI mapping', () => {
  const { context } = loadRenderContext({
    getCurrentMasterCodes: () => new Set(['X5FU1']),
    getRealInventory: () => [{
      code: 'X5FU1', barcode: '880222', realQty: 5, systemQty: 5, systemQtyUsed: 5,
    }],
    appDataType: 'chemo',
    ANTICANCER_CODES: new Set(),
    state: {
      forecastUsage: {
        from: '2026-01-01',
        to: '2026-01-31',
        items: [{ code: '880222', name: 'Fluorouracil', total: 10 }],
      },
    },
  });
  vm.runInContext(loadFunction('getDemandForecast'), context);
  const rows = context.getDemandForecast();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].code, '880222');
  assert.strictEqual(rows[0].resolvedCode, 'X5FU1');
});

test('renderForecast: EDI drugCode highlights PHS barcode row via resolvedCode', () => {
  const { context, tbody } = loadRenderContext({
    getCurrentMasterCodes: () => new Set(['X5FU1']),
    getRealInventory: () => [{
      code: 'X5FU1', barcode: '880222', realQty: 5, systemQty: 5, systemQtyUsed: 5,
    }],
    appDataType: 'chemo',
    ANTICANCER_CODES: new Set(),
    getFilteredZeroDrugs: () => [{ drugCode: 'X5FU1' }],
    state: {
      forecastUsage: {
        from: '2026-01-01',
        to: '2026-01-31',
        items: [{ code: '880222', name: 'Fluorouracil', total: 10 }],
      },
      hiddenDrugs: [],
    },
  });
  vm.runInContext(loadFunction('getDemandForecast'), context);
  context.renderForecast();
  assert.ok(/forecast-zero-row/.test(tbody.innerHTML), 'EDI zero-drug should highlight barcode-keyed forecast row');
  assert.ok(/880222/.test(tbody.innerHTML));
});

if (failures.length) {
  console.error('\n' + failures.length + ' failed');
  process.exit(1);
}
console.log('forecast-ui.test.cjs: all passed');
