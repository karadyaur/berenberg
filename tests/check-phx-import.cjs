// Run: node tests/check-phx-import.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('../js/vendor/xlsx.full.min.js');
const nodes = new Map();
function element(id) {
  if (!nodes.has(id)) nodes.set(id, {
    id, listeners: {}, disabled: false, value: '', textContent: '', open: true,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {}, click() { this.clicked = true; }, close() { this.open = false; }
  });
  return nodes.get(id);
}
const context = vm.createContext({ XLSX, Date, Uint8Array, console,
  document: { getElementById: element, addEventListener() {} },
  window: { addEventListener() {} }
});
const run = code => vm.runInContext(code, context);
run(fs.readFileSync(path.join(__dirname, '../js/phx-import.js'), 'utf8'));
const importer = run('PhxImport');
function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Prices');
  return book;
}
const headers = ['CURRENCY', 'ISIN NAME', 'ISIN', 'PRICE', 'PRICE DATE'];
const row = ['EUR', 'K+S', 'DE000KSAG888', 15.661234, 46293]; // 28 September 2026
const book = workbook([['PHX report'], [], headers, row,
  ['USD', 'Gold', 'JE00B588CD74', '1.234,56', '29.09.2026']]);
const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
const file = { name: 'prices.xlsx', size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const parsed = await importer.readFile(file);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].price, 15.661234);
  assert.equal(parsed.records[0].date, '2026-09-28');
  assert.equal(parsed.records[0].currency, 'EUR', 'column zero must be recognized');
  assert.equal(parsed.records[1].price, 1234.56);
  assert.equal(parsed.records[1].fxRate, 0.92);
  assert.equal(parsed.latestDate, '2026-09-29');
  const zero = importer.parseWorkbook(workbook([['ISIN', 'KURS', 'REPORT DATE'], ['DE000KSAG888', 0, '2026-09-28']]));
  assert.equal(zero.records[0].price, 0);
  assert.equal(zero.records[0].name, 'DE000KSAG888');
  assert.equal(zero.records[0].currency, 'EUR');
  const dated = workbook([headers, ['EUR', 'K+S', 'DE000KSAG888', 15, 44831]]);
  dated.Workbook = { WBProps: { date1904: true } };
  assert.equal(importer.parseWorkbook(dated).records[0].date, '2026-09-28');
  assert.throws(() => importer.parseWorkbook(workbook([headers, [...row.slice(0, 4), '31.02.2026']])), /row 2/);
  assert.throws(() => importer.parseWorkbook(workbook([headers, [...row.slice(0, 3), '12xyz', row[4]]])), /row 2/);
  assert.throws(() => importer.parseWorkbook(workbook([headers, row, [...row.slice(0, 3), 19, row[4]]])), /conflicting/);
  assert.equal(importer.parseWorkbook(workbook([headers, row, row])).records.length, 1);
  assert.throws(() => importer.parseWorkbook(workbook([headers])), /No prices/);
  assert.throws(() => importer.parseWorkbook(workbook([['ISIN', 'PRICE'], ['DE000KSAG888', 15]])), /DATE/);
  await assert.rejects(importer.readFile({ ...file, name: 'prices.csv' }), /\.xlsx/);
  await assert.rejects(importer.readFile({ ...file, size: 11 * 1024 * 1024 }), /10 MB/);
  await assert.rejects(importer.readFile({ ...file, arrayBuffer: async () => new TextEncoder().encode('ISIN,PRICE').buffer }), /not an XLSX/);
  const ods = XLSX.write(book, { type: 'buffer', bookType: 'ods' });
  await assert.rejects(importer.readFile({ ...file, arrayBuffer: async () => ods }), /not an XLSX/);

  let available = true;
  importer.bind({ canSelect: () => available });
  assert.equal(element('import-phx-file').disabled, true);
  element('choose-phx-file').listeners.click();
  assert.equal(element('phx-file-input').clicked, true);
  await element('phx-file-input').listeners.change({ target: { files: [file] } });
  assert.equal(importer.getSelection().records.length, 2);
  assert.equal(element('import-phx-file').disabled, false);
  element('clear-phx-file').listeners.click();
  assert.equal(importer.getSelection(), null);
  let prevented = false;
  const drop = files => element('prices-modal').listeners.drop({ preventDefault() { prevented = true; }, dataTransfer: { files } });
  drop([file]); await tick();
  assert.equal(prevented, true);
  assert.equal(importer.getSelection().records.length, 2);
  drop([file, file]); await tick();
  assert.equal(importer.getSelection(), null);
  assert.match(element('phx-file-status').textContent, /one XLSX/);
  assert.equal(element('import-phx-file').disabled, true);
  available = false; drop([file]); await tick();
  assert.equal(importer.getSelection(), null);
  available = true; drop([file]); await tick();

  run(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'));
  const batches = [];
  let fail = true;
  context.LendingDB = { batch: async (operations, action) => {
    if (fail) throw new Error('Save failed');
    batches.push({ operations, action });
  } };
  run("persistDatabase = async operation => { await operation; }; switchTab = () => {}; marketPrices = { DE000KSAG888: {} };");
  await assert.rejects(run('processPhxData()'), /Save failed/);
  assert.equal(importer.isBusy(), false);
  assert.equal(importer.getSelection().records.length, 2, 'failed save retains the file for retry');
  fail = false;
  await run('processPhxData()');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].action, 'IMPORT_PHX');
  assert.equal(batches[0].operations[0].type, 'update');
  assert.equal(batches[0].operations[1].type, 'create');
  assert.equal(batches[0].operations[2].record.value, '2026-09-29');
  assert.equal(importer.getSelection(), null);
  assert.equal(element('prices-modal').open, false);
  console.log('PASS: real XLSX reading, dates, prices, validation, picker/drop, atomic import and failed-save retry.');
})().catch(error => { console.error(error); process.exitCode = 1; });
