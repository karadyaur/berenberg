const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const byId = id => document.getElementById(id);
const formatAmount = (value, fractionDigits = 2) => value.toLocaleString('de-DE', {
  minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits
});
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
});
function formatDate(value) {
  const text = String(value || '');
  const european = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!european && !iso) return text;
  const [, year, month, day] = iso || [null, european[3], european[2], european[1]];
  return dateFormatter.format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}
// Translate built-in labels from existing databases without changing stored records.
function displaySecurityName(value) {
  const labels = {
    'Aktie / Anleihe': 'Equity / Bond',
    'Namens-Aktien o.N.': 'Registered shares without par value',
    'Aandelen op naam EO': 'Registered shares in EUR'
  };
  return Object.hasOwn(labels, value) ? labels[value] : String(value).replace(/^DEMO Wertpapier (\d+)$/, 'DEMO Security $1');
}
const loanExposure = trade => trade.shares * getCurrentLoanPrice(trade.isin, trade.priceOpen) * 1.05;
const loanStatusLabel = trade => trade.status === 'OPEN' ? 'Open' : 'Closed';
// The entered rate is annual; daily commission uses the opening value and a 365-day year.
function dailyLoanCommission(trade) {
  const rate = Number(String(trade.commission ?? '').trim().replace(',', '.'));
  if (trade.commission == null || String(trade.commission).trim() === '' || !Number.isFinite(rate) || rate < 0) return null;
  return trade.shares * trade.priceOpen * rate / 100 / 365;
}
const commissionDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
});
function commissionDay(value) {
  if (!value) return null;
  const text = String(value);
  const european = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year, month, day;
  if (european || iso) {
    [, year, month, day] = iso || [null, european[3], european[2], european[1]];
  } else {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = Object.fromEntries(commissionDateFormatter.formatToParts(date).map(part => [part.type, part.value]));
    ({ year, month, day } = parts);
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return date.getTime() / 86400000;
}
// Include today's calendar day for open loans; exclude the return date for closed loans.
function accruedLoanCommission(trade, now = new Date()) {
  const start = commissionDay(trade.valueDate || trade.tradeDate);
  const today = commissionDay(now);
  const end = trade.status === 'OPEN' ? today + 1 : commissionDay(trade.closedAt);
  if (start === null || today === null || end === null || dailyLoanCommission(trade) === null) return null;
  if (trade.status === 'CANCELLED') return { amount: 0, days: 0 };
  const days = Math.max(0, Math.min(end, today + 1) - start);
  const finish = start + days;
  const history = loanEvents.slice().sort((a, b) => a.revision - b.revision);
  let returns = [];
  for (const event of history) {
    for (const change of event.changes || []) {
      if (change.store !== 'trades' || change.id !== trade.id || !change.after) continue;
      // Rebooking a cancelled MO ID starts a new accrual period.
      if (!change.before || (change.before.status === 'CANCELLED' && change.after.status === 'OPEN')) returns = [];
      if (event.action === 'PARTIAL_RETURN' && change.before) {
        const day = commissionDay(event.timestamp);
        if (day !== null) returns.push({ day, before: change.before.shares, after: change.after.shares });
      }
    }
  }
  let quantity = returns.length ? returns[0].before : trade.shares;
  let cursor = start, amount = 0;
  for (const change of returns) {
    if (change.day >= finish) break;
    const boundary = Math.max(start, change.day);
    amount += (boundary - cursor) * dailyLoanCommission({ ...trade, shares: quantity });
    quantity = change.after;
    cursor = boundary;
  }
  amount += (finish - cursor) * dailyLoanCommission({ ...trade, shares: quantity });
  return { amount, days };
}
function commissionTotalHTML(trade) {
  const total = accruedLoanCommission(trade);
  return total === null ? '—' : `${escapeHTML(trade.currency)} ${formatAmount(total.amount)}<span class="loan-commission-rate">${total.days} days</span>`;
}

// Loaded from the automatically opened IndexedDB.
let counterparties = {};
let marketPrices = {};
let trades = [];

let currentParsedData = null;
let selectedTradeId = null;
let pendingMarginCall = null;
let loanPage = 1;
let loanPageSize = 10;
let loanSort = { key: null, direction: 'ascending' };
let selectedCloseLoanId = null;
let loanEvents = [];
let selectedDetailLoanId = null;
let detailFilesBusy = false;

let loanAttachments = [];
let attachmentGeneration = 0;
let fileImports = 0;
let fileImportQueue = Promise.resolve();

function setAttachmentFeedback(state, message) {
  byId('attachment-feedback').dataset.state = state;
  byId('attachment-status').textContent = message;
  byId('attachment-list').setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
}

function renderLoanAttachments(newIds = []) {
  byId('attachment-count').textContent = `${loanAttachments.length} files`;
  byId('choose-loan-files-btn').textContent = loanAttachments.length ? 'Add more files' : 'Choose files';
  byId('attachment-list').innerHTML = loanAttachments.map((file, index) => `
    <li class="attachment-row ${newIds.includes(file.id) ? 'attachment-row-new' : ''} p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs" style="--file-index: ${Math.min(index, 5)}">
      <span class="attachment-file-icon" aria-hidden="true"><i class="fas ${/\.(eml|msg)$/i.test(file.name) ? 'fa-envelope' : 'fa-file'}"></i></span>
      <span class="attachment-name"><strong>${escapeHTML(file.name)}</strong><br><span class="text-slate-500">${(file.size / 1024).toFixed(1)} KB</span></span>
      <span class="attachment-loaded"><i class="fas fa-check" aria-hidden="true"></i> Uploaded</span>
      <button type="button" data-on-click="download-draft-file" data-file-id="${file.id}">Download</button>
      <button type="button" class="attachment-remove" data-on-click="remove-loan-file" data-file-id="${file.id}" aria-label="Remove ${escapeHTML(file.name)}">Remove</button>
    </li>`).join('');
}

function attachLoanFiles(files) {
  const generation = attachmentGeneration;
  const batch = Array.from(files);
  if (!batch.length) return Promise.resolve();
  fileImports++;
  const job = fileImportQueue.then(async () => {
    if (generation !== attachmentGeneration) return;
    setAttachmentFeedback('loading', `Loading ${batch.length} ${batch.length === 1 ? 'file' : 'files'} …`);
    const texts = [], errors = [], addedIds = [];
    for (const [index, file] of batch.entries()) {
      if (generation !== attachmentGeneration) return;
      if (loanAttachments.some(saved => saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified)) continue;
      if (loanAttachments.reduce((total, saved) => total + saved.size, 0) + file.size > LoanAttachments.maxTotalSize) {
        errors.push(`${file.name}: total attachments must stay below 25 MB.`);
        continue;
      }
      try {
        setAttachmentFeedback('loading', `Loading ${file.name} · ${index + 1} of ${batch.length}`);
        const prepared = await LoanAttachments.prepare(file);
        if (generation !== attachmentGeneration) return;
        loanAttachments.push(prepared.attachment);
        addedIds.push(prepared.attachment.id);
        if (prepared.text && /IS(?:IN|N)\s*:/i.test(prepared.text)) texts.push(prepared.text);
        renderLoanAttachments(addedIds);
      } catch (error) { errors.push(error.message); }
    }
    if (generation !== attachmentGeneration) return;
    if (texts.length) {
      byId('ticket-input').value = [byId('ticket-input').value, ...texts].filter(Boolean).join('\n');
      if (!currentParsedData) parseTicket();
    }
    const uploaded = `${addedIds.length} ${addedIds.length === 1 ? 'file uploaded' : 'files uploaded'}.`;
    setAttachmentFeedback(errors.length ? 'error' : 'success', errors.length
      ? `${addedIds.length ? uploaded + ' ' : ''}${errors.join(' ')}`
      : addedIds.length ? `${uploaded} You can add more emails or files.` : 'These files are already attached. You can add more files.');
  }).finally(() => { fileImports--; });
  fileImportQueue = job.catch(() => {});
  return job;
}

function attachmentLinks(trade) {
  if (!trade.attachments?.length) return '';
  return `<details class="saved-attachments"><summary>${trade.attachments.length} attachments</summary>${trade.attachments.map(file =>
    `<button type="button" data-on-click="download-saved-file" data-trade-id="${trade.id}" data-file-id="${escapeHTML(file.id)}">${escapeHTML(file.name)}</button>`
  ).join('')}</details>`;
}

function bindLoanIngestion() {
  byId('loan-file-input').addEventListener('change', async event => {
    if (!byId('ticket-modal').open || databaseBusy) { event.target.value = ''; return; }
    try { await attachLoanFiles(event.target.files); }
    catch (error) { setAttachmentFeedback('error', error.message); }
    finally { event.target.value = ''; }
  });
  const modal = byId('ticket-modal');
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  const insideModal = event => modal.open && event.target !== modal && modal.contains(event.target);
  let dragDepth = 0;
  const clearDrag = () => { dragDepth = 0; modal.classList.remove('is-file-dragging'); };
  modal.addEventListener('dragenter', event => {
    if (!hasFiles(event) || !insideModal(event)) return;
    event.preventDefault();
    dragDepth++;
    modal.classList.add('is-file-dragging');
  });
  modal.addEventListener('dragover', event => {
    if (!hasFiles(event) || !insideModal(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  modal.addEventListener('dragleave', event => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) clearDrag();
  });
  modal.addEventListener('drop', async event => {
    if (!hasFiles(event) || !insideModal(event)) return;
    event.preventDefault();
    clearDrag();
    if (!databaseReady || databaseBusy) { alert('Please wait while the database is opening or saving, then drop your files again.'); return; }
    try { await attachLoanFiles(event.dataTransfer.files); }
    catch (error) { setAttachmentFeedback('error', error.message); }
  });
  modal.addEventListener('dragend', clearDrag);
  modal.addEventListener('close', clearDrag);
}

// TAB NAVIGATION
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('border-blue-500', 'text-white', 'bg-slate-800/80');
    btn.classList.add('border-transparent', 'text-slate-300');
  });

  byId(`tab-${tabId}`).classList.remove('hidden');
  const activeBtn = byId(`tab-btn-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add('border-blue-500', 'text-white', 'bg-slate-800/80');
    activeBtn.classList.remove('border-transparent', 'text-slate-300');
  }

  if (tabId === 'active-loans') renderTradesTable();
  if (tabId === 'collateral') renderCollateralMatrix();
}

// PARSE TICKET
function parseTicket() {
  const text = byId('ticket-input').value;
  if (!text.trim()) {
    alert("Please paste the ticket text.");
    return;
  }

  function extractField(keys) {
    for (let key of keys) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|[|\\n])\\s*${escapedKey}\\s*:\\s*([^|\\n]+)`, 'i');
      const match = text.match(regex);
      if (match && match[1]) return match[1].trim();
    }
    return "";
  }

  const id = extractField(["ID"]) || ("26" + Math.floor(10 + Math.random()*80));
  const trader = extractField(["Trader BEGO", "Trader"]) || "Middle Office";
  const lender = extractField(["Lender"]);
  const shares = extractField(["Shares", "Nominal"]);
  const isin = extractField(["ISN", "ISIN"]);
  const stockName = extractField(["Stock Name", "Security Name"]);
  const commission = extractField(["Commission (in %)", "Commission", "Fee"]) || "0.35";
  const price = extractField(["Price"]) || "10.00";
  const currency = extractField(["Currency"]) || "EUR";
  const date = extractField(["Date", "Trade Date"]) || "28.09.2026";
  const valueDate = extractField(["Value Date"]) || date;

  const matchedCpty = Object.keys(counterparties).find(key =>
    key.toLowerCase() === lender.toLowerCase() || counterparties[key].fullName.toLowerCase() === lender.toLowerCase()
  ) || Object.keys(counterparties)[0] || 'DEMO-1';

  const numericPrice = parseFloat(price.replace(',', '.')) || 10.0;
  const numericShares = parseInt(shares.replace(/\./g, '')) || 1000;

  currentParsedData = {
    id: parseInt(id),
    trader,
    counterparty: matchedCpty,
    isin,
    stockName: stockName || "Equity / Bond",
    shares: numericShares,
    priceOpen: numericPrice,
    currency,
    commission,
    tradeDate: date,
    valueDate,
    uti: "DEMO-UTI-" + Math.floor(1000000000 + Math.random() * 9000000000),
    wpsOrder: "220" + Math.floor(1000000 + Math.random() * 9000000)
  };

  // Populate Form
  byId('form-mo-id').setCustomValidity('');
  byId('form-stock-name').setCustomValidity('');
  byId('form-mo-id').value = currentParsedData.id;
  byId('form-counterparty').value = currentParsedData.counterparty;
  byId('form-isin').value = currentParsedData.isin;
  byId('form-stock-name').value = displaySecurityName(currentParsedData.stockName);
  byId('form-shares').setCustomValidity('');
  byId('form-shares').value = currentParsedData.shares;
  byId('form-price').value = currentParsedData.priceOpen;
  byId('form-currency').value = currentParsedData.currency;
  byId('form-comm').value = currentParsedData.commission;
  byId('form-comm').setCustomValidity('');
  byId('form-trade-date').value = ticketDateToISO(currentParsedData.tradeDate);
  byId('form-value-date').value = ticketDateToISO(currentParsedData.valueDate);

  byId('enrichment-status').className = "bg-emerald-100 text-emerald-800 text-xs font-bold px-2.5 py-1 rounded-full border border-emerald-200";
  byId('enrichment-status').innerText = "Ready to book";

  const bookBtn = byId('book-btn');
  bookBtn.disabled = false;
  bookBtn.className = "px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-md shadow-blue-600/20 flex items-center gap-1.5 cursor-pointer";
}

function ticketDateToISO(value) {
  return value.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
}

// Validate and save the reviewed values, including changes made after parsing.
function readLoanDetails() {
  const commissionInput = byId('form-comm');
  const commissionText = commissionInput.value.trim().replace(',', '.');
  const commission = Number(commissionText);
  commissionInput.setCustomValidity(commissionText && Number.isFinite(commission) && commission >= 0
    ? '' : 'Enter a non-negative commission percentage.');
  const idInput = byId('form-mo-id');
  const id = Number(idInput.value);
  idInput.setCustomValidity(Number.isSafeInteger(id) && id > 0 ? '' : 'Enter a positive MO ID.');
  const nameInput = byId('form-stock-name');
  nameInput.setCustomValidity(nameInput.value.trim() ? '' : 'Enter a security name.');
  const sharesInput = byId('form-shares');
  const shares = Number(sharesInput.value);
  sharesInput.setCustomValidity(Number.isSafeInteger(shares) && shares > 0 ? '' : 'Enter a positive whole number of shares.');
  if (!byId('loan-details-form').reportValidity()) return null;
  return {
    ...currentParsedData,
    id,
    counterparty: byId('form-counterparty').value,
    isin: byId('form-isin').value.trim().toUpperCase(),
    stockName: nameInput.value.trim(),
    shares,
    priceOpen: Number(byId('form-price').value),
    currency: byId('form-currency').value.trim().toUpperCase(),
    commission: String(commission),
    tradeDate: byId('form-trade-date').value,
    valueDate: byId('form-value-date').value
  };
}

// ADD REVIEWED LOAN
async function executeWpsBooking() {
  if (!currentParsedData) return;
  if (fileImports) { alert('Please wait until the attachments finish loading.'); return; }

  const reviewedData = readLoanDetails();
  if (!reviewedData) return;

  const activeDuplicate = trades.some(trade => trade.id === reviewedData.id);
  const archivedMatch = archivedTrades.find(trade => trade.id === reviewedData.id);
  if (activeDuplicate || (archivedMatch && archivedMatch.status !== 'CANCELLED')) {
    alert('A loan with this MO ID has already been saved.');
    return;
  }

  const trade = {
    ...reviewedData,
    sourceTicket: byId('ticket-input').value,
    attachments: structuredClone(loanAttachments),
    sftrTypeQuality: '',
    sftrReference: null,
    status: 'OPEN'
  };
  const operations = archivedMatch
    ? [{ type: 'update', store: 'trades', id: trade.id, record: { ...trade, closedAt: null } }]
    : [{ type: 'create', store: 'trades', record: trade }];
  if (!marketPrices[trade.isin]) {
    operations.push({ type: 'create', store: 'prices', record: {
      isin: trade.isin, price: trade.priceOpen, currency: trade.currency,
      name: trade.stockName, date: trade.tradeDate
    } });
  }
  await persistDatabase(LendingDB.batch(operations, archivedMatch ? 'REBOOK_AFTER_CANCEL' : 'BOOK_TRADE'));

  alert(`✅ SUCCESSFULLY BOOKED IN WPS!\n\n1. Opening entry: Demo securities account (DTB: O${Math.round(trade.priceOpen * 100)}001)\n2. Counterparty: ${trade.counterparty}\n3. Delivery account statement: Order no. ${trade.wpsOrder}\n4. Exposure & collateral have been updated immediately!`);

  closeTicketModal();
  switchTab('active-loans');
}

function clearIngestionForm() {
  attachmentGeneration++;
  loanAttachments = [];
  renderLoanAttachments();
  byId('loan-file-input').value = '';
  setAttachmentFeedback('idle', 'Attached files are saved with the loan.');
  byId('ticket-input').value = "";
  ['mo-id', 'isin', 'stock-name', 'shares', 'price', 'currency', 'comm', 'trade-date', 'value-date'].forEach(id => {
    const el = byId(`form-${id}`);
    if (el) { el.value = ""; el.setCustomValidity(''); }
  });
  byId('enrichment-status').className = "bg-slate-100 text-slate-600 text-xs font-bold px-2.5 py-1 rounded-full border border-slate-200";
  byId('enrichment-status').innerText = "No data";
  byId('ftt-badge').className = "bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded";
  byId('ftt-badge').innerText = "Demo";
  byId('form-counterparty').value = Object.keys(counterparties)[0] || 'DEMO-1';
  byId('ftt-desc').textContent = 'Demo only. In the future, this check will connect to an external application.';

  const bookBtn = byId('book-btn');
  bookBtn.disabled = true;
  bookBtn.className = "px-6 py-2 bg-slate-300 text-slate-500 rounded-lg text-xs font-bold shadow flex items-center gap-1.5 cursor-not-allowed";
  currentParsedData = null;
}

// GET EFFECTIVE LOAN PRICE
function getCurrentLoanPrice(isin, fallbackPrice) {
  const quote = marketPrices[isin];
  if (!quote) return fallbackPrice;
  return quote.currency === 'USD' ? quote.price * (quote.fxRate || 0.92) : quote.price;
}

// RENDER ACTIVE TRADES TABLE
const loanSortValues = {
  id: trade => [trade.id],
  counterparty: trade => [trade.counterparty],
  security: trade => [trade.isin, displaySecurityName(trade.stockName)],
  quantity: trade => [trade.shares],
  opening: trade => [trade.priceOpen],
  commission: trade => [dailyLoanCommission(trade) === null ? null : trade.status === 'OPEN' ? dailyLoanCommission(trade) : 0],
  commissionTotal: trade => [accruedLoanCommission(trade)?.amount ?? null],
  current: trade => [getCurrentLoanPrice(trade.isin, trade.priceOpen)],
  exposure: trade => [trade.status === 'OPEN' ? loanExposure(trade) : 0],
  dates: trade => [commissionDay(trade.tradeDate), commissionDay(trade.valueDate || trade.tradeDate)],
  status: trade => [loanStatusLabel(trade)]
};
const loanSortCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function sortedActiveLoans(data) {
  const valueFor = loanSortValues[loanSort.key];
  if (!valueFor) return data;
  const direction = loanSort.direction === 'descending' ? -1 : 1;
  // Calculate commission/exposure only once per loan, before pagination.
  return data.map(trade => ({ trade, values: valueFor(trade) })).sort((a, b) => {
    for (let index = 0; index < a.values.length; index++) {
      const left = a.values[index], right = b.values[index];
      const missingLeft = left == null || (typeof left === 'number' && !Number.isFinite(left));
      const missingRight = right == null || (typeof right === 'number' && !Number.isFinite(right));
      if (missingLeft || missingRight) {
        if (missingLeft !== missingRight) return missingLeft ? 1 : -1;
        continue;
      }
      const comparison = typeof left === 'number' && typeof right === 'number'
        ? left - right : loanSortCollator.compare(String(left), String(right));
      if (comparison) return comparison * direction;
    }
    return a.trade.id - b.trade.id;
  }).map(row => row.trade);
}
function updateLoanSortHeaders() {
  const header = byId('loan-table-head');
  if (!header) return;
  for (const button of header.querySelectorAll('[data-sort-column]')) {
    const selected = button.dataset.sortColumn === loanSort.key;
    button.closest('th').setAttribute('aria-sort', selected ? loanSort.direction : 'none');
    button.querySelector('.loan-sort-indicator').textContent = selected
      ? loanSort.direction === 'ascending' ? '↑' : '↓' : '↕';
  }
}
function sortLoans(key) {
  if (!Object.hasOwn(loanSortValues, key)) return;
  loanSort = { key, direction: loanSort.key === key && loanSort.direction === 'ascending' ? 'descending' : 'ascending' };
  loanPage = 1;
  renderTradesTable();
}
function loansInSelectedView() {
  return byId('filter-status').value === 'CLOSED' ? archivedTrades : trades;
}
function filteredActiveLoans() {
  const cp = byId('filter-counterparty').value || 'ALL';
  const query = byId('filter-search').value.trim().toLowerCase();
  return loansInSelectedView().filter(trade =>
    (cp === 'ALL' || trade.counterparty.includes(cp)) &&
    (!query || `${trade.id} ${trade.isin} ${displaySecurityName(trade.stockName)}`.toLowerCase().includes(query))
  );
}

function renderTradesTable(data = filteredActiveLoans()) {
  data = sortedActiveLoans(data);
  updateLoanSortHeaders();
  const tbody = byId('trades-tbody');
  tbody.innerHTML = "";
  const pages = Math.max(1, Math.ceil(data.length / loanPageSize));
  loanPage = Math.min(Math.max(1, loanPage), pages);
  const start = (loanPage - 1) * loanPageSize;
  const visible = data.slice(start, start + loanPageSize);
  const totalLoans = loansInSelectedView().length;
  const viewLabel = byId('filter-status').value === 'CLOSED' ? 'closed' : 'open';
  byId('trade-count-badge').innerText = `${data.length} of ${totalLoans} ${viewLabel} loans`;
  byId('loan-page-summary').textContent = data.length
    ? `${start + 1}–${start + visible.length} of ${data.length} · Page ${loanPage} of ${pages}`
    : '0 loans';
  byId('loan-page-prev').disabled = loanPage <= 1;
  byId('loan-page-next').disabled = loanPage >= pages;
  if (!visible.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="loan-empty"><strong>${totalLoans ? 'No matching loans' : 'No loans'}</strong><p>${totalLoans ? 'Try another search, status or counterparty.' : 'Add a loan to get started.'}</p></td></tr>`;
  }
  byId('nav-loan-count').innerText = totalLoans;

  visible.forEach(t => {
    const currentP = getCurrentLoanPrice(t.isin, t.priceOpen);
    // Matches the exposure file: Quantity * CurrentPrice * 1.05
    const exposure = t.status === 'OPEN' ? loanExposure(t) : 0;
    const dailyCommission = dailyLoanCommission(t) === null ? null : t.status === 'OPEN' ? dailyLoanCommission(t) : 0;
    const statusLabel = loanStatusLabel(t);

    const tr = document.createElement('tr');
    tr.className = "loan-clickable-row hover:bg-blue-50/40 transition-colors";
    tr.dataset.onClick = 'view-loan';
    tr.dataset.tradeId = String(t.id);
    tr.innerHTML = `
      <td data-label="MO ID" class="loan-id"><button type="button" data-on-click="view-loan" data-trade-id="${t.id}" class="loan-detail-link" aria-label="View loan ${t.id}">#${t.id}</button>${attachmentLinks(t)}</td>
      <td data-label="Counterparty" class="loan-counterparty">${escapeHTML(t.counterparty)}</td>
      <td data-label="Security" class="loan-security">
        <span class="loan-security-name">${escapeHTML(displaySecurityName(t.stockName))}</span>
        <span class="loan-isin">${escapeHTML(t.isin)}</span>
      </td>
      <td data-label="Quantity" class="loan-number loan-quantity">${t.shares.toLocaleString('de-DE')}</td>
      <td data-label="Opening price" class="loan-number">${escapeHTML(t.currency)} ${formatAmount(t.priceOpen)}</td>
      <td data-label="Commission / day" class="loan-number" title="Quantity × opening price × annual rate / 100 / 365">${dailyCommission === null ? '—' : `${escapeHTML(t.currency)} ${formatAmount(dailyCommission)}<span class="loan-commission-rate">${escapeHTML(t.commission)}% p.a.</span>`}</td>
      <td data-label="Total commission" class="loan-number" title="From value date through today, including weekends; opening price, 365-day basis">${commissionTotalHTML(t)}</td>
      <td data-label="Current price (PHX)" class="loan-number">€ ${formatAmount(currentP)}</td>
      <td data-label="Exposure (+5%)" class="loan-number loan-exposure">€ ${formatAmount(exposure)}</td>
      <td data-label="Trade / Value date" class="loan-dates"><span>${escapeHTML(formatDate(t.tradeDate))}</span><span class="loan-value-date">Value ${escapeHTML(formatDate(t.valueDate || t.tradeDate))}</span></td>
      <td data-label="Status"><span class="loan-status${t.status === 'OPEN' ? '' : ' loan-status-archived'}">${statusLabel}</span>${t.closedAt ? `<span class="loan-value-date">${escapeHTML(formatLoanTimestamp(t.closedAt))}</span>` : ''}</td>
      <td class="loan-action">
        ${t.status === 'OPEN' ? `<button type="button" data-on-click="close-loan" data-trade-id="${t.id}" class="loan-close-button" aria-label="Close loan ${t.id}">
          <i class="fas fa-check" aria-hidden="true"></i> Close loan
        </button>` : '<span aria-label="Loan is no longer open">—</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });

  window.LoanLayout?.apply();
  renderCollateralMatrix();
}

function filterTrades() {
  loanPage = 1;
  renderTradesTable();
}

function loanDetailFields(fields) {
  return `<dl class="loan-detail-fields">${fields.map(([label, value]) =>
    `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value === undefined || value === null || value === '' ? 'Not available' : value)}</dd></div>`
  ).join('')}</dl>`;
}

function formatLoanTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-GB');
}

function openLoanDetails(tradeId, preserveScroll = false) {
  const trade = [...trades, ...archivedTrades].find(item => item.id === tradeId);
  if (!trade) return;
  const content = byId('loan-details-content');
  const scrollPosition = preserveScroll ? content.scrollTop : 0;
  selectedDetailLoanId = tradeId;
  if (!preserveScroll) byId('loan-detail-file-status').textContent = '';
  const party = counterparties[trade.counterparty] || {};
  const quote = marketPrices[trade.isin];
  const files = trade.attachments || [];
  byId('loan-details-title').textContent = `Loan #${trade.id}`;
  byId('loan-details-subtitle').textContent = `${displaySecurityName(trade.stockName)} · ${trade.counterparty} · ${loanStatusLabel(trade)}`;
  const section = (heading, content) => `<section class="loan-detail-section"><h3>${heading}</h3>${content}</section>`;
  const history = loanEvents.filter(event => event.changes?.some(change => change.store === 'trades' && change.id === trade.id));
  const totalCommission = accruedLoanCommission(trade);
  byId('loan-details-content').innerHTML =
    section('Loan details', loanDetailFields([
      ['MO ID', trade.id], ['Status', loanStatusLabel(trade)], ['Security', displaySecurityName(trade.stockName)],
      ['ISIN', trade.isin], ['Quantity', trade.shares.toLocaleString('de-DE')], ['Currency', trade.currency],
      ['Opening price', `${trade.currency} ${formatAmount(trade.priceOpen)}`], ['Commission (% p.a.)', trade.commission],
      ['Commission / day (opening value, 365 days)', dailyLoanCommission(trade) === null ? null : `${trade.currency} ${formatAmount(dailyLoanCommission(trade))}`],
      ['Total commission', totalCommission === null ? null : `${trade.currency} ${formatAmount(totalCommission.amount)} · ${totalCommission.days} days`],
      ['Commission period', 'From value date, including today and weekends; return date excluded. 365-day basis.'],
      ['Trade date', formatDate(trade.tradeDate)], ['Value date', formatDate(trade.valueDate)],
      ['Trader', trade.trader], ['Closed at', formatLoanTimestamp(trade.closedAt)]
    ])) +
    section('Counterparty & references', loanDetailFields([
      ['Counterparty', trade.counterparty], ['Full name', party.fullName], ['Email', party.email],
      ['Type', party.type], ['UTI', trade.uti], ['WPS order', trade.wpsOrder],
      ['WPS reference data', 'A separate tool will be connected.'],
      ['SFTR type / quality', trade.sftrTypeQuality || 'A separate tool will be connected.']
    ]) + (trade.sftrReference ? `<details class="loan-reference-record"><summary>Saved SFTR reference details</summary><pre>${escapeHTML(JSON.stringify(trade.sftrReference, null, 2))}</pre></details>` : '')) +
    section('Market & exposure', loanDetailFields([
      ['Current price (EUR)', `€ ${formatAmount(getCurrentLoanPrice(trade.isin, trade.priceOpen))}`],
      ['Price source', quote ? 'Stored PHX quote' : 'Opening price (no PHX quote)'],
      ['Quote date', quote ? formatDate(quote.date) : null], ['Quote currency', quote?.currency],
      ['FX rate', quote?.fxRate], ['Exposure (+5%)', trade.status === 'OPEN' ? `€ ${formatAmount(loanExposure(trade))}` : '€ 0,00 (closed)']
    ])) +
    section(`Files (${files.length})`, `<div class="loan-files-toolbar"><button type="button" id="loan-detail-add-files" data-on-click="choose-detail-files"${detailFilesBusy ? ' disabled' : ''}><i class="fas fa-plus" aria-hidden="true"></i> Add files</button><p>Up to 10 MB per file · 25 MB per loan. Changes are saved immediately.</p></div>` + (files.length ? `<ul class="loan-detail-files">${files.map(file => {
      const size = Number.isFinite(file.size) ? file.size < 1024 ? `${file.size} B` : file.size < 1048576 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1048576).toFixed(1)} MB` : 'Unknown size';
      return `<li><div><strong>${escapeHTML(file.name)}</strong><span>${escapeHTML(size)} · ${escapeHTML(file.type || 'Unknown file type')}</span>${file.lastModified ? `<span>Modified ${escapeHTML(formatLoanTimestamp(file.lastModified))}</span>` : ''}</div><button type="button" data-on-click="download-saved-file" data-trade-id="${trade.id}" data-file-id="${escapeHTML(file.id)}" aria-label="Download ${escapeHTML(file.name)}"><i class="fas fa-download" aria-hidden="true"></i> Download</button><button type="button" data-on-click="remove-detail-file" data-trade-id="${trade.id}" data-file-id="${escapeHTML(file.id)}" class="loan-file-remove" aria-label="Remove ${escapeHTML(file.name)}"${detailFilesBusy ? ' disabled' : ''}><i class="fas fa-trash" aria-hidden="true"></i> Remove</button></li>`;
    }).join('')}</ul>` : '<p class="loan-detail-empty">No files attached to this loan.</p>')) +
    section('Original ticket', trade.sourceTicket ? `<pre class="loan-source-ticket">${escapeHTML(trade.sourceTicket)}</pre>` : '<p class="loan-detail-empty">No original ticket saved.</p>') +
    section('Activity', history.length ? `<ol class="loan-detail-history">${history.slice().reverse().map(event => `<li><strong>${escapeHTML(event.action.replaceAll('_', ' '))}</strong><span>${escapeHTML(formatLoanTimestamp(event.timestamp))} · Revision ${escapeHTML(event.revision)}</span></li>`).join('')}</ol>` : '<p class="loan-detail-empty">No saved activity for this loan.</p>');
  if (!byId('loan-details-dialog').open) byId('loan-details-dialog').showModal();
  content.scrollTop = scrollPosition;
}

function setDetailFilesBusy(busy) {
  detailFilesBusy = busy;
  byId('loan-details-content').querySelectorAll('[data-on-click="choose-detail-files"], [data-on-click="remove-detail-file"]').forEach(button => {
    button.disabled = busy;
  });
  byId('loan-detail-file-status').setAttribute('aria-busy', String(busy));
}

function refreshLoanDetails(tradeId) {
  if (byId('loan-details-dialog').open && selectedDetailLoanId === tradeId) openLoanDetails(tradeId, true);
}

async function addDetailFiles(tradeId, files) {
  const trade = [...trades, ...archivedTrades].find(item => item.id === tradeId);
  if (!trade || !files.length) return;
  const attachments = structuredClone(trade.attachments || []);
  let added = 0;
  setDetailFilesBusy(true);
  byId('loan-detail-file-status').textContent = 'Loading files…';
  try {
    for (const file of Array.from(files)) {
      if (attachments.some(saved => saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified)) continue;
      if (attachments.reduce((sum, saved) => sum + saved.size, 0) + file.size > LoanAttachments.maxTotalSize) {
        throw new Error('Attachments must stay below 25 MB per loan. No new files were saved.');
      }
      const prepared = await LoanAttachments.prepare(file);
      attachments.push(prepared.attachment);
      added++;
    }
    if (added) {
      await persistDatabase(LendingDB.trades.update(tradeId, { attachments }, 'ADD_ATTACHMENTS'));
      refreshLoanDetails(tradeId);
    }
    byId('loan-detail-file-status').textContent = added
      ? `${added} ${added === 1 ? 'file added' : 'files added'} and saved.` : 'These files are already attached.';
  } catch (error) {
    byId('loan-detail-file-status').textContent = `Files were not saved: ${error.message}`;
    throw error;
  } finally {
    setDetailFilesBusy(false);
    byId('loan-detail-add-files').focus();
  }
}

async function removeDetailFile(tradeId, fileId) {
  const trade = [...trades, ...archivedTrades].find(item => item.id === tradeId);
  const file = trade?.attachments?.find(item => item.id === fileId);
  if (!file) return;
  setDetailFilesBusy(true);
  byId('loan-detail-file-status').textContent = `Removing ${file.name}…`;
  try {
    await persistDatabase(LendingDB.trades.update(tradeId, {
      attachments: trade.attachments.filter(item => item.id !== fileId)
    }, 'REMOVE_ATTACHMENT'));
    refreshLoanDetails(tradeId);
    byId('loan-detail-file-status').textContent = `${file.name} removed and saved.`;
  } catch (error) {
    byId('loan-detail-file-status').textContent = `File was not removed: ${error.message}`;
    throw error;
  } finally {
    setDetailFilesBusy(false);
    byId('loan-detail-add-files').focus();
  }
}

function openCloseLoan(tradeId) {
  const trade = trades.find(item => item.id === tradeId);
  if (!trade) return;
  selectedCloseLoanId = tradeId;
  byId('close-loan-details').innerHTML = `
    <dt>Loan</dt><dd>#${trade.id} · ${escapeHTML(trade.counterparty)}</dd>
    <dt>Security</dt><dd>${escapeHTML(displaySecurityName(trade.stockName))}<br>${escapeHTML(trade.isin)}</dd>
    <dt>Quantity</dt><dd>${trade.shares.toLocaleString('de-DE')}</dd>`;
  byId('close-loan-dialog').showModal();
}

async function confirmCloseLoan() {
  const trade = trades.find(item => item.id === selectedCloseLoanId);
  if (!trade) { byId('close-loan-dialog').close(); return; }
  const button = byId('confirm-close-loan');
  button.disabled = true;
  button.textContent = 'Closing…';
  try {
    await persistDatabase(LendingDB.trades.update(trade.id, {
      status: 'CLOSED', closedAt: new Date().toISOString()
    }, 'RETURN'));
    selectedCloseLoanId = null;
    byId('close-loan-dialog').close();
    renderTradesTable();
    byId('loan-page-summary').textContent += ` · Loan #${trade.id} closed.`;
    (byId('trades-tbody').querySelector('button.loan-close-button') || byId('loan-page-size')).focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Close loan';
  }
}

// RECALCULATE LIVE COLLATERAL MATRIX FROM ACTIVE TRADES (1:1 EXPOSURE FILE)
function renderCollateralMatrix() {
  const tbody = byId('collateral-matrix-tbody');
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const [cptyKey, cptyInfo] of Object.entries(counterparties)) {
    const cptyTrades = trades.filter(t => t.counterparty === cptyKey || t.counterparty.includes(cptyKey));

    // Exposure = Sum(Quantity * PHX Price * 1.05)
    const totalExposure = cptyTrades.reduce((total, trade) => total + loanExposure(trade), 0);

    const collateralHeld = cptyInfo.collateralHeld;

    // Collateral Diff = Collateral Held - Exposure (as in the exposure file)
    const diff = collateralHeld - totalExposure;
    const absDiff = Math.abs(diff);
    const needsCall = (diff < 0) && (absDiff >= cptyInfo.threshold);

    const tr = document.createElement('tr');
    tr.className = needsCall ? "bg-rose-50/70 hover:bg-rose-50" : "hover:bg-slate-50";

    tr.innerHTML = `
      <td class="p-3 font-sans font-bold text-slate-800">${escapeHTML(cptyInfo.fullName)}</td>
      <td class="p-3 font-sans text-slate-500">${escapeHTML(cptyInfo.type)}</td>
      <td class="p-3 text-right font-bold text-slate-700">${cptyTrades.length} ${cptyTrades.length === 1 ? 'loan' : 'loans'}</td>
      <td class="p-3 text-right font-bold text-slate-900">€ ${formatAmount(totalExposure)}</td>
      <td class="p-3 text-right text-slate-700">€ ${formatAmount(collateralHeld)}</td>
      <td class="p-3 text-right font-bold ${diff >= 0 ? 'text-emerald-600' : 'text-rose-600'}">
        ${diff >= 0 ? '+' : ''}€ ${formatAmount(diff)}
      </td>
      <td class="p-3 text-right text-slate-500 font-sans">€ ${formatAmount(cptyInfo.threshold)}</td>
      <td class="p-3 text-center font-sans">
        ${needsCall 
          ? `<span class="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-full border border-rose-200 animate-pulse">Margin Call Required</span>`
          : (cptyTrades.length === 0 
              ? `<span class="bg-slate-100 text-slate-500 text-[10px] px-2 py-0.5 rounded-full">No Exposure</span>`
              : `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full">Within Limit</span>`
            )
        }
      </td>
      <td class="p-3 text-right font-sans">
        ${needsCall
          ? `<button data-on-click="prepare-margin-call" data-counterparty="${escapeHTML(cptyKey)}" data-amount="${absDiff}" class="bg-rose-600 hover:bg-rose-700 text-white font-bold px-3 py-1 rounded text-xs shadow-sm flex items-center gap-1 ml-auto">
               <i class="fas fa-paper-plane"></i> Send call
             </button>`
          : `<button disabled class="bg-slate-100 text-slate-400 px-3 py-1 rounded text-xs ml-auto cursor-not-allowed">No Call</button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  }


}

// MARGIN CALL OUTLOOK INTEGRATION
function prepareMarginCall(cptyKey, amount) {
  const cpty = counterparties[cptyKey];
  if (!cpty) return;

  const roundedAmount = Math.ceil(amount / 50000) * 50000;
  const formattedAmount = formatAmount(roundedAmount);

  pendingMarginCall = {
    cptyKey,
    cptyName: cpty.fullName,
    email: cpty.email,
    subject: `Margin Call Notice - Berenberg / ${cpty.fullName} - ${new Date().toLocaleDateString('en-GB')}`,
    amount: roundedAmount,
    formattedAmount
  };

  const bodyText = `Dear Sir or Madam,\n\nUnder our securities lending master agreement, please arrange the following collateral transfer with value date ${new Date().toLocaleDateString('en-GB')}:\n\n` +
    `Counterparty: ${cpty.fullName}\n` +
    `Required Amount: EUR ${formattedAmount}\n` +
    `Collateral Type: ${cpty.type}\n` +
    `Reference Securities Account / Account: DEMO account\n\n` +
    `Please confirm the transfer as soon as possible.\n\nKind regards,\nSettlement & Collateral Management\nJoh. Berenberg, Gossler & Co. KG`;

  pendingMarginCall.body = bodyText;

  byId('margin-modal-cpty').innerText = `Counterparty: ${cpty.fullName}`;
  byId('margin-email-to').value = cpty.email;
  byId('margin-email-subject').value = pendingMarginCall.subject;
  byId('margin-email-body').value = bodyText;

  openModal('margin-call-modal');
}

function openInOutlook() {
  if (!pendingMarginCall) return;
  const to = encodeURIComponent(byId('margin-email-to').value);
  const subject = encodeURIComponent(byId('margin-email-subject').value);
  const body = encodeURIComponent(byId('margin-email-body').value);

  const mailtoUrl = `mailto:${to}?subject=${subject}&body=${body}`;
  window.location.href = mailtoUrl;

  setTimeout(() => {
    alert(`📧 OUTLOOK REQUESTED!\n\nRecipient: ${byId('margin-email-to').value}\nAmount: EUR ${pendingMarginCall.formattedAmount}\n\nIf Outlook does not open automatically, use "Copy to clipboard" to paste the text.`);
    closeModal('margin-call-modal');
  }, 500);
}

function copyMarginEmailToClipboard() {
  const text = `To: ${byId('margin-email-to').value}\nSubject: ${byId('margin-email-subject').value}\n\n${byId('margin-email-body').value}`;
  navigator.clipboard.writeText(text).then(() => {
    alert("✅ The email content, recipient and subject have been copied to the clipboard. You can now paste them directly into Outlook.");
  }).catch(err => {
    alert("Could not copy the text. Please select and copy it manually.");
  });
}

// PHX records are read and validated by the separate XLSX import module.
async function processPhxData() {
  const imported = PhxImport.getSelection();
  if (PhxImport.isBusy() || !imported) return;
  PhxImport.setBusy(true);
  try {
    const operations = imported.records.map(record => ({
      type: marketPrices[record.isin] ? 'update' : 'create', store: 'prices', id: record.isin, record
    }));
    operations.push({ type: 'update', store: 'meta', id: 'phxDate', record: { value: imported.latestDate } });
    await persistDatabase(LendingDB.batch(operations, 'IMPORT_PHX'));
    PhxImport.setBusy(false);
    PhxImport.reset();
    closePricesModal();
    switchTab('collateral');
  } finally {
    PhxImport.setBusy(false);
  }
}

function renderPricesTable() {
  const tbody = byId('phx-prices-tbody');
  if (!tbody) return;
  tbody.innerHTML = "";
  const isinKeys = Object.keys(marketPrices);
  byId('price-table-count').innerText = `${isinKeys.length} ${isinKeys.length === 1 ? 'security' : 'securities'} loaded`;

  isinKeys.forEach(isin => {
    const item = marketPrices[isin];
    const tr = document.createElement('tr');
    tr.className = "hover:bg-slate-50";
    tr.innerHTML = `
      <td class="p-2 font-bold text-slate-800">${escapeHTML(isin)}</td>
      <td class="p-2 text-slate-600 font-sans truncate max-w-[150px]">${escapeHTML(displaySecurityName(item.name))}</td>
      <td class="p-2 text-slate-500">${escapeHTML(item.currency)}</td>
      <td class="p-2 text-right font-bold text-blue-700">${formatAmount(item.price, 4)}</td>
      <td class="p-2 text-center text-slate-500 font-sans text-[11px]">${escapeHTML(formatDate(item.date))}</td>
    `;
    tbody.appendChild(tr);
  });
}

// MODAL DIALOGS & LIFECYCLE
function openPricesModal() {
  renderPricesTable();
  byId('prices-modal').showModal();
}

function closePricesModal() {
  byId('prices-modal').close();
}

function openTicketModal() {
  byId('ticket-modal').showModal();
}

function closeTicketModal() {
  byId('ticket-modal').close();
  clearIngestionForm();
}

function openLifecycleModal(tradeId) {
  selectedTradeId = tradeId;
  byId('lifecycle-modal-subtitle').innerText = `Trade ID: #${tradeId}`;
  toggleLifecycleFields();
  openModal('lifecycle-modal');
}

function toggleLifecycleFields() {
  const type = byId('lifecycle-action-type').value;
  const partialBox = byId('partial-return-field');
  partialBox.classList.toggle('hidden', type !== 'PARTIAL');
}

async function executeLifecycleAction() {
  const actionType = byId('lifecycle-action-type').value;
  const trade = trades.find(t => t.id === selectedTradeId);
  if (!trade) return;

  if (actionType === 'RETURN') {
    await persistDatabase(LendingDB.trades.update(trade.id, {
      status: 'CLOSED', closedAt: new Date().toISOString()
    }, 'RETURN'));
    alert(`✅ LOAN FULLY RETURNED!\n\n- Closing entry completed in WPS (Demo securities account, DTB code: C).\n- Termination confirmation sent to ${trade.counterparty}.\n- Collateral exposure reduced immediately.`);
  } else if (actionType === 'PARTIAL') {
    const nominal = parseInt(byId('partial-return-nominal').value) || 0;
    if (nominal <= 0 || nominal >= trade.shares) {
      alert("Please enter a valid return quantity below the total holding.");
      return;
    }
    const remaining = trade.shares - nominal;
    await persistDatabase(LendingDB.trades.update(trade.id, { shares: remaining }, 'PARTIAL_RETURN'));
    alert(`✅ PARTIAL RETURN COMPLETED!\n\n- Return of ${nominal.toLocaleString('de-DE')} shares booked.\n- Remaining holding: ${remaining.toLocaleString('de-DE')} shares.\n- SFTR MODI report queued.\n- Collateral exposure adjusted.`);
  } else if (actionType === 'CONFIRMATION') {
    await persistDatabase(LendingDB.batch([], 'CONFIRMATION_DEMO'));
    alert(`📄 CONFIRMATION SENT!\n\nLoan confirmation for trade #${trade.id} (${displaySecurityName(trade.stockName)}) has been emailed to ${counterparties[trade.counterparty]?.email || trade.counterparty}.`);
  } else if (actionType === 'CANCEL') {
    await persistDatabase(LendingDB.trades.update(trade.id, { status: 'CANCELLED', closedAt: new Date().toISOString() }, 'CANCEL'));
    alert(`⚠️ CANCELLATION COMPLETED!\n\n- WPS opening entry cancelled.\n- ISS force close completed.\n- Regis-TR EROR cancellation report submitted.`);
  }

  closeModal('lifecycle-modal');
  renderTradesTable();
}

function downloadXmlPayload(type) {
  alert(`📄 ISO 20022 XML PAYLOAD (${type}):\n\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:auth.052.001.01">\n  <SctiesLndgTradRpt>\n    <TxData>\n      <ActnTp>${type}</ActnTp>\n      <RptgPtyLEI>DEMO_REPORTING_LEI</RptgPtyLEI>\n      <CtrPtyLEI>DEMO_COUNTERPARTY_LEI</CtrPtyLEI>\n    </TxData>\n  </SctiesLndgTradRpt>\n</Document>`);
}

function openModal(id) {
  byId(id).classList.remove('hidden');
}

function closeModal(id) {
  byId(id).classList.add('hidden');
}

// The repository is the only persistent-data writer.
let archivedTrades = [];
let databaseReady = false;
// ponytail: serialize UI actions for this MVP; use per-operation locks if concurrent edits are needed.
let databaseBusy = false;

function applyDatabase(data) {
  const normalizedTrades = data.trades.map(trade => ({
    ...trade,
    status: ['OPEN', 'CLOSED', 'CANCELLED'].includes(trade.status) ? trade.status : 'OPEN'
  }));
  trades = normalizedTrades.filter(trade => trade.status === 'OPEN');
  archivedTrades = normalizedTrades.filter(trade => ['CLOSED', 'CANCELLED'].includes(trade.status));
  marketPrices = Object.fromEntries(data.prices.map(({ isin, ...value }) => [isin, value]));
  counterparties = Object.fromEntries(data.counterparties.map(({ key, ...value }) => [key, value]));
  loanEvents = data.events || [];
  byId('current-phx-date').innerText = formatDate(data.meta.find(row => row.key === 'phxDate')?.value);
  renderPricesTable();
  renderTradesTable();
}

async function persistDatabase(operation) {
  applyDatabase(await operation);
}

async function openDatabase() {
  applyDatabase(await LendingDB.open());
  databaseReady = true;
  closeTicketModal();
  closeModal('lifecycle-modal');
  closeModal('margin-call-modal');
  selectedTradeId = null;
  pendingMarginCall = null;
}

async function exportDatabase() {
  const json = await LendingDB.exportJSON();
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `berenberg-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.addEventListener('DOMContentLoaded', () => {
  let displayedCommissionDay = commissionDay(new Date());
  const refreshCommissions = () => {
    const day = commissionDay(new Date());
    if (!databaseReady || day === displayedCommissionDay) return;
    displayedCommissionDay = day;
    renderTradesTable();
    if (byId('loan-details-dialog').open && !detailFilesBusy) openLoanDetails(selectedDetailLoanId, true);
  };
  window.setInterval(refreshCommissions, 60000);
  window.addEventListener('focus', refreshCommissions);
  document.addEventListener('visibilitychange', refreshCommissions);
  bindLoanIngestion();
  PhxImport.bind({ canSelect: () => databaseReady && !databaseBusy });
  byId('loan-details-dialog').addEventListener('cancel', event => {
    if (detailFilesBusy) event.preventDefault();
  });
  byId('loan-detail-file-input').addEventListener('change', async event => {
    const input = event.target;
    const tradeId = selectedDetailLoanId;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!byId('loan-details-dialog').open || !databaseReady || databaseBusy || !files.length) return;
    databaseBusy = true;
    try { await addDetailFiles(tradeId, files); }
    catch { /* The popup displays the error and retains the saved attachments. */ }
    finally { databaseBusy = false; }
  });
  byId('loan-details-form').addEventListener('submit', event => event.preventDefault());
  const pricesModal = byId('prices-modal');
  pricesModal.addEventListener('cancel', event => {
    event.preventDefault();
    if (!databaseBusy && !PhxImport.isBusy()) closePricesModal();
  });
  pricesModal.addEventListener('click', event => {
    if (event.target !== pricesModal || databaseBusy || PhxImport.isBusy()) return;
    const bounds = pricesModal.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) closePricesModal();
  });
  const ticketModal = byId('ticket-modal');
  ticketModal.addEventListener('cancel', event => {
    event.preventDefault();
    if (!databaseBusy) closeTicketModal();
  });
  ticketModal.addEventListener('click', event => {
    if (event.target !== ticketModal || databaseBusy) return;
    const bounds = ticketModal.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) closeTicketModal();
  });
  renderPricesTable();
  renderTradesTable();
  databaseBusy = true;
  openDatabase().catch(error => {
    alert('Database unavailable: ' + error.message);
  }).finally(() => { databaseBusy = false; });
});

// Bind controls declared in the HTML without inline JavaScript.
const controlHandlers = {
  'open-database': openDatabase,
  'switch-tab': control => switchTab(control.dataset.tab),
  'open-prices-modal': openPricesModal,
  'close-prices-modal': () => { if (!databaseBusy && !PhxImport.isBusy()) closePricesModal(); },
  'open-ticket-modal': openTicketModal,
  'close-ticket-modal': () => { if (!databaseBusy) closeTicketModal(); },
  'download-xml-payload': control => downloadXmlPayload(control.dataset.type),
  'close-modal': control => closeModal(control.dataset.modal),
  'export-database': () => exportDatabase(),
  'open-lifecycle': control => openLifecycleModal(Number(control.dataset.tradeId)),
  'prepare-margin-call': control => prepareMarginCall(control.dataset.counterparty, Number(control.dataset.amount)),
  'filter-trades': filterTrades,
  'sort-loans': control => sortLoans(control.dataset.sortColumn),
  'choose-detail-files': () => { if (!databaseBusy) byId('loan-detail-file-input').click(); },
  'remove-detail-file': control => removeDetailFile(Number(control.dataset.tradeId), control.dataset.fileId),
  'view-loan': control => openLoanDetails(Number(control.dataset.tradeId)),
  'dismiss-loan-details': () => { if (!detailFilesBusy) byId('loan-details-dialog').close(); },
  'loan-page-size': control => { loanPageSize = [10, 20, 50].includes(Number(control.value)) ? Number(control.value) : 10; loanPage = 1; renderTradesTable(); },
  'loan-page-prev': () => { loanPage--; renderTradesTable(); },
  'loan-page-next': () => { loanPage++; renderTradesTable(); },
  'close-loan': control => openCloseLoan(Number(control.dataset.tradeId)),
  'dismiss-close-loan': () => { selectedCloseLoanId = null; byId('close-loan-dialog').close(); },
  'confirm-close-loan': confirmCloseLoan,
  'parse-ticket': parseTicket,
  'choose-loan-files': () => byId('loan-file-input').click(),
  'remove-loan-file': control => {
    loanAttachments = loanAttachments.filter(file => file.id !== control.dataset.fileId);
    renderLoanAttachments();
    setAttachmentFeedback(loanAttachments.length ? 'success' : 'idle', loanAttachments.length
      ? `${loanAttachments.length} files attached. You can add more emails or files.` : 'No files attached. Choose files or drop them into this window.');
  },
  'download-draft-file': control => { const file = loanAttachments.find(file => file.id === control.dataset.fileId); if (file) LoanAttachments.download(file); },
  'download-saved-file': control => {
    const trade = [...trades, ...archivedTrades].find(trade => trade.id === Number(control.dataset.tradeId));
    const file = trade?.attachments?.find(file => file.id === control.dataset.fileId);
    if (file) LoanAttachments.download(file);
  },
  'execute-wps-booking': executeWpsBooking,
  'process-phx-data': processPhxData,
  'submit-sftr-batch': () => alert('The Regis-TR SFTR batch was successfully generated and validated for submission.'),
  'export-z14': () => alert('Z14 report exported as CSV.'),
  'export-z15': () => alert('Z15 report exported as CSV.'),
  'toggle-lifecycle-fields': toggleLifecycleFields,
  'execute-lifecycle-action': executeLifecycleAction,
  'copy-margin-email-to-clipboard': copyMarginEmailToClipboard,
  'open-in-outlook': openInOutlook,
};

// Delegation also handles buttons created when tables are rendered again.
const databaseActions = new Set([
  'open-ticket-modal', 'remove-detail-file',
  'export-database', 'process-phx-data',
  'execute-wps-booking', 'execute-lifecycle-action', 'open-lifecycle', 'close-loan', 'confirm-close-loan',
  'prepare-margin-call', 'download-xml-payload', 'submit-sftr-batch',
  'export-z14', 'export-z15', 'open-in-outlook',
]);

for (const eventName of ['click', 'change', 'keyup', 'input']) {
  document.addEventListener(eventName, async event => {
    const control = event.target.closest(`[data-on-${eventName}]`);
    if (!control || control.disabled) return;
    // Links, file controls and Close loan keep their own behavior within a clickable row.
    if (control.matches('tr') && event.target.closest('button, a, input, select, textarea, summary, details')) return;
    const action = control.getAttribute(`data-on-${eventName}`);
    const handler = controlHandlers[action];
    if (!handler) return;
    const needsDatabase = databaseActions.has(action);
    const locksDatabase = needsDatabase || action === 'open-database';
    if (databaseBusy && locksDatabase) {
      alert('Please wait while the database is opening or saving.');
      return;
    }
    if (!databaseReady && needsDatabase) {
      alert('Please wait while the database is opening.');
      return;
    }
    if (locksDatabase) databaseBusy = true;
    try {
      await handler(control);
    } catch (error) {
      if (error.name === 'AbortError' && action === 'open-database') return;
      if (needsDatabase && databaseReady) {
        try { applyDatabase(await LendingDB.reload()); }
        catch { databaseReady = false; }
      }
      alert('Action not completed: ' + error.message);
    } finally {
      if (locksDatabase) databaseBusy = false;
    }
  });
}
