import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'functions', 'api', 'state.js');
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace(/export async function onRequestGet/g, 'async function onRequestGet')
  .replace(/export async function onRequestPut/g, 'async function onRequestPut')
  + '\nglobalThis.handlers = { onRequestGet, onRequestPut };';

function makeEnv(updatedAt = '2026-09-06T01:00:00.000Z', { empty = false } = {}) {
  const rows = new Map();
  if (!empty) {
    rows.set('chemo', {
      data: JSON.stringify({ _dataType: 'chemo', zeroDrugs: [] }),
      daily_data: '{}',
      updated_at: updatedAt,
    });
  }
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.startsWith('SELECT data, daily_data, updated_at')) return rows.get(args[0]) || null;
                return null;
              },
              async all() { return { results: [] }; },
              async run() {
                if (sql.startsWith('UPDATE app_state SET')) {
                  const [data, dailyData, nextUpdatedAt, type, expectedUpdatedAt] = args;
                  const current = rows.get(type);
                  if (!current || current.updated_at !== expectedUpdatedAt) return { meta: { changes: 0 } };
                  rows.set(type, { data, daily_data: dailyData, updated_at: nextUpdatedAt });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('INSERT') && sql.includes('app_state')) {
                  const [type, data, dailyData, updatedAtValue] = args;
                  if (rows.has(type)) return { meta: { changes: 0 } };
                  rows.set(type, { data, daily_data: dailyData, updated_at: updatedAtValue });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

const context = { Response, URL, Date, JSON, console };
vm.createContext(context);
vm.runInContext(source, context);
const { onRequestGet, onRequestPut } = context.handlers;
const env = makeEnv();

const unchanged = await onRequestGet({
  request: new Request('https://example.test/api/state?type=chemo&since=2026-09-06T01%3A00%3A00.000Z'),
  env,
});
assert.equal(unchanged.status, 304, 'matching version must avoid downloading unchanged state');

const missingVersion = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({ type: 'chemo', data: '{"_dataType":"chemo"}', daily_data: '{}' }),
  }),
  env,
  data: { adminType: 'chemo' },
});
assert.equal(missingVersion.status, 428, 'writes without a loaded server version must be rejected');

const stale = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({
      type: 'chemo', base_updated_at: '2026-09-06T00:59:00.000Z',
      data: '{"_dataType":"chemo"}', daily_data: '{}',
    }),
  }),
  env,
  data: { adminType: 'chemo' },
});
assert.equal(stale.status, 409, 'stale writes must not overwrite current state');
const staleBody = await stale.json();
assert.equal(staleBody.updated_at, '2026-09-06T01:00:00.000Z');

const saved = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({
      type: 'chemo', base_updated_at: '2026-09-06T01:00:00.000Z',
      data: '{"_dataType":"chemo","zeroDrugs":[{"id":1}]}', daily_data: '{}',
    }),
  }),
  env,
  data: { adminType: 'chemo' },
});
assert.equal(saved.status, 200, 'matching version must save');
const savedBody = await saved.json();
assert.ok(savedBody.updated_at > '2026-09-06T01:00:00.000Z', 'accepted writes must always advance the version token');

const emptyEnv = makeEnv('2026-09-06T01:00:00.000Z', { empty: true });
const inserted = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({
      type: 'chemo',
      data: '{"_dataType":"chemo","zeroDrugs":[{"id":7}]}',
      daily_data: '{}',
    }),
  }),
  env: emptyEnv,
  data: { adminType: 'chemo' },
});
assert.equal(inserted.status, 200, 'missing row must INSERT instead of 409/428 deadlock');
const insertedBody = await inserted.json();
assert.ok(insertedBody.updated_at, 'INSERT must return a version token');

const insertedAgain = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({
      type: 'chemo', base_updated_at: insertedBody.updated_at,
      data: '{"_dataType":"chemo","zeroDrugs":[{"id":8}]}', daily_data: '{}',
    }),
  }),
  env: emptyEnv,
  data: { adminType: 'chemo' },
});
assert.equal(insertedAgain.status, 200, 'matching version after INSERT must save');

const staleAfterInsert = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({
      type: 'chemo', base_updated_at: '2026-09-06T00:00:00.000Z',
      data: '{"_dataType":"chemo"}', daily_data: '{}',
    }),
  }),
  env: emptyEnv,
  data: { adminType: 'chemo' },
});
assert.equal(staleAfterInsert.status, 409, 'stale writes after INSERT must not overwrite current state');

function makeInsertRaceEnv() {
  const rows = new Map();
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.startsWith('SELECT data, daily_data, updated_at')) return rows.get(args[0]) || null;
                return null;
              },
              async all() { return { results: [] }; },
              async run() {
                if (sql.includes('INSERT') && sql.includes('app_state')) {
                  rows.set(args[0], {
                    data: '{"_dataType":"chemo","zeroDrugs":[{"id":1}]}',
                    daily_data: '{}',
                    updated_at: '2026-09-06T01:00:00.000Z',
                  });
                  throw new Error('UNIQUE constraint failed: app_state.id');
                }
                if (sql.startsWith('UPDATE app_state SET')) {
                  return { meta: { changes: 0 } };
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

const raced = await onRequestPut({
  request: new Request('https://example.test/api/state', {
    method: 'PUT',
    body: JSON.stringify({
      type: 'chemo',
      data: '{"_dataType":"chemo","zeroDrugs":[{"id":9}]}',
      daily_data: '{}',
    }),
  }),
  env: makeInsertRaceEnv(),
  data: { adminType: 'chemo' },
});
assert.equal(raced.status, 409, 'INSERT unique-key race must return 409, not 500');
const racedBody = await raced.json();
assert.equal(racedBody.updated_at, '2026-09-06T01:00:00.000Z');

console.log('state-api-version.test.mjs: all passed');
