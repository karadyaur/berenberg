// Run: node tests/check-loan-list.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
const field = id => {
  if (!elements.has(id)) elements.set(id, {
    value: '', textContent: '', innerText: '', children: [], open: false,
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html || ''; },
    appendChild(child) { this.children.push(child); },
    querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}, focus() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    classList: { contains: () => true }
  });
  return elements.get(id);
};
let stored = Array.from({length: 21}, (_, i) => ({
  id: i + 1, isin: `DEMO${i}`, stockName: `Security ${i}`, counterparty: i % 2 ? 'UBS' : 'BNP',
  shares: 100, priceOpen: 10, commission: '0.35', currency: 'EUR', tradeDate: '2026-10-07', valueDate: '2026-10-09', status: 'OPEN'
}));
let failSave = false;
const downloads = [];
const context = vm.createContext({
  document: {getElementById: field, createElement: () => ({dataset: {}}), addEventListener() {}},
  window: {addEventListener() {}}, Intl, Date, Math, console, structuredClone,
  LoanAttachments: {
    download: file => downloads.push(file), maxTotalSize: 25 * 1024 * 1024,
    prepare: async file => {
      if (file.size > 10 * 1024 * 1024) throw new Error('File exceeds 10 MB');
      return {attachment: {id: file.name, name: file.name, size: file.size, lastModified: file.lastModified, data: 'YWJj'}, text: 'different ticket'};
    }
  },
  LendingDB: {trades: {update: async (id, patch, action) => {
    if (failSave) throw new Error('Save failed');
    assert.ok(['RETURN', 'ADD_ATTACHMENTS', 'REMOVE_ATTACHMENT'].includes(action));
    stored = stored.map(item => item.id === id ? {...item, ...patch} : item);
    return {trades: stored, prices: [], counterparties: [], meta: []};
  }}}
});
vm.runInContext(fs.readFileSync('js/app.js', 'utf8'), context);
const run = code => vm.runInContext(code, context);
run('renderCollateralMatrix = () => {}; renderPricesTable = () => {};');
field('filter-status').value = 'OPEN';
context.initialTrades = stored;
run('trades = structuredClone(initialTrades); renderTradesTable();');
assert.equal(run('dailyLoanCommission(trades[0])'), 100 * 10 * 0.35 / 100 / 365);
assert.match(field('trades-tbody').children[0].innerHTML, /data-label="Commission \/ day"/);
assert.match(field('trades-tbody').children[0].innerHTML, /EUR 0,01/);
assert.match(field('trades-tbody').children[0].innerHTML, /0\.35% p\.a\./);
run('marketPrices[trades[0].isin] = {price: 500, currency: "EUR"};');
assert.equal(run('dailyLoanCommission(trades[0])'), 100 * 10 * 0.35 / 100 / 365, 'PHX changes must not change commission');
assert.equal(run('dailyLoanCommission({...trades[0], commission: "0,75", shares: 365, priceOpen: 100})'), 0.75);
assert.equal(run('dailyLoanCommission({...trades[0], commission: "0"})'), 0);
for (const rate of [null, '', 'invalid', '-1']) {
  context.invalidRate = rate;
  assert.equal(run('dailyLoanCommission({...trades[0], commission: invalidRate})'), null);
}
run('marketPrices = {};');
context.accrualTrade = { id: 700, shares: 365, priceOpen: 100, commission: '1', currency: 'EUR', valueDate: '2026-10-01', status: 'OPEN' };
const accrue = date => JSON.parse(run(`JSON.stringify(accruedLoanCommission(accrualTrade, new Date('${date}'))) `));
assert.deepEqual(accrue('2026-10-07T12:00:00Z'), { amount: 7, days: 7 });
assert.deepEqual(accrue('2026-09-30T12:00:00Z'), { amount: 0, days: 0 });
assert.deepEqual(accrue('2026-10-01T12:00:00Z'), { amount: 1, days: 1 });
assert.deepEqual(accrue('2026-10-01T22:30:00Z'), { amount: 2, days: 2 }, 'Berlin midnight advances accrual');
context.accrualTrade.valueDate = '01.10.2026';
assert.deepEqual(accrue('2026-10-07T12:00:00Z'), { amount: 7, days: 7 });
context.accrualTrade.status = 'CLOSED';
context.accrualTrade.closedAt = '2026-10-04T12:00:00Z';
assert.deepEqual(accrue('2026-10-07T12:00:00Z'), { amount: 3, days: 3 });
assert.deepEqual(accrue('2026-12-07T12:00:00Z'), { amount: 3, days: 3 }, 'closed loans stop accruing');
context.accrualTrade.status = 'CANCELLED';
assert.deepEqual(accrue('2026-10-07T12:00:00Z'), { amount: 0, days: 0 });
context.accrualTrade.status = 'OPEN';
context.accrualTrade.valueDate = '2026-03-28';
assert.deepEqual(accrue('2026-03-30T12:00:00Z'), { amount: 3, days: 3 }, 'DST must not lose calendar days');
context.accrualTrade.valueDate = '2026-02-30';
assert.equal(accrue('2026-10-07T12:00:00Z'), null);
context.accrualTrade.valueDate = '2026-10-01';
context.accrualTrade.shares = 182.5;
run(`loanEvents = [{revision: 1, action: 'PARTIAL_RETURN', timestamp: '2026-10-04T12:00:00Z', changes: [{store: 'trades', id: 700, before: {shares: 365}, after: {shares: 182.5}}]}];`);
assert.deepEqual(accrue('2026-10-07T12:00:00Z'), { amount: 5, days: 7 }, 'partial returns preserve commission earned before the return');
run(`loanEvents.push({revision: 2, action: 'BOOK', timestamp: '2026-10-05T12:00:00Z', changes: [{store: 'trades', id: 700, before: {status: 'CANCELLED'}, after: {status: 'OPEN'}}]});`);
context.accrualTrade.shares = 365;
context.accrualTrade.valueDate = '2026-10-05';
assert.deepEqual(accrue('2026-10-07T12:00:00Z'), { amount: 3, days: 3 }, 'rebooked loans start a new period');
run('loanEvents = [];');
assert.match(field('trades-tbody').children[0].innerHTML, /data-label="Total commission"/);
assert.equal(field('trades-tbody').children.length, 10);
assert.equal(field('loan-page-prev').disabled, true);
run('controlHandlers["loan-page-next"]();');
assert.match(field('loan-page-summary').textContent, /11–20 of 21/);
run('controlHandlers["loan-page-next"]();');
assert.equal(field('trades-tbody').children.length, 1);
assert.equal(field('loan-page-next').disabled, true);
field('filter-search').value = '  DEMO1  ';
run('filterTrades();');
assert.match(field('loan-page-summary').textContent, /Page 1/);
assert.equal(run('filteredActiveLoans().length'), 11);
field('filter-counterparty').value = 'UBS';
run('filterTrades();');
assert.equal(run('filteredActiveLoans().length'), 6);
field('filter-search').value = 'nonexistent';
run('filterTrades();');
assert.match(field('trades-tbody').innerHTML, /No matching loans/);
assert.equal(field('loan-page-next').disabled, true);
field('filter-counterparty').value = 'ALL';
field('filter-search').value = '';
run('loanPage = 3; renderTradesTable(); openCloseLoan(21);');
assert.equal(field('close-loan-dialog').open, true);
(async () => {
  failSave = true;
  await assert.rejects(run('confirmCloseLoan()'), /Save failed/);
  assert.equal(field('close-loan-dialog').open, true);
  assert.equal(field('confirm-close-loan').disabled, false);
  failSave = false;
  await run('confirmCloseLoan()');
  assert.equal(stored.find(item => item.id === 21).status, 'CLOSED');
  assert.ok(stored.find(item => item.id === 21).closedAt);
  assert.equal(run('archivedTrades.length'), 1);
  assert.equal(run('trades.length'), 20);
  assert.match(field('loan-page-summary').textContent, /Page 2 of 2/);
  assert.equal(field('close-loan-dialog').open, false);
  assert.equal(field('nav-loan-count').innerText, 20, 'Loans count reflects the Open view');
  field('filter-status').value = 'CLOSED';
  run('controlHandlers["filter-trades"]();');
  assert.equal(field('trades-tbody').children.length, 1, 'Closed uses the same loan table');
  assert.equal(field('trades-tbody').children[0].dataset.tradeId, '21');
  assert.match(field('trades-tbody').children[0].innerHTML, /loan-status-archived">Closed/);
  assert.ok(!field('trades-tbody').children[0].innerHTML.includes('data-on-click="close-loan"'), 'closed rows cannot be closed again');
  assert.match(field('trades-tbody').children[0].innerHTML, /loan-exposure">€ 0,00/);
  assert.equal(run('loanPage'), 1);
  assert.equal(field('nav-loan-count').innerText, 1, 'Loans count reflects the Closed view');
  field('filter-search').value = 'not found';
  run('filterTrades();');
  assert.match(field('trades-tbody').innerHTML, /No matching loans/);
  field('filter-search').value = '';
  field('filter-status').value = 'ALL';
  run('filterTrades();');
  assert.equal(run('filteredActiveLoans().length'), 20, 'invalid modes fall back to Open and never mix statuses');
  field('filter-status').value = 'OPEN';
  run('filterTrades();');
  assert.equal(run('filteredActiveLoans().length'), 20, 'Open returns to the active subset');
  run(`
    archivedTrades[0].sourceTicket = '<script>unsafe</script>';
    archivedTrades[0].attachments = [{id: 'file-21', name: 'ticket <original>.eml', size: 2048, type: 'message/rfc822', data: 'YWJj'}];
    loanEvents = [{action: 'RETURN', timestamp: '2026-10-07T12:00:00Z', revision: 5, changes: [{store: 'trades', id: 21}]}];
    openLoanDetails(21);
  `);
  assert.equal(field('loan-details-dialog').open, true);
  assert.equal(field('loan-details-title').textContent, 'Loan #21');
  assert.match(field('loan-details-content').innerHTML, /Closed/);
  assert.match(field('loan-details-content').innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(field('loan-details-content').innerHTML, /ticket &lt;original&gt;\.eml/);
  assert.match(field('loan-details-content').innerHTML, /2\.0 KB/);
  assert.match(field('loan-details-content').innerHTML, /Revision 5/);
  assert.ok(!field('loan-details-content').innerHTML.includes('YWJj'), 'file bytes stay out of the rendered content');
  run('controlHandlers["download-saved-file"]({dataset: {tradeId: "21", fileId: "file-21"}});');
  assert.equal(downloads[0].data, 'YWJj');
  run('controlHandlers["dismiss-loan-details"](); openLoanDetails(1);');
  assert.match(field('loan-details-content').innerHTML, /No files attached/);
  assert.match(field('loan-details-content').innerHTML, /No original ticket saved/);
  stored = stored.map(item => item.id === 21 ? structuredClone(run('archivedTrades[0]')) : item);
  run('openLoanDetails(21);');
  context.extraFiles = [{name: 'extra.pdf', size: 1024, lastModified: 1}];
  failSave = true;
  await assert.rejects(run('addDetailFiles(21, extraFiles)'), /Save failed/);
  assert.equal(stored.find(item => item.id === 21).attachments.length, 1, 'failed upload retains saved files');
  failSave = false;
  await run('addDetailFiles(21, extraFiles)');
  assert.equal(stored.find(item => item.id === 21).attachments.length, 2);
  assert.equal(stored.find(item => item.id === 21).status, 'CLOSED');
  assert.equal(stored.find(item => item.id === 21).sourceTicket, '<script>unsafe</script>');
  assert.match(field('loan-detail-file-status').textContent, /1 file added/);
  await run('addDetailFiles(21, extraFiles)');
  assert.equal(stored.find(item => item.id === 21).attachments.length, 2, 'duplicate files are skipped');
  failSave = true;
  await assert.rejects(run('removeDetailFile(21, "extra.pdf")'), /Save failed/);
  assert.equal(stored.find(item => item.id === 21).attachments.length, 2, 'failed removal retains attachments');
  failSave = false;
  await run('removeDetailFile(21, "extra.pdf")');
  assert.equal(stored.find(item => item.id === 21).attachments.length, 1);
  assert.match(field('loan-detail-file-status').textContent, /removed and saved/);
  context.largeFiles = [{name: 'large.pdf', size: 11 * 1024 * 1024}];
  await assert.rejects(run('addDetailFiles(21, largeFiles)'), /10 MB/);
  assert.equal(stored.find(item => item.id === 21).attachments.length, 1);
  context.tooManyFiles = [1, 2, 3].map(i => ({name: `large-${i}.pdf`, size: 9 * 1024 * 1024}));
  await assert.rejects(run('addDetailFiles(21, tooManyFiles)'), /25 MB/);
  assert.equal(stored.find(item => item.id === 21).attachments.length, 1, 'invalid batches are atomic');
  assert.equal(run('detailFilesBusy'), false);
  console.log('PASS: loan details, file addition/removal/downloads, limits, duplicate detection, atomic failures, archived records, pagination and closure persistence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
