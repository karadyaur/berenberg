// Browser-local display preferences; loan records are never modified.
(() => {
  const keys = ['id', 'counterparty', 'security', 'quantity', 'opening', 'commission', 'commissionTotal', 'current', 'exposure', 'dates', 'status', 'close'];
  const labels = ['MO ID', 'Counterparty', 'ISIN / Security', 'Quantity', 'Opening Price', 'Commission / day', 'Total commission', 'Current Price (PHX)', 'Current Exposure (+5%)', 'Trade / Value Date', 'Status', 'Close'];
  const storageKey = 'berenberg-loan-layout-v1';
  const defaults = () => ({ order: [...keys], hidden: [] });
  function normalize(value) {
    const order = [...new Set(Array.isArray(value?.order) ? value.order.filter(key => keys.includes(key)) : [])];
    order.push(...keys.filter(key => !order.includes(key)));
    const hidden = [...new Set(Array.isArray(value?.hidden) ? value.hidden.filter(key => keys.includes(key)) : [])];
    return { order, hidden: hidden.length === keys.length ? [] : hidden };
  }
  let state = defaults();
  try { state = normalize(JSON.parse(localStorage.getItem(storageKey))); } catch {}
  let dragged = null;
  const byId = id => document.getElementById(id);

  function apply() {
    const table = document.querySelector('.loan-table');
    if (!table) return;
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.children];
      if (cells.length === 1 && cells[0].classList.contains('loan-empty')) {
        cells[0].colSpan = keys.length - state.hidden.length;
        continue;
      }
      cells.forEach((cell, index) => { if (!cell.dataset.loanColumn) cell.dataset.loanColumn = keys[index]; });
      const mapped = new Map(cells.map(cell => [cell.dataset.loanColumn, cell]));
      for (const key of state.order) {
        const cell = mapped.get(key);
        if (!cell) continue;
        cell.hidden = state.hidden.includes(key);
        if (cell.tagName === 'TH') {
          cell.draggable = true;
          if (!cell.title) cell.title = 'Click the label to sort; drag the header to move this column, or use Layout settings';
        }
        row.appendChild(cell);
      }
    }
  }

  function renderSettings(focusKey, action) {
    const list = byId('loan-layout-columns');
    if (!list) return;
    list.innerHTML = state.order.map((key, index) => {
      const label = labels[keys.indexOf(key)];
      const checked = !state.hidden.includes(key);
      return `<li draggable="true" data-layout-column="${key}">
        <i class="fas fa-grip-vertical" aria-hidden="true"></i>
        <label><input type="checkbox" data-layout-action="visibility" data-column="${key}" ${checked ? 'checked' : ''} ${checked && state.hidden.length === keys.length - 1 ? 'disabled' : ''}> ${label}</label>
        <button type="button" data-layout-action="up" data-column="${key}" aria-label="Move ${label} up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-layout-action="down" data-column="${key}" aria-label="Move ${label} down" ${index === keys.length - 1 ? 'disabled' : ''}>↓</button>
      </li>`;
    }).join('');
    if (focusKey) {
      const row = list.querySelector(`[data-layout-column="${focusKey}"]`);
      const target = row.querySelector(`[data-layout-action="${action}"]`);
      (target && !target.disabled ? target : row.querySelector('button:not(:disabled)')).focus();
    }
  }

  function save(message, focusKey, action) {
    let feedback = message;
    try { localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch { feedback += ' Browser storage is unavailable; changes last for this session.'; }
    apply();
    renderSettings(focusKey, action);
    byId('loan-layout-feedback').textContent = feedback;
  }

  function move(key, target) {
    if (!keys.includes(key) || !keys.includes(target) || key === target) return;
    const position = state.order.indexOf(target);
    state.order.splice(state.order.indexOf(key), 1);
    state.order.splice(position, 0, key);
    save(`${labels[keys.indexOf(key)]} moved to position ${position + 1}.`);
  }

  window.LoanLayout = { apply };
  document.addEventListener('DOMContentLoaded', () => {
    const dialog = byId('loan-layout-dialog');
    const list = byId('loan-layout-columns');
    byId('open-loan-layout').addEventListener('click', () => {
      renderSettings();
      byId('loan-layout-feedback').textContent = 'At least one column must remain visible.';
      dialog.showModal();
    });
    for (const id of ['close-loan-layout', 'done-loan-layout']) {
      byId(id).addEventListener('click', () => dialog.close());
    }
    byId('reset-loan-layout').addEventListener('click', () => { state = defaults(); save('Default layout restored.'); });
    list.addEventListener('click', event => {
      const button = event.target.closest('button[data-layout-action]');
      if (!button || button.disabled) return;
      const key = button.dataset.column;
      const action = button.dataset.layoutAction;
      const index = state.order.indexOf(key);
      const target = state.order[index + (action === 'up' ? -1 : 1)];
      if (!target) return;
      move(key, target);
      renderSettings(key, action);
    });
    list.addEventListener('change', event => {
      const input = event.target.closest('input[data-layout-action]');
      if (!input) return;
      const key = input.dataset.column;
      if (!input.checked && state.hidden.length === keys.length - 1) { input.checked = true; return; }
      state.hidden = state.hidden.filter(item => item !== key);
      if (!input.checked) state.hidden.push(key);
      save(`${labels[keys.indexOf(key)]} ${input.checked ? 'shown' : 'hidden'}.`, key, 'visibility');
    });
    const table = document.querySelector('.loan-table');
    for (const surface of [table.tHead, list]) {
      const selector = surface === list ? '[data-layout-column]' : 'th[data-loan-column]';
      const columnKey = node => node.dataset.layoutColumn || node.dataset.loanColumn;
      surface.addEventListener('dragstart', event => {
        const node = event.target.closest(selector);
        if (!node) return;
        dragged = columnKey(node);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragged);
      });
      surface.addEventListener('dragover', event => {
        const node = event.target.closest(selector);
        if (!dragged || !node) return;
        event.preventDefault();
        surface.querySelectorAll('.layout-drop-target').forEach(item => item.classList.remove('layout-drop-target'));
        node.classList.add('layout-drop-target');
      });
      const clear = () => {
        dragged = null;
        surface.querySelectorAll('.layout-drop-target').forEach(item => item.classList.remove('layout-drop-target'));
      };
      surface.addEventListener('drop', event => {
        const node = event.target.closest(selector);
        if (dragged && node) { event.preventDefault(); move(dragged, columnKey(node)); }
        clear();
      });
      surface.addEventListener('dragend', clear);
    }
    apply();
  });
})();
