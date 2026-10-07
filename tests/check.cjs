// Run: node tests/check.cjs
// A tiny IndexedDB substitute keeps the repository checks dependency-free.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const seedContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'data/database-seed.js'), 'utf8'), seedContext);
const seed = seedContext.window.LendingDBSeed;
const databases = new Map();

function requestWithResult(result, tx) {
  const request = {};
  tx.pending++;
  setTimeout(() => {
    request.result = typeof result === 'function' ? result() : result;
    request.onsuccess?.();
    tx.pending--;
    tx.finishWhenIdle();
  }, 0);
  return request;
}

function makeTransaction(db, selected, upgrading = false) {
  const tx = {
    pending: 0,
    oncomplete: null,
    onabort: null,
    completed: false,
    finishWhenIdle() {
      if (upgrading || tx.pending || tx.completed) return;
      tx.completed = true;
      setTimeout(() => tx.oncomplete?.(), 0);
    },
    objectStore(name) {
      if (!selected.includes(name) && !upgrading) throw new Error(`Store not in transaction: ${name}`);
      const store = db.data.get(name);
      if (!store) throw new Error(`Missing store: ${name}`);
      return {
        getAll: () => requestWithResult(() => [...store.rows.values()].map(row => structuredClone(row)), tx),
        get(key) {
          const request = { result: store.rows.get(key) };
          Object.defineProperty(request, 'onsuccess', { set(handler) { handler?.(); } });
          return request;
        },
        clear() {
          if (upgrading) { store.rows.clear(); return; }
          tx.pending++;
          setTimeout(() => { store.rows.clear(); tx.pending--; tx.finishWhenIdle(); }, 0);
        },
        put(row) {
          if (upgrading) { store.rows.set(row[store.keyPath], structuredClone(row)); return; }
          tx.pending++;
          setTimeout(() => { store.rows.set(row[store.keyPath], structuredClone(row)); tx.pending--; tx.finishWhenIdle(); }, 0);
        }
      };
    }
  };
  return tx;
}
const indexedDB = { open: (name, version) => {
  const request = {};
  setTimeout(() => {
    let db = databases.get(name);
    const oldVersion = db?.version || 0;
    if (!db) {
      db = {
        data: new Map(),
        version: 0,
        objectStoreNames: { contains: key => db.data.has(key) },
        createObjectStore(key, { keyPath }) { db.data.set(key, { keyPath, rows: new Map() }); },
        transaction(stores) { return makeTransaction(db, stores); },
        close() {}
      };
      databases.set(name, db);
    }
    request.result = db;
    if (oldVersion < version) {
      const tx = makeTransaction(db, [], true);
      request.transaction = tx;
      request.onupgradeneeded?.({ oldVersion });
      db.version = version;
    }
    request.onsuccess?.();
  }, 0);
  return request;
} };

// Mimic an existing v3 database containing sensitive data in every store.
const legacyDb = {
  data: new Map(), version: 3,
  objectStoreNames: { contains: key => legacyDb.data.has(key) },
  createObjectStore(key, { keyPath }) { legacyDb.data.set(key, { keyPath, rows: new Map() }); },
  transaction(stores) { return makeTransaction(legacyDb, stores); },
  close() {}
};
for (const [store, keyPath] of Object.entries({ trades: 'id', prices: 'isin', counterparties: 'key', events: 'id', meta: 'key' })) {
  legacyDb.createObjectStore(store, { keyPath });
  for (const row of seed[store]) legacyDb.data.get(store).rows.set(row[keyPath], structuredClone(row));
}
legacyDb.data.get('trades').rows.set(777, { id: 777, trader: 'Sample', counterparty: 'BNP', isin: 'DE000KSAG888', stockName: 'Sample', shares: 1, priceOpen: 1, currency: 'EUR', tradeDate: '01.01.2026', status: 'SETTLED' });
legacyDb.data.get('events').rows.set('sample', { id: 'sample', action: 'BOOK_TRADE' });
legacyDb.data.get('meta').rows.set('revision', { key: 'revision', value: 9 });
legacyDb.data.get('meta').rows.set('phxDate', { key: 'phxDate', value: '28.09.2026' });
legacyDb.data.get('trades').rows.get(777).sourceTicket = 'PRIVATE-TICKET';
legacyDb.data.get('trades').rows.get(777).attachments = [{ name: 'PRIVATE-ATTACHMENT', data: 'PRIVATE-BYTES' }];
legacyDb.data.get('prices').rows.set('PRIVATE-ISIN', { isin: 'PRIVATE-ISIN', name: 'PRIVATE-SECURITY' });
legacyDb.data.get('counterparties').rows.set('PRIVATE-PARTY', { key: 'PRIVATE-PARTY', email: 'PRIVATE-EMAIL' });
legacyDb.data.get('events').rows.get('sample').changes = [{ before: { sourceTicket: 'PRIVATE-HISTORY' } }];
legacyDb.data.get('meta').rows.set('PRIVATE-META', { key: 'PRIVATE-META', value: 'PRIVATE-CONTENT' });
databases.set('berenberg-lending-mvp', legacyDb);

const context = vm.createContext({
  window: { LendingDBSeed: seed }, indexedDB, structuredClone, crypto,
  console, setTimeout, clearTimeout, Date, Math
});
vm.runInContext(fs.readFileSync(path.join(root, 'js/database/database.js'), 'utf8'), context);

(async () => {
  const db = context.window.LendingDB;
  const opened = await db.open();
  assert.equal(opened.trades.length, 30, 'demo trades should be added during upgrade');
  assert.equal(opened.events.length, 1, 'old history should be replaced with the demo seed event');
  assert.equal((await db.trades.get(777)), undefined);
  assert.match((await db.trades.get(900001)).trader, /^DEMO/);
  assert.equal(legacyDb.version, 4);
  assert.equal(opened.prices.length, 30);
  assert.equal(opened.counterparties.length, 6);
  assert.equal(opened.meta.length, 2);
  assert.ok(opened.counterparties.every(row => row.key.startsWith('DEMO-') && row.email.endsWith('@example.invalid')));
  assert.ok(!JSON.stringify(opened).includes('PRIVATE-'), 'privacy migration must clear all stores, including history and file bytes');
  const quote = { isin: 'TEST', price: 1, currency: 'EUR', name: 'Test', date: '2026-10-04' };
  await db.batch([
    { type: 'create', store: 'prices', record: quote },
    { type: 'update', store: 'meta', id: 'phxDate', record: { value: '2026-10-04' } }
  ], 'TEST_BATCH');
  assert.equal((await db.prices.get('TEST')).price, 1);
  assert.equal((await db.read()).events.at(-1).action, 'TEST_BATCH');
  const before = await db.exportJSON();
  await assert.rejects(db.batch([
    { type: 'update', store: 'prices', id: 'TEST', record: { price: 2 } },
    { type: 'delete', store: 'trades', id: -1 }
  ]), /missing/);
  assert.equal(await db.exportJSON(), before, 'failed batch must roll back');
  await assert.rejects(db.prices.create(quote), /already exists/);
  await assert.rejects(db.prices.update('TEST', { isin: 'OTHER' }), /key cannot be changed/);
  await db.prices.update('TEST', { price: 2 });
  assert.equal((await db.prices.get('TEST')).price, 2);
  const reopened = await db.reload();
  assert.equal((await db.prices.get('TEST')).price, 2);
  assert.equal(reopened.meta.find(row => row.key === 'revision').value, 3);
  await db.trades.update(900001, {
    attachments: [{ id: 'original-file', name: 'mail.eml', size: 3, type: 'message/rfc822', data: 'YWJj' }],
    sftrTypeQuality: 'MEQU / NOAP',
    sftrReference: { isin: (await db.trades.get(900001)).isin, status: 'suggested', sources: [{ title: 'Test source', url: 'https://www.openfigi.com/api/documentation' }] }
  });
  await db.reload();
  const savedLoan = await db.trades.get(900001);
  assert.equal(savedLoan.attachments[0].data, 'YWJj', 'original attachment bytes survive database reopen');
  assert.equal(savedLoan.sftrTypeQuality, 'MEQU / NOAP');
  assert.equal(savedLoan.sftrReference.sources[0].title, 'Test source');
  // Older database versions must use the same complete privacy reset.
  for (const version of [1, 2]) {
    legacyDb.version = version;
    legacyDb.data.get('meta').rows.set('PRIVATE-META', { key: 'PRIVATE-META', value: 'PRIVATE-CONTENT' });
    const migrated = await db.reload();
    assert.ok(!JSON.stringify(migrated).includes('PRIVATE-'));
    assert.equal(migrated.trades.length, 30);
  }
  databases.delete('berenberg-lending-mvp');
  const fresh = await db.reload();
  assert.equal(fresh.trades.length, 30);
  assert.ok(fresh.counterparties.every(row => row.email.endsWith('@example.invalid')));
  console.log('PASS: privacy reset for v1/v2/v3 and fresh databases, CRUD, atomic batch, validation and reopen without repeated resets.');
})().catch(error => { console.error(error); process.exitCode = 1; });
