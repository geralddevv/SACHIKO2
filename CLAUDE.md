# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (node server.js) — port from PORT in .env, default 3001
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
node scripts/resignature-labelstock.js           # resync every /sachiko/label-stock/view row's labelStockSignature + list rows sharing a recipe (--apply to write)
node scripts/serialize-labelstock-sku-codes.js   # close gaps in SachikoLabelStock skuCode + re-anchor variant SKUs ("000002-A") to their base row's SKU
node scripts/dissolve-deckle.js [deckleId]       # un-make a Deckle, returning its mtrs to the raw reels it was laminated from
node scripts/backfill-family-master-seed.js      # seed the Family master with values already in use on Label Stock / Facestock Master + the old hardcoded dropdown list
node scripts/backfill-type-master-seed.js        # seed the Type master with values already in use on Facestock / Adhesive / Release Master + the old hardcoded dropdown lists
node scripts/deckle-optimizer-bench.js [--verbose]  # bench + invariant check for utils/deckleOptimizer; no DB, exits non-zero on failure
```

## Environment

Requires a `.env` file with at minimum:
- `SESSION_SECRET` — app crashes at startup without this
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

### Label Stock Product Code variants

`SachikoLabelStock.productCode` (`models/sachiko/sachikoLabelStock.js`) is free text, not itself unique — only the full `labelStockSignature` (every user-editable field, Product Code included) is unique-indexed, so nothing used to stop the *same* Product Code being entered again for a genuinely different recipe (e.g. `C011` re-entered against a different vendor).

`POST /sachiko/label-stock/form` (`routes/sachiko/sachiko_route.js`) now resolves this at create time via `resolveProductCodeVariant()`:
1. Find every existing row named exactly the entered code or `<code>-<LETTERS>` (its variant family).
2. Compare recipes with `buildLabelStockSpecSignature()` — the same sha256 signature `buildLabelStockSignature()` already used, just built **without** Product Code (`labelStockSignatureParts(payload, { includeProductCode })` is the shared builder both call).
3. An existing family member has the identical recipe → rejected as a real duplicate, naming the existing Product Code it collides with.
4. No family member matches → a legitimate new variant → assigned the next unused single-letter suffix (`C011` → `C011-A` → `C011-B` → …, reusing a freed letter rather than always climbing).
5. No family yet → saved under the plain entered code, no suffix.

Only applies at create time — editing an existing row still uses the plain exact-duplicate `buildLabelStockSignature()` check and never renames a row into a new variant on its own.

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

`POST /labels/production/deckle-set/plan/:itemId/auto` is **read-only**: it
creates nothing and changes nothing, it only answers "here is the least-waste way
to cut these". Order widths, quantities and roll lengths are re-read from the
database — the client chooses *which* orders to plan, never what they say. The
planner reviews the layouts it drops into the form and still presses Create
Deckle Batch, which goes through the same POST and the same validation as a
hand-drawn plan. That is what makes it safe on a production server: a wrong
answer is discarded by not saving it.
