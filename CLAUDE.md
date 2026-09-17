# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (node server.js) — port from PORT in .env (required; the app refuses to start without it)
```

No test suite exists. There is no build step — this is a plain Node.js ES-module project.

Utility scripts (run directly). The signature/backfill ones are dry-run by
default — pass `--apply` to commit:
```bash
node scripts/backfill-prodbinding-signatures.js
node scripts/backfill-prodbinding-calc.js
node scripts/backfill-employee-nickname.js       # empNickName = first word of empName
node scripts/backfill-facestock-signatures.js    # repair Facestock Master dup protection (also drops old vendor+SKU index)
node scripts/backfill-adhesive-signatures.js     # repair Adhesive Master dup protection (also drops old vendor+SKU index)
node scripts/backfill-release-signatures.js      # repair Release Master dup protection
node scripts/backfill-releaselinerstock-sensing.js  # ReleaseLinerStock.sensing <- its Release Master's (needed: Release Liner allocation matches on Sensing alone)
node scripts/backfill-core-signatures.js         # repair Core Master dup protection
node scripts/drop-legacy-skucode-index.js        # drop dead skuCode_1 index on Facestock/Adhesive/Release/Core Master
node scripts/send-back-to-pending.js <orderId>   # unassign one WIP order back to Pending (CLI form of the UI button)
node scripts/clear-label-stock-layer-data.js     # wipe SachikoLabelStock facestock/adhesive/releaseLiner (+2) so they're re-picked from master
node scripts/backfill-pendingproduction-allotted-layers.js  # PendingProduction allottedLayers <- parsed from the produced Deckle's log, where missing
node scripts/backfill-labelstock-signatures.js   # repair SachikoLabelStock dup protection
node scripts/backfill-finishedstock-rate.js      # price slit rolls that landed with no rate from their sales order's orderRate
node scripts/resignature-labelstock.js           # resync every /sachiko/label-stock/view row's labelStockSignature + list rows sharing a recipe (--apply to write)
node scripts/serialize-labelstock-sku-codes.js   # close gaps in SachikoLabelStock skuCode + re-anchor variant SKUs ("000002-A") to their base row's SKU
node scripts/dissolve-deckle.js [deckleId]       # un-make a Deckle, returning its mtrs to the raw reels it was laminated from
node scripts/backfill-family-master-seed.js      # seed the Family master with values already in use on Label Stock / Facestock Master + the old hardcoded dropdown list
node scripts/backfill-type-master-seed.js        # seed the Type master with values already in use on Facestock / Adhesive / Release Master + the old hardcoded dropdown lists
node scripts/backfill-location-master-seed.js    # seed the Location master with values already in use on employee records + the old hardcoded Employee form dropdown
node scripts/deckle-optimizer-bench.js [--verbose]  # bench + invariant check for utils/deckleOptimizer; no DB, exits non-zero on failure
node scripts/raw-auto-allot-bench.js [--verbose]    # invariant check for public/js/rawAutoAllot.js (Assign Production's Auto Allot); no DB, exits non-zero on failure
node scripts/reset-transactional-data.js         # empty orders/production/bindings, KEEP masters+stock+people (dry-run; --apply --db=<name>)
node scripts/company-slug-history.js             # URL prefixes the company is served under (renames record themselves; this is the manual override)
node scripts/rewrite-id-prefix.js --from SP --to GM  # move ids left behind by an older company code (dry-run; --apply)
```

## Environment

Requires a `.env` file with at minimum:
- `SESSION_SECRET` — app crashes at startup without this
- `PORT` — app crashes at startup without this (no hardcoded default)
- `MONGO_URI` (or equivalent — see `config/db.js`)
- `TASKS_MONGO_URI` (optional) — the `/fairtech/tasks` feature stores its data in a separate, isolated database (`config/tasksDb.js`), for privacy. Without this set, it defaults to a sibling database named `<main db>_tasks` on the same server as `MONGO_URI`.
- `DECKLE_AUTO_ENABLED` (optional) — kill switch for the Auto Deckle optimizer (see below). Enabled unless set to `false`/`0`/`off`/`no`. Set it to `false` and restart to remove the feature entirely: the Set Deckle page then renders with no Auto Set panel and no client code for it, and the API returns 503.
- In dev only: `PROPRIETOR_USER`, `PROPRIETOR_PASS`, `ADMIN_USER`, `ADMIN_PASS`, `HR_USER`, `HR_PASS`, `HOD_USER`, `HOD_PASS`, `SALES_USER`, `SALES_PASS` (backdoor accounts; blocked in production)

## Architecture

### Route structure

All app routes live under `/fairtech/`. Routes are split into sub-router files and mounted in `server.js`:

| Mount point | File |
|---|---|
| `/fairtech/*` (main views) | `routes/fairdesk_route.js` |
| `/fairtech/` (machine master + binding) | `routes/system/machine.js` |
| `/fairtech/payroll` | `routes/acccounting/payroll.js` |
| `/fairtech/loan` | `routes/acccounting/loan.js` |
| `/fairtech/advance` | `routes/acccounting/advance.js` |
| `/fairtech/employee` | `routes/hr/employee.js` |
| `/fairtech/client` | `routes/users/clients.js` |
| `/fairtech/` (tape/ttr bindings) | `routes/inventory/*.js` |
| `/fairtech/tapestock` etc. | `routes/stock/*.js` |

Roles: `proprietor`, `admin`, `hod`, `sales`, `hr`, `employee`, `master`, `operator`. `proprietor` sits above `admin` and is granted access everywhere `admin` is. Access guarded by `requireAuth` and `requireRole([...])` from `middleware/auth.js`.

`operator` is a session-only role: shopfloor operators sign in at `/fairtech/operator/login` with nick name (`empNickName`) + location + password (their employee record has `empProfile: "OPERATOR"` and `role: "none"`), and land on the queue of the machine named by their profile code. They can reach only `routes/system/machine.js` — mounted ahead of the other `/fairtech` routers, since each of those runs `requireRole` for every `/fairtech/*` request, not just its own paths.

### View rendering pattern

Every route renders an EJS view using the `boilerplate.ejs` layout:

```js
res.render("inventory/machineMaster.ejs", {
  JS: false,            // or "filename.js" — loaded as /js/<filename>
  CSS: "tableDisp.css", // or false — loaded as /css/<filename>
  title: "Machine Master",
  // ... data for the template
  notification: req.flash("notification"),
});
```

Views start with `<% layout('/layout/boilerplate') %>`. The layout loads `common.css`, `choices.min.css`, Bootstrap, Font Awesome, and `common.js` on every page. The `.indi-head` header bar class is in `tableDisp.css` — pass `CSS: "tableDisp.css"` in the route render call when using it.

### CSRF

`common.js` wraps `window.fetch` globally to auto-inject `x-csrf-token` on every request. For HTML forms, either include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">` or rely on the form submit interceptor in `common.js` (which also injects `_csrf` on POST forms).

### Rate limiting

All mutating routes must use limiters from `utils/limiters.js`:

```js
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

router.post("/...", requireAuth, createLimiter, async (req, res) => { ... });
router.put("/...",  requireAuth, updateLimiter, async (req, res) => { ... });
router.delete("/...", requireAuth, deleteLimiter, async (req, res) => { ... });
```

### Photo / video uploads (shared media store)

`utils/media.js` is the one way to take a photo or video from a user. It
compresses on the way in (images → EXIF-rotated JPEG capped at 1600px; videos →
faststart H.264 MP4 capped at 1280px, trimmed to 2 min, via the bundled
`ffmpeg-static` binary), writes a 400px JPEG thumbnail for both, and returns
records matching `mediaAssetSchema` (`models/system/mediaAsset.js`) to embed on
your document. Files live in `media/<bucket>/` — one bucket per feature —
under a random filename; `media/` is gitignored.

```js
const upload = mediaUpload({ bucket: "maintenance", fields: [
  { name: "photo", kind: "image", maxCount: 1 },
  { name: "video", kind: "video", maxCount: 1 },
]});

router.post("/x", requireAuth, createLimiter, upload, async (req, res) => {
  const assets = await storeUploads(req.files, "maintenance"); // compresses + cleans temps
  try { await Thing.create({ media: assets }); }
  catch (e) { await removeAssets(assets); throw e; }          // no orphan files
});
```

Serve files back with `sendAsset(res, asset, { thumb })` after your own auth
check — it honours Range requests, which is what lets a video seek and start
playing immediately. Route them by document id + array index (see
`routes/system/maintenance.js`), never by filename.

Note the CSP in `server.js` allows `media-src 'self' blob:` — blob for previewing
a picked clip before upload. Image previews must use a `data:` URL (`img-src`
does not allow blob).

### Embedding server data in views

Use the `safeJson` helper (available as `res.locals.safeJson`) to safely embed JSON in templates:

```html
<script id="locations-data" type="application/json"><%- safeJson(locations) %></script>
```

Then in client JS:
```js
const locations = JSON.parse(document.getElementById("locations-data").textContent);
```

Never interpolate object data directly into `<script>` blocks or `onclick` attributes.

### Dialog / modal pattern

Use the `.logout-modal` / `.logout-dialog` CSS classes from `boilerplate.ejs` for all dialogs. Key rules:
- Dialog `<dialog>` element: `style="width: min(440px, 95vw); padding: 0; border-radius: 14px; border: none;"` — **no `overflow: hidden`**
- Apply `border-radius: 14px 14px 0 0` to `.dialog-header` and `border-radius: 0 0 14px 14px` to `.dialog-body` instead — avoids clipping Choices.js absolutely-positioned dropdowns

### Choices.js

Choices.js v11.1.0 is available globally (loaded via CDN in boilerplate). In dialogs, use the destroy/reinit pattern:

```js
let myChoices = null;
function openDialog() {
  if (myChoices) { myChoices.destroy(); myChoices = null; }
  const sel = document.getElementById("my-select");
  sel.innerHTML = options.map(o => `<option value="${o._id}">${o.name}</option>`).join("");
  myChoices = new Choices(sel, { searchEnabled: true, shouldSort: false, itemSelectText: "" });
}
```

To pre-select a value on edit, set the `selected` attribute in the `<option>` HTML before calling `new Choices(...)` — more reliable than `setChoiceByValue` after init.

Add `z-index: 99999` to `.choices__list--dropdown` inside dialogs so the dropdown list renders above the dialog overlay.

### Passing data to onclick handlers

Use `data-*` attributes on buttons; read them in the handler via `this.dataset`. Never interpolate strings into onclick attributes (escaping is fragile):

```html
<button data-id="<%= item._id %>" data-name="<%= item.name %>"
        onclick="openEditDialog(this.dataset.id, this.dataset.name)">Edit</button>
```

### Text inputs auto-uppercase

`common.js` automatically converts all `input[type="text"]` values to uppercase on input. This matches the Mongoose model convention of storing names in uppercase.

### Renaming the company moves the URL prefix (and old links follow)

The public prefix is the first word of the company name (`slugifyCompany`), so
renaming **SACHIKO PACKAGING** to **RYT INFO** moves the whole app from
`/sachiko/...` to `/ryt/...` the instant it is saved — no restart, because the
brand cache is refreshed by the write (`routes/system/company.js` →
`refreshBrand()`).

That is also how a rename *looks broken*: the name is live everywhere (page
titles, nav header, login screen), but every bookmark and open tab on the old
prefix answers **404**, so it reads as "I renamed the company and nothing
changed".

`Company.slugHistory` closes that. The update route records the outgoing prefix
whenever the name changes, and `middleware/brandPrefix.js` forwards any
remembered prefix onto the current one:

    /sachiko/labels/production/pending?tab=wip
      -> 302 /ryt/labels/production/pending?tab=wip

- **Temporary redirects, deliberately** — 302 for GET/HEAD, 307 for anything
  else so a form post from a stale tab keeps its method and body. A 301 would
  be cached by the browser and would then misroute if the company is ever
  renamed back.
- Five prefixes are kept, newest last, never the current one and never the
  internal `/app` mount.
- **A database that predates the field seeds itself.** On the first start
  after this shipped, `seedSlugHistory()` reads every name the company has been
  saved under out of the audit log (`Registered/Updated company "X"`, written
  since the beginning), maps them through `slugifyCompany` and records them —
  one line on the console, then never again (`undefined` means "never looked",
  `[]` means "looked, nothing to forward"). So an old address starts working on
  the next restart with nobody running anything.
- `node scripts/company-slug-history.js` only exists for a prefix neither of
  those can know — one used on an earlier installation, or from before the
  audit log was kept. `--add <slug> --apply` records it.

The database is **not** renamed: it is a fixed random id assigned at
registration (`utils/companyDb.js`), so a rename touches nothing but the name,
the prefix and — from then on — the id code.

### The id code every generated id starts with

`SP | FCS | 000001`, `SP | LS | 000047`, `SP | LOT | 0042` — the `SP` is the
**company's own id code**, not a constant. It comes from the Company master
(`idPrefix`, `models/system/company.js`) through `currentIdPrefix()` in
`utils/companyBrand.js`, read live at mint time, so changing it needs no
restart — the same live path the app name and the URL slug already take.

- **Typed, with a suggestion.** The field is pre-filled from the name by
  `suggestIdPrefix()` (initials of the words; first two letters of a one-word
  name: SACHIKO PACKAGING → SP, ORBIT LABELS PVT LTD → OL, ZACTAC → ZA) and
  left blank it keeps using that. It is typed because a company's short code
  is a fact about the company, not something a rule can guess — Zactac go by
  **ZC**, which no derivation from the letters produces. 2–4 letters or digits,
  validated in the route and on the field.
- **Changing the code moves the ids minted under it.** When the code changes
  (typed, or because the name's initials did), `rewriteIdPrefix()`
  (`utils/idPrefixRewrite.js`) moves every id carrying the **outgoing** code
  onto the new one — `GM | LS | 000047` → `XY | LS | 000047` — and says how
  many in the flash message and the audit entry. Ids from an *earlier* code are
  deliberately left alone: they belong to a period that is over, and moving
  them would make old stickers and paper records disagree with the screen a
  second time. `scripts/rewrite-id-prefix.js --from SP --to GM` moves one of
  those by hand (dry-run by default).
- **It is a blind scan of every string field, not a list of id fields.** The
  same id string is copied between documents — an order's Lot No is stamped
  onto its Deckles and Job Cards, and those copies are how they are matched
  back up — so a field missing from a list would quietly break a link. The
  audit log and every `*logs` collection are skipped: they record what happened
  under the code in force at the time, and are read as history, never as links.
  An id that would collide with one already under the new code is left alone
  and reported.
- **Numbering continues across a change.** Every generator takes its next
  number either from a `Counter` document or from the trailing 6 digits of the
  highest existing id (`parseSkuSeq`), both of which ignore the prefix. After
  switching to ZC, the master that follows `SP | FCS | 000025` is
  `ZC | FCS | 000026`, not `ZC | FCS | 000001`. The `exists()` probe each
  generator does is prefix-aware, so it can't collide either.

Every mint site reads `currentIdPrefix()` — Facestock / Adhesive / Core /
Release Master, Label Stock (id + SKU code, incl. `utils/labelStockVariant.js`),
Machine, Machine Job Card, Slitting Job Card, Maintenance ticket and Lot No.
Add a new one the same way; don't write the letters in.

`scripts/serialize-labelstock-sku-codes.js` mints too, so it calls
`refreshBrand()` after `connectDB()` and uses the same code — it used to
hardcode `SP`, which meant one run quietly renumbered every Label Stock SKU
back to SP on an installation that had set its own. Note that this script
renumbers *existing* rows, so it does move them onto the current code; that is
the one place existing ids change, and only when someone runs it with
`--apply`.

**Still hardcoded, deliberately:** the FAIRTECH-era `FS | CLIENT | 1`,
`FS | Tape | 000001` and `FS | <mat> | <cat> | 000001` ids in
`routes/fairdesk_route.js`. They are a different, older family whose prefix
never matched the company code even for Sachiko, so switching them would change
client and tape ids for an installation that has not renamed anything.

### Label Stock order rates follow the binding, not the product

On `/sachiko/sales/order`, a Label Stock row's Rate is a property of the
**`LabelStockBinding`**, whose identity is product + client + **Paper Size +
RM** (`buildLabelStockBindingSignature` in `routes/fairdesk_route.js`). One
product legitimately has several bindings at different rates — `C001WB` is
bound at 62.5/RM 300 = ₹20, 210/RM 1000 = ₹26 and 250/RM 2000 = ₹27.

So the rate **cannot** be settled when the Product Code is picked. `aiResolveRow()`
in `views/inventory/orders/salesOrderForm.ejs` re-runs on Product Code, Paper
Size *and* RM input, and:

- an exact binding match fills its rate and sets the row's `itemId`;
- no exact match leaves `itemId` empty and sets `labelStockMasterId` instead
  (the server auto-creates the binding), filling the rate from the client's
  other binding for the same product purely as a starting point;
- a hand-typed rate (`dataset.userEdited`) is never overwritten.

An auto-filled rate shows yellow until clicked — `aiValidateRows()` blocks
submit until it is acknowledged, so a rate that changed with the size can't be
submitted unseen. The acknowledgement is only re-armed when the figure actually
moves, since typing a size re-runs the resolve on every keystroke.

**`aiFindBinding()` must match the way the server's signature does** — Paper
Size trimmed and uppercased with whitespace runs collapsed, RM compared as a
number, blanks rejected (`Number("")` is `0` and would match a binding with no
RM). If the two drift apart the form shows a rate the order is not placed at.

### Finished stock export (to the FAIRTECH ERP)

The mirror of the paper re-order import below, going the other way: `/sachiko/finishedstock`
has an **Export to FAIRTECH** button that turns ticked finished rolls into the JSON file
FAIRTECH's `/fairtech/paperstock` **Import from Sachiko** takes in as paper stock.

Rolls are ticked **in the dialog** (the table's own ticks just pre-select it), styled after
FAIRTECH's own "Export to Sachiko" dialog. A roll FAIRTECH would refuse can't be ticked at
all — the file is all-or-nothing, so one bad roll must never reach the server.

`POST /finishedstock/export` **dispatches** as it exports — the rolls physically leave, so
they come off this stock in the same call, or the same reels are counted in both databases
at once. Nothing is deleted: the roll keeps its row and its whole INWARD/OUTWARD history,
`quantity` goes to 0 and `dispatchedAt` / `dispatchInvoiceNo` are stamped on it. A
dispatched roll then drops off `/sachiko/finishedstock` (which lists stock only) and shows
on **`/sachiko/finishedstock/dispatched`** with the invoice it went out on — recorded
outright rather than parsed back out of the OUTWARD log line's remarks.
Rolls are claimed with an atomic `quantity > 0` guard, so a double-click — or two people
exporting at once — can't dispatch the same roll twice; if any claim loses the race the
whole selection is put back.

The mapping, all of which are **required** on a FAIRTECH `PaperStock`, so each is validated
here rather than letting the import fail halfway through a delivery:

| finished roll | → | FAIRTECH |
|---|---|---|
| `material.productCode` **base code** | → | `Paper.prodCode` |
| `material.family` | → | `Paper.family` |
| `paperSize` / `mtrs` / `rate` | → | `paperSize` / `paperMtrs` / `rate` |
| `rollId` | → | `vendorRollId` (FAIRTECH mints its own `rollId`) |

**The base code is the trap.** A finished roll is booked against the Deckle's own Label
Stock, so its code is often a production-time variant (`C001WB-B`). That split is internal
to this app — FAIRTECH files the paper under `C001WB` and knows nothing about variants, so
exporting the variant verbatim misses the existing Paper there and mints a junk duplicate.
`baseProductCode()` strips it; the full code still travels as `variantProductCode`, for
tracing a reel back here only.

Rate comes from the sales order (see the slitting Stop handler), which is what makes the
export worth anything: it is what FAIRTECH books the reel in at.

### Paper re-order import (from the FAIRTECH ERP)

`/sachiko/sales/pending` has an **Import** button that takes the JSON file
FAIRTECH's `/fairtech/inventory/paper-reorder` page exports and turns it into a
multi-line Label Stock PO here. The two apps are separate deployments on
separate databases — the file is the whole interface, so everything has to be
re-resolved locally on the way in.

The handshake is the Product Code string both masters already share
(`SachikoLabelStock.productCode` ↔ FAIRTECH's `Paper.prodCode`: `C001WB`,
`P002WB`, …), plus the client name (`Username.clientName`) FAIRTECH is filed
under here. Neither is an id, so a rename on either side breaks the match —
which is why an unmatched code is reported per line rather than skipped.

Two steps, because nothing should be written from a file nobody has read:

1. `POST /sales/pending/import/preview` (multipart, field `file`) — parses the
   file, resolves every line, and parks the resolved rows **on the session**.
   Writes nothing. Each row reports its Label Stock master, whether a
   `LabelStockBinding` for that client + paper size + RM already exists (and so
   what rate to pre-fill), and whether this PO already brought the same line
   in. A line that can't be ordered carries an `error` and can't be ticked.
2. `POST /sales/pending/import/commit` — creates the ticked lines. The browser
   sends only *which* rows to include and at what rate; the products,
   quantities and sizes come from the session copy of the preview, so a
   doctored post can't smuggle in a line that was never shown.

Both call `createLabelStockPoLines()` in `routes/fairdesk_route.js` — the same
helper `POST /sales/order`'s multi-item branch uses. An imported PO is the same
PO, just typed by FAIRTECH's export instead of by hand, and it has to land on
exactly the same bindings, `orderSignature`s and `PendingProduction` rows.
**Don't fork it**: a second copy of that loop is how the two paths drift.

Notes on the resolution rules:

- **Location is never asked for.** It decides one thing — where a *newly
  created* binding is filed — and a client's paper belongs wherever that
  client's existing bindings already sit, so there is nothing to choose. The
  preview resolves it (this user's binding locations → the user's own location
  → the Location master when it holds exactly one entry) and carries it on the
  session to the commit; the browser never sends it. It can't simply be
  skipped: `resolveLabelStockBinding()` validates a location for *every* line,
  including lines whose binding already exists. A client with nothing to go on
  fails at preview with a message saying to bind a product first, rather than
  halfway through the commit.
- A rate is always required, even where a binding exists, because
  `resolveLabelStockBinding()` validates the rate before it looks the binding
  up. The preview pre-fills it from the matching binding, or failing that from
  the client's most recent binding for the same product (clearly marked as a
  guess). Editing it writes the new rate back to the binding, exactly as the
  Sales Order form does.
- Same PO + product + size + RM already on the books means the file has most
  likely been uploaded twice. That isn't an error — a genuine top-up under one
  PO number is legitimate — so the line starts **unticked** rather than
  blocked.
- `submissionToken` is `import-<upload token>-<line index>`, and the session
  entry is cleared on a successful commit, so re-confirming the same staged
  preview can't double-create.
- "-A"/"-B" variant Product Codes are excluded from the match, the same way
  `GET /sales/order`'s own Product Code picker excludes them (see "Label Stock
  Product Code variants").

The upload is multipart, so csurf can't find its token in the body — the client
sends it as an `x-csrf-token` header instead.

### Inward: the rows must add up to the invoice total

Every Add Stock dialog — **Facestock**, **Adhesive**, **Release Liner** and
**Core** — checks what the rows add up to against the total keyed off the
invoice, and refuses to save when they disagree in **either** direction. Too
much means a row has been keyed twice or a weight is wrong; too little means a
row is missing. Both put stock on the shelf that isn't what arrived, and
neither is recoverable from the rows alone afterwards — this is the one moment
someone has the invoice in front of them.

| page | rows | total |
|---|---|---|
| Facestock | reels, Kg | Total Kg |
| Adhesive | drums, Kg | Total Kg |
| Release Liner | reels, Kg | Total Kg |
| Core | lots, **Pieces** | **Total Pcs** |

Core counts pieces rather than weighing, so it got the field it never had
(`addTotalPcsInput`) and is compared as whole numbers — no tolerance, they
either match or they don't. The kg pages compare to 2 decimals with a 0.01
tolerance, so `100.005 + 99.995 + 100` against `300` passes rather than
tripping on floating point.

It is checked in three places, and all three have to stay in step: the dialog
header says the difference as it is typed (`summaryKgCheck` /
`summaryPcsCheck`), the submit refuses with the figures spelled out, and
`POST /create` runs the same test server-side — the total is sent with the
batch for exactly that reason. Before this, the total was a client-only field
that nothing compared and that never even reached the server.

### Reel labels: one sticker or a whole batch

On **`/sachiko/facestockstock`**, **`/sachiko/adhesivestock`** and
**`/sachiko/releaselinerstock`** alike — the three are the same page three
times over, so a change to one belongs in all three.

The inward sticker a reel (a drum, on Adhesive) gets stuck on it. Two ways in,
one label:

- a reel row's own **Print** button, for the one reel (`GET /label/:stockId`);
- **clicking any master row**, which opens **Print Reel Labels**: that spec's
  reels in stock, ticked off (or **Select all**) and printed in one pass
  (`GET /labels?ids=...`), one sticker per page, so a whole inward batch is
  labelled at the printer in a single run.

`views/stock/facestockRollLabel.ejs` renders **both**. It takes `labels` as an
array and nothing else changed for a single reel: with more than one, `<html>`
gets `class="sheet"`, which turns on a page break before every label after the
first (the `@page` IS one 101.5 x 75.1 mm sticker, so without it two would land
on the same page) and lets the body grow past one label's height. Don't fork it
into a second view — the SVG, the QR, the fit-to-box pass and the remembered
180° flip would then have to be fixed twice.

Notes on the dialog:

- **The preview is the print target.** The frame holds the very document that
  is printed (fetched and written in as `srcdoc`, for the same reason the
  single-reel dialog does it — navigating a frame to the URL dies on the login
  redirect's `X-Frame-Options` instead of saying the session has ended), and
  Print is `labelApi.print()` on it. Ticking re-fetches on a 300 ms debounce;
  Print re-fetches first if a debounce is still in flight, so it can never
  print the previous selection.
- **Only the ids travel.** Every value on every label is re-read from the
  database by the route, exactly as the one-reel route reads it. A reel deleted
  between opening the dialog and printing is dropped rather than failing the
  sheet, and the page says so — a silently short stack is how a reel ends up
  with no sticker on it.
- Printing writes nothing, so an **allotted** or **part-used** reel is still
  listed and still printable (it is a physical reel that needs a sticker like
  any other); its state shows as a badge.
- **Rotate 180°** is the same remembered per-PC setting the single-reel dialog
  sets (`localStorage.facestockLabelFlip180`, read by the label page itself —
  a `srcdoc` frame shares this origin's storage), because which way the stock
  feeds is a property of the printer, not of the reel.
- `MAX_LABELS_PER_SHEET` (200) caps one run.

Per pool, only the names differ: the table id (`#facestock-` / `#adhesive-` /
`#release-masters-table`), the mount the dialog fetches from, the flip key, the
noun on screen (Adhesive prints **drums**), and the spec line the dialog's
subtitle is built from — each page names its own master's fields (Adhesive has
no family/size/micron; Release Liner adds Sensing and Colour). The **kg field
is `reelMtrs` in every pool, drums included**; there is no `drumMtrs`.

Semi-Finished has its own copy of the label view and its own stock page; this
is not wired into it.

While this went in, **Create PO was switched off** on all three pages: the
button renders greyed and `disabled`, with `pointer-events: none` so the click
falls through to the row underneath rather than dying on a dead button, and the
reason on the cell's tooltip. Its dialog and `POST /purchase-order` are
untouched — drop the two lines in the Purchase Order column's formatter to turn
it back on.

One trap in that column's neighbourhood: `tableDisp.css` sets
`cursor: default !important` on `.tabulator .tabulator-row:hover`, so a plain
`cursor: pointer` on the row is overridden for the whole time the cursor is
actually over it. The rule has to name `:hover` and the `.tabulator-cell`
children, and carry `!important`.

### Label Stock Product Code variants

`SachikoLabelStock.productCode` (`models/sachiko/sachikoLabelStock.js`) is free text, not itself unique — only the full `labelStockSignature` (every user-editable field, Product Code included) is unique-indexed, so nothing used to stop the *same* Product Code being entered again for a genuinely different recipe (e.g. `C011` re-entered against a different vendor).

`POST /sachiko/label-stock/form` (`routes/sachiko/sachiko_route.js`) now resolves this at create time via `resolveProductCodeVariant()`:
1. Find every existing row named exactly the entered code or `<code>-<LETTERS>` (its variant family).
2. Compare recipes with `buildLabelStockSpecSignature()` — the same sha256 signature `buildLabelStockSignature()` already used, just built **without** Product Code (`labelStockSignatureParts(payload, { includeProductCode })` is the shared builder both call).
3. An existing family member has the identical recipe → rejected as a real duplicate, naming the existing Product Code it collides with.
4. No family member matches → a legitimate new variant → assigned the next unused single-letter suffix (`C011` → `C011-A` → `C011-B` → …, reusing a freed letter rather than always climbing).
5. No family yet → saved under the plain entered code, no suffix.

Only applies at create time — editing an existing row still uses the plain exact-duplicate `buildLabelStockSignature()` check and never renames a row into a new variant on its own.

### DOUBLE RELEASE / DOUBLE FACESTOCK: one reel may serve two layers

A DOUBLE RELEASE job is made in two passes — facestock + adhesive + release
liner as normal, then a second adhesive and a second liner on top — so
`LAYER_ORDER["DOUBLE RELEASE"]` is exactly that sequence
(`utils/labelStockProduction.js`).

Because the passes are **sequential**, one reel or drum may be allotted to more
than one layer: the second pass unwinds the same liner again and draws the same
glue again. `POST /labels/production/assign/:id` therefore does not refuse a
repeated pick at all. It used to, and that made these jobs unassignable: the
picker offers the one bound drum (and often the one liner of that spec), the
operator ticks it on both layers because there is nothing else to tick, and the
whole Assign & Continue bounced back to the form with a flash — allotting
nothing and never reaching the machine queue, which reads as "selecting the
material does nothing".

`produceDeckle()` is what makes that safe. A reel serving several layers is
grouped by reel id first (`drawByReel`), so it is:

- **checked once, against the total** — a drum with 102 left is refused for two
  100 m coats, where per-layer checks would each have passed;
- **deducted once, for the total** — the loop used to compute
  `reelMtrs - draw` per layer from the same starting figure and write both, so
  the second write overwrote the first and half the adhesive never left stock.

Each layer still writes its own OUTWARD log line, so the ledger says what each
coat took.

The machine queue has to answer the same way. `computeAllotmentCoverage()`
(`routes/system/machine.js`) **pools the layers that share a reel** and asks
whether that reel covers what they add up to, rather than counting it in full
on each (which would say the material goes twice as far as it does) or
splitting it (which invents a shortfall: 85 kg against needs of 35.3 + 43.0 is
enough, but no apportionment of it makes both sides land). Layers that share
nothing are measured on their own exactly as before.

### One deckle batch per deckle size

`POST /labels/production/deckle-set` creates **one `PendingProduction` batch per
deckle size the plan cuts**, not one per plan. A single-width plan makes the one
batch it always did; a mixed-web plan (660 × 8 + 635 × 15 + 510 × 3) makes
three, because they are three different things to make — three reels off the
shelf, three runs through the laminator, three rows in the Deckle Queue, three
Lot Nos, three machine assignments, three raw-material allotments.

Bundling them into one batch is what made Assign Production unreadable: the
batch-level `deckleSize` holds only whichever width carries the most webs, so a
635 mm batch asked for raw material against a 660 mm budget and the 635 mm reels
— the ones the job mostly runs on — came up flagged as too narrow.

How an order that is cut at more than one width is divided:

- layouts are grouped by `L.deckleSize ?? deckleSize`, widest first, and each
  group's `rollsByWidth` is worked out from its own layouts;
- each roll width's orders are served group by group, oldest order first, with
  the overflow landing on the last order out of the last group that cuts it
  (exactly where it landed when there was one group);
- the order's **own row** joins the first group it appears in; a further group
  gets a **clone** (`parentOrderId` = the order), the same device the shortfall
  rows have always used — which is why Dissolve already folds them back
  correctly, one batch at a time (it only re-merges a spare row whose parent is
  itself loose);
- whatever no group cuts is carved off to Deckle Sorting as before.

`rollsByWidth` is keyed on **`orderedWidth ?? width`**. Where the planner
applied grace the knife is set wider than the order (157.5 mm for a 150 mm
roll), but the roll that comes off is still that order's, and it is billed at
150 — keying on the knife width left those rolls belonging to nobody, so the
order read as short and had its balance carved off while the rolls were on the
machine.

Per-layout `deckleSize` is **not** stored on the new batches (inside a
single-width batch it is the batch's own size). Slitting Allocation's
`BATCH_LAYOUT_FOR_WEB` filter already treats a layout with no width as always
applicable, so its pre-fill is unaffected.

Batches created before this change are still mixed. There is no migration:
dissolve one from the Deckle Queue and re-create it from Deckle Set, which is
the documented way a batch's size is changed anyway.

### Machine queue: how far the allotted material gets

`buildQueueRows()` (`routes/system/machine.js`) reports, per order, **how many
rolls the reels actually allotted to it will run** — shown under Required Rolls
as "material for 4 of 15" and spelled out in the row's dialog.

`materialStatus` has **three** states, not two:

| state | meaning | row | can start |
|---|---|---|---|
| `match` | every layer allotted, and enough of it for the whole job | green | yes |
| `partial` | every layer allotted, but it runs out part way | amber | **yes** |
| `short` | at least one layer has no reel at all | red | no |

`partial` exists because the old yes/no test only asked *is there a reel on
every layer*, which says yes to a 27 kg remnant standing in for a 770 kg job —
an order could sit green on the queue and stop three deckles in. A partial job
still starts: every layer is on the machine, so it runs and stops when the
material does, which is a normal way to work; the queue says how far it will get
rather than barring it. The Facestock/Adhesive/Release badges fold the same fact
in — "Partial" now means either *one of two layers of that pool* or *allotted
but not enough*, and the tooltip says which.

`computeAllotmentCoverage()` does the arithmetic with the same two figures
Assign Production measures against (`utils/rawMaterialNeed.js`: kg and running
metres per layer) and the same `kg x 1e6 / (gsm x width)` conversion — the
reel's own GSM and width, or the recipe's wet GSM over the job's web for a drum.
Coverage is the **worst layer** (a deckle is every layer at once), and rolls are
rounded **down**: a deckle half fed is a deckle that stops mid-run. When *no*
reel on a layer can be turned into a length (no GSM recorded), the metres side
measures nothing, so the weight alone answers and the count of unmeasurable
reels is reported instead — "0 of 15" with 800 kg on the machine is worse than
saying nothing. A layer where only *some* reels are unmeasurable keeps both
sides and so reads low, which is the safe direction.

### Undoing an assignment (taking a job back off a machine)

"Undo" is `POST /labels/production/unassign/:id` — the order goes back to
Pending, the machine/operator/helper are cleared, every reel and drum allotted
to it is released, any Deckle laminated at **Assign & Continue**
(`producedVia: "assign"`) is un-made and its material returned to the reels it
came off, and the **Lot No is kept** so a re-assignment reuses it.
`liveMaterialInUse` **and** `runningOn` are cleared with it: a job that had
Start punched carries a device claim that only the job card's save would
otherwise clear, and left behind it follows the order back to Pending and
blocks the next device for 15 minutes.

It is offered on the **machine queue row** (the natural place — that is where
the job is looked at) and on the WIP tab. `buildQueueRows` decides it as
`canUndo` / `undoBlockedReason`, from the same facts the POST refuses on, so a
greyed button is never a surprise and an offered one never bounces. Operators
don't see it (same `canEditOrder` gate as the Edit button).

| state of the job | undo? |
|---|---|
| assigned, untouched | yes |
| Start punched, reels scanned, nothing made | yes — the scanned reels are released |
| a Stop punched (a Deckle inwarded off the log) | **no** — save the Job Card to close it out |
| a reel reconciled mid-job (`materialSwapLog`) | **no** — same |
| already produced (`producedAt`) | **no** |

Once material has moved there is no clean reversal from here: the raw a
job-card Deckle consumed is only settled when the whole card is saved, and
`dissolveDeckle` has no lamination ledger to reverse for it. The way out is to
open the Job Card and **Save Production Entry** (or cancel the order). To undo
a produced Deckle deliberately, `node scripts/dissolve-deckle.js <deckleId>`
first, then undo.

An undo pressed on a queue returns to that queue (`from`, validated against
this app's own queue paths); from anywhere else it lands on Deckle Set, where
the job now is.

### WIP tab: only jobs that have started, and what "live" means

`/sachiko/labels/production/pending?tab=wip` lists **jobs an operator has
actually started** — not every order sitting on a machine queue. Being
assigned is not being in progress: an order can wait days on a queue, and
listing those buried the handful genuinely running.

The membership test and the Live Status column are the same question, answered
by `buildJobCardProgressMap()` (`routes/fairdesk_route.js`). A `MachineJobCard`
is written **once, by Save Production Entry, at the end of the job**, so
reading only cards left this column saying "Not started" for a job that had
been running for hours with Deckles already in Semi Finished Stock. Three
things the shop floor writes as it goes are folded in, all of them already
there to be read:

| signal | written by | shows as |
|---|---|---|
| `MaterialStock.producedFor` + `producedVia: "jobcard"` | each Stop punch (`POST /machine/jobcard/log/produce`) | the metres, tagged **LIVE** |
| `PendingProduction.runningOn` | first Start (`POST /api/operator/jobcard/claim`), heartbeated | **Running** |
| `PendingProduction.liveMaterialInUse` | each reel scanned (`POST /machine/jobcard/mark-in-use`) | **In Setting** |
| `MachineJobCard` | Save Production Entry | the filed figures |

Three rules hold it together:

- **A Deckle is counted once.** A card's Production Log row carries the same
  `rowToken` (and `deckleId`) the Deckle was minted with, so a Deckle a card
  already accounts for is matched and skipped rather than added again.
- **`producedVia: "assign"` never counts.** Those Deckles are the order's raw
  material being laminated at Assign & Continue, not metres it has run —
  counting them would show every freshly assigned order as part-produced.
- **Started is persistent, running is not.** `runningOn` is cleared only when
  the card saves, so its *presence* is "started"; `activeClaim()` (exported
  from `routes/api/operatorApi.js`, one definition of the 15-minute freshness
  rule) is what makes the badge say Running. A tablet that dies leaves the job
  listed, reading "In Setting".

Because rows now **join** when a job starts and **leave** when it is produced,
`GET /labels/production/wip-progress` answers with the whole row set (same
query, same `mapPendingProductionRow()`, same filter as the page render) and
the poll reconciles: update, add, and delete what is no longer there. It used
to send progress alone and call `wipTable.updateData()`, which rejects on any
row the table doesn't have.

"Send Back to Pending" is disabled on `canSendBack`, computed from the same
facts `POST /labels/production/unassign/:id` refuses on (anything produced, or
a reel reconciled mid-job) — *not* on "has this job started", which is the one
case most worth sending back. Note this tab is the only UI path to that
action, so an assigned-but-not-yet-started order can no longer be un-assigned
from here (`scripts/send-back-to-pending.js <orderId>` still does it).

### Auto Allot (`public/js/rawAutoAllot.js`)

The **Auto Allot (FIFO)** button in Raw Material Allotment on
`/labels/production/assign/:id`. Ticks the Facestock/Adhesive/Release Liner
reels the job needs, oldest stock first, and says how much of the batch can
actually be laminated. It only ticks checkboxes a person could have ticked
themselves — nothing is reserved until **Assign & Continue**, and the server
neither knows nor cares that a pick came from it.

Split the same way `utils/deckleOptimizer/` is: the planner is plain numbers in,
plain numbers out (no DOM, no fetch), so it can be tested without a browser —
`scripts/raw-auto-allot-bench.js` loads it into a `vm` context and asserts the
rules below. `assignProduction.ejs` does the measuring (what a reel weighs, the
length that weight gives at its own width) and the rendering.

**A job is not one width.** This is the whole reason the planner works in
*demands* rather than layer totals. A mixed-web batch laminates several widths
(660 × 8 + 635 × 15 + 510 × 3) and the laminator mounts a reel per run, so the
requirement is one demand per web width and a reel can only serve a demand it is
wide enough for. Oldest-first over one flat list hands the three oldest 510 mm
reels to the whole job and reads 100% allotted for a plan that cannot cut a
single one of its 23 wider deckles. Demands are served widest first (those
widths have the least to choose from). A **drum has no width**, so the adhesive
states one demand for the whole job — splitting it per web would round a
part-drum up once per width and lock drums the job never needed.

The requirement per width is a *share* of the figures already on the Raw
Material Required strip — metres by each width's share of the running metres, kg
by its share of the area — so the parts add back to exactly what the bars show
and the two can never disagree.

Order of choice: exact-fit before wider (a 1020 mm reel run for a 660 mm web
loses 360 mm to trim for the whole job), then FIFO on `inwardDate` (falling back
to `createdAt`; a reel with neither sorts last), stopping the moment a demand is
covered on **both** kg and running metres. A reel wider than the web it serves
only counts the weight that lands on the web (`width / reel width` of it) — the
rest is trim, and counting it says covered while the machine runs out.

**The reel that tops a demand off is chosen by size, not by date.** While the
next reel by date still leaves the demand short, take it — old stock the job
will consume in full costs nothing. Only when that next reel would *overshoot*
is the choice reopened, and then the leanest reel that finishes the job is taken
instead. Without this, a 125 kg demand took the 102 kg remnant, landed 23 kg
short, and reached for a 630 kg reel because that was next by date: 732 kg
locked to a 125 kg job with a 27 kg remnant of the same paper still on the
shelf. It now picks 102 + 27 = 129 kg. The test is on **the next FIFO reel**,
not "can any reel finish this" — a full reel can nearly always finish a small
demand alone, so asking that first walks straight past every remnant, which is
the opposite of what FIFO is for. The width tier still outranks it: a wider reel
loses trim down the whole run, which costs more than the tail it saves.

**Matching to the shortest** (the toggle, on by default) allots every layer only
what its widths can actually run: if the liner covers two thirds of the 635 mm
webs, allotting a full 15 webs of facestock reserves paper that cannot be
laminated for want of liner. Worked out per width, since a shortage at one width
says nothing about another. What it cost is reported in **reels actually held
back**, never as a percentage — whole reels mean a layer often comes out at the
same pick either way, and claiming a layer was cut back when it wasn't is how a
button like this loses trust.

A layer with nothing pickable at all (no adhesive binding, nothing of that spec
in the store) is reported as **blocked** and left out of the width arithmetic —
letting its zero through would scale every other layer to nothing and tick
nothing anywhere, which says less than ticking what is there and naming the
blocker. `runMtrs` still goes to 0: a deckle is every layer at once.

**The allotment tables list this deckle's own web width and nothing else**
(`reelFitsBatchWeb`). A store holds every size the plant runs, and scrolling
past 510 mm and 1020 mm reels to find the 635s — with the chance of ticking one
by mistake — is not a choice worth offering on a page whose whole job is one
deckle size. Drums are never narrowed (no width); a reel with no Size recorded
is hidden with the rest. The count of off-width reels sits under the column
heading as a **toggle**, off by default: a store can run out of the exact width
while a 640 mm reel that would run a 635 mm web sits on the shelf, and hiding it
outright would leave the job unassignable. A reel that is **ticked** stays
listed whatever its width — the tick lives in the checkbox, so filtering its row
away would silently un-allot it. Auto Allot only ever considers what the table
shows.

**Ticked reels are pinned to the top of their column** (`sortedReelsFor` takes
the checked set as its first sort key; the column sort orders each half). A
layer can hold several reels out of a fifty-row list, and a pick two thirds of
the way down was invisible from the top of the page. A tick re-renders that
column, so the row moves up as it is ticked.

**"Too narrow" means narrower than *every* web in the plan.** Judging reels
against the single widest web marked the batch's own main width unusable — on a
batch whose `deckleSize` is 635 the page filtered the table down to 635 mm reels
and then painted every one of them amber. For the same reason a mixed-web batch
no longer has its Size filter seeded with one width, and `applyDeckleSize()`
no longer overwrites the card's list of every web with the single headline
number. `rawNeed.budgetWidthMm` (the widest web) is still what an adhesive
drum's weight is spread over — it is not a fit test.

### Auto Deckle (`utils/deckleOptimizer/`)

Automatic deckle layout planning behind the **Auto Set Deckle** panel on
`/labels/production/deckle-set/plan/:itemId`. Deliberately a standalone module —
no mongoose, no express, no session; plain numbers in, plain numbers out — so
the algorithm can be developed and benchmarked without disturbing the manual
planner it sits beside.

| File | Role |
|---|---|
| `patterns.js` | Enumerates every feasible A–L knife layout. Widths handled as integer hundredths of a mm (decimal paper sizes make float `<=` unsafe). |
| `solver.js` | Picks how many webs of each pattern to run: greedy warm start, then branch & bound under node/time budgets. |
| `index.js` | Public API `planDeckleLayouts()`, the `deckleSize` outer loop, overrun caps, waste accounting, `isDeckleAutoEnabled()`. |

The underlying problem is one-dimensional cutting stock with three wrinkles:

1. **Deckle size is an outer choice** — by default one size serves the whole
   batch: each candidate is solved independently and the cheapest wins. With
   **mixed webs** (below) every size's patterns go into one solve and each
   layout may come off a different width.
2. **One roll length per layout** — `plannedRunningMeter` belongs to the layout,
   not to a knife position, so orders wanting different roll lengths can never
   share a layout. Orders are partitioned by running metres, one instance each.
3. **Demand is in rolls, supply is in position-webs** — one knife position on one
   web yields `floor(deckleRunningMeters / plannedRunningMeter)` rolls. This
   granularity, not the packing, is usually what forces an overrun.

**Objective**: minimise facestock consumed (`deckleSize × deckleRunningMeters ×
webs`). Under-production is never allowed and the ordered roll area is fixed, so
useful area is identical in every feasible plan — which makes "least consumed"
exactly equivalent to "least waste", and with Deckle R.M. fixed by the planner
the whole objective collapses to minimising `deckleSize × totalWebs`.

**Mixed webs** (the *Different web per layout* toggle) lets each layout be cut
from whichever deckle width suits it. Often a large trim reduction — on a real
4-order job it took waste from 6.38% to 1.48% and removed the overrun entirely.
Because the mixed search space *contains* every single-size answer it can only
match or beat one width — but only if its search gets far enough, and that space
is much bigger for the same budget. So `planDeckleLayouts` always runs the
single-size search too and keeps the mixed plan only if it is genuinely cheaper,
which turns that property into a guarantee. When mixed loses, `notes` says so.

Mixed webs changes what has to be persisted, so it goes all the way through:

- `PendingProduction.deckleLayout[].deckleSize` — the width **that** layout is
  cut from. The batch-level `deckleSize` holds whichever width carries the most
  webs (it is one number, and the Deckle Queue / Assign Production / job card
  all show it). Read per-layout as `L.deckleSize ?? pending.deckleSize` —
  batches saved before mixed webs have no per-layout width.
- Slitting Allocation allocates the Deckles of **one** width at a time (they are
  grouped by reel size), so its layout pre-fill filters `BATCH_LAYOUT` down to
  the layouts planned for that web. Without that filter a 1250 mm layout would
  seed onto a 510 mm deckle.

**Overrun** — spare rolls made beyond what was ordered — is bounded by two
ceilings, both editable on the page, of which the tighter one binds:

    allowed extra = min( ceil(qty * pct), maxExtraRolls )

`pct` (default 10%) scales with the order and usually governs; `maxExtraRolls`
(default 5) is the absolute stop that keeps a large order from authorising a
pile of spares. Either at 0 means no overrun at all. The percentage is rounded
up so even a 3-roll order gets a whole roll of room.

Spares are not extra consumption: the web count is already at its minimum, so a
knife position carrying a spare uses width that would otherwise have been
trimmed off and scrapped. Where the rolls-per-web granularity makes even the cap
unreachable (4 rolls ordered, 3 per knife position — 6 must be made), the cap is
widened for that width rather than the plan being refused, and `notes` says so,
so a forced overrun is never silent.

**Waste accounting** follows from that, and the two balances are asserted by
`scripts/deckle-optimizer-bench.js` — break either and the bench fails:

    consumedSqM = usefulSqM + edgeSqM + sideTrimSqM + endTrimSqM
    usefulSqM   = orderedSqM + overrunSqM

The optimizer's own `wasteSqM` (and `wastePct`) is **scrap only** — edge trim +
side trim + end tail. `overrunSqM` is a *slice of* `usefulSqM`, not a sibling of
it: a spare roll is wound onto a finished roll off width that would otherwise
have been trimmed away, and consumption is fixed by `size x drm x webs` before
anything is cut, so booking it as waste charges the plan twice for width it
never lost. It once did exactly that, which left the headline roughly double and
unable to reconcile with its own parts.

**The Set Deckle page's headline is `Total`, not waste**, and it is a wider
figure than the optimizer's: everything the job gives up beyond the widths that
were **ordered**, which is edge trim + Side Run (both scrapped) *and* **Grace**
(cut and wound, but handed to the rolls rather than billed). Grace is not scrap
— that is exactly why the column and the chip are not called waste — but it is
width the client did not order and is not paying for, so leaving it out of the
headline made a graced plan look tighter than it is. Per layout it works out as
`deckle size − the ordered roll widths`, which is what makes the row add up
across.

Side Run, Grace and Total are all **whole-job totals**, in mm as well as %,
never a per-web average — Side Run mm is every web's side trim added up, and the
others likewise. That makes them reconcile by eye, which is the quickest check
the figures are sane:

    Total  =  edge trim x webs  +  Side Run  +  Grace

in mm and in % alike, matching the recap table's Siderun / Trim / Grace / Total
columns. (Showing a per-web average beside a whole-job percentage is what
previously made these look like they disagreed.) Grace is already netted out of
Side Run — the slack is what is left *after* it was shared out — so the three
never double-count. The spare stock stays visible as m² beside the Extra Rolls
count, so nothing is hidden by keeping it out of the headline.

`POST /labels/production/deckle-set/plan/:itemId/auto` is **read-only**: it
creates nothing and changes nothing, it only answers "here is the least-waste way
to cut these". Order widths, quantities and roll lengths are re-read from the
database — the client chooses *which* orders to plan, never what they say. The
planner reviews the layouts it drops into the form and still presses Create
Deckle Batch, which goes through the same POST and the same validation as a
hand-drawn plan. That is what makes it safe on a production server: a wrong
answer is discarded by not saving it.

### Deckle Calculator (`/labels/production/deckle-calculator`)

The Set Deckle planner with nothing behind it — a **Calculator** tab of its own
in the sidebar. Same web strip, same layout dialog, same grace panel, same AI
Deckle Set and the same figures as
`/labels/production/deckle-set/plan/:itemId`, so a plan worked out here reads
exactly as it will when the same plan is set for real. Two differences:

- **The requirements are typed**, not read off loose orders — roll width,
  running metres, roll quantity. It answers "what would this job cost me in
  trim" before there is an order to plan.
- **It ends nowhere.** No Create Deckle Batch, no POST that writes: the page
  creates no batch, touches no order and stores nothing. A wrong answer is
  discarded by closing the tab.

Three files, plus one route each for the page and the optimizer:
`views/utilities/deckleCalculator.ejs`, `public/js/deckleCalculator.js`,
`public/css/deckleCalculator.css`. The ids and classes are the Set Deckle
page's own (`dsf-`/`sl-`) and the stylesheet started as a copy of that page's
inline `<style>` block — that page renders with `CSS: false`, so there is
nothing to share yet. **Change one and look at the other**: they are two
copies of the same rules, and a fix to a shared behaviour (the web strip, the
grace panel, the recap) has to be made twice.

Where the two deliberately differ, and why — keep these, they are not drift:

- **Recap columns are narrower** (`min-width: 1240px`, diagram 46%/380px
  against the original's 1520/560). Thirteen columns at the original widths put
  Rolls, Deckle and the footer's own totals off the right edge of the card on a
  laptop, so you scrolled sideways to read the figures the table exists to show.
- **The per-column filter boxes carry a drawn magnifier, not the word
  "Search"**, which clipped to "Sear" in the 74px Trim and Grace columns.
- **Available Sizes are chips**, and a width the store does not hold is drawn
  dashed and grey (`.dsf-size-item.is-added`) — on the Set Deckle page every
  candidate comes from stock by construction, so there is nothing to
  distinguish.
- **Requirements** (the numbered card, its totals row, the short/spare/exact
  states) exist only here; the Set Deckle page lists orders instead.
- **One deckle width folds into the chip row** rather than taking a full-width
  bar of its own; the bar is kept for the multi-width list, which is what it
  was for.

A rule left unclosed in a stylesheet swallows every declaration after it in
silence — no error, the styles just stop applying. That happened once here,
so **check the braces balance after editing either file**; there is a
throwaway checker in the session notes, or `node -e` over the file counting
`{`/`}` outside comments does it.

What it reads, and what it does not:

- **Available Sizes opens on the facestock widths in stock** (every width, with
  its reel count and kg on the chip's tooltip), so a plan starts from reels
  that exist. `suggestDeckleSize()` narrows the same roll-up to one recipe for
  the Set Deckle page; there is no recipe here, so nothing is narrowed. It is a
  starting point only — the pencil adds and removes, and nothing is tied back
  to the store.
- `POST /labels/production/deckle-calculator/auto` hands the typed requirements
  to `planDeckleLayouts()` and returns the plan. Unlike its sister endpoint it
  does **not** re-read anything from the database — there is nothing to re-read
  (the requirements exist only on the page) and nothing to protect (the handler
  owns no data and writes nothing), so a doctored request can only produce a
  wrong answer in the asker's own browser. Same `DECKLE_AUTO_ENABLED` kill
  switch: off, the page renders with no panel and the endpoint returns 503.

**A requirement is a width AND a roll length, and rolls are matched on both.**
20 rolls of 150 mm at 300 m are not met by 150 mm rolls wound to 1000 m, and
"Rolls Set" says so ("no layout at this length") rather than reading as a plain
shortfall. The Set Deckle page pools by width alone, which it can afford to —
its orders come out of one Deckle Sorting group — but anything at all can be
typed side by side here. Either side may leave the length unstated (a layout
with no Deckle R.M./R. Meter, or a requirement with no Running Mtrs) and then
it matches whatever the other side says; exact matches are served first.

**Each layout picks its own deckle web**, and a layout that has not picked one
is shown on the best fit **for its own knives** — not for the widest layout on
the page. Measuring the whole plan against its widest layout is what would put
a 600 mm run on the 1000 mm web its neighbour needs, and then report the trim
of a job nobody would run.
