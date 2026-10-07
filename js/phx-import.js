/* PHX XLSX reading and upload UI. Files are processed locally. */
const PhxImport = (() => {
  const maxFileSize = 10 * 1024 * 1024;
  const aliases = {
    isin: ['ISIN'], price: ['PRICE', 'KURS'], currency: ['CURRENCY', 'WÄHRUNG', 'WAEHRUNG'],
    name: ['ISIN NAME', 'SECURITY', 'ISSUER'], date: ['PRICE DATE', 'REPORT DATE', 'KURSDATUM']
  };
  const text = value => String(value ?? '').trim().replace(/^'+/, '');
  const header = value => text(value).toUpperCase().replace(/[_\s]+/g, ' ');
  let selection = null;
  let busy = false;
  let ui;

  function priceNumber(value) {
    if (typeof value === 'number') return value;
    let raw = text(value).replace(/[\s\u00a0]/g, '');
    if (raw.includes(',')) raw = raw.includes('.')
      ? (raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''))
      : raw.replace(',', '.');
    return raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  }

  function dateValue(value, date1904) {
    let year, month, day;
    if (value instanceof Date && !isNaN(value)) {
      year = value.getFullYear(); month = value.getMonth() + 1; day = value.getDate();
    } else if (typeof value === 'number') {
      const parts = XLSX.SSF.parse_date_code(value, { date1904 });
      if (!parts) return null;
      year = parts.y; month = parts.m; day = parts.d;
    } else {
      const raw = text(value);
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
      if (iso) [, year, month, day] = iso.map(Number);
      else if (german) [, day, month, year] = german.map(Number);
      else return null;
    }
    const check = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function parseWorkbook(workbook) {
    const prices = new Map();
    let found = false;
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: true });
      const index = rows.findIndex(row => row.some(value => header(value) === 'ISIN') && row.some(value => aliases.price.includes(header(value))));
      if (index < 0) continue;
      found = true;
      const headers = rows[index].map(header);
      const columns = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, names.map(name => headers.indexOf(name)).find(i => i >= 0) ?? -1]));
      if (columns.date < 0) throw new Error(`${sheetName}: add PRICE DATE or REPORT DATE.`);
      for (let i = index + 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every(value => text(value) === '')) continue;
        const isin = text(row[columns.isin]).toUpperCase();
        const price = priceNumber(row[columns.price]);
        const currency = columns.currency < 0 ? 'EUR' : text(row[columns.currency]).toUpperCase();
        const date = dateValue(row[columns.date], !!workbook.Workbook?.WBProps?.date1904);
        const name = columns.name < 0 ? isin : text(row[columns.name]) || isin;
        if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) || !Number.isFinite(price) || price < 0 || !/^[A-Z]{3}$/.test(currency) || !date) {
          throw new Error(`${sheetName}, row ${i + 1}: check ISIN, price, currency and date.`);
        }
        const record = { isin, price, currency, name, date, fxRate: currency === 'USD' ? 0.92 : 1 };
        const previous = prices.get(isin);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error(`${sheetName}, row ${i + 1}: conflicting prices for ${isin}.`);
        prices.set(isin, record);
      }
    }
    if (!found) throw new Error('No sheet with ISIN and PRICE / KURS columns.');
    if (!prices.size) throw new Error('No prices found in this workbook.');
    const records = [...prices.values()];
    return { records, latestDate: records.reduce((latest, row) => row.date > latest ? row.date : latest, '') };
  }

  async function readFile(file) {
    if (!file || !/\.xlsx$/i.test(file.name)) throw new Error('Choose an .xlsx file.');
    if (!file.size || file.size > maxFileSize) throw new Error('Choose an XLSX file up to 10 MB.');
    if (typeof XLSX === 'undefined') throw new Error('XLSX reader unavailable. Reload the page.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('This file is not an XLSX workbook.');
    let workbook;
    try { workbook = XLSX.read(bytes, { type: 'array', bookFiles: true }); }
    catch { throw new Error('Cannot read this XLSX file. Check that it is not damaged or password protected.'); }
    if (!workbook.keys?.some(key => /^xl\/workbook\.xml$/.test(key))) throw new Error('This file is not an XLSX workbook.');
    return { ...parseWorkbook(workbook), fileName: file.name };
  }

  function feedback(message, error = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle('text-red-600', error);
  }
  function updateControls() {
    ui.choose.disabled = busy;
    ui.clear.disabled = busy || !selection;
    ui.import.disabled = busy || !selection;
    ui.zone.setAttribute('aria-busy', String(busy));
  }
  function reset() {
    if (busy) return;
    selection = null;
    ui.input.value = '';
    feedback('');
    updateControls();
  }
  async function selectFiles(files) {
    if (busy || !ui.canSelect()) return;
    selection = null;
    busy = true;
    updateControls();
    feedback('Reading XLSX…');
    try {
      if (files.length !== 1) throw new Error('Choose one XLSX file.');
      selection = await readFile(files[0]);
      feedback(`${selection.fileName} · ${selection.records.length} prices · ${selection.latestDate}`);
    } catch (error) { feedback(error.message, true); }
    finally { busy = false; ui.input.value = ''; updateControls(); }
  }
  function bind({ canSelect }) {
    const get = id => document.getElementById(id);
    ui = { zone: get('phx-dropzone'), input: get('phx-file-input'), choose: get('choose-phx-file'), clear: get('clear-phx-file'), import: get('import-phx-file'), status: get('phx-file-status'), canSelect };
    ui.choose.addEventListener('click', () => { if (!busy && canSelect()) ui.input.click(); });
    ui.clear.addEventListener('click', () => { if (canSelect()) reset(); });
    ui.input.addEventListener('change', event => selectFiles(Array.from(event.target.files || [])));
    const dialog = get('prices-modal');
    let dragDepth = 0;
    const clearDrag = () => { dragDepth = 0; ui.zone.classList.remove('is-dragging'); };
    dialog.addEventListener('dragenter', event => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth++;
      if (!busy && canSelect()) ui.zone.classList.add('is-dragging');
    });
    dialog.addEventListener('dragover', event => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = busy || !canSelect() ? 'none' : 'copy';
    });
    dialog.addEventListener('dragleave', () => { if (--dragDepth <= 0) clearDrag(); });
    dialog.addEventListener('drop', event => {
      event.preventDefault(); clearDrag();
      if (dialog.open) selectFiles(Array.from(event.dataTransfer?.files || []));
    });
    dialog.addEventListener('close', clearDrag);
    dialog.addEventListener('dragend', clearDrag);
    updateControls();
  }
  function setBusy(value) { busy = value; updateControls(); }
  return { bind, readFile, parseWorkbook, getSelection: () => selection, isBusy: () => busy, setBusy, reset };
})();
