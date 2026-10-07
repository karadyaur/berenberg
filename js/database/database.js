/* One automatically opened IndexedDB database for direct HTML launches. */
window.LendingDB = (() => {
  'use strict';
  const name = 'berenberg-lending-mvp';
  const stores = ['trades', 'prices', 'counterparties', 'events', 'meta'];
  const keys = { trades: 'id', prices: 'isin', counterparties: 'key', events: 'id', meta: 'key' };
  let connection;
  let writing = false;
  const clone = value => structuredClone(value);
  const text = value => typeof value === 'string' && value.length > 0;
  const number = value => typeof value === 'number' && Number.isFinite(value);

  function validate(document) {
    if (document?.database !== name || document.version !== 1) throw new Error('Unknown database format.');
    for (const store of stores) {
      if (!Array.isArray(document[store])) throw new Error(`Invalid table: ${store}`);
      const ids = new Set();
      for (const row of document[store]) {
        const key = row?.[keys[store]];
        if (!row || typeof row !== 'object' || Array.isArray(row) || !(text(key) || (Number.isSafeInteger(key) && key >= 0)) || ids.has(key)) {
          throw new Error(`Invalid or duplicate key: ${store}`);
        }
        ids.add(key);
        if (store === 'trades' && (!Number.isSafeInteger(key) || key <= 0 || !Number.isSafeInteger(row.shares) || row.shares <= 0 ||
          !number(row.priceOpen) || row.priceOpen < 0 || !['OPEN', 'CLOSED', 'CANCELLED'].includes(row.status) ||
          !['isin', 'counterparty', 'stockName', 'currency', 'tradeDate'].every(field => text(row[field])))) throw new Error('Invalid loan.');
        if (store === 'prices' && (!text(key) || !number(row.price) || row.price < 0 || !text(row.currency) || !text(row.name) || !text(row.date) ||
          (row.fxRate !== undefined && (!number(row.fxRate) || row.fxRate <= 0)))) throw new Error('Invalid price.');
        if (store === 'counterparties' && (!text(key) || !number(row.threshold) || row.threshold < 0 || !number(row.collateralHeld) ||
          !['fullName', 'email', 'type'].every(field => text(row[field])))) throw new Error('Invalid counterparty.');
      }
    }
    const revision = document.meta.find(row => row.key === 'revision')?.value;
    if (!Number.isSafeInteger(revision) || revision < 0 || !text(document.meta.find(row => row.key === 'phxDate')?.value)) throw new Error('Invalid metadata.');
    const parties = new Set(document.counterparties.map(row => row.key));
    if (document.trades.some(row => !parties.has(row.counterparty))) throw new Error('The loan counterparty is missing.');
    return document;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Database access failed.'));
    });
  }

  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Database transaction failed.'));
    });
  }

  async function open() {
    if (connection) connection.close();
    const request = indexedDB.open(name, 4);
    request.onupgradeneeded = event => {
      const db = request.result;
      const tx = request.transaction;
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: keys[store] });
      }
      if (event.oldVersion < 4) {
        // User-requested privacy reset. Clear every store, including history
        // snapshots and embedded attachments, in the upgrade transaction.
        for (const store of stores) tx.objectStore(store).clear();
        tx.objectStore('meta').put({ key: 'revision', value: 0 });
        addDemoDataset(tx);
      }
    };
    request.onblocked = () => alert('Close other Lending Tool tabs, then reopen this page to finish clearing the database.');
    connection = await requestResult(request);
    connection.onversionchange = () => connection.close();
    return read();
  }

  function addDemoDataset(tx) {
    const partyRows = Array.from({ length: 6 }, (_, index) => ({
      key: `DEMO-${index + 1}`, fullName: `Demo Counterparty ${index + 1}`,
      email: `collateral-${index + 1}@example.invalid`, type: 'Cash',
      threshold: 100000, collateralHeld: index === 2 ? 500000 : 0, haircut: 0
    }));
    const parties = partyRows.map(row => row.key);
    const counterparties = tx.objectStore('counterparties');
    for (const row of partyRows) {
      const request = counterparties.get(row.key);
      request.onsuccess = () => { if (!request.result) counterparties.put(row); };
    }
    const changes = [];
    for (let index = 1; index <= 30; index++) {
      const id = 900000 + index;
      const isin = `DEMO${String(index).padStart(8, '0')}`;
      const price = Number((12.5 + (index * 7.31 % 88)).toFixed(2));
      const shares = 400 + ((index * 733) % 9600);
      const day = String(1 + (index % 28)).padStart(2, '0');
      const date = `${day}.10.2026`;
      const quote = { isin, price, currency: 'EUR', name: `DEMO Security ${String(index).padStart(2, '0')}`, date };
      const trade = {
        id, trader: `DEMO User ${String(index).padStart(2, '0')}`, counterparty: parties[(index - 1) % parties.length],
        isin, stockName: quote.name, shares, priceOpen: price, currency: 'EUR', commission: '0.25',
        tradeDate: date, valueDate: date, uti: `DEMO-UTI-${String(id)}`, wpsOrder: `DEMO-${String(id)}`,
        sourceTicket: `DEMO DATASET ${String(index).padStart(2, '0')}`, status: 'OPEN'
      };
      tx.objectStore('prices').put(quote);
      tx.objectStore('trades').put(trade);
      changes.push({ type: 'create', store: 'prices', id: isin, before: null, after: quote });
      changes.push({ type: 'create', store: 'trades', id, before: null, after: trade });
    }
    const revisionRequest = tx.objectStore('meta').get('revision');
    revisionRequest.onsuccess = () => {
      const revision = (revisionRequest.result?.value || 0) + 1;
      const meta = tx.objectStore('meta');
      meta.put({ key: 'revision', value: revision });
      meta.put({ key: 'phxDate', value: '28.09.2026' });
      tx.objectStore('events').put({
        id: 'demo-seed-2026-10', action: 'SEED_DEMO_DATA', timestamp: new Date().toISOString(), revision, changes
      });
    };
  }

  async function readFrom(tx) {
    const rows = await Promise.all(stores.map(store => requestResult(tx.objectStore(store).getAll())));
    const document = { database: name, version: 1 };
    stores.forEach((store, index) => { document[store] = rows[index]; });
    document.trades = document.trades.map(row => ({
      ...row,
      status: ['OPEN', 'CLOSED', 'CANCELLED'].includes(row.status) ? row.status : 'OPEN'
    }));
    return validate(document);
  }

  async function read() {
    if (!connection) throw new Error('The database is still opening.');
    const tx = connection.transaction(stores, 'readonly');
    return clone(await readFrom(tx));
  }

  function applyOperations(next, operations, action) {
    const changes = [];
    for (const { type, store, record, id } of operations) {
      if (!stores.slice(0, 3).concat('meta').includes(store) || !['create', 'update', 'delete'].includes(type)) throw new Error('Unknown CRUD operation.');
      const key = keys[store];
      const recordId = type === 'create' ? record?.[key] : id;
      if (store === 'meta' && (recordId !== 'phxDate' || type !== 'update')) throw new Error('Metadata is protected.');
      const index = next[store].findIndex(row => row[key] === recordId);
      if (type === 'create' && index !== -1) throw new Error(`Record already exists: ${recordId}`);
      if (type !== 'create' && index === -1) throw new Error(`Record missing: ${recordId}`);
      if (type === 'update' && record?.[key] !== undefined && record[key] !== id) throw new Error('The key cannot be changed.');
      const before = index === -1 ? null : clone(next[store][index]);
      const after = type === 'delete' ? null : type === 'create' ? clone(record) : { ...before, ...clone(record) };
      if (type === 'create') next[store].unshift(after);
      else if (type === 'update') next[store][index] = after;
      else next[store].splice(index, 1);
      changes.push({ type, store, id: recordId, before, after });
    }
    next.meta.find(row => row.key === 'revision').value++;
    next.events.push({ id: crypto.randomUUID(), action, timestamp: new Date().toISOString(), revision: next.meta.find(row => row.key === 'revision').value, changes });
    return validate(next);
  }

  async function batch(operations, action = 'CRUD') {
    if (!connection) throw new Error('The database is still opening.');
    if (writing) throw new Error('Saving in progress.');
    writing = true;
    try {
      const tx = connection.transaction(stores, 'readwrite');
      const done = transactionDone(tx);
      const current = await readFrom(tx);
      const next = applyOperations(clone(current), operations, action);
      for (const store of stores) {
        const objectStore = tx.objectStore(store);
        objectStore.clear();
        for (const row of next[store]) objectStore.put(row);
      }
      await done;
      return clone(next);
    } catch (error) {
      throw error;
    } finally {
      writing = false;
    }
  }

  function repository(store) {
    return Object.freeze({
      list: async () => (await read())[store],
      get: async id => (await read())[store].find(row => row[keys[store]] === id),
      create: (record, action) => batch([{ type: 'create', store, record }], action),
      update: (id, record, action) => batch([{ type: 'update', store, id, record }], action),
      delete: (id, action) => batch([{ type: 'delete', store, id }], action)
    });
  }

  return Object.freeze({
    open, read, reload: open, batch,
    exportJSON: async () => JSON.stringify(await read(), null, 2),
    trades: repository('trades'), prices: repository('prices'), counterparties: repository('counterparties')
  });
})();
