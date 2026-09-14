const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function loadFunction(name) {
  const asyncStart = html.indexOf(`async function ${name}(`);
  const start = asyncStart === -1 ? html.indexOf(`function ${name}(`) : asyncStart;
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

function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

const context = { JSON, Object, Set, Array, Date, Map };
vm.createContext(context);
[
  'cloneSyncData',
  'isSameSyncData',
  'makePersistedStateSnapshot',
  'mergeServerState',
  'trimDailyDataForSave',
  'pendingSaveStorageKey',
  'buildPendingSaveRecord',
  'writePendingSave',
  'readPendingSave',
  'clearPendingSave',
  'pendingSaveFingerprint',
  'shouldClearPendingAfterSave',
  'resolvePendingOnLoad',
  'applyPendingRecordToMemory',
  'shouldApplyRemoteNow',
  'saveFlushPolicy',
  'shouldRetrySaveOnVisible',
  'shouldRefetchServerVersion',
  'buildPersistedPutPayload',
  'shouldKeepPendingRemotePayload',
  'shouldApplyPendingRemotePayload',
  'shouldOverwritePendingSave',
].forEach(name => vm.runInContext(loadFunction(name), context));

function pendingFrom(local, daily, seq, baseUpdatedAt, extras) {
  return JSON.parse(JSON.stringify(context.buildPendingSaveRecord('chemo', baseUpdatedAt || 'v1', local, daily || {}, seq || 1, extras || {})));
}

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}

{
  const local = { inventory: [{ code: 'A', qty: 9 }], zeroDrugs: [{ id: 1, patient: 'A', qty: 2 }], dailyUsage: ['NO'] };
  const daily = { '2026-09-01': { inventory: [{ code: 'A', qty: 9 }] } };
  const pending = pendingFrom(local, daily, 1, 'v1');
  const storage = makeStorage();
  assert.equal(context.writePendingSave(storage, pending), true);
  assert.ok(!Object.prototype.hasOwnProperty.call(pending.data, 'dailyUsage'));

  const emptyMemory = { inventory: [], dailyUsage: [], inpatientMix: [], outpatientData: [], dailyData: {} };
  const olderServer = { inventory: [{ code: 'A', qty: 1 }], zeroDrugs: [{ id: 1, patient: 'A', qty: 1 }] };
  const loaded = fromVm(context.readPendingSave(storage, 'chemo'));
  const resolved = fromVm(context.resolvePendingOnLoad(loaded, olderServer, {}, 'v1'));
  assert.equal(resolved.action, 'restore');
  assert.equal(resolved.retry, true);
  const restored = fromVm(context.applyPendingRecordToMemory(emptyMemory, resolved));
  assert.equal(restored.inventory[0].qty, 9);
  assert.equal(restored.zeroDrugs[0].qty, 2);
  assert.deepStrictEqual(restored.dailyUsage, []);
  assert.deepStrictEqual(restored.dailyData['2026-09-01'].inventory[0].qty, 9);
}

{
  const storage = makeStorage();
  const pending = pendingFrom({ inventory: [{ code: 'A', qty: 2 }] }, {}, 1, 'v1');
  context.writePendingSave(storage, pending);
  const fp = context.pendingSaveFingerprint(pending);
  assert.equal(context.shouldClearPendingAfterSave(context.readPendingSave(storage, 'chemo'), fp), true);
  context.clearPendingSave(storage, 'chemo');
  assert.equal(context.readPendingSave(storage, 'chemo'), null);
}

{
  const storage = makeStorage();
  const older = pendingFrom({ inventory: [{ code: 'A', qty: 1 }] }, {}, 1, 'v1');
  const newer = pendingFrom({ inventory: [{ code: 'A', qty: 2 }] }, {}, 2, 'v1');
  context.writePendingSave(storage, older);
  context.writePendingSave(storage, newer);
  const olderFp = context.pendingSaveFingerprint(older);
  assert.equal(context.shouldClearPendingAfterSave(context.readPendingSave(storage, 'chemo'), olderFp), false);
  const kept = context.readPendingSave(storage, 'chemo');
  assert.equal(kept.seq, 2);
  assert.equal(kept.data.inventory[0].qty, 2);
}

{
  const server = { inventory: [{ code: 'S', qty: 1 }], dailyUsage: [] };
  const serverDaily = { '2026-09-01': { inventory: [{ code: 'S' }] } };
  assert.doesNotThrow(() => {
    assert.equal(context.readPendingSave(makeStorage(), 'chemo'), null);
    assert.equal(context.readPendingSave(makeStorage(), ''), null);
    assert.equal(context.readPendingSave(makeStorage(), null), null);
    assert.equal(context.readPendingSave(null, 'chemo'), null);
    const corrupt = makeStorage();
    corrupt.setItem(context.pendingSaveStorageKey('chemo'), '{');
    assert.equal(context.readPendingSave(corrupt, 'chemo'), null);
    const wrongType = makeStorage();
    wrongType.setItem(context.pendingSaveStorageKey('chemo'), JSON.stringify({ type: 'general', data: { inventory: [] } }));
    assert.equal(context.readPendingSave(wrongType, 'chemo'), null);
    const noData = makeStorage();
    noData.setItem(context.pendingSaveStorageKey('chemo'), JSON.stringify({ type: 'chemo' }));
    assert.equal(context.readPendingSave(noData, 'chemo'), null);
    assert.deepStrictEqual(fromVm(context.resolvePendingOnLoad(null, server, serverDaily, 'v1')), { action: 'ignore' });
    assert.deepStrictEqual(fromVm(context.resolvePendingOnLoad(undefined, server, serverDaily, 'v1')), { action: 'ignore' });
    assert.deepStrictEqual(fromVm(context.resolvePendingOnLoad({ type: 'chemo' }, server, serverDaily, 'v1')), { action: 'ignore' });
    assert.deepStrictEqual(fromVm(context.resolvePendingOnLoad('{', server, serverDaily, 'v1')), { action: 'ignore' });
  });
  const emptyMemory = { inventory: [], dailyUsage: ['keep'], inpatientMix: [1], outpatientData: [2], dailyData: {} };
  const ignored = fromVm(context.applyPendingRecordToMemory(emptyMemory, { action: 'ignore' }));
  assert.equal(ignored.inventory.length, 0);
  assert.deepStrictEqual(ignored.dailyUsage, ['keep']);
}

{
  const server = { inventory: [{ code: 'A', qty: 3 }] };
  const pending = pendingFrom(server, {}, 1, 'v9');
  const resolved = fromVm(context.resolvePendingOnLoad(pending, server, {}, 'v9'));
  assert.equal(resolved.action, 'clear');
}

{
  assert.equal(context.shouldApplyRemoteNow({}), true);
  assert.equal(context.shouldApplyRemoteNow({ pending: true }), false);
  assert.equal(context.shouldApplyRemoteNow({ saving: true }), false);
  assert.equal(context.shouldApplyRemoteNow({ saveTimer: true }), false);
  assert.equal(context.shouldApplyRemoteNow({ queued: true }), false);
  assert.equal(context.shouldApplyRemoteNow({ editing: true }), false);
  assert.equal(context.shouldApplyRemoteNow({ lastSaveFailed: true }), false);
  assert.equal(context.shouldApplyRemoteNow({
    pending: true, saving: true, saveTimer: true, queued: true, editing: true, lastSaveFailed: true,
  }), false);
}

{
  assert.equal(context.saveFlushPolicy('pagehide'), 'immediate');
  assert.equal(context.saveFlushPolicy('hidden'), 'immediate');
  assert.equal(context.saveFlushPolicy('visible'), 'debounce');
  assert.equal(context.saveFlushPolicy('focus'), 'debounce');
  assert.equal(context.saveFlushPolicy('edit'), 'debounce');
  assert.equal(context.shouldRetrySaveOnVisible({ type: 'chemo' }, false), true);
  assert.equal(context.shouldRetrySaveOnVisible(null, true), true);
  assert.equal(context.shouldRetrySaveOnVisible(null, false), false);
}

{
  assert.equal(context.shouldRefetchServerVersion(428, 'v1', false), true);
  assert.equal(context.shouldRefetchServerVersion(200, null, false), true);
  assert.equal(context.shouldRefetchServerVersion(428, 'v1', true), false);
  assert.equal(context.shouldRefetchServerVersion(409, 'v1', false), false);
}

{
  const source = {
    inventory: [{ code: 'A', qty: 1 }],
    dailyUsage: [{ code: 'A' }],
    inpatientMix: [{ code: 'M' }],
    outpatientData: [{ code: 'O' }],
    dailyData: { x: 1 },
  };
  const orig = JSON.parse(JSON.stringify(source));
  const payload = fromVm(context.buildPersistedPutPayload(source, 'chemo', {
    '2026-01-01': { inventory: [] },
  }));
  assert.deepStrictEqual(source, orig);
  const parsed = JSON.parse(payload.data);
  assert.equal(parsed._dataType, 'chemo');
  assert.equal(parsed.dailyUsage, undefined);
  assert.equal(parsed.inpatientMix, undefined);
  assert.equal(parsed.outpatientData, undefined);
  assert.equal(parsed.dailyData, undefined);
  assert.equal(JSON.parse(payload.daily_data)['2026-01-01'].inventory.length, 0);
}

{
  const quota = {
    getItem() { return null; },
    setItem() { const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err; },
    removeItem() {},
  };
  const pending = pendingFrom({ inventory: [{ code: 'A' }] }, {}, 1, 'v1');
  assert.equal(context.writePendingSave(quota, pending), false);
}

{
  const map = new Map();
  let attempts = 0;
  const quotaThenSlim = {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      attempts++;
      if (attempts === 1) {
        const err = new Error('quota');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
  };
  const pending = pendingFrom({ inventory: [{ code: 'A', qty: 4 }] }, {}, 1, 'v1', {
    base: { inventory: [{ code: 'A', qty: 1 }] },
    baseDaily: { '2026-09-01': { inventory: [] } },
  });
  assert.equal(context.writePendingSave(quotaThenSlim, pending), true);
  const stored = JSON.parse(map.get(context.pendingSaveStorageKey('chemo')));
  assert.equal(stored.data.inventory[0].qty, 4);
  assert.equal(stored.base, undefined);
  assert.equal(stored.baseDaily, undefined);
}

{
  const local = { zeroDrugs: [{ id: 1, patient: 'A', qty: 2 }], inventory: [{ code: 'A', qty: 1 }] };
  const base = { zeroDrugs: [{ id: 1, patient: 'A', qty: 1 }], inventory: [{ code: 'A', qty: 1 }] };
  const remote = { zeroDrugs: [{ id: 1, patient: 'A', qty: 1 }, { id: 2, patient: 'B', qty: 1 }], inventory: [{ code: 'A', qty: 1 }] };
  const pending = pendingFrom(local, {}, 1, 'v1', { base: base, baseDaily: {} });
  const resolved = fromVm(context.resolvePendingOnLoad(pending, remote, {}, 'v2'));
  assert.equal(resolved.action, 'restore');
  assert.equal(resolved.retry, true);
  assert.deepStrictEqual(resolved.conflicts, []);
  const ids = resolved.state.zeroDrugs.map(z => z.id).sort();
  assert.deepStrictEqual(ids, [1, 2]);
  assert.equal(resolved.state.zeroDrugs.find(z => z.id === 1).qty, 2);
}

async function runComposedTests() {
function makeComposedContext(overrides) {
  const storage = makeStorage();
  const applied = [];
  const ctx = {
    JSON, Object, Set, Array, Date, Map, Promise, Error, encodeURIComponent,
    console: { warn() {}, log() {} },
    API_BASE: '/api',
    appMode: 'admin',
    appDataType: 'chemo',
    authToken: 'chemo',
    state: {
      inventory: [{ code: 'A', qty: 1 }],
      dailyUsage: [],
      inpatientMix: [],
      outpatientData: [],
      dailyData: {},
    },
    _d1SaveTimer: null,
    _d1Saving: false,
    _d1SaveQueued: false,
    _serverVersion: '2026-09-06T00:00:00.000Z',
    _lastSyncedState: { inventory: [{ code: 'A', qty: 1 }] },
    _lastSyncedDailyData: {},
    _pendingRemotePayload: null,
    _pendingSaveSeq: 0,
    _d1LastSaveFailed: false,
    _d1Hydrated: true,
    _longTermStatsCache: null,
    localStorage: storage,
    document: {
      hidden: false,
      activeElement: null,
      querySelector() { return null; },
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    getWorkDate() { return '2026-09-09'; },
    buildDailyStatsFull() { return {}; },
    buildChemoStats() { return {}; },
    updateSyncBadge() {},
    toast() {},
    renderAll() {},
    renderInventory() {},
    renderUsage() {},
    renderForecast() {},
    renderZeroDrugs() {},
    renderSettings() {},
    renderStats() {},
    migrateZeroDrugDonedays() {},
    autoAdvanceAllCycles() { return false; },
    loadOtherMaster: async () => {},
    saveState() {},
    setTimeout() { return 0; },
    clearTimeout() {},
  };
  Object.assign(ctx, overrides || {});
  vm.createContext(ctx);
  [
    'cloneSyncData',
    'isSameSyncData',
    'makePersistedStateSnapshot',
    'mergeServerState',
    'trimDailyDataForSave',
    'pendingSaveStorageKey',
    'buildPendingSaveRecord',
    'writePendingSave',
    'readPendingSave',
    'clearPendingSave',
    'pendingSaveFingerprint',
    'shouldClearPendingAfterSave',
    'resolvePendingOnLoad',
    'applyPendingRecordToMemory',
    'shouldApplyRemoteNow',
    'saveFlushPolicy',
    'shouldRetrySaveOnVisible',
    'shouldRefetchServerVersion',
    'buildPersistedPutPayload',
    'getPendingSaveStorage',
    'capturePendingSnapshot',
    'currentRemoteApplyFlags',
    'isUserEditing',
    'applyRemoteState',
    'pollRemoteState',
    'saveToD1',
    'flushPendingSaveNow',
    'refetchAndMergePending',
    '_saveToD1Impl',
    'loadFromD1',
    'shouldApplyPendingRemotePayload',
    'shouldKeepPendingRemotePayload',
    'consumePendingRemotePayload',
    'restorePendingAfterLoadFailure',
    'shouldOverwritePendingSave',
    'discardStalePendingRemote',
  ].forEach(name => vm.runInContext(loadFunction(name), ctx));
  const origApply = ctx.applyRemoteState;
  ctx.applyRemoteState = function(remoteState, remoteDaily) {
    applied.push({
      state: JSON.parse(JSON.stringify(remoteState || {})),
      daily: JSON.parse(JSON.stringify(remoteDaily || {})),
    });
    return origApply.call(this, remoteState, remoteDaily);
  };
  return { ctx, applied, storage };
}

{
  const { ctx, applied, storage } = makeComposedContext({ _serverVersion: null });
  const pending = pendingFrom({ inventory: [{ code: 'A', qty: 1 }] }, {}, 1, null);
  ctx.writePendingSave(storage, pending);
  ctx.fetch = async function(url, opts) {
    if (!opts || opts.method !== 'PUT') {
      return { ok: true, status: 200, json: async () => ({ data: '{}', daily_data: '{}', updated_at: null }) };
    }
    ctx.state.inventory = [{ code: 'A', qty: 9 }];
    ctx.writePendingSave(storage, pendingFrom({ inventory: [{ code: 'A', qty: 9 }] }, {}, 2, null));
    return { ok: true, status: 200, json: async () => ({ updated_at: '2026-09-06T02:00:00.000Z' }) };
  };
  await ctx._saveToD1Impl();
  assert.equal(ctx.state.inventory[0].qty, 9, '200 after null-version refetch must not apply resolvedState over newer live edits');
  assert.equal(applied.length, 0, 'HTTP 200 must not applyRemoteState');
  const kept = ctx.readPendingSave(storage, 'chemo');
  assert.equal(kept.data.inventory[0].qty, 9);
}

{
  const { ctx, storage } = makeComposedContext();
  ctx.writePendingSave(storage, pendingFrom({ inventory: [{ code: 'A', qty: 1 }] }, {}, 1, ctx._serverVersion));
  let releasePut;
  const putGate = new Promise(resolve => { releasePut = resolve; });
  ctx.fetch = async function(url, opts) {
    if (opts && opts.method === 'PUT') {
      await putGate;
      return { ok: true, status: 200, json: async () => ({ updated_at: '2026-09-06T02:00:00.000Z' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        data: JSON.stringify({ inventory: [{ code: 'A', qty: 0 }] }),
        daily_data: '{}',
        updated_at: '2026-09-06T01:00:00.000Z',
      }),
    };
  };
  const saveP = ctx._saveToD1Impl();
  while (!ctx._d1Saving) await Promise.resolve();
  await ctx.pollRemoteState();
  assert.ok(ctx._pendingRemotePayload, 'poll during PUT should stash remote payload');
  releasePut();
  await saveP;
  assert.equal(ctx._pendingRemotePayload, null, '200 must drop a stale pending-remote payload');
  ctx._d1Saving = false;
  ctx._d1SaveQueued = false;
  ctx._d1SaveTimer = null;
  const appliedNow = ctx.consumePendingRemotePayload();
  assert.equal(appliedNow.applied, false);
  assert.equal(ctx.state.inventory[0].qty, 1);
}

{
  const { ctx, storage } = makeComposedContext({
    state: { inventory: [], dailyUsage: ['keep'], inpatientMix: [], outpatientData: [], dailyData: {} },
    _d1Hydrated: false,
    _serverVersion: null,
    _lastSyncedState: { inventory: [{ code: 'OLD', qty: 1 }] },
  });
  ctx.writePendingSave(storage, pendingFrom({ inventory: [{ code: 'A', qty: 9 }] }, { '2026-09-01': { inventory: [{ code: 'A' }] } }, 1, 'v1'));
  ctx.fetch = async function() { return { ok: false, status: 500, json: async () => ({ error: 'fail' }) }; };
  await ctx.loadFromD1();
  assert.equal(ctx.state.inventory[0].qty, 9, 'GET !ok must restore pending into memory');
  assert.deepStrictEqual(ctx.state.dailyUsage, ['keep']);
  const kept = ctx.readPendingSave(storage, 'chemo');
  assert.equal(kept.data.inventory[0].qty, 9);
  ctx.state.inventory = [];
  ctx._d1Hydrated = false;
  ctx.capturePendingSnapshot();
  const afterEmptyCapture = ctx.readPendingSave(storage, 'chemo');
  assert.equal(afterEmptyCapture.data.inventory[0].qty, 9, 'empty reset must not overwrite durable pending');
}

{
  const { ctx } = makeComposedContext({ _d1LastSaveFailed: true });
  let retries = 0;
  ctx.saveToD1 = function() { retries += 1; };
  ctx.fetch = async function() { return { ok: false, status: 304 }; };
  await ctx.pollRemoteState();
  assert.equal(retries, 1, 'a failed save must retry when the next version poll returns 304');
}

{
  const { ctx, storage } = makeComposedContext();
  ctx.writePendingSave(storage, pendingFrom(
    { inventory: [{ code: 'A', qty: 2 }] },
    {},
    1,
    ctx._serverVersion,
    { base: { inventory: [{ code: 'A', qty: 1 }] }, baseDaily: {} }
  ));
  let automaticRetries = 0;
  ctx.saveToD1 = function() { automaticRetries += 1; };
  ctx.fetch = async function(url, opts) {
    assert.equal(opts.method, 'PUT');
    return {
      ok: false,
      status: 409,
      json: async function() {
        return {
          data: JSON.stringify({ inventory: [{ code: 'A', qty: 3 }] }),
          daily_data: '{}',
          updated_at: '2026-09-06T02:00:00.000Z',
        };
      },
    };
  };
  await ctx._saveToD1Impl();
  assert.equal(automaticRetries, 0, 'a conflicting 409 must not automatically write another merged state');
  assert.equal(ctx.readPendingSave(storage, 'chemo'), null, 'a conflicting pending save must be cleared instead of retried later');
  assert.equal(ctx.state.inventory[0].qty, 3, 'a conflicting 409 must show the server state until the user edits again');
}

{
  const { ctx, storage } = makeComposedContext();
  const sent = pendingFrom(
    { inventory: [{ code: 'A', qty: 2 }] },
    {},
    1,
    ctx._serverVersion,
    { base: { inventory: [{ code: 'A', qty: 1 }] }, baseDaily: {} }
  );
  ctx.writePendingSave(storage, sent);
  let automaticRetries = 0;
  ctx.saveToD1 = function() { automaticRetries += 1; };
  ctx.fetch = async function(url, opts) {
    assert.equal(opts.method, 'PUT');
    ctx.state.inventory = [{ code: 'A', qty: 4 }];
    ctx.writePendingSave(storage, pendingFrom(
      { inventory: [{ code: 'A', qty: 4 }] },
      {},
      2,
      ctx._serverVersion,
      { base: { inventory: [{ code: 'A', qty: 1 }] }, baseDaily: {} }
    ));
    ctx._d1SaveQueued = true;
    return {
      ok: false,
      status: 409,
      json: async function() {
        return {
          data: JSON.stringify({ inventory: [{ code: 'A', qty: 3 }] }),
          daily_data: '{}',
          updated_at: '2026-09-06T02:00:00.000Z',
        };
      },
    };
  };
  await ctx._saveToD1Impl();
  assert.equal(automaticRetries, 0, 'a conflict must not retry a newer edit automatically');
  assert.equal(ctx.readPendingSave(storage, 'chemo').data.inventory[0].qty, 4, 'a newer edit made during a conflicted save must remain durable');
  assert.equal(ctx.state.inventory[0].qty, 4, 'a newer edit made during a conflicted save must remain visible');
}

{
  assert.equal(context.shouldApplyPendingRemotePayload(
    { updated_at: '2026-09-06T01:00:00.000Z' },
    '2026-09-06T02:00:00.000Z',
    {}
  ), false);
  assert.equal(context.shouldApplyPendingRemotePayload(
    { updated_at: '2026-09-06T03:00:00.000Z' },
    '2026-09-06T02:00:00.000Z',
    { pending: true }
  ), false);
  assert.equal(context.shouldApplyPendingRemotePayload(
    { updated_at: '2026-09-06T03:00:00.000Z' },
    '2026-09-06T02:00:00.000Z',
    {}
  ), true);
  assert.equal(context.shouldKeepPendingRemotePayload(
    { updated_at: '2026-09-06T01:00:00.000Z' },
    '2026-09-06T02:00:00.000Z'
  ), false);
}

{
  assert.equal(context.shouldOverwritePendingSave(
    pendingFrom({ inventory: [{ code: 'A', qty: 9 }] }, {}, 1, 'v1'),
    pendingFrom({ inventory: [] }, {}, 2, 'v1'),
    false
  ), false);
  assert.equal(context.shouldOverwritePendingSave(
    null,
    pendingFrom({ inventory: [{ code: 'A', qty: 1 }] }, {}, 1, 'v1'),
    false
  ), true);
  assert.equal(context.shouldOverwritePendingSave(
    pendingFrom({ inventory: [{ code: 'A', qty: 9 }] }, {}, 1, 'v1'),
    pendingFrom({ inventory: [] }, {}, 2, 'v1'),
    true
  ), true);
}
}

runComposedTests().then(() => {
  console.log('pending-save.test.cjs: all passed');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
