// Run: node tests/check-loan-sort.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('laa.html', 'utf8');
const keys = [...html.matchAll(/data-sort-column="([^"]+)"/g)].map(match => match[1]);
const headers = keys.map(key => {
  const th = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const indicator = { textContent: '↕' };
  return { dataset: { sortColumn: key }, closest: () => th, querySelector: () => indicator, th, indicator };
});
const elements = new Map();
function field(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', children: [],
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html || ''; },
    appendChild(child) { this.children.push(child); },
    querySelectorAll: () => id === 'loan-table-head' ? headers : []
  });
  return elements.get(id);
}
const context = vm.createContext({
  document: { getElementById: field, createElement: () => ({ dataset: {} }), addEventListener() {} },
  window: { addEventListener() {} }, Intl, Date, Math, console
});
vm.runInContext(fs.readFileSync('js/app.js', 'utf8'), context);
const run = code => vm.runInContext(code, context);
run('renderCollateralMatrix = () => {};');
assert.deepEqual(keys, Array.from(run('Object.keys(loanSortValues)')), 'every data column must have a sortable header');
context.fixtures = [
  { id: 10, counterparty: 'UBS', isin: 'SEC10', stockName: 'Z', shares: 1000, priceOpen: 2, commission: '0.35', currency: 'EUR', tradeDate: '2026-01-15', valueDate: '2026-01-16', status: 'OPEN' },
  { id: 2, counterparty: 'bnp', isin: 'SEC2', stockName: 'A', shares: 20, priceOpen: 100, commission: '0.1', currency: 'EUR', tradeDate: '02.02.2026', valueDate: '03.02.2026', status: 'OPEN' },
  { id: 3, counterparty: 'BNP', isin: 'SEC3', stockName: 'B', shares: 100, priceOpen: 10, commission: null, currency: 'EUR', tradeDate: '01.12.2025', valueDate: '02.12.2025', status: 'OPEN' }
];
run('trades = fixtures; marketPrices = {SEC10: {price: 5}, SEC2: {price: 1}, SEC3: {price: 20}};');
const ids = () => field('trades-tbody').children.map(row => Number(row.dataset.tradeId));
function sort(key) { run(`controlHandlers['sort-loans']({dataset: {sortColumn: '${key}'}});`); return ids(); }
const expected = {
  id: [2, 3, 10], counterparty: [2, 3, 10], security: [2, 3, 10],
  quantity: [2, 3, 10], opening: [10, 3, 2], commission: [2, 10, 3],
  commissionTotal: [2, 10, 3], current: [2, 10, 3], exposure: [2, 3, 10],
  dates: [3, 10, 2], status: [2, 3, 10]
};
for (const key of keys) {
  run('loanSort = {key: null, direction: "ascending"};');
  assert.deepEqual(sort(key), expected[key], `${key} ascending`);
  const selected = headers.find(header => header.dataset.sortColumn === key);
  assert.equal(selected.th.attributes['aria-sort'], 'ascending');
  assert.equal(selected.indicator.textContent, '↑');
  assert.equal(headers.filter(header => header.th.attributes['aria-sort'] !== 'none').length, 1);
  sort(key);
  assert.equal(selected.th.attributes['aria-sort'], 'descending');
  assert.equal(selected.indicator.textContent, '↓');
}
assert.deepEqual(sort('quantity'), [2, 3, 10]);
assert.deepEqual(sort('quantity'), [10, 3, 2]);
sort('commission');
assert.deepEqual(sort('commission'), [10, 2, 3], 'missing rates stay last in descending order');
assert.deepEqual(context.fixtures.map(trade => trade.id), [10, 2, 3], 'sorting must not mutate stored order');
run('trades = Array.from({length: 21}, (_, i) => ({...fixtures[0], id: i + 1})); loanPage = 3;');
sort('id');
assert.equal(run('loanPage'), 1, 'sorting resets pagination');
assert.deepEqual(ids(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
sort('id');
assert.deepEqual(ids(), [21, 20, 19, 18, 17, 16, 15, 14, 13, 12], 'sort the full dataset before slicing pages');
run('controlHandlers["loan-page-next"]();');
assert.deepEqual(ids(), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
run('trades = fixtures; loanSort = {key: "quantity", direction: "descending"};');
field('filter-counterparty').value = 'BNP';
run('renderTradesTable();');
assert.deepEqual(ids(), [3], 'sorting preserves filters');
field('filter-counterparty').value = 'ALL';
run('marketPrices.SEC10.price = 0.1; loanSort = {key: "current", direction: "ascending"}; renderTradesTable();');
assert.deepEqual(ids(), [10, 2, 3], 'sort updates when market prices change');
run(`trades = [
  {...fixtures[0], id: 1, tradeDate: '2026-01-01', valueDate: '2026-01-03', priceOpen: 10.004},
  {...fixtures[0], id: 2, tradeDate: '01.01.2026', valueDate: '02.01.2026', priceOpen: 10.001}
]; loanSort = {key: null, direction: 'ascending'};`);
assert.deepEqual(sort('dates'), [2, 1], 'value date breaks trade-date ties');
assert.deepEqual(sort('opening'), [2, 1], 'prices sort before display rounding');
assert.deepEqual(sort('opening'), [1, 2]);
run(`archivedTrades = [
  {...fixtures[0], id: 30, status: 'CLOSED', closedAt: '2026-10-01T12:00:00Z'},
  {...fixtures[1], id: 31, status: 'CANCELLED', closedAt: '2026-10-01T12:00:00Z'}
]; loanSort = {key: null, direction: 'ascending'};`);
field('filter-status').value = 'CLOSED';
run('filterTrades();');
assert.deepEqual(ids(), [30, 31], 'Closed includes closed and cancelled loans');
assert.deepEqual(sort('commissionTotal'), [31, 30], 'sorting also applies to the combined Closed view');
assert.deepEqual(sort('status'), [30, 31], 'both archived statuses display and sort as Closed');
for (const row of field('trades-tbody').children) {
  assert.match(row.innerHTML, /loan-status-archived">Closed/);
  assert.ok(!row.innerHTML.includes('Cancelled'));
}
field('filter-status').value = 'OPEN';
run('filterTrades();');
assert.deepEqual(ids(), [1, 2], 'Open never includes archived loans');
field('filter-status').value = '';
run('filterTrades();');
assert.deepEqual(ids(), [1, 2], 'default view is Open');
const statusSelector = html.match(/<select id="filter-status"[\s\S]*?<\/select>/)[0];
assert.deepEqual([...statusSelector.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['OPEN', 'CLOSED']);
assert.match(statusSelector, /value="OPEN" selected/);
assert.ok(!html.includes('tab-btn-canceled') && !html.includes('tab-canceled'), 'Closed must not have a separate tab');
console.log('PASS: all data columns, numeric and date ordering, directions, header indicators, missing values, filters, pagination, refresh and immutable records.');
