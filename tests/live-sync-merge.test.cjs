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

const context = { JSON, Object, Set, Array };
vm.createContext(context);
vm.runInContext(loadFunction('cloneSyncData'), context);
vm.runInContext(loadFunction('isSameSyncData'), context);
vm.runInContext(loadFunction('mergeServerState'), context);

function merge(base, local, remote, baseDaily, localDaily, remoteDaily) {
  return JSON.parse(JSON.stringify(context.mergeServerState(base, local, remote, baseDaily || {}, localDaily || {}, remoteDaily || {})));
}

{
  const result = merge(
    { zeroDrugs: [{ id: 1, patient: 'A', qty: 1 }], drugMaster: [{ code: 'AA', name: 'A' }] },
    { zeroDrugs: [{ id: 1, patient: 'A', qty: 2 }], drugMaster: [{ code: 'AA', name: 'A' }] },
    { zeroDrugs: [{ id: 1, patient: 'A', qty: 1 }, { id: 2, patient: 'B', qty: 1 }], drugMaster: [{ code: 'AA', name: 'A' }, { code: 'BB', name: 'B' }] },
  );
  assert.deepStrictEqual(result.conflicts, []);
  assert.deepStrictEqual(result.state.zeroDrugs, [{ id: 1, patient: 'A', qty: 2 }, { id: 2, patient: 'B', qty: 1 }]);
  assert.deepStrictEqual(result.state.drugMaster, [{ code: 'AA', name: 'A' }, { code: 'BB', name: 'B' }]);
}

{
  const result = merge(
    { zeroDrugs: [{ id: 42, patient: 'A', qty: 1 }] },
    { zeroDrugs: [{ id: 42, patient: 'A', qty: 2 }] },
    { zeroDrugs: [{ id: 42, patient: 'A', qty: 3 }] },
  );
  assert.deepStrictEqual(result.conflicts, ['zeroDrugs:42']);
}

{
  const result = merge(
    { zeroDrugs: [{ id: 9, patient: 'A', qty: 1 }] },
    { zeroDrugs: [] },
    { zeroDrugs: [{ id: 9, patient: 'A', qty: 2 }] },
  );
  assert.deepStrictEqual(result.conflicts, ['zeroDrugs:9']);
}

{
  const result = merge({}, {}, {}, { '2026-09-06': { inventory: [{ code: 'A' }] } }, { '2026-09-06': { inventory: [{ code: 'B' }] } }, { '2026-09-06': { inventory: [{ code: 'C' }] } });
  assert.deepStrictEqual(result.conflicts, ['dailyData:2026-09-06']);
}

console.log('live-sync-merge.test.cjs: all passed');
