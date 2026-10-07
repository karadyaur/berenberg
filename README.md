# Berenberg Lending MVP

Open `laa.html` directly in Chrome or Edge. The app automatically connects to
one IndexedDB database in the current browser profile. No Node.js, server,
build step or file selection is required. Tailwind and Font Awesome load from the internet.

## Files and data

- `laa.html`, `css/styles.css` — interface and styling.
- `js/app.js` — workflows, calculations and rendering.
- `js/phx-import.js` — local XLSX reading, validation, file selection and drag-and-drop.
- `js/vendor/xlsx.full.min.js` — vendored SheetJS CE 0.20.3 XLSX reader (Apache 2.0).
- `js/tailwind.config.js` — Tailwind configuration.
- `js/database/database.js` — the single database, automatic connection and CRUD.
- `data/database-seed.js` — initial data; a set of 30 demo trades is added on first launch.
- `tests/check.cjs` — scenario checks.

Trades, prices, counterparties, the change log and metadata are stored in one
IndexedDB database, `berenberg-lending-mvp`. On first open with database version 4,
all previous records are deleted in one upgrade transaction, including tickets,
attachments, prices, counterparty contacts and history snapshots. They are replaced
with 30 fictional loans and six demo counterparties using `example.invalid` email
addresses. Close other app tabs and reopen the updated page to apply this reset.
Subsequent reloads preserve newly entered records. Previously downloaded exports
and older copies of the app are outside this browser database reset.
JSON exports remain available through
`LendingDB.exportJSON()`; the database toolbar has been removed. Initial data does not replace an existing database
in this browser profile after the one-time privacy reset.

The navigation contains **Loans**, **Collateral**, and **Regulatory Reporting**.
**Import new PHX prices** on Collateral opens **Market Prices** in a popup. Loans opens with **Open** selected. The Status selector
switches between **Open** and **Closed**; the two views never mix records.
Closed includes both closed and cancelled transactions, displayed as Closed
in the table and loan details. Search, sorting, pagination and layout preferences
work in both views. The navigation count reflects the selected view. New trades
have status `OPEN`. Closed transactions have zero current exposure and no Close action; their
close timestamp appears under Status. A canceled trade can be booked
again with the same MO ID; a closed MO ID cannot be reused. The change log is
available in the JSON export.
Regulatory and banking integrations remain demonstrations.

Loans shows 10 rows per page, with 20 and 50 available in the page-size
selector. **Commission / day** shows quantity × opening price × the entered annual
commission percentage / 100 / 365, in the loan currency, with the annual rate
underneath. PHX price changes do not affect this amount. Missing rates display
an em dash; a zero rate displays zero. **Total commission** accrues from Value
Date (or Trade Date if absent), including today and weekends, using Berlin
calendar dates. It refreshes on a new day, on returning to the tab, and after
reload, including days while the app was closed. Closed loans stop before the
return date and retain their total in the loan table and loan details; cancelled loans
show zero. Partial returns reduce the daily quantity from the return date,
preserving prior accrual using saved activity history. Totals are calculated
before rounding for display. **Layout** lets you reorder every column using drag-and-drop or arrow
buttons, hide/show columns, and restore the default layout. Desktop table headers
can also be dragged directly. Preferences are saved locally in the browser and
apply after filtering, pagination, and reloads, including the mobile card field order.
At least one column remains visible. Search and counterparty filters apply to the full list and return to
the first page. Click any data-column label in Loans to sort ascending;
click again to sort descending. Arrows indicate the current direction. Sorting
applies to the full filtered list before pagination and remains active when
prices or commissions refresh or columns move. Numbers use their unrounded
values; dates sort chronologically (Trade Date, then Value Date), security sorts
by ISIN then name, and missing values stay last. The Close action has no sort.
On narrow screens, rows become labeled cards. **Close loan**
opens a confirmation, saves the loan as `CLOSED`, and updates active exposure.
Click a loan row or its MO ID to open its full details,
original ticket, activity history and downloadable original attachments.
Use **Add files** or **Remove** in the popup to update attachments on active or
closed loans. Changes save immediately; limits are 10 MB per file and 25 MB
per loan. Uploads preserve reviewed loan fields and the original ticket.

## PHX prices

Choose or drop one `.xlsx` file (up to 10 MB) in the Market Prices popup,
then click **Import prices**. Files are read locally; CSV/pasted text is no longer supported.
The reader finds a header row on each sheet, including after report titles or blank rows.
Required columns: **ISIN**, **PRICE** (or **KURS**) and **PRICE DATE**
(or **REPORT DATE** / **KURSDATUM**). Optional columns: **CURRENCY**
(or **WÄHRUNG** / **WAEHRUNG**, defaults to EUR) and **ISIN NAME**
(or **SECURITY** / **ISSUER**, defaults to ISIN).
Excel dates, ISO dates and `DD.MM.YYYY` dates are supported, as are numeric
prices and decimal-comma text. All populated rows must be valid; conflicting
duplicate ISINs stop the import. Quotes and the latest report date save in one
database transaction, then loan exposure and collateral refresh. A failed save
retains the selected file for retry. The existing USD conversion uses a fixed
0.92 FX rate, as before.

## CRUD API

`LendingDB.trades`, `.prices` and `.counterparties` provide `list`, `get`,
`create`, `update` and `delete`. Batch operations are written in a single
transaction, keys are immutable, and counterparties referenced by trades
are protected from deletion.

## File attachments and reference data

Drop files inside the **Add loan** popup, or use **Choose files** there.
The regular page has no file-drop upload behavior.
Original bytes and file metadata are stored with the loan in the same local
IndexedDB database and included in JSON exports. Files can be downloaded from
Loans using the attachment list under the MO ID.
The limit is 10 MB per file and 25 MB per loan. Removing a file before saving
removes it from the draft.

Plain text, HTML and MIME `.eml` email bodies can populate the ticket field.
Base64 and quoted-printable email bodies are supported. Other files, including
Outlook `.msg` and PDFs, are attached intact; paste the ticket text to parse those
formats. Emails and files are never uploaded to reference providers.

The **Add loan** reference-data section shows matching WPS and SFTR notices:
“A separate tool will be connected.” It does not populate demo WPS values or
request online SFTR suggestions. New loans keep SFTR reference values empty
until the separate tool is connected. Existing saved reference data is retained.

Checks: `node tests/check.cjs`, `node tests/check-loan-entry.cjs`,
`node tests/check-ingestion.cjs`, `node tests/check-loan-list.cjs`,
`node tests/check-loan-layout.cjs`, `node tests/check-loan-sort.cjs`,
`node tests/check-phx-import.cjs`.
