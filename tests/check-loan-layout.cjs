// Run: node tests/check-loan-layout.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/loan-layout.js'), 'utf8');
const keys = ['id', 'counterparty', 'security', 'quantity', 'opening', 'commission', 'commissionTotal', 'current', 'exposure', 'dates', 'status', 'close'];
const storage = new Map();
function surface() {
  return { handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, querySelectorAll() { return []; } };
}
function row(tag = 'TD') {
  return {
    children: keys.map(() => ({ tagName: tag, dataset: {}, classList: { contains: () => false } })),
    appendChild(cell) { this.children.splice(this.children.indexOf(cell), 1); this.children.push(cell); }
  };
}
function launch() {
  const head = row('TH');
  const body = row();
  const empty = { children: [{ classList: { contains: name => name === 'loan-empty' } }] };
  const rows = [head, body, empty];
  const table = { tHead: surface(), querySelectorAll: () => rows };
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { ...surface(), querySelector: () => ({ querySelector: () => ({ focus() {} }) }), showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  let init;
  const context = vm.createContext({ window: {}, document: { getElementById: get, querySelector: () => table, addEventListener: (_, fn) => { init = fn; } }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext(source, context);
  init();
  const action = (type, column, layoutAction, checked) => {
    const control = { dataset: { column, layoutAction }, checked };
    get('loan-layout-columns').handlers[type]({ target: { closest: () => control } });
  };
  return { context, head, body, rows, empty, table, get, action };
}
let app = launch();
const order = row => row.children.map(cell => cell.dataset.loanColumn);
app.action('click', 'id', 'down');
assert.deepEqual(order(app.head).slice(0, 2), ['counterparty', 'id']);
assert.deepEqual(order(app.body), order(app.head), 'headers and values must stay aligned');
app.action('change', 'quantity', 'visibility', false);
assert.equal(app.body.children.find(cell => cell.dataset.loanColumn === 'quantity').hidden, true);
assert.equal(app.empty.children[0].colSpan, 11);
const fresh = row();
app.rows.push(fresh);
app.context.window.LoanLayout.apply();
assert.deepEqual(order(fresh), order(app.head), 'new rows after pagination must use the saved order');
assert.equal(fresh.children.find(cell => cell.dataset.loanColumn === 'quantity').hidden, true);
app = launch();
assert.deepEqual(order(app.head).slice(0, 2), ['counterparty', 'id'], 'reload must retain column order');
assert.equal(app.body.children.find(cell => cell.dataset.loanColumn === 'quantity').hidden, true, 'reload must retain visibility');
for (const key of keys) app.action('change', key, 'visibility', false);
assert.equal(app.body.children.filter(cell => !cell.hidden).length, 1, 'cannot hide all columns');
app.get('reset-loan-layout').handlers.click();
assert.deepEqual(order(app.head), keys);
assert.equal(app.body.children.filter(cell => cell.hidden).length, 0);
const node = key => ({ dataset: { loanColumn: key } });
app.table.tHead.handlers.dragstart({ target: { closest: () => node('close') }, dataTransfer: { setData() {} } });
app.table.tHead.handlers.drop({ target: { closest: () => node('id') }, preventDefault() {} });
assert.equal(order(app.head)[0], 'close', 'drag and drop must reorder the table');
storage.set('berenberg-loan-layout-v1', JSON.stringify({ order: ['unknown', 'id', 'id'], hidden: keys }));
app = launch();
assert.deepEqual(order(app.head), keys, 'invalid stored columns must be discarded');
assert.equal(app.body.children.filter(cell => cell.hidden).length, 0);
storage.set('berenberg-loan-layout-v1', 'broken JSON');
assert.deepEqual(order(launch().head), keys, 'corrupt preferences must fall back to defaults');
storage.set('berenberg-loan-layout-v1', JSON.stringify({ order: keys.filter(key => key !== 'commission'), hidden: ['opening'] }));
app = launch();
assert.equal(app.body.children.find(cell => cell.dataset.loanColumn === 'commission').hidden, false, 'existing layouts must show the new commission column');
assert.deepEqual(order(app.body), order(app.head), 'existing layouts must keep commission values aligned');
assert.equal(app.body.children.find(cell => cell.dataset.loanColumn === 'opening').hidden, true, 'existing visibility preferences must survive');
console.log('PASS: column alignment, reordering, drag-and-drop, visibility, pagination, reload, reset and corrupt preference recovery.');
