# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (node server.js) on port 3000
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
node scripts/serialize-labelstock-sku-codes.js   # close gaps in SachikoLabelStock skuCode + re-anchor variant SKUs ("000002-A") to their base row's SKU
node scripts/dissolve-deckle.js [deckleId]       # un-make a Deckle, returning its mtrs to the raw reels it was laminated from
node scripts/backfill-family-master-seed.js      # seed the Family master with values already in use on Label Stock / Facestock Master + the old hardcoded dropdown list
node scripts/backfill-type-master-seed.js        # seed the Type master with values already in use on Facestock / Adhesive / Release Master + the old hardcoded dropdown lists
```

## Environment

Requires a `.env` file with at minimum:
- `SESSION_SECRET` — app crashes at startup without this
- `MONGO_URI` (or equivalent — see `config/db.js`)
- `TASKS_MONGO_URI` (optional) — the `/fairtech/tasks` feature stores its data in a separate, isolated database (`config/tasksDb.js`), for privacy. Without this set, it defaults to a sibling database named `<main db>_tasks` on the same server as `MONGO_URI`.
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

### Label Stock Product Code variants

`SachikoLabelStock.productCode` (`models/sachiko/sachikoLabelStock.js`) is free text, not itself unique — only the full `labelStockSignature` (every user-editable field, Product Code included) is unique-indexed, so nothing used to stop the *same* Product Code being entered again for a genuinely different recipe (e.g. `C011` re-entered against a different vendor).

`POST /sachiko/label-stock/form` (`routes/sachiko/sachiko_route.js`) now resolves this at create time via `resolveProductCodeVariant()`:
1. Find every existing row named exactly the entered code or `<code>-<LETTERS>` (its variant family).
2. Compare recipes with `buildLabelStockSpecSignature()` — the same sha256 signature `buildLabelStockSignature()` already used, just built **without** Product Code (`labelStockSignatureParts(payload, { includeProductCode })` is the shared builder both call).
3. An existing family member has the identical recipe → rejected as a real duplicate, naming the existing Product Code it collides with.
4. No family member matches → a legitimate new variant → assigned the next unused single-letter suffix (`C011` → `C011-A` → `C011-B` → …, reusing a freed letter rather than always climbing).
5. No family yet → saved under the plain entered code, no suffix.

Only applies at create time — editing an existing row still uses the plain exact-duplicate `buildLabelStockSignature()` check and never renames a row into a new variant on its own.
