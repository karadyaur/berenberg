// Run: node tests/check-loan-entry.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const elements = new Map();
const field = id => {
  if (!elements.has(id)) elements.set(id, {
    value: '', validationMessage: '', dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    setCustomValidity(message) { this.validationMessage = message; }
  });
  return elements.get(id);
};
field('loan-details-form').reportValidity = () =>
  [...elements.values()].every(element => !element.validationMessage);
const batches = [];
const alerts = [];
const context = vm.createContext({
  document: { getElementById: field, addEventListener() {} },
  window: { addEventListener() {} },
  Intl, Date, Math, console, AbortController, setTimeout, clearTimeout, structuredClone,
  LoanAttachments: { maxTotalSize: 25 * 1024 * 1024, prepare: async file => ({ attachment: { id: file.name, name: file.name, size: file.size, lastModified: file.lastModified, data: 'YWJj' }, text: 'ID:777 | ISIN:GB0002634946 | Shares:999 |' }) },
  fetch: async () => ({ ok: true, json: async () => ({ isin: 'GB0002634946', type: 'MEQU', quality: 'NOAP', asOf: '2026-10-07T12:00:00Z', message: 'Online suggestion.', sources: [] }) }),
  alert: message => alerts.push(message),
  LendingDB: { batch: async (operations, action) => { batches.push({ operations, action }); } }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'), context);
vm.runInContext(`
  persistDatabase = async operation => { await operation; };
  closeTicketModal = () => {};
  switchTab = () => {};
`, context);
const run = code => vm.runInContext(code, context);

(async () => {
  field('ticket-input').value = 'ID:2633 | Lender:BNP | Shares:8800 | ISIN:GB0002634946 | Stock Name:BAE SYSTEMS | Commission:0,35 | Price:23,916467 | Currency:EUR | Date:31.07.2026 | Value Date:03.08.2026 |';
  run('parseTicket()');
  assert.equal(field('form-trade-date').value, '2026-07-31');
  assert.equal(field('form-value-date').value, '2026-08-03');
  assert.equal(field('form-price').value, 23.916467, 'parsing must preserve price precision');
  Object.entries({
    'mo-id': '77777', counterparty: 'UBS', isin: 'fr0000120271',
    'stock-name': 'Updated security', shares: '1250', price: '74.381234',
    currency: 'usd', comm: '0,75', 'trade-date': '2026-10-07', 'value-date': '2026-10-09'
  }).forEach(([id, value]) => { field(`form-${id}`).value = value; });
  run("loanAttachments = [{ id: 'file-1', name: 'ticket.eml', size: 3, type: 'message/rfc822', data: 'YWJj' }]");
  await run('executeWpsBooking()');
  const saved = batches[0].operations[0].record;
  assert.equal(saved.attachments[0].data, 'YWJj', 'original file bytes are saved with the loan');
  assert.equal(saved.attachments[0].name, 'ticket.eml');
  assert.equal(saved.sftrReference, null, 'lookup result for the previous ISIN cannot be saved with the edited instrument');
  assert.equal(saved.id, 77777);
  assert.equal(saved.counterparty, 'UBS');
  assert.equal(saved.isin, 'FR0000120271');
  assert.equal(saved.stockName, 'Updated security');
  assert.equal(saved.shares, 1250);
  assert.equal(saved.priceOpen, 74.381234);
  assert.equal(saved.currency, 'USD');
  assert.equal(saved.commission, '0.75');
  assert.equal(saved.tradeDate, '2026-10-07');
  assert.equal(saved.valueDate, '2026-10-09');
  assert.equal(saved.status, 'OPEN');
  assert.equal(batches[0].operations[1].record.isin, saved.isin, 'new quote uses the reviewed ISIN');
  assert.equal(batches[0].operations[1].record.price, saved.priceOpen);
  assert.match(alerts.at(-1), /UBS/);

  run('trades = [{ id: 77777 }]');
  await run('executeWpsBooking()');
  assert.equal(batches.length, 1, 'duplicate check uses the edited MO ID');
  assert.match(alerts.at(-1), /already been saved/);
  run('trades = []');
  field('form-comm').value = '-1';
  await run('executeWpsBooking()');
  assert.equal(batches.length, 1, 'invalid commission cannot be saved');
  field('form-comm').value = '0';
  field('form-shares').value = '1.5';
  await run('executeWpsBooking()');
  assert.equal(batches.length, 1, 'fractional shares cannot be saved');
  field('form-shares').value = '200';
  run("archivedTrades = [{ id: 77777, status: 'CANCELLED' }]");
  await run('executeWpsBooking()');
  assert.equal(batches.length, 2);
  assert.equal(batches[1].action, 'REBOOK_AFTER_CANCEL');
  assert.equal(batches[1].operations[0].type, 'update');
  assert.equal(batches[1].operations[0].record.shares, 200);
  assert.equal(batches[1].operations[0].record.commission, '0');
  assert.equal(saved.sftrTypeQuality, '', 'SFTR stays empty until the separate tool is connected');
  const existingShares = field('form-shares').value;
  await run("attachLoanFiles([{ name: 'second.eml', size: 3, lastModified: 2 }])");
  assert.equal(field('attachment-feedback').dataset.state, 'success');
  assert.match(field('attachment-list').innerHTML, /Uploaded/);
  assert.equal(field('choose-loan-files-btn').textContent, 'Add more files');
  await run("attachLoanFiles([{ name: 'third.eml', size: 4, lastModified: 3 }, { name: 'fourth.pdf', size: 5, lastModified: 4 }])");
  assert.equal(run('loanAttachments.length'), 4, 'later batches append to existing attachments');
  assert.equal(field('form-shares').value, existingShares, 'additional emails retain reviewed loan values');
  assert.equal(field('attachment-list').attributes['aria-busy'], 'false');
  await run("attachLoanFiles([{ name: 'third.eml', size: 4, lastModified: 3 }])");
  assert.equal(run('loanAttachments.length'), 4, 'repeated files are not duplicated');
  console.log('PASS: loan editing, persistence, reference placeholders, upload feedback, multiple batches and retention of reviewed values.');
})().catch(error => { console.error(error); process.exitCode = 1; });
