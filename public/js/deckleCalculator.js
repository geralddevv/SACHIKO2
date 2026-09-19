/* ==========================================================================
   Deckle Calculator  --  /labels/production/deckle-calculator
   ==========================================================================

   The Set Deckle planner with nothing behind it. Type the rolls you want and
   the deckle sizes you can get them on, draw the layouts by hand, read the
   trim off. It creates no batch, touches no order and writes nothing: there
   is no submit on this page and no endpoint behind it.

   Everything that draws or measures a web is lifted straight from
   views/inventory/orders/deckleSetForm.ejs -- same segment builders, same
   grace panel, same recap table, same figures -- so a plan worked out here
   reads exactly as it will when the same plan is set for real. The ids and
   classes are that page's too (the dsf- and sl- prefixes), which is what lets
   public/css/deckleCalculator.css be a straight copy of its <style> block.

   What is this page's own:

   - Requirements are TYPED, not read off loose orders (dc-* markup below).
   - A requirement is a width AND a roll length, and rolls are matched on
     both: 20 rolls of 150 mm at 300 m are not met by 150 mm rolls wound to
     1000 m. The Set Deckle page pools by width alone, which it can afford to
     -- its orders come out of one Deckle Sorting group -- but here anything
     at all can be typed side by side. Either side may leave the length
     unstated, and then it matches whatever the other side says.
   - Each layout picks its own deckle web (the Set Deckle page's "mixed webs",
     which ships on there too). Picking a size inside a layout's own size
     table sets that layout's web; the headline figure is whichever width
     carries the most webs.
   - Deckle Size is typed, every one of it -- the list starts empty. The
     facestock in stock is read only to annotate a width once it is in: a
     chip says how many reels of that width are on the shelf, or is drawn
     dashed when there are none. Nothing here is tied back to the store.

   AI Deckle Set is the same panel and the same optimizer as the Set Deckle
   page's, over typed requirements instead of orders. It plans and never
   saves: what comes back is dropped into the layout rows, and from there it
   is edited by hand like any other plan.
   -------------------------------------------------------------------------- */

(() => {
  const SLOTS = JSON.parse(document.getElementById("dc-slots").textContent);
  const CFG = JSON.parse(document.getElementById("dc-cfg").textContent);
  // [{ size, reelCount, totalKg }] -- the facestock widths on the shelf.
  const STOCK_SIZES = JSON.parse(document.getElementById("dc-sizes").textContent);
  const SUB_COLSPAN = Number(CFG.subColspan) || SLOTS.length + 5;
  const DEFAULT_TRIM = Number(CFG.trimDefault) || 5;
  const DEFAULT_DRM = Number(CFG.defaultRunningMeters) || 1000;

  // Sane bounds -- a deckle web is a label reel, never a few mm and never
  // metres wide; R.Meter figures are lengths, not widths. Used only to catch
  // fat-finger input, not to model the real machine limits.
  const MIN_DECKLE_MM = 25;
  const MAX_DECKLE_MM = 2000;
  const MIN_WIDTH_MM = 1;
  const MAX_RM = 1000000;
  const MAX_QTY = 1000000;

  const round2 = (n) => Math.round(n * 100) / 100;
  const fmt = (n) => (Number.isFinite(n) ? round2(n).toLocaleString("en-IN") : "—");
  const fmtI = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-IN") : "—");
  const esc = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const trimmedVal = (el) => (el ? String(el.value).trim() : "");

  // One .dsa-stat chip for the summary bar at the foot of the page.
  const finalStat = (k, v, cls, wrapCls, title) =>
    `<div class="dsa-stat${wrapCls ? " " + wrapCls : ""}"${title ? ` title="${esc(title)}"` : ""}>` +
    `<span class="k">${esc(k)}</span><span class="v${cls ? " " + cls : ""}">${esc(v)}</span></div>`;

  // ---- elements ----------------------------------------------------------
  const dsfTrim = document.getElementById("dsfTrim");
  const drmDefaultEl = document.getElementById("dcDrmDefault");
  const layoutBody = document.getElementById("dsfLayoutBody");
  const layoutStatus = document.getElementById("dsfLayoutStatus");
  const layoutTable = document.getElementById("dsfLayoutTable");
  const layoutModal = document.getElementById("dsfLayoutModal");
  const layoutModalTitle = document.getElementById("dsfLayoutModalTitle");
  const dsfAddLayout = document.getElementById("dsfAddLayout");
  const dsfSetBody = document.getElementById("dsfSetBody");
  const dsfSetSub = document.getElementById("dsfSetSub");
  const dsfSetHead = document.getElementById("dsfSetHead");
  const dsfFinalStats = document.getElementById("dsfFinalStats");
  const dsfStatChips = document.getElementById("dsfStatChips");
  const reqBody = document.getElementById("dcReqBody");
  const sizeFieldsEl = document.getElementById("dsfSizeFields");
  const sizeMsgEl = document.getElementById("dsfSizeMsg");
  const dsfIssues = document.getElementById("dsfIssues");
  const dsfIssuesBody = document.getElementById("dsfIssuesBody");
  const gracePanel = document.getElementById("dsfGracePanel");
  const graceBtn = document.getElementById("dsfGraceBtn");
  const resetBtn = document.getElementById("dcReset");
  const resetLabel = document.getElementById("dcResetLabel");
  // Null when DECKLE_AUTO_ENABLED=false -- the panel is not rendered at all.
  const dsaRun = document.getElementById("dsaRun");
  const dsaBody = document.getElementById("dsaBody");

  // ---- edge trim ---------------------------------------------------------
  // Per-side edge trim, live from the editable "Edge Trim (total mm)" field.
  let EDGE = DEFAULT_TRIM / 2;
  function readTrim() {
    const t = Number(dsfTrim && dsfTrim.value);
    EDGE = (Number.isFinite(t) && t >= 0 ? t : DEFAULT_TRIM) / 2;
  }
  // Edge Trim is an open field on the control strip -- there is no longer a
  // pencil to swap text for an input. All that is left of that pair is the
  // guard it carried: a blank or negative entry goes back to the default
  // when the field loses focus, so EDGE is never read off nonsense.
  function normaliseTrim() {
    const t = Number(dsfTrim.value);
    if (!(Number.isFinite(t) && t >= 0)) dsfTrim.value = DEFAULT_TRIM;
  }

  // ---- available deckle sizes --------------------------------------------
  // Seeded from the facestock widths in stock, the way the Set Deckle page
  // seeds from the stock matching its recipe. With nothing in the store the
  // list starts empty and the editor opens itself -- a size is the one thing
  // the page cannot work without.
  // Empty. Every width on this page is typed: it used to open pre-filled
  // with the whole facestock store, which answers "what is on the shelf"
  // when the question being asked is "what can this job be cut on" -- and
  // five chips had to be read and mostly removed before the first one that
  // mattered could go in.
  let SIZE_LIST = [];
  // Stock is still read, but only to annotate a width somebody has typed:
  // whether there are reels of it, and how many. A width with two reels on
  // the shelf and one with forty are not the same choice, and this figure is
  // the only thing that says so.
  const STOCK_BY_SIZE = new Map(STOCK_SIZES.map((s) => [round2(Number(s.size)), s]));

  function normSizeList() {
    SIZE_LIST = [
      ...new Set(SIZE_LIST.map((n) => round2(Number(n))).filter((n) => Number.isFinite(n) && n > 0)),
    ].sort((a, b) => a - b);
  }
  // The seed comes out of the database, so it goes through the same rounding,
  // de-duping and sorting as anything typed into the box.
  normSizeList();

  // ---- the Deckle Size fields --------------------------------------------
  // One input per width, and the row grows itself: fill the last box and an
  // empty one appears beside it. It was a single box with an Add button
  // beside it that turned what you typed into a chip, which meant three
  // actions per width (type, reach for Add, come back) and a list you could
  // no longer edit -- a mistyped 653 had to be deleted and retyped rather
  // than corrected in place. Here every width stays a field: click into it
  // and fix the digit.
  //
  // The DOM is the source of truth and SIZE_LIST is derived from it, so the
  // boxes keep the order they were typed in while SIZE_LIST stays sorted and
  // de-duped for the planner. Nothing re-renders on a keystroke -- rebuilding
  // the row under the caret would throw focus out of the box being typed in
  // -- so growing, validating and syncing all work on the existing nodes.
  let SIZE_FIELD_SEQ = 0;

  function sizeInputs() {
    return [...sizeFieldsEl.querySelectorAll(".dc-size-input")];
  }

  function addSizeField(value) {
    const id = `dcSize${(SIZE_FIELD_SEQ += 1)}`;
    const wrap = document.createElement("span");
    wrap.className = "dc-size-field";
    wrap.innerHTML =
      `<input type="number" step="any" min="0" inputmode="decimal" class="dc-size-input" ` +
      `id="${id}" placeholder="mm" aria-label="Deckle size in mm" />` +
      `<button type="button" class="dc-size-x" tabindex="-1" title="Remove this size" ` +
      `aria-label="Remove this size">&times;</button>`;
    const input = wrap.querySelector(".dc-size-input");
    if (value != null) input.value = value;

    input.addEventListener("input", () => {
      growSizeFields();
      syncSizes();
    });
    // Enter moves along the row the way it does in the Requirements table,
    // and lands in the empty box growSizeFields() has just opened.
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const all = sizeInputs();
      const next = all[all.indexOf(input) + 1];
      if (next) next.focus();
    });
    wrap.querySelector(".dc-size-x").addEventListener("click", () => {
      // Never leave the row with nothing in it: the last field is emptied
      // rather than removed, so there is always somewhere to type.
      if (sizeInputs().length <= 1) {
        input.value = "";
        input.focus();
      } else {
        wrap.remove();
      }
      growSizeFields();
      syncSizes();
    });

    sizeFieldsEl.appendChild(wrap);
    return input;
  }

  // Exactly one empty box at the end, always. That trailing box is the "add
  // another" -- there is no button to press.
  function growSizeFields() {
    const all = sizeInputs();
    if (!all.length) {
      addSizeField();
      return;
    }
    const last = all[all.length - 1];
    if (String(last.value).trim() !== "") addSizeField();
  }

  // Reads the boxes, flags the bad ones, rebuilds SIZE_LIST and recalculates.
  // Every box is judged on its own and wears its own red, so with three
  // widths typed it is obvious WHICH one the message is about.
  function syncSizes() {
    const trim = Number(dsfTrim && dsfTrim.value);
    const seen = new Set();
    const values = [];
    let msg = "";

    sizeInputs().forEach((input) => {
      const wrap = input.closest(".dc-size-field");
      const raw = String(input.value).trim();
      let bad = "";
      let v = null;

      if (raw === "") {
        // An empty box is the next one waiting to be filled, not a mistake.
      } else {
        v = round2(Number(raw));
        if (!Number.isFinite(v)) bad = "Enter a number in mm.";
        else if (v <= 0) bad = "Deckle size must be greater than 0.";
        else if (v < MIN_DECKLE_MM || v > MAX_DECKLE_MM)
          bad = `Deckle size looks wrong — expected ${MIN_DECKLE_MM}–${MAX_DECKLE_MM} mm.`;
        else if (Number.isFinite(trim) && trim >= 0 && v <= trim)
          bad = `Deckle size must be more than the ${round2(trim)} mm edge trim.`;
        else if (seen.has(v)) bad = `${fmt(v)} mm is listed twice.`;
      }

      input.classList.toggle("is-bad", Boolean(bad));
      if (bad) {
        if (!msg) msg = bad;
      } else if (v != null) {
        seen.add(v);
        values.push(v);
      }

      // A width the store does not hold still plans perfectly well, but
      // nobody can fetch that reel today -- worth seeing without hovering,
      // and the count is worth having on the tooltip (two reels on the shelf
      // and forty are not the same choice).
      const st = v == null || bad ? null : STOCK_BY_SIZE.get(v);
      wrap.classList.toggle("in-stock", Boolean(st));
      wrap.classList.toggle("off-stock", Boolean(v != null && !bad && !st));
      input.title = st
        ? `${fmtI(st.reelCount)} reel${st.reelCount === 1 ? "" : "s"} in stock · ${fmt(st.totalKg)} kg`
        : v != null && !bad
          ? "No facestock of this width in stock — it still plans, nobody can fetch the reel today"
          : "";
    });

    showSizeMsg(msg);
    SIZE_LIST = values;
    normSizeList();
    recalcAll();
  }

  function showSizeMsg(text) {
    if (!sizeMsgEl) return;
    sizeMsgEl.textContent = text || "";
    sizeMsgEl.hidden = !text;
  }

  // ---- web-view segment builders -----------------------------------------
  function edgeSeg(side) {
    return (
      `<div class="sl-web-seg sl-web-edge" style="flex-grow:${EDGE}" title="${side} edge trim — ${EDGE} mm">` +
      `<span class="sl-seg-slot">EDGE</span><span class="sl-seg-w">${EDGE}</span></div>`
    );
  }
  function cutSeg(slot, w) {
    return (
      `<div class="sl-web-seg" style="flex-grow:${w}" title="${esc(slot)} — ${esc(fmt(w))} mm">` +
      `<span class="sl-seg-slot">${esc(slot)}</span><span class="sl-seg-w">${esc(fmt(w))}</span></div>`
    );
  }
  function trimSeg(w) {
    return (
      `<div class="sl-web-seg sl-web-trim" style="flex-grow:${w}" title="Trim (uncut slack) — ${esc(fmt(w))} mm">` +
      `<span class="sl-seg-slot">TRIM</span><span class="sl-seg-w">${esc(fmt(w))}</span></div>`
    );
  }
  function webInnerHTML(cuts, webWidth) {
    const sum = round2(cuts.reduce((n, [, w]) => n + w, 0));
    const cuttable = round2(webWidth - 2 * EDGE);
    const over = webWidth > 0 && sum > cuttable;
    const slack = round2(cuttable - sum);
    if (!cuts.length) {
      return (
        `${edgeSeg("Left")}<div class="sl-web-empty" style="flex-grow:${Math.max(cuttable, 1)};flex-basis:0;min-width:0;width:auto;">` +
        `${webWidth > 0 ? esc(fmt(cuttable)) + " mm — no roll widths yet" : "enter roll widths"}</div>${edgeSeg("Right")}`
      );
    }
    const segs = cuts.map(([slot, w]) => cutSeg(slot, w));
    if (!over && slack > 0) segs.push(trimSeg(slack));
    return `${edgeSeg("Left")}${segs.join("")}${edgeSeg("Right")}`;
  }

  // ---- grace -------------------------------------------------------------
  // Spare web that would be scrapped as side trim, shared out over a layout's
  // rolls so it is cut instead. A 30 mm siderun across 3 rolls makes each one
  // 10 mm wider: the knives are set to the WIDER figure, the client is still
  // billed the width they ordered, so the two numbers are different things and
  // both are kept. The A..L inputs go on holding the ORDERED widths -- the
  // Requirements table matches on those, and matching on a graced width would
  // find nothing at all. Grace is held beside them, per slot, on the row.
  const graceOf = (tr) => (tr.__grace ||= {});
  const graceFor = (tr, slot) => {
    const g = Number(graceOf(tr)[slot]);
    return Number.isFinite(g) && g > 0 ? round2(g) : 0;
  };
  // Grace on a slot with no roll width is meaningless -- drop it, so clearing a
  // width can't leave width behind in the totals.
  function pruneGrace(tr) {
    const g = graceOf(tr);
    SLOTS.forEach((s) => {
      const el = tr.querySelector(`.sl-roll-width[data-slot="${s}"]`);
      if (!(Number(el && el.value) > 0)) delete g[s];
    });
  }

  // ---- layout rows -------------------------------------------------------
  // `cuts` are the ordered widths (what was asked for, and what the
  // Requirements table reads); `graced` are the widths the knives are actually
  // set to. They are the same list when no grace has been given, which is why
  // everything that draws or measures the web reads `graced`.
  function readRow(tr) {
    const cuts = SLOTS.map((s) => [s, Number(tr.querySelector(`.sl-roll-width[data-slot="${s}"]`).value)]).filter(
      ([, w]) => Number.isFinite(w) && w > 0,
    );
    const graced = cuts.map(([s, w]) => [s, round2(w + graceFor(tr, s))]);
    return {
      graced,
      cuts,
      drm: Number(tr.querySelector(".dsf-drm").value) || null,
      rm: Number(tr.querySelector(".dsf-rm").value) || null,
      webs: Math.max(0, Math.floor(Number(tr.querySelector(".dsf-webs").value) || 0)),
    };
  }

  // Raw per-slot state for validation -- keeps the blanks and bad values that
  // readRow() silently drops.
  function rowSlots(tr) {
    return SLOTS.map((s) => {
      const el = tr.querySelector(`.sl-roll-width[data-slot="${s}"]`);
      const raw = String(el.value).trim();
      return { slot: s, el, raw, num: raw === "" ? null : Number(raw) };
    });
  }
  const lastFilledIdx = (slots) => slots.reduce((idx, s, k) => (s.raw !== "" ? k : idx), -1);

  // Finished rolls per knife position from one deckle web = Deckle R.M. / roll
  // R. Meter (e.g. 900 / 300 = 3). Falls back to 1 when it can't be computed.
  function rollsPerWeb(r) {
    return r.drm > 0 && r.rm > 0 ? Math.max(1, Math.floor(round2(r.drm / r.rm))) : 1;
  }

  // Layout rows are addressed by a stable id rather than by position: the
  // recap sorts by Total and hands that id back when its pencil is pressed, so
  // a row that moved still opens the layout that was clicked.
  let LID = 0;

  // True once AI Deckle Set has put a plan on the page. That plan is a complete
  // answer for every requirement, so piling a hand-drawn layout on top of it is
  // almost always a mistake -- and a blank one would sit there reading "not
  // drawn yet" for ever. So Add Deckle Layout is closed off while what is on
  // screen is the AI's plan. Taking a layout out of it means it is no longer
  // the AI's plan, and adding opens back up -- otherwise removing a layout
  // would be a one-way door with no way to draw its replacement.
  let AI_PLANNED = false;

  // After a run the planner has already been told which web each layout runs
  // on, so every other size's diagram is noise: each layout's size table
  // collapses to the chosen row until the planner asks to see the rest again
  // (per row, via "Show all sizes"). Hand planning is unaffected -- the full
  // table is how you choose a size in the first place.
  let ONLY_CHOSEN = false;

  function addLayoutRow(preset) {
    const tr = document.createElement("tr");
    tr.className = "dsf-layout-row";
    tr.dataset.lid = String(++LID);
    tr.innerHTML = `
      <td class="dsf-rownum">1</td>
      ${SLOTS.map(
        (s) =>
          `<td><input type="number" step="any" min="0" inputmode="decimal" class="form-control sl-roll-width sl-width-input" data-slot="${s}" placeholder="${s}" title="Roll ${s} width in mm" /></td>`,
      ).join("")}
      <td><input type="number" step="any" min="0" inputmode="decimal" class="form-control dsf-drm" placeholder="Mtrs" title="Length of one deckle web" /></td>
      <td><input type="number" step="any" min="0" inputmode="decimal" class="form-control dsf-rm" placeholder="Mtrs" title="Length wound on each finished roll" /></td>
      <td><input type="number" step="1" min="1" inputmode="numeric" class="form-control dsf-webs" placeholder="Qty" value="1" title="How many deckle webs (reels) use this same layout" /></td>
      <td><button type="button" class="dsf-row-btn dsf-remove" title="Remove this layout" aria-label="Remove this layout"><i class="fa-solid fa-xmark"></i></button></td>`;

    const sub = document.createElement("tr");
    sub.className = "dsf-layout-sub";
    sub.innerHTML = `<td class="dsf-sub-cell" colspan="${SUB_COLSPAN}">
        <div class="dsf-webs-stack"></div>
      </td>`;
    tr.__sub = sub;

    // A new layout opens with the page's default web length already in it --
    // it is the same figure on every layout of a job far more often than not,
    // and it is the one field with a sensible default to give. The seed is
    // remembered ON THE ROW, not read back off the default field: a row still
    // carrying the figure it was opened with counts as untouched, and editing
    // the default afterwards must not turn somebody's blank rows into errors.
    const seedDrm = Number(drmDefaultEl && drmDefaultEl.value);
    if (Number.isFinite(seedDrm) && seedDrm > 0) {
      tr.querySelector(".dsf-drm").value = seedDrm;
      tr.dataset.seedDrm = String(seedDrm);
    }

    if (preset) {
      // A preset is a whole layout, lengths included -- including a layout that
      // HAS no lengths. So the seeded default is cleared rather than left
      // behind to half-fill the row (Deckle R.M. and R. Meter are
      // both-or-neither, and a lone seeded R.M. would read as an error).
      tr.querySelector(".dsf-drm").value = preset.drm != null ? preset.drm : "";
      if (preset.drm == null) delete tr.dataset.seedDrm;
      else tr.dataset.seedDrm = String(preset.drm);
      if (preset.rm != null) tr.querySelector(".dsf-rm").value = preset.rm;
      if (preset.webs != null) tr.querySelector(".dsf-webs").value = preset.webs;
      if (preset.size != null) tr.dataset.size = String(preset.size);
      (preset.cuts || []).forEach(([slot, w]) => {
        const el = tr.querySelector(`.sl-roll-width[data-slot="${slot}"]`);
        if (el) el.value = w;
      });
    }

    const widthInputs = [...tr.querySelectorAll(".sl-roll-width")];
    widthInputs.forEach((el, idx) => {
      el.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        (widthInputs[idx + 1] || widthInputs[idx]).focus();
      });
    });
    tr.querySelectorAll("input").forEach((el) => el.addEventListener("input", recalcAll));
    tr.querySelector(".dsf-remove").addEventListener("click", () => {
      AI_PLANNED = false;
      if (layoutBody.querySelectorAll(".dsf-layout-row").length > 1) {
        const wasEditing = tr.classList.contains("is-editing");
        sub.remove();
        tr.remove();
        // The dialog is scoped to this row -- with it gone there is nothing
        // left to edit, so close rather than leave an empty solo table.
        if (wasEditing) closeLayoutDialog();
        recalcAll();
        return;
      }
      // Last layout -- the × clears its values instead of removing the row.
      tr.querySelectorAll(".sl-roll-width").forEach((el) => {
        el.value = "";
      });
      tr.__grace = {};
      delete tr.dataset.size;
      tr.querySelector(".dsf-drm").value = tr.dataset.seedDrm || "";
      tr.querySelector(".dsf-rm").value = "";
      tr.querySelector(".dsf-webs").value = "1";
      recalcAll();
    });

    layoutBody.appendChild(tr);
    layoutBody.appendChild(sub);
    recalcAll();
    return tr;
  }

  function layoutRows() {
    return [...layoutBody.querySelectorAll(".dsf-layout-row")];
  }

  // ---- layout dialog -----------------------------------------------------
  // Opens the layout table on one layout: that row and its size sub-row take
  // .is-editing and the rest are hidden by CSS (#dsfLayoutTable.is-solo).
  // Nothing is detached, so every other layout keeps counting towards the
  // totals and the figures.
  function openLayoutDialog(lid) {
    const tr = layoutBody.querySelector(`.dsf-layout-row[data-lid="${lid}"]`);
    if (!tr) return;
    layoutBody.querySelectorAll("tr.is-editing").forEach((el) => el.classList.remove("is-editing"));
    tr.classList.add("is-editing");
    if (tr.__sub) tr.__sub.classList.add("is-editing");
    layoutTable.classList.add("is-solo");
    // The number every "Layout #N: ..." message uses -- the recap's own #
    // column is a row counter, so a layout is named here and on its pencil.
    layoutModalTitle.textContent = `Deckle Layout #${layoutRows().indexOf(tr) + 1}`;
    layoutModal.classList.add("show");
    layoutModal.setAttribute("aria-hidden", "false");
    renderGracePanel();
    const first = tr.querySelector(".sl-roll-width:not(:disabled)");
    if (first) first.focus();
  }

  function closeLayoutDialog() {
    layoutModal.classList.remove("show");
    layoutModal.setAttribute("aria-hidden", "true");
    layoutTable.classList.remove("is-solo");
    layoutBody.querySelectorAll("tr.is-editing").forEach((el) => el.classList.remove("is-editing"));
    // The panel belongs to the layout that was open; it is not carried to the
    // next one. Grace already given stays on the row either way.
    graceOpen = false;
    renderGracePanel();
  }

  // ---- grace panel -------------------------------------------------------
  // Scoped to the layout the dialog currently has open. Editing here writes
  // straight onto that row's grace and re-runs recalcAll(), so the web
  // diagram, the Siderun, Grace and Total all move as the numbers are typed.
  let graceOpen = false;

  function graceRows(tr) {
    return SLOTS.map((slot) => ({ slot, el: tr.querySelector(`.sl-roll-width[data-slot="${slot}"]`) }))
      .map((x) => ({ ...x, ordered: Number(x.el && x.el.value) }))
      .filter((x) => Number.isFinite(x.ordered) && x.ordered > 0);
  }

  // Spare usable web once the ordered widths and the grace already given are
  // taken off. Negative means the layout overflows -- recalcAll() is already
  // saying so, the panel just refuses to add more.
  function graceSpare(tr) {
    const size = rowSize(tr);
    if (!(size > 0)) return null;
    const cuttable = round2(size - 2 * EDGE);
    const cut = round2(readRow(tr).graced.reduce((n, [, w]) => n + w, 0));
    return round2(cuttable - cut);
  }

  // Share every last mm of the spare out over the rolls, in WHOLE
  // millimetres. Nobody sets a knife to half a millimetre by choice, so a
  // 30 mm spare over 4 rolls goes out as 8, 8, 7, 7 -- never more than 1 mm
  // apart, and the same 30 mm in total. A spare that is not itself whole
  // cannot come out whole on every roll; the sub-millimetre remainder lands on
  // ONE roll rather than being smeared over all of them.
  function graceSpreadEvenly(tr) {
    const rows = graceRows(tr);
    if (!rows.length) return;
    const spare = graceSpare(tr);
    if (!(spare > 0)) return;
    const g = graceOf(tr);
    const n = rows.length;

    const base = Math.floor(spare / n);
    if (base > 0)
      rows.forEach((x) => {
        g[x.slot] = round2(graceFor(tr, x.slot) + base);
      });

    let left = round2(spare - base * n);
    for (let i = 0; i < n && left >= 1; i += 1) {
      g[rows[i].slot] = round2(graceFor(tr, rows[i].slot) + 1);
      left = round2(left - 1);
    }

    if (left > 0) g[rows[0].slot] = round2(graceFor(tr, rows[0].slot) + left);
    recalcAll();
  }

  function graceClear(tr) {
    tr.__grace = {};
    recalcAll();
  }

  // The Grace button is the way in AND the way out, so it says which it
  // currently is, and carries the mm this layout has already been given.
  function renderGraceBtn() {
    const tr = layoutBody.querySelector(".dsf-layout-row.is-editing");
    const given = tr ? round2(SLOTS.reduce((n, sl) => n + graceFor(tr, sl), 0)) : 0;
    const badge = given > 0 ? `<span class="dsf-btn-badge">${esc(fmt(given))} mm</span>` : "";
    graceBtn.classList.toggle("is-on", graceOpen);
    graceBtn.setAttribute("aria-expanded", graceOpen ? "true" : "false");
    graceBtn.innerHTML = graceOpen
      ? `<i class="fa-solid fa-chevron-up"></i> Hide Grace${badge}`
      : `<i class="fa-solid fa-arrows-left-right-to-line"></i> Grace${badge}`;
    graceBtn.title = graceOpen
      ? "Hide the grace panel"
      : given > 0
        ? `${fmt(given)} mm of side trim shared out over this layout's rolls — click to adjust`
        : "Share this layout's leftover side trim out over its rolls — cut wider, still billed at the ordered width";
  }

  function renderGracePanel() {
    renderGraceBtn();
    const tr = layoutBody.querySelector(".dsf-layout-row.is-editing");
    if (!graceOpen || !tr) {
      gracePanel.hidden = true;
      gracePanel.innerHTML = "";
      return;
    }
    gracePanel.hidden = false;

    // recalcAll() redraws this panel on every keystroke, and innerHTML throws
    // away the very box being typed in -- which costs it its focus, its caret
    // and its tab position. Remember the box first and put it back after. Its
    // RAW text is restored, not the rounded number: half-typed values like
    // "18." parse to 18, and writing that back mid-entry turns the next
    // keystroke into "183" instead of "18.3".
    const act = document.activeElement;
    const keep =
      act && act.classList && act.classList.contains("dsf-grace-input")
        ? { slot: act.dataset.graceSlot, raw: act.value, start: act.selectionStart, end: act.selectionEnd }
        : null;

    const rows = graceRows(tr);
    const size = rowSize(tr);
    const cuttable = size > 0 ? round2(size - 2 * EDGE) : null;
    const orderedSum = round2(rows.reduce((n, x) => n + x.ordered, 0));
    const graceSum = round2(rows.reduce((n, x) => n + graceFor(tr, x.slot), 0));
    const cutSum = round2(orderedSum + graceSum);
    const spare = cuttable == null ? null : round2(cuttable - cutSum);

    const msg = !rows.length
      ? "Enter this layout's roll widths first — grace shares out what is left over after them."
      : cuttable == null
        ? "Pick a deckle size for this layout first."
        : "";
    const over = spare != null && spare < 0;

    const sum = (k, v, cls) =>
      `<div class="dsf-grace-sum"><span class="k">${esc(k)}</span>` +
      `<span class="v${cls ? " " + cls : ""}">${esc(v)}</span></div>`;

    gracePanel.innerHTML = `
      <div class="dsf-grace-head">
        <h3>Grace</h3>
        <button type="button" class="dsf-grace-x" data-grace-close="1"
                aria-label="Hide grace" title="Hide grace">&times;</button>
        <span class="dsf-grace-note">Cut wider than ordered so the side trim is used, not scrapped.
          The client is still billed the width they ordered.</span>
        <div class="dsf-grace-acts">
          <button type="button" class="dsf-mini-btn" data-grace-spread="1"
                  ${rows.length && spare > 0 ? "" : "disabled"}
                  title="Share the whole spare out evenly across these rolls">
            <i class="fa-solid fa-arrows-left-right"></i> Spread evenly
          </button>
          <button type="button" class="dsf-mini-btn" data-grace-clear="1"
                  ${graceSum > 0 ? "" : "disabled"}>Clear</button>
        </div>
      </div>
      <div class="dsf-grace-body">
        ${
          rows.length
            ? `
        <table class="dsf-grace-table">
          <thead>
            <tr>
              <th>Roll</th>
              <th title="The width asked for — what the client is billed">Ordered</th>
              <th title="Extra width handed to this roll out of the side trim">Grace (mm)</th>
              <th title="What the knife is actually set to">Cut width</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (x) => `
              <tr>
                <td class="dsf-g-slot">${esc(x.slot)}</td>
                <td>${esc(fmt(x.ordered))} mm</td>
                <td><input type="text" inputmode="decimal" autocomplete="off"
                           class="dsf-grace-input" data-grace-slot="${esc(x.slot)}"
                           value="${graceFor(tr, x.slot) > 0 ? esc(graceFor(tr, x.slot)) : ""}"
                           placeholder="0" aria-label="Grace for roll ${esc(x.slot)}" /></td>
                <td class="dsf-g-cut">${esc(fmt(round2(x.ordered + graceFor(tr, x.slot))))} mm</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>`
            : ""
        }
        <div class="dsf-grace-sums">
          ${sum("Usable web", cuttable != null ? `${fmt(cuttable)} mm` : "—")}
          ${sum("Ordered", `${fmt(orderedSum)} mm`)}
          ${sum("Grace given", `${fmt(graceSum)} mm`, graceSum > 0 ? "good" : "")}
          ${sum("Cut total", `${fmt(cutSum)} mm`, over ? "bad" : "")}
          ${sum("Still scrapped", spare != null ? `${fmt(spare)} mm` : "—", over ? "bad" : spare === 0 ? "good" : "warn")}
        </div>
        <div class="dsf-grace-msg">${esc(
          over ? `Over the web by ${fmt(-spare)} mm — take that much grace back off.` : msg,
        )}</div>
      </div>`;

    if (!keep) return;
    const el = gracePanel.querySelector(`.dsf-grace-input[data-grace-slot="${keep.slot}"]`);
    if (!el) return;
    el.value = keep.raw;
    el.focus();
    try {
      el.setSelectionRange(keep.start, keep.end);
    } catch {
      /* nothing to place */
    }
  }

  // ---- which web a layout is cut from ------------------------------------
  // The least-trim web for a given run of knives: the smallest available size
  // whose cuttable width still covers them; the largest if none does.
  function bestFitSize(widest) {
    if (!SIZE_LIST.length) return null;
    return widest > 0
      ? (SIZE_LIST.find((sz) => round2(sz - 2 * EDGE) >= widest) ?? SIZE_LIST[SIZE_LIST.length - 1])
      : SIZE_LIST[0];
  }

  // Worked out PER LAYOUT, against that layout's own knives. Every layout here
  // may be cut from a different deckle width (the Set Deckle page's "mixed
  // webs", which ships on there too), so measuring the whole plan against its
  // single widest layout would put a 600 mm run on the 1000 mm web its
  // neighbour needs -- and report the trim of a job nobody would run.
  function rowBestFit(tr) {
    return bestFitSize(round2(readRow(tr).graced.reduce((n, [, w]) => n + w, 0)));
  }

  // The web a layout is cut from: the one it has been given, or failing that
  // the best fit for what is drawn on it.
  function rowSize(tr) {
    const own = Number(tr.dataset.size);
    if (Number.isFinite(own) && own > 0 && SIZE_LIST.includes(own)) return own;
    return rowBestFit(tr);
  }

  // The one width the job would be recorded at -- whichever carries the most
  // webs (ties to the wider), matching what utils/deckleOptimizer reports as
  // its headline size and what a real batch would be saved as.
  function headlineSize() {
    const byS = new Map();
    layoutRows().forEach((tr) => {
      const s = rowSize(tr);
      if (!(s > 0)) return;
      const webs = Math.max(0, Math.floor(Number(tr.querySelector(".dsf-webs").value) || 0));
      byS.set(s, (byS.get(s) || 0) + webs);
    });
    if (!byS.size) return SIZE_LIST[0] ?? null;
    return [...byS.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }

  // Picking a size in a layout's own size table pins THAT layout's web. There
  // is nowhere else to pick one from, which is the point: the width is a
  // property of the layout here, not of the job.
  function selectSize(sz, tr) {
    const n = Number(sz);
    if (!Number.isFinite(n) || !tr) return;
    tr.dataset.size = String(n);
    recalcAll();
  }

  const WEB_TABLE_HEAD =
    `<thead><tr><th>Deckle Size</th><th>Siderun</th><th>Across</th><th>Deckle Count</th><th>Layout</th><th>Use</th></tr></thead>`;

  // One "deckle size | siderun | across | deckle count | diagram | pick" row.
  function webRowHTML(cuts, sz, chosen, isBest, webs) {
    const cutSum = round2(cuts.reduce((n, [, w]) => n + w, 0));
    const cuttable = round2(sz - 2 * EDGE);
    const remaining = round2(cuttable - cutSum);
    const over = cutSum > cuttable;
    const rollWord = `${cuts.length} roll${cuts.length === 1 ? "" : "s"}`;
    const cap = cuts.length ? rollWord : "—";
    return `
      <tr class="dsf-web-tr${chosen ? " is-chosen" : ""}" data-size="${sz}" role="radio" aria-checked="${chosen}" tabindex="0">
        <td class="dsf-web-size">${esc(fmt(sz))} mm</td>
        <td class="dsf-web-rem${over ? " sl-bad" : ""}">${cuts.length ? esc(fmt(remaining)) + " mm" : "—"}</td>
        <td class="dsf-web-across">
          <span class="flag ${over ? "sl-bad" : cuts.length ? "sl-ok" : ""}">${cap}</span>
          ${isBest && !chosen ? `<span class="dsf-tag">best fit</span>` : ""}
        </td>
        <td class="dsf-web-dc">${esc(fmt(webs))}</td>
        <td class="dsf-web-diag">
          <div class="sl-web${over ? " is-over" : ""}">${webInnerHTML(cuts, sz)}</div>
        </td>
        <td class="dsf-web-pick"><span class="dsf-radio"></span></td>
      </tr>`;
  }

  // ---- requirements ------------------------------------------------------
  // The typed stand-in for "Orders In This Deckle": roll width, the length
  // wound on each roll, and how many are wanted.
  function reqRows() {
    return [...reqBody.querySelectorAll(".dc-req-row")];
  }

  function addReqRow(preset) {
    const tr = document.createElement("tr");
    tr.className = "dc-req-row";
    tr.innerHTML = `
      <td class="dc-req-no">1</td>
      <td><input type="checkbox" class="dsf-order-check dc-req-check" checked title="Include this requirement" /></td>
      <td><input type="number" step="any" min="0" inputmode="decimal" class="form-control dc-req-width" placeholder="mm" title="Finished roll width in mm" /></td>
      <td><input type="number" step="any" min="0" inputmode="decimal" class="form-control dc-req-rm" placeholder="any" title="Length wound on each finished roll. Leave blank to count rolls of any length." /></td>
      <td><input type="number" step="1" min="1" inputmode="numeric" class="form-control dc-req-qty" placeholder="Qty" title="How many rolls of this width and length are wanted" /></td>
      <td class="dc-req-set">—</td>
      <td class="dc-req-bal">—</td>
      <td><button type="button" class="dsf-row-btn dc-req-remove" title="Remove this requirement" aria-label="Remove this requirement"><i class="fa-solid fa-xmark"></i></button></td>`;

    if (preset) {
      if (preset.width != null) tr.querySelector(".dc-req-width").value = preset.width;
      if (preset.rm != null) tr.querySelector(".dc-req-rm").value = preset.rm;
      if (preset.qty != null) tr.querySelector(".dc-req-qty").value = preset.qty;
    }

    const fields = [...tr.querySelectorAll("input[type=number]")];
    fields.forEach((el) => el.addEventListener("input", recalcAll));
    tr.querySelector(".dc-req-check").addEventListener("change", recalcAll);
    // Enter moves along the row, then on to the next one -- requirements are
    // typed in runs, and a new row is opened rather than trapping the caret on
    // the last field of the last one.
    fields.forEach((el, idx) => {
      el.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        const next = fields[idx + 1];
        if (next) {
          next.focus();
          return;
        }
        const all = reqRows();
        const nextRow = all[all.indexOf(tr) + 1] || addReqRow();
        nextRow.querySelector(".dc-req-width").focus();
      });
    });
    tr.querySelector(".dc-req-remove").addEventListener("click", () => {
      if (reqRows().length > 1) tr.remove();
      else {
        tr.querySelectorAll("input[type=number]").forEach((el) => {
          el.value = "";
        });
        tr.querySelector(".dc-req-check").checked = true;
      }
      recalcAll();
    });

    reqBody.appendChild(tr);
    return tr;
  }

  // Rolls Set + Balance for one line. Everything about how those two cells
  // look lives here and in the stylesheet, rather than being written onto the
  // elements as inline colours -- a state ("short", "spare", "exact", nothing
  // to say yet) is a thing the CSS can style, a hex code is not.
  const REQ_STATES = ["is-short", "is-spare", "is-exact", "is-muted"];
  function paintReq(tr, { set, balance, state, note, title }) {
    const setEl = tr.querySelector(".dc-req-set");
    const balEl = tr.querySelector(".dc-req-bal");
    setEl.textContent = set;
    setEl.classList.toggle("is-muted", state === "is-muted");
    balEl.innerHTML = esc(balance) + (note ? `<span class="dc-bal-note">${esc(note)}</span>` : "");
    REQ_STATES.forEach((c) => balEl.classList.toggle(c, c === state));
    balEl.title = title || "";
  }

  // The bottom line under the requirements: what was asked for, what the
  // layouts make of it, and the difference. Only the lines actually in the
  // calculation count -- a blank line has nothing to add, and an unticked one
  // was left out on purpose.
  function paintReqTotals(reqs) {
    const qtyEl = document.querySelector(".dc-req-foot-qty");
    const setEl = document.querySelector(".dc-req-foot-set");
    const balEl = document.querySelector(".dc-req-foot-bal");
    if (!qtyEl) return;
    if (!reqs.length) {
      [qtyEl, setEl, balEl].forEach((el) => {
        el.textContent = "—";
        REQ_STATES.forEach((c) => el.classList.remove(c));
        el.classList.add("is-muted");
        el.title = "";
      });
      return;
    }
    const qty = reqs.reduce((n, q) => n + q.qty, 0);
    const set = reqs.reduce((n, q) => n + q.set, 0);
    const balance = round2(set - qty);
    qtyEl.textContent = fmtI(qty);
    setEl.textContent = fmtI(set);
    balEl.textContent = `${balance > 0 ? "+" : ""}${fmtI(balance)}`;
    [qtyEl, setEl].forEach((el) => {
      REQ_STATES.forEach((c) => el.classList.remove(c));
      el.title = "";
    });
    const state = balance < 0 ? "is-short" : balance > 0 ? "is-spare" : "is-exact";
    REQ_STATES.forEach((c) => balEl.classList.toggle(c, c === state));
    balEl.title =
      balance < 0
        ? `${fmtI(-balance)} roll(s) short across every line`
        : balance > 0
          ? `${fmtI(balance)} roll(s) more than asked for across every line`
          : "Every line exactly covered";
    // A total that nets to zero over lines that are individually short and
    // spare would read as "all covered", which it is not. Say so.
    const anyShort = reqs.some((q) => q.set < q.qty);
    if (anyShort && balance >= 0) {
      REQ_STATES.forEach((c) => balEl.classList.toggle(c, c === "is-short"));
      balEl.title = "Some lines are still short — the spare on other lines is what nets this out.";
    }
  }

  function readReq(tr) {
    const wRaw = trimmedVal(tr.querySelector(".dc-req-width"));
    const rRaw = trimmedVal(tr.querySelector(".dc-req-rm"));
    const qRaw = trimmedVal(tr.querySelector(".dc-req-qty"));
    return {
      tr,
      on: tr.querySelector(".dc-req-check").checked,
      blank: wRaw === "" && rRaw === "" && qRaw === "",
      wRaw,
      rRaw,
      qRaw,
      width: wRaw === "" ? null : round2(Number(wRaw)),
      rm: rRaw === "" ? null : round2(Number(rRaw)),
      qty: qRaw === "" ? null : Number(qRaw),
    };
  }

  // ---- matching rolls to requirements ------------------------------------
  // A roll is a width AND a length. A layout that cuts 150 mm and winds 1000 m
  // does not make the 150 mm × 300 m rolls somebody asked for, so the two are
  // matched on both. Either side may leave the length unstated -- a layout
  // with no Deckle R.M./R. Meter (allowed: it yields one roll per knife per
  // web) or a requirement with no Running Mtrs -- and then it matches whatever
  // the other side says. Exact length matches are served first, so a stated
  // length never loses its rolls to a row that did not care.
  const exactLen = (e, q) => e.rm != null && q.rm != null && e.rm === q.rm;
  const looseLen = (e, q) => e.rm == null || q.rm == null;
  const claims = (e, q) => e.width === q.width && (exactLen(e, q) || looseLen(e, q));

  // One entry per (roll width, roll length) the layouts produce.
  function supplyFromLayouts() {
    const out = [];
    layoutRows().forEach((tr) => {
      const r = readRow(tr);
      const rpw = rollsPerWeb(r);
      const rolls = r.webs * rpw;
      if (rolls <= 0) return;
      r.cuts.forEach(([, w]) => {
        out.push({ width: round2(w), rm: r.rm == null ? null : round2(r.rm), rolls, left: rolls });
      });
    });
    return out;
  }

  // Cover what was asked for first, in the order the requirements are listed;
  // whatever is left over is spare. The spare is then handed to the LAST
  // requirement that could have claimed it, so it shows as a + on the line it
  // belongs to rather than vanishing -- the same thing the Set Deckle page's
  // "the last one absorbs any overflow" does.
  function allocate(reqs, supply) {
    reqs.forEach((q) => {
      q.set = 0;
      q.spare = 0;
    });

    reqs.forEach((q) => {
      const pools = [
        supply.filter((e) => e.left > 0 && e.width === q.width && exactLen(e, q)),
        supply.filter((e) => e.left > 0 && e.width === q.width && !exactLen(e, q) && looseLen(e, q)),
      ];
      pools.forEach((pool) => {
        pool.forEach((e) => {
          if (q.set >= q.qty || e.left <= 0) return;
          const take = Math.min(q.qty - q.set, e.left);
          q.set += take;
          e.left -= take;
        });
      });
    });

    // Rolls made beyond what was asked for. Counted with their own width and
    // length, since that is what their area is worth.
    let extraRolls = 0;
    let extraSqM = 0;
    let orphanRolls = 0;
    supply.forEach((e) => {
      if (e.left <= 0) return;
      extraRolls += e.left;
      extraSqM += e.left * (e.width / 1000) * (e.rm || 0);
      let owner = null;
      reqs.forEach((q) => {
        if (claims(e, q)) owner = q;
      });
      if (owner) {
        owner.set += e.left;
        owner.spare += e.left;
      } else {
        orphanRolls += e.left;
      }
      e.left = 0;
    });

    return { extraRolls, extraSqM: round2(extraSqM), orphanRolls };
  }

  // What the last allocation worked out -- recalcAll() refreshes it,
  // renderFinalStats() reads it.
  let ALLOC = { extraRolls: 0, extraSqM: 0, orphanRolls: 0 };
  // The requirements as they currently stand: ticked, filled in and valid.
  // recalcAll() refreshes it, AI Deckle Set plans from it -- so what is
  // planned is exactly what the Requirements table says, never a second
  // reading of the same boxes.
  let LIVE_REQS = [];
  // Last computed validation state.
  let ISSUES = { errors: [], notReady: false };

  // ---- the recalculation everything hangs off ----------------------------
  function recalcAll() {
    readTrim();
    const rows = layoutRows();
    let totalWebs = 0;
    const errors = [];
    // Layout rows nobody has started filling -- not an error, just "not
    // ready": these keep the Add-layout button locked but never show a red
    // "fix this" line.
    let blankRows = 0;
    // Layout numbers (1-based) that currently carry a hard error -- gates the
    // "Add Deckle Layout" button so a new row can't be piled on a broken one.
    const brokenRows = new Set();

    rows.forEach((tr, i) => {
      // Row number, plus the web this row is cut from -- layouts can differ,
      // and otherwise the size only appears in the sub-table.
      const numCell = tr.querySelector(".dsf-rownum");
      const ownSize = rowSize(tr);
      numCell.innerHTML =
        ownSize > 0 ? `${i + 1}<div class="dsf-row-web">${esc(fmt(ownSize))}</div>` : String(i + 1);
      tr.querySelectorAll(".sl-roll-width").forEach((el) => el.classList.toggle("is-set", el.value.trim() !== ""));
      const L = `Layout #${i + 1}: `;
      const errBefore = errors.length;
      const rSz = ownSize;
      // Which size the "best fit" tag goes on in this layout's own table.
      const best = rowBestFit(tr);
      const cuttable = rSz > 0 ? round2(rSz - 2 * EDGE) : 0;

      pruneGrace(tr);
      const slots = rowSlots(tr);
      const drmEl = tr.querySelector(".dsf-drm");
      const rmEl = tr.querySelector(".dsf-rm");
      const websEl = tr.querySelector(".dsf-webs");
      const drmRaw = trimmedVal(drmEl);
      const rmRaw = trimmedVal(rmEl);
      const websRaw = trimmedVal(websEl);
      const anyWidth = slots.some((s) => s.raw !== "");

      // A row nobody has started -- no widths, web count still at its default.
      // A new layout opens with a Deckle R.M. already in it, so a row carrying
      // only the figure it was opened with is still blank.
      const drmIsSeed = drmRaw === "" || drmRaw === (tr.dataset.seedDrm || "");
      const rowBlank = !anyWidth && drmIsSeed && rmRaw === "" && (websRaw === "" || websRaw === "1");
      if (rowBlank) blankRows += 1;

      // --- roll widths: filled A -> L, in order, no gaps ---
      const lastIdx = lastFilledIdx(slots);
      let prevFilled = true;
      slots.forEach((s) => {
        // A slot opens once every slot before it holds a value; a slot that
        // already has a value stays open so it can be corrected.
        s.el.disabled = !(prevFilled || s.raw !== "");
        if (s.raw === "") prevFilled = false;
        const badNum = s.raw !== "" && (!Number.isFinite(s.num) || s.num < MIN_WIDTH_MM);
        // It is the width the knife is SET to that has to fit the web, so this
        // is checked after grace, not on the figure typed in the box.
        const cutW = Number.isFinite(s.num) ? round2(s.num + graceFor(tr, s.slot)) : s.num;
        const wide = rSz > 0 && Number.isFinite(cutW) && cutW > cuttable;
        s.el.classList.toggle("is-bad", badNum || wide);
        if (wide) {
          errors.push(
            `${L}roll ${s.slot} (${fmt(cutW)} mm` +
              `${cutW !== s.num ? ` after grace, ordered ${fmt(s.num)} mm` : ""})` +
              ` is wider than the ${fmt(cuttable)} mm usable web`,
          );
        }
      });
      const hasGap = slots.some((s, k) => k < lastIdx && s.raw === "");
      if (hasGap) errors.push(`${L}fill roll widths A→L in order — no blank slot between them`);
      if (slots.some((s) => s.raw !== "" && (!Number.isFinite(s.num) || s.num < MIN_WIDTH_MM)))
        errors.push(`${L}every roll width must be a number greater than 0`);

      const r = readRow(tr);

      // --- Deckle R.M. / Roll R. Meter: both or neither, roll <= web ---
      const drmN = Number(drmRaw);
      const rmN = Number(rmRaw);
      const drmBad = drmRaw !== "" && (!Number.isFinite(drmN) || drmN <= 0 || drmN > MAX_RM);
      const rmBad = rmRaw !== "" && (!Number.isFinite(rmN) || rmN <= 0 || rmN > MAX_RM);
      if (drmBad) errors.push(`${L}Deckle R.M. must be a length greater than 0`);
      if (rmBad) errors.push(`${L}Roll R. Meter must be a length greater than 0`);
      // Not on a row nobody has started: it opens with the page's default
      // Deckle R.M. already in it and no R. Meter yet, which is exactly this
      // mismatch -- and being told off for a row you have not touched is no
      // way to open a page. It fires the moment the row is really being used.
      if (!rowBlank && (drmRaw === "") !== (rmRaw === ""))
        errors.push(`${L}enter both Deckle R.M. and Roll R. Meter, or leave both blank`);
      let rmOverWeb = false;
      if (!drmBad && !rmBad && drmRaw !== "" && rmRaw !== "" && rmN > drmN) {
        rmOverWeb = true;
        errors.push(`${L}Roll R. Meter (${fmt(rmN)} m) can't be longer than the deckle web (${fmt(drmN)} m)`);
      }
      drmEl.classList.toggle("is-bad", drmBad);
      rmEl.classList.toggle("is-bad", rmBad || rmOverWeb);

      // --- Deckle Count (webs): whole number, 1 or more (skipped when blank) ---
      const websNum = Number(websRaw);
      const websBad =
        !rowBlank && (websRaw === "" || !Number.isFinite(websNum) || websNum < 1 || !Number.isInteger(websNum));
      if (websBad) errors.push(`${L}Deckle Count must be a whole number of 1 or more`);
      websEl.classList.toggle("is-bad", websBad);

      // The × removes the row; on the sole remaining row it just clears the
      // values, and is disabled while that row is already untouched.
      const rmBtn = tr.querySelector(".dsf-remove");
      const isLast = rows.length <= 1;
      rmBtn.disabled = isLast && rowBlank;
      rmBtn.title = isLast ? "Clear this layout" : "Remove this layout";
      totalWebs += r.webs;

      // What the knives actually take off the web -- ordered width plus grace.
      const cutSum = round2(r.graced.reduce((n, [, w]) => n + w, 0));
      const over = rSz > 0 && cutSum > cuttable;

      // Table: one row per available deckle size -- size | siderun | across |
      // deckle count | diagram | pick. Clicking one sets THIS layout's web.
      const stack = tr.__sub.querySelector(".dsf-webs-stack");
      // Collapsed (AI-planned) rows show only the size actually in use; the
      // chosen size must still be an available one, else fall back to the full
      // list rather than drawing an empty table.
      const collapsed =
        ONLY_CHOSEN && SIZE_LIST.length > 1 && tr.dataset.showAll !== "1" && SIZE_LIST.includes(rSz);
      const sizesShown = collapsed ? [rSz] : SIZE_LIST;
      stack.innerHTML = SIZE_LIST.length
        ? `<table class="dsf-web-table">${WEB_TABLE_HEAD}<tbody>${sizesShown
            .map((s) => webRowHTML(r.graced, s, s === rSz, s === best, r.webs))
            .join("")}</tbody></table>` +
          (collapsed
            ? `<button type="button" class="dsf-sizes-toggle" title="Show every available deckle size for this layout"><i class="fa-solid fa-chevron-down"></i>Show all ${SIZE_LIST.length} sizes</button>`
            : ONLY_CHOSEN && SIZE_LIST.length > 1
              ? `<button type="button" class="dsf-sizes-toggle" data-hide="1" title="Show only the deckle size this layout uses"><i class="fa-solid fa-chevron-up"></i>Show only the selected size</button>`
              : "")
        : `<div style="font-size:12px;font-weight:700;color:#7c8ba1;padding:6px 2px;">Add a deckle size above, under “Deckle Size”.</div>`;
      stack.querySelectorAll(".dsf-web-tr").forEach((el) => {
        el.addEventListener("click", () => selectSize(el.dataset.size, tr));
        el.addEventListener("keydown", (ev) => {
          if (ev.key === " " || ev.key === "Enter") {
            ev.preventDefault();
            selectSize(el.dataset.size, tr);
          }
        });
      });
      const sizesToggle = stack.querySelector(".dsf-sizes-toggle");
      if (sizesToggle) {
        sizesToggle.addEventListener("click", () => {
          if (sizesToggle.dataset.hide === "1") delete tr.dataset.showAll;
          else tr.dataset.showAll = "1";
          recalcAll();
        });
      }

      if (!rowBlank && !r.cuts.length && !hasGap) errors.push(`${L}enter at least one roll width`);
      if (over)
        errors.push(
          `${L}widths total ${fmt(cutSum)} mm — only ${fmt(cuttable)} mm of the ${fmt(rSz)} mm web is usable; split the layout or pick a bigger deckle size`,
        );

      if (errors.length > errBefore) brokenRows.add(i + 1);
    });

    // ---- requirements: validate, then measure the plan against them ----
    const reqs = [];
    let liveReqs = 0;
    reqRows().forEach((tr, i) => {
      const q = readReq(tr);
      const R = `Requirement #${i + 1}: `;
      // The number the issues panel names this line by -- "Requirement #3"
      // means nothing if the rows are not numbered where you can see them.
      tr.querySelector(".dc-req-no").textContent = String(i + 1);
      tr.classList.toggle("is-off", !q.on);
      const wEl = tr.querySelector(".dc-req-width");
      const rEl = tr.querySelector(".dc-req-rm");
      const qEl = tr.querySelector(".dc-req-qty");

      // A blank line, or one left out on purpose, is not something to fix.
      if (q.blank || !q.on) {
        [wEl, rEl, qEl].forEach((el) => el.classList.remove("is-bad"));
        paintReq(tr, {
          set: "—",
          balance: q.on ? "—" : "Left out",
          state: "is-muted",
          title: q.on ? "" : "Not counted — tick the box to put this line back in.",
        });
        return;
      }
      liveReqs += 1;

      const widthBad = !Number.isFinite(q.width) || q.width < MIN_WIDTH_MM || q.width > MAX_DECKLE_MM;
      const rmBad = q.rRaw !== "" && (!Number.isFinite(q.rm) || q.rm <= 0 || q.rm > MAX_RM);
      const qtyBad =
        q.qRaw === "" || !Number.isFinite(q.qty) || q.qty < 1 || !Number.isInteger(q.qty) || q.qty > MAX_QTY;
      wEl.classList.toggle("is-bad", widthBad);
      rEl.classList.toggle("is-bad", rmBad);
      qEl.classList.toggle("is-bad", qtyBad);
      if (widthBad) errors.push(`${R}roll width must be a number between ${MIN_WIDTH_MM} and ${MAX_DECKLE_MM} mm`);
      if (rmBad) errors.push(`${R}Running Mtrs must be a length greater than 0, or blank for any length`);
      if (qtyBad) errors.push(`${R}Roll Qty must be a whole number of 1 or more`);

      if (widthBad || rmBad || qtyBad) {
        paintReq(tr, { set: "—", balance: "—", state: "is-muted", title: "" });
        return;
      }
      reqs.push(q);
    });

    LIVE_REQS = reqs.map((q) => ({ width: q.width, rm: q.rm, qty: q.qty }));
    const supply = supplyFromLayouts();
    const widthsMade = new Set(supply.map((e) => e.width));
    ALLOC = allocate(reqs, supply);

    reqs.forEach((q) => {
      const balance = round2(q.set - q.qty);
      // Right width, wrong roll length is worth saying outright -- the figure
      // on its own reads like nothing was planned for it at all.
      const wrongLength = q.set === 0 && widthsMade.has(q.width);
      paintReq(q.tr, {
        set: fmtI(q.set),
        balance: `${balance > 0 ? "+" : ""}${fmtI(balance)}`,
        state: balance < 0 ? "is-short" : balance > 0 ? "is-spare" : "is-exact",
        note: wrongLength ? "no layout at this length" : "",
        title: wrongLength
          ? `${fmt(q.width)} mm rolls are being cut, but none at ${fmt(q.rm)} m — set a layout's R. Meter to ${fmt(q.rm)}`
          : balance < 0
            ? `${fmtI(-balance)} roll(s) short of what this line asks for`
            : balance > 0
              ? `${fmtI(balance)} spare roll(s) beyond what this line asks for`
              : "Exactly covered",
      });
    });
    paintReqTotals(reqs);

    // ---- whole-page checks ----
    if (!SIZE_LIST.length) {
      errors.push("Add at least one deckle size — the “Deckle Size” box on the strip above.");
    }
    const trimRaw = trimmedVal(dsfTrim);
    const trimNum = Number(trimRaw);
    const trimInvalid = trimRaw === "" || !Number.isFinite(trimNum) || trimNum < 0;
    if (trimInvalid) {
      errors.push("Edge Trim must be 0 mm or more.");
    } else if (SIZE_LIST.length && trimNum >= SIZE_LIST[0]) {
      errors.push(
        `Edge Trim (${fmt(trimNum)} mm) leaves nothing to cut on the smallest deckle size (${fmt(SIZE_LIST[0])} mm).`,
      );
    }
    if (dsfTrim) dsfTrim.classList.toggle("is-bad", trimInvalid || (SIZE_LIST.length && trimNum >= SIZE_LIST[0]));
    if (!liveReqs) errors.push("Enter at least one requirement — what rolls do you want off this deckle?");

    ISSUES = { errors, notReady: blankRows > 0 };
    renderIssues();
    dsfAddLayout.disabled = AI_PLANNED || blankRows > 0 || brokenRows.size > 0;
    dsfAddLayout.title = AI_PLANNED
      ? "AI Deckle Set planned these layouts — remove one to draw your own, or run it again to re-plan"
      : blankRows > 0
        ? "Draw the layout you already have before adding another"
        : "";

    // Errors only. The plan's recap is already on the page, so repeating it in
    // the dialog says nothing new -- but the issues panel is behind the dialog
    // while it is open, so this is the only place a broken layout is seen.
    layoutStatus.textContent = errors[0] || "";

    renderGracePanel();
    renderSetSummary();
  }

  // ---- "Deckle Set" recap ------------------------------------------------
  // A read-only picture of the plan: one line per layout (the web it runs on,
  // the knives across it, what one web yields and how many webs), then the
  // totals. Purely derived from the layout rows -- redrawn by recalcAll(),
  // never edited here; each line's pencil opens its layout in the dialog.
  function cutsPairs(cuts) {
    const byW = new Map();
    cuts.forEach(([, w]) => byW.set(w, (byW.get(w) || 0) + 1));
    return [...byW.entries()].sort((a, b) => b[0] - a[0]);
  }
  const cutsHTML = (cuts) =>
    cutsPairs(cuts)
      .map(([w, n]) => `<b>${esc(fmt(w))}</b> mm × <b>${esc(fmtI(n))}</b>`)
      .join(", ");
  const cutsPlain = (cuts) =>
    cutsPairs(cuts)
      .map(([w, n]) => `${fmt(w)} mm × ${fmtI(n)}`)
      .join(", ");
  const mmText = (v) => (v != null ? fmt(v) + " mm" : "—");
  const mText = (v) => (v > 0 ? fmt(v) + " m" : "—");

  // One spec per column. The header, the filter row and every body cell are
  // generated from this list, so the three can't drift out of step.
  //   plain:  no sorting, no filter box (a counter or a button, not data).
  //   sort:   the value the column orders on.
  //   text:   what a filter matches against -- the string the cell shows.
  const SET_COLS = [
    {
      key: "sl",
      label: "#",
      cls: "dsf-set-no",
      plain: true,
      th: "Row number — always 1 down to the last row shown, whatever the sort or filter. The layout's own number is on its pencil.",
      cell: (L, i) => String(i + 1),
    },
    {
      key: "size",
      label: "Deckle Size",
      cls: "dsf-set-size",
      th: "The web this layout is cut from.",
      sort: (L) => L.size,
      text: (L) => (L.size > 0 ? fmt(L.size) + " mm" : "—"),
      cell: (L) => (L.size > 0 ? esc(fmt(L.size)) + " mm" : "—"),
    },
    {
      key: "across",
      label: "Rolls Across",
      cls: "dsf-set-cuts",
      th: "The knives across the web — roll width × how many of it, at the width asked for. Sorts on how many knives.",
      sort: (L) => L.cuts.length,
      text: (L) => cutsPlain(L.cuts) + (L.grace > 0 ? ` +${fmt(L.grace)} grace` : ""),
      cell: (L) =>
        cutsHTML(L.cuts) +
        (L.grace > 0
          ? `<span class="dsf-grace-tag" title="${esc(
              `${fmt(L.grace)} mm of side trim shared out over these rolls — they are cut wider, and billed at the widths shown here`,
            )}">+${esc(fmt(L.grace))} GRACE</span>`
          : ""),
    },
    {
      key: "layout",
      label: "Layout",
      cls: "dsf-web-diag",
      th: "The web drawn to scale, at the widths actually cut (grace included). Sorts on the total width cut from it.",
      sort: (L) => L.cutSum,
      text: (L) => cutsPlain(L.graced),
      cell: (L) =>
        `<div class="sl-web${L.remaining != null && L.remaining < 0 ? " is-over" : ""}">` +
        `${webInnerHTML(L.graced, L.size)}</div>`,
    },
    // Siderun + Trim + Grace = Total, in that order across the row, so the
    // headline figure can be checked against its three parts by eye.
    {
      key: "rem",
      label: "Siderun",
      th: "Uncut web left over after the knives, edge trim and grace already netted out. The scrapped slack in Total.",
      cls: (L) => "dsf-set-rem" + (L.remaining != null && L.remaining < 0 ? " sl-bad" : ""),
      sort: (L) => (L.remaining == null ? -Infinity : L.remaining),
      text: (L) => mmText(L.remaining),
      cell: (L) => (L.remaining != null ? esc(fmt(L.remaining)) + " mm" : "—"),
    },
    {
      key: "edge",
      label: "Trim",
      cls: "dsf-set-edge",
      th: "Edge trim scrapped off this web, both edges — the Edge Trim (total mm) set at the top of the page.",
      sort: (L) => (L.edge == null ? -1 : L.edge),
      text: (L) => mmText(L.edge),
      cell: (L) => (L.edge != null ? esc(fmt(L.edge)) + " mm" : "—"),
    },
    {
      key: "grace",
      label: "Grace",
      cls: "dsf-set-grace",
      th: "Side trim handed to the rolls instead of being scrapped — the knives are set this much wider in total, and the client is still billed the width ordered.",
      sort: (L) => (L.size > 0 ? L.grace : -1),
      text: (L) => (L.size > 0 ? mmText(L.grace) : "—"),
      cell: (L) => (L.size > 0 ? esc(fmt(L.grace)) + " mm" : "—"),
    },
    {
      key: "total",
      label: "Total",
      cls: "dsf-set-trim",
      th: "Everything this web gives up beyond the widths asked for — the Siderun, Trim and Grace beside it added together (i.e. deckle size minus the roll widths). The table starts ranked by this, most first.",
      sort: (L) => (L.total == null ? -1 : L.total),
      text: (L) => mmText(L.total),
      cell: (L) => (L.total != null ? esc(fmt(L.total)) + " mm" : "—"),
    },
    {
      key: "drm",
      label: "Deckle R.M.",
      th: "Length of the web this layout runs on.",
      sort: (L) => L.drm || 0,
      text: (L) => mText(L.drm),
      cell: (L) => esc(mText(L.drm)),
    },
    {
      key: "rm",
      label: "Roll R.M.",
      th: "Length wound on each finished roll.",
      sort: (L) => L.rm || 0,
      text: (L) => mText(L.rm),
      cell: (L) => esc(mText(L.rm)),
    },
    {
      key: "rolls",
      label: "Rolls",
      cls: "dsf-set-rolls",
      th: "Finished rolls this layout yields — knives × webs × rolls per knife.",
      sort: (L) => L.rolls,
      text: (L) => fmtI(L.rolls),
      cell: (L) => esc(fmtI(L.rolls)),
    },
    {
      key: "webs",
      label: "Deckle",
      th: "How many deckle webs (reels) run this layout.",
      sort: (L) => L.webs,
      text: (L) => fmtI(L.webs),
      cell: (L) => esc(fmtI(L.webs)),
    },
    {
      key: "act",
      label: "",
      plain: true,
      cls: "dsf-set-edit-cell",
      cell: (L) =>
        `<button type="button" class="dsf-set-edit" data-edit-lid="${esc(L.lid)}"` +
        ` title="Edit layout #${esc(L.no)}" aria-label="Edit layout #${esc(L.no)}">` +
        `<i class="fa-solid fa-pen"></i></button>`,
    },
  ];

  // Sort + per-column filters outlive a redraw -- recalcAll() rebuilds this
  // table on every keystroke -- so they live out here rather than inside the
  // renderer.
  let SET_SORT = { key: "total", dir: "desc" };
  const SET_FILTERS = {};
  let SET_ROWS = [];
  let SET_PENDING = [];
  let SET_TOTALS = { totWebs: 0, totRolls: 0, sqm: 0 };

  // Filters match what the cell shows, with grouping commas ignored so "1250"
  // still finds a "1,250 mm" cell.
  const filterKey = (v) => String(v ?? "").toLowerCase().replace(/,/g, "").trim();

  const activeSetFilters = () =>
    SET_COLS.filter((c) => !c.plain && filterKey(SET_FILTERS[c.key]) !== "").map((c) => [c, filterKey(SET_FILTERS[c.key])]);

  // Rows as the table currently shows them: filtered, then sorted.
  function visibleSetRows() {
    const filters = activeSetFilters();
    const rows = SET_ROWS.filter((L) => filters.every(([c, q]) => filterKey(c.text(L)).includes(q)));
    const col = SET_COLS.find((c) => c.key === SET_SORT.key && !c.plain);
    if (!col) return rows;
    const dir = SET_SORT.dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      const av = col.sort(a);
      const bv = col.sort(b);
      const d =
        typeof av === "string" || typeof bv === "string"
          ? String(av).localeCompare(String(bv), undefined, { numeric: true })
          : av - bv;
      if (d) return d * dir;
      // Ties break the way this table always does, whichever way it is sorted:
      // the layout throwing away more in total leads, then layout order.
      const t = (b.total || 0) * b.webs - (a.total || 0) * a.webs;
      return t !== 0 ? t : a.no - b.no;
    });
  }

  function renderSetSummary() {
    const rows = layoutRows();
    // Only layouts that are actually drawn (at least one roll width) make it
    // into the recap proper. A half-filled row still has to be listed, as a
    // "not drawn yet" line below the rest -- this table is the only route back
    // into it.
    const pending = [];
    const set = rows
      .map((tr, i) => {
        const r = readRow(tr);
        const no = i + 1;
        const lid = tr.dataset.lid;
        if (!r.cuts.length) {
          pending.push({ no, lid });
          return null;
        }
        const size = rowSize(tr) || 0;
        const cutSum = round2(r.graced.reduce((n, [, w]) => n + w, 0));
        const rpw = rollsPerWeb(r);
        // Width handed to the rolls rather than scrapped -- the difference
        // between what the knives are set to and what was asked for. Already
        // netted out of `remaining` below (the slack is what is left AFTER
        // grace was shared out), so the three never double-count.
        const graceMm = round2(
          r.graced.reduce((n, [, w]) => n + w, 0) - r.cuts.reduce((n, [, w]) => n + w, 0),
        );
        return {
          no,
          lid,
          size,
          cuts: r.cuts,
          graced: r.graced,
          grace: graceMm,
          cutSum,
          // Usable web left over after the knives -- negative means the layout
          // overflows the web.
          remaining: size > 0 ? round2(size - 2 * EDGE - cutSum) : null,
          // Edge trim netted off this web -- both edges. The same on every row
          // (it comes off one field at the top of the page), but it earns a
          // column of its own between Siderun and Grace so the four read
          // straight across as the sum they are.
          edge: size > 0 ? round2(2 * EDGE) : null,
          // Everything one web gives up beyond the widths ASKED FOR: both edge
          // trims and the uncut slack (scrapped), plus the grace (cut, and
          // run, but handed to the rolls instead of billed). Exactly `size −
          // the roll widths`, which is why the three parts beside it add up to
          // it on every row.
          total: size > 0 ? round2(2 * EDGE + Math.max(0, round2(size - 2 * EDGE - cutSum)) + graceMm) : null,
          drm: r.drm,
          rm: r.rm,
          rpw,
          webs: r.webs,
          // Finished rolls this layout yields = knives × webs × rolls per knife.
          rolls: r.cuts.length * r.webs * rpw,
        };
      })
      .filter(Boolean);

    // Worst first: the layout that scraps the most width off its web leads,
    // down to the tightest one. `no` stays the layout's own number (messages
    // name rows by it), which is why the counter on the left is separate.
    set.sort((a, b) => {
      const at = a.total == null ? -1 : a.total;
      const bt = b.total == null ? -1 : b.total;
      if (bt !== at) return bt - at;
      const bw = (b.total || 0) * b.webs;
      const aw = (a.total || 0) * a.webs;
      if (bw !== aw) return bw - aw;
      return a.no - b.no;
    });

    if (!set.length) {
      // Nothing drawn yet. The header row would be an empty strip with a
      // second Add button in it, so it stays hidden and the empty state is the
      // single way in. It opens the blank layout the page already holds rather
      // than adding another.
      dsfSetSub.textContent = "";
      dsfSetHead.hidden = true;
      SET_ROWS = [];
      SET_PENDING = pending;
      SET_TOTALS = { totWebs: 0, totRolls: 0, sqm: 0 };
      const first = pending[0];
      dsfSetBody.innerHTML =
        `<div class="dsf-set-empty">` +
        `<span>Nothing set yet — draw a layout and it appears here.</span>` +
        `<button type="button" class="dsf-set-empty-btn"` +
        (first ? ` data-edit-lid="${esc(first.lid)}"` : ` data-add-layout="1"`) +
        `><i class="fa-solid fa-plus"></i> Add Layout</button>` +
        `</div>`;
      dsfFinalStats.innerHTML = "";
      dsfStatChips.innerHTML =
        `<div class="dsa-stat dc-stat-empty"><span class="k">Figures</span>` +
        `<span class="v">Draw a layout and the trim is worked out here</span></div>`;
      return;
    }
    dsfSetHead.hidden = false;

    const totWebs = set.reduce((n, L) => n + L.webs, 0);
    const totRolls = set.reduce((n, L) => n + L.rolls, 0);
    // Facestock the job consumes: Σ web width × web length × webs, in m².
    const sqm = round2(set.reduce((n, L) => n + (L.size / 1000) * (L.drm || 0) * L.webs, 0));
    // Webs per distinct deckle width -- the reels a real run would pull.
    const byS = new Map();
    set.forEach((L) => {
      if (L.size > 0) byS.set(L.size, (byS.get(L.size) || 0) + L.webs);
    });
    const sizeLine = [...byS.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sz2, w]) => `${fmt(sz2)} mm × ${fmtI(w)}`)
      .join("  ·  ");
    dsfSetSub.textContent = sizeLine ? `Deckle webs: ${sizeLine}` : "";

    SET_ROWS = set;
    SET_PENDING = pending;
    SET_TOTALS = { totWebs, totRolls, sqm };
    paintSetTable();

    renderFinalStats(set, totWebs, sqm, byS, sizeLine);
  }

  // Redraw the recap under the current sort and filters. innerHTML replaces
  // the filter boxes along with everything else, so whichever one was being
  // typed in is refocused with its caret where it was.
  function paintSetTable() {
    const act = document.activeElement;
    const keep =
      act && act.classList && act.classList.contains("dsf-set-filter")
        ? { col: act.dataset.filterCol, start: act.selectionStart, end: act.selectionEnd }
        : null;
    dsfSetBody.innerHTML = setTableHTML();
    if (!keep) return;
    const el = dsfSetBody.querySelector(`.dsf-set-filter[data-filter-col="${keep.col}"]`);
    if (!el) return;
    el.focus();
    try {
      el.setSelectionRange(keep.start, keep.end);
    } catch {
      /* not a settable input */
    }
  }

  function setTableHTML() {
    const rows = visibleSetRows();
    const hidden = SET_ROWS.length - rows.length;
    const span = SET_COLS.length;
    const { totWebs, totRolls, sqm } = SET_TOTALS;

    const head = SET_COLS.map((c) => {
      const title = c.th ? ` title="${esc(c.th)}"` : "";
      if (c.plain) return `<th${title}>${esc(c.label)}</th>`;
      const on = SET_SORT.key === c.key;
      const dirName = SET_SORT.dir === "asc" ? "ascending" : "descending";
      const arrow = on ? (SET_SORT.dir === "asc" ? "fa-arrow-up-long" : "fa-arrow-down-long") : "fa-sort";
      return (
        `<th class="dsf-set-th${on ? " is-sorted" : ""}" data-sort-col="${esc(c.key)}"` +
        ` role="button" tabindex="0" aria-sort="${on ? dirName : "none"}"` +
        ` title="${esc(`${c.th ? c.th + " " : ""}Click to sort.`)}">` +
        `<span class="dsf-th-in">${esc(c.label)}<i class="dsf-th-arrow fa-solid ${arrow}"></i></span></th>`
      );
    }).join("");

    const filterRow = SET_COLS.map((c) => {
      if (c.plain) return `<th></th>`;
      const v = SET_FILTERS[c.key] || "";
      return (
        // No placeholder text: several of these columns are narrower than the
        // word "Search", which clipped to "Sear". The magnifier the stylesheet
        // draws in the box says the same thing and fits every width.
        `<th><input type="text" autocomplete="off" class="dsf-set-filter${v ? " is-on" : ""}"` +
        ` data-filter-col="${esc(c.key)}" value="${esc(v)}"` +
        ` aria-label="Search ${esc(c.label || "column")}" /></th>`
      );
    }).join("");

    const body = rows
      .map(
        (L, i) =>
          `<tr data-edit-lid="${esc(L.lid)}" title="Click to edit layout #${esc(L.no)}">${SET_COLS.map((c) => {
            const cls = typeof c.cls === "function" ? c.cls(L) : c.cls;
            return `<td${cls ? ` class="${cls}"` : ""}>${c.cell(L, i)}</td>`;
          }).join("")}</tr>`,
      )
      .join("");

    // Layouts with nothing drawn on them yet are pinned under the rest and are
    // never filtered out -- this table is the only handle on them.
    const pendingRows = SET_PENDING.map(
      (L, j) => `
      <tr class="dsf-set-pending" data-edit-lid="${esc(L.lid)}" title="Click to draw layout #${esc(L.no)}">
        <td class="dsf-set-no">${rows.length + j + 1}</td>
        <td colspan="${span - 2}" style="text-align:left;">Not drawn yet — no roll widths on this layout. Draw it or remove it.</td>
        <td class="dsf-set-edit-cell">
          <button type="button" class="dsf-set-edit" data-edit-lid="${esc(L.lid)}"
                  title="Draw layout #${esc(L.no)}" aria-label="Draw layout #${esc(L.no)}">
            <i class="fa-solid fa-pen"></i>
          </button>
        </td>
      </tr>`,
    ).join("");

    const noMatch =
      rows.length === 0 && hidden > 0
        ? `<tr class="dsf-set-nomatch"><td colspan="${span}">No layout matches these filters.` +
          ` <button type="button" class="dsf-set-clear" data-clear-filters="1">Clear filters</button></td></tr>`
        : "";

    // The totals are the whole plan's, not the filtered view's -- what gets
    // made doesn't change because someone typed in a search box -- so say
    // plainly when rows are being held back from a footer that still counts
    // them.
    const hiddenNote =
      hidden > 0
        ? ` <span class="dsf-set-hid">${fmtI(hidden)} hidden by filter, still counted` +
          ` <button type="button" class="dsf-set-clear" data-clear-filters="1">Clear</button></span>`
        : "";

    return `
      <table class="dsf-set-table">
        <thead>
          <tr>${head}</tr>
          <tr class="dsf-set-filters">${filterRow}</tr>
        </thead>
        <tbody>${body}${noMatch}${pendingRows}</tbody>
        <tfoot>
          <tr>
            <td colspan="4" style="text-align:left;">Total — ${SET_ROWS.length} layout${SET_ROWS.length === 1 ? "" : "s"}${hiddenNote}</td>
            <td colspan="6" style="text-align:right;">${sqm > 0 ? `Facestock ${esc(fmt(sqm))} m²` : ""}</td>
            <td>${esc(fmtI(totRolls))}</td>
            <td>${esc(fmtI(totWebs))}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>`;
  }

  // Click cycles a column the way a Tabulator header does: ascending, then
  // descending. Moving to another column starts it ascending.
  function sortSetBy(key) {
    SET_SORT = SET_SORT.key === key ? { key, dir: SET_SORT.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    paintSetTable();
  }

  function clearSetFilters() {
    SET_COLS.forEach((c) => {
      delete SET_FILTERS[c.key];
    });
    paintSetTable();
  }

  // ---- the figures -------------------------------------------------------
  // Side Run, Grace and Total are whole-job totals, in mm as well as %, never
  // a per-web average -- so they reconcile by eye, which is the quickest check
  // the figures are sane:
  //
  //     Total = edge trim x webs + Side Run + Grace
  //
  // in mm and in % alike, matching the Siderun / Trim / Grace / Total columns
  // of the recap table above.
  function renderFinalStats(set, totWebs, sqm, byS, sizeLine) {
    // Side Run: the uncut slack left on each web after its knives (edge trims
    // netted out already) -- the trim a different layout could still recover.
    let sideMm = 0;
    let avoidableSqM = 0;
    set.forEach((L) => {
      if (!(L.size > 0) || !(L.remaining > 0)) return;
      sideMm += L.remaining * L.webs;
      avoidableSqM += (L.remaining / 1000) * (L.drm || 0) * L.webs;
    });
    sideMm = round2(sideMm);
    avoidableSqM = round2(avoidableSqM);
    const avoidPct = sqm > 0 ? round2((avoidableSqM / sqm) * 100) : 0;

    // Grace: side trim handed to the rolls instead of being scrapped. Not
    // waste -- the web is cut and wound -- but not asked for or billed either,
    // so it is reported on its own and counted in Total below.
    let graceMm = 0;
    let graceSqM = 0;
    set.forEach((L) => {
      if (!(L.size > 0) || !(L.grace > 0)) return;
      graceMm += L.grace * L.webs;
      graceSqM += (L.grace / 1000) * (L.drm || 0) * L.webs;
    });
    graceMm = round2(graceMm);
    graceSqM = round2(graceSqM);
    const gracePct = sqm > 0 ? round2((graceSqM / sqm) * 100) : 0;

    // Total: everything the job gives up beyond the widths ASKED FOR -- edge
    // trim + Side Run (both scrapped) + Grace (cut, but not billed). Equal to
    // deckle size minus the roll widths, over every web. Extra Rolls are NOT
    // in it: they are spare stock cut from width that would otherwise have
    // been trimmed away, not a second helping of loss.
    const edgeMm = round2(2 * EDGE * totWebs);
    const wasteMm = round2(edgeMm + sideMm + graceMm);
    let edgeSqM = 0;
    set.forEach((L) => {
      if (L.size > 0) edgeSqM += ((2 * EDGE) / 1000) * (L.drm || 0) * L.webs;
    });
    const wasteSqM = round2(edgeSqM + avoidableSqM + graceSqM);
    const wastePct = sqm > 0 ? round2((wasteSqM / sqm) * 100) : 0;

    const { extraRolls, extraSqM, orphanRolls } = ALLOC;
    // With more than one web in play the reels to pull are a LIST, and a list
    // needs a line of its own -- it is the one figure here that grows with the
    // plan. A single width is just a number, and giving a number its own
    // full-width bar leaves most of that bar empty, so it joins the other
    // chips instead (.dsf-final-stats:empty then takes the line away).
    const distinctSizes = byS.size;
    dsfFinalStats.innerHTML =
      distinctSizes > 1 ? finalStat("Deckle Webs Used", sizeLine, "", "dsf-stat-lead", sizeLine) : "";
    dsfStatChips.innerHTML = [
      distinctSizes > 1
        ? ""
        : finalStat("Deckle Size", `${fmt(headlineSize() || 0)} mm`, "", "dsa-stat-size"),
      finalStat("Layouts", `${set.length}`, "", "dsa-stat-narrow"),
      finalStat("Deckle Count", `${fmtI(totWebs)}`, "", "dsa-stat-narrow"),
      finalStat("Facestock Used", `${fmt(sqm)} m²`),
      finalStat(
        "Extra Rolls",
        extraRolls ? `${fmtI(extraRolls)} · ${fmt(extraSqM)} m²` : "0",
        extraRolls ? "warn" : "good",
        "",
        extraRolls
          ? `Rolls made beyond what the requirements ask for (${fmt(extraSqM)} m²).` +
            (orphanRolls
              ? ` ${fmtI(orphanRolls)} of them are a width or length no requirement asks for at all.`
              : "")
          : "Every roll made is a roll asked for.",
      ),
      finalStat(
        "Side Run",
        `${fmt(avoidPct)} % | ${fmt(sideMm)} mm`,
        avoidPct <= 2 ? "good" : "warn",
        "",
        `Total uncut slack across all ${fmtI(totWebs)} webs (${fmt(avoidableSqM)} m²).`,
      ),
      finalStat(
        "Grace",
        `${fmt(gracePct)} % | ${fmt(graceMm)} mm`,
        graceMm > 0 ? "good" : "",
        "",
        graceMm > 0
          ? `Side trim shared out over the rolls across all ${fmtI(totWebs)} webs (${fmt(graceSqM)} m²) — cut and wound, but billed at the widths asked for.`
          : "No grace given: every roll is cut at the width asked for.",
      ),
      finalStat(
        "Total",
        `${fmt(wastePct)} % | ${fmt(wasteMm)} mm`,
        wastePct <= 10 ? "good" : "warn",
        "dsa-stat-wide",
        `Everything beyond the widths asked for: Edge trim ${fmt(edgeMm)} mm + Side Run ${fmt(sideMm)} mm` +
          ` + Grace ${fmt(graceMm)} mm = ${fmt(wasteSqM)} m². Of that, ${fmt(round2(wasteSqM - graceSqM))} m² is scrapped` +
          ` and ${fmt(graceSqM)} m² goes out on the rolls. Spare rolls are not counted here.`,
      ),
    ].join("");
  }

  // Paint the issues panel. Nothing is submitted from this page, so these
  // never block anything -- they say what is wrong with the plan as drawn.
  function renderIssues() {
    const { errors } = ISSUES;
    if (!errors.length) {
      dsfIssues.hidden = true;
      dsfIssuesBody.innerHTML = "";
      return;
    }
    dsfIssues.hidden = false;
    dsfIssuesBody.classList.add("is-error");
    dsfIssuesBody.innerHTML =
      `<div class="dsf-issue-head">Check these</div><ul>${errors.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
  }

  // ---- wiring ------------------------------------------------------------
  // A layout is added and drawn in one move -- there is no layout table on the
  // page to type into, so the new row opens straight away.
  dsfAddLayout.addEventListener("click", () => {
    if (dsfAddLayout.disabled) return;
    openLayoutDialog(addLayoutRow().dataset.lid);
  });
  document.getElementById("dcAddReq").addEventListener("click", () => {
    addReqRow().querySelector(".dc-req-width").focus();
    recalcAll();
  });
  // The recap is rebuilt on every keystroke, so its controls are delegated
  // rather than re-bound each time.
  dsfSetBody.addEventListener("click", (ev) => {
    const edit = ev.target.closest("[data-edit-lid]");
    if (edit) {
      openLayoutDialog(edit.dataset.editLid);
      return;
    }
    if (ev.target.closest("[data-add-layout]")) {
      openLayoutDialog(addLayoutRow().dataset.lid);
      return;
    }
    if (ev.target.closest("[data-clear-filters]")) {
      clearSetFilters();
      return;
    }
    // th[...] rather than [...]: the filter boxes carry data-filter-col, and a
    // click in one must not also sort the column it sits under.
    const th = ev.target.closest("th[data-sort-col]");
    if (th) sortSetBy(th.dataset.sortCol);
  });
  dsfSetBody.addEventListener("input", (ev) => {
    const f = ev.target.closest(".dsf-set-filter");
    if (!f) return;
    SET_FILTERS[f.dataset.filterCol] = f.value;
    paintSetTable();
  });
  dsfSetBody.addEventListener("keydown", (ev) => {
    const f = ev.target.closest(".dsf-set-filter");
    if (f) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        f.value = "";
        SET_FILTERS[f.dataset.filterCol] = "";
        paintSetTable();
      }
      return;
    }
    const th = ev.target.closest("th[data-sort-col]");
    if (th && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      sortSetBy(th.dataset.sortCol);
    }
  });
  graceBtn.addEventListener("click", () => {
    graceOpen = !graceOpen;
    renderGracePanel();
    if (graceOpen) gracePanel.scrollIntoView({ block: "nearest" });
  });
  // The panel is rebuilt on every recalc, so its controls are delegated.
  gracePanel.addEventListener("click", (ev) => {
    const tr = layoutBody.querySelector(".dsf-layout-row.is-editing");
    if (!tr) return;
    if (ev.target.closest("[data-grace-spread]")) {
      graceSpreadEvenly(tr);
      return;
    }
    if (ev.target.closest("[data-grace-clear]")) {
      graceClear(tr);
      return;
    }
    if (ev.target.closest("[data-grace-close]")) {
      graceOpen = false;
      renderGracePanel();
      graceBtn.focus();
    }
  });
  gracePanel.addEventListener("input", (ev) => {
    const el = ev.target.closest("[data-grace-slot]");
    if (!el) return;
    const tr = layoutBody.querySelector(".dsf-layout-row.is-editing");
    if (!tr) return;
    const raw = String(el.value).trim();
    // Plain decimal only -- a text box would otherwise accept "1e5" or "0x10",
    // both of which Number() happily turns into a width. A lone "." or a
    // trailing one is mid-entry, not an error: it reads as 0 for now and the
    // box keeps the text so the next digit lands where it is expected.
    const partial = raw === "" || raw === ".";
    const bad = !partial && !/^\d*(\.\d*)?$/.test(raw);
    el.classList.toggle("is-bad", bad);
    if (bad) return;
    const n = partial ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    // Zero and blank are the same thing -- no grace on that roll -- and
    // neither is stored, so a row with nothing given stays plainly ungraced.
    if (n === 0) delete graceOf(tr)[el.dataset.graceSlot];
    else graceOf(tr)[el.dataset.graceSlot] = round2(n);
    recalcAll();
  });
  document.getElementById("dsfLayoutModalClose").addEventListener("click", closeLayoutDialog);
  document.getElementById("dsfLayoutModalDone").addEventListener("click", closeLayoutDialog);
  layoutModal.addEventListener("click", (ev) => {
    if (ev.target === layoutModal) closeLayoutDialog();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && layoutModal.classList.contains("show")) closeLayoutDialog();
  });
  // Edge Trim is one of the bounds a deckle size is judged against ("must be
  // more than the N mm edge trim"), so moving it re-judges every box rather
  // than only redrawing the plan.
  dsfTrim.addEventListener("input", syncSizes);
  dsfTrim.addEventListener("blur", () => {
    normaliseTrim();
    syncSizes();
  });
  dsfTrim.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === "Escape") {
      ev.preventDefault();
      dsfTrim.blur();
    }
  });
  // The one Deckle R.M. on the page. It is a starting value for layouts added
  // from here on -- changing it never reaches back into a layout already
  // drawn, which would silently re-plan a job somebody has finished -- and it
  // is the length AI Deckle Set plans against.
  //
  // There used to be a second box for the latter, in the AI panel, kept in
  // step by copying this field into it on every keystroke. It was never a
  // second setting: one physical quantity, the length of one deckle web,
  // seeded on both sides from the one DEFAULT_DECKLE_RUNNING_METERS. Asking
  // twice only created the chance of them disagreeing.
  drmDefaultEl.addEventListener("input", () => {
    const v = Number(drmDefaultEl.value);
    drmDefaultEl.classList.toggle("is-bad", trimmedVal(drmDefaultEl) !== "" && !(Number.isFinite(v) && v > 0));
  });

  // Reset asks once, in the button itself -- a confirm dialog for something
  // that takes ten seconds to retype would be worse than the mistake.
  let resetArmed = false;
  let resetTimer = null;
  function disarmReset() {
    resetArmed = false;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = null;
    resetLabel.textContent = "Reset";
    resetBtn.classList.remove("is-armed");
  }
  resetBtn.addEventListener("click", () => {
    if (!resetArmed) {
      resetArmed = true;
      resetLabel.textContent = "Clear it all?";
      resetBtn.classList.add("is-armed");
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    closeLayoutDialog();
    reqBody.innerHTML = "";
    layoutBody.innerHTML = "";
    AI_PLANNED = false;
    ONLY_CHOSEN = false;
    if (dsaBody) dsaBody.innerHTML = "";
    SET_SORT = { key: "total", dir: "desc" };
    clearSetFilters();
    for (let i = 0; i < 3; i += 1) addReqRow();
    addLayoutRow();
  });

  // ---- AI Deckle Set -----------------------------------------------------
  // Asks the server (utils/deckleOptimizer, behind DECKLE_AUTO_ENABLED) for the
  // least-waste set of layouts and writes them into the layout rows. Purely a
  // drafting aid: it replaces the layouts and hands straight back to
  // recalcAll(), so every check, every figure and every warning behaves
  // exactly as it does for a hand-drawn plan -- and, this being a calculator,
  // there was never anything for it to save in the first place.
  if (dsaRun) {
    const dsaOvPct = document.getElementById("dsaOvPct");
    const dsaOvRolls = document.getElementById("dsaOvRolls");

    const dsaShowError = (msg) => {
      dsaBody.innerHTML = `<div class="dsa-err">${esc(msg)}</div>`;
    };
    const dsaShowNotes = (notes) => {
      if (!Array.isArray(notes) || !notes.length) return;
      dsaBody.innerHTML +=
        `<div class="dsa-notes"><ul>${notes.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
    };

    // Replace every layout row with the planned ones.
    function dsaApply(plan) {
      // Every layout row is about to be replaced -- close the dialog first so
      // it can't be left scoped to a row that no longer exists.
      closeLayoutDialog();
      layoutBody.innerHTML = "";
      // The optimizer has picked the web for every layout -- show just that
      // one diagram per layout instead of one per available size.
      ONLY_CHOSEN = true;

      // Nothing came back to apply -- that is not a plan, so the page is left
      // hand-drawable with a blank row to start from.
      if (!plan.layouts.length) {
        AI_PLANNED = false;
        addLayoutRow();
        return;
      }
      plan.layouts.forEach((L) => {
        const hasLen = L.rm != null && L.drm != null;
        addLayoutRow({
          cuts: L.cuts.map((c) => [c.slot, c.width]),
          drm: hasLen ? L.drm : null,
          rm: hasLen ? L.rm : null,
          webs: L.webs,
          // Each layout remembers the web it was planned for; rowSize() reads
          // it back and every check below runs against that width.
          size: L.size,
        });
      });
      AI_PLANNED = true;
      recalcAll();
    }

    async function dsaPlan() {
      // Plan what the Requirements table says, as recalcAll() last read it --
      // ticked, filled in and valid. A half-typed line is not a requirement.
      recalcAll();
      const orders = LIVE_REQS;
      if (!orders.length) {
        dsaShowError("Fill in at least one requirement — roll width and quantity — before planning.");
        return;
      }
      if (!SIZE_LIST.length) {
        dsaShowError("Add at least one deckle size first — the “Deckle Size” box on the strip above.");
        return;
      }
      // Deckle R.M. lives on the control strip -- the same field every new
      // layout opens with, so a plan can never come back at a length the
      // page was not showing.
      const drm = Number(drmDefaultEl.value);
      drmDefaultEl.classList.toggle("is-bad", !(Number.isFinite(drm) && drm > 0));
      if (!(Number.isFinite(drm) && drm > 0)) {
        dsaShowError("Deckle R.M. must be a length greater than 0.");
        return;
      }

      dsaRun.disabled = true;
      const label = dsaRun.innerHTML;
      dsaRun.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Planning…`;
      dsaBody.innerHTML = "";
      try {
        const res = await fetch("/app/labels/production/deckle-calculator/auto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orders,
            sizes: SIZE_LIST,
            trim: Number(dsfTrim.value),
            drm,
            overrunPct: Number(dsaOvPct.value) / 100,
            overrunRolls: Number(dsaOvRolls.value),
          }),
        });
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!data) {
          dsaShowError(
            `AI Deckle Set failed (HTTP ${res.status}). Plan the layouts by hand — Add Deckle Layout, under Deckle Set.`,
          );
          return;
        }
        if (!data.ok) {
          dsaShowError(data.error || "AI Deckle Set could not plan these requirements.");
          dsaShowNotes(data.notes);
          return;
        }
        dsaApply(data.plan);
        // A plan that worked prints nothing. The optimizer still returns
        // `notes` and they are still shown when it FAILS (above), where they
        // are the only account of why it could not plan. On success they were
        // commentary on a plan the page already shows in full: the forced
        // overrun, the mixed-web verdict and the spare rolls are all readable
        // off the layout rows dsaApply just filled and the summary bar at the
        // foot of the page.
        //
        // Deliberately NOT done on the Set Deckle page, which runs the same
        // panel against the same endpoint: there the plan becomes real batches
        // and a forced overrun is stock that will actually be made, so what
        // the optimizer had to say about it is worth the line.
        if (typeof showToast === "function") {
          showToast(
            `AI Deckle Set: ${data.plan.layouts.length} layout(s), ${data.plan.webs} web(s), ${fmt(data.plan.waste.wastePct)}% waste.`,
            "success",
          );
        }
      } catch {
        dsaShowError(
          "AI Deckle Set could not be reached. Plan the layouts by hand — Add Deckle Layout, under Deckle Set.",
        );
      } finally {
        dsaRun.disabled = false;
        dsaRun.innerHTML = label;
      }
    }

    dsaRun.addEventListener("click", dsaPlan);
  }

  // ---- init --------------------------------------------------------------
  normaliseTrim();
  // One empty box to start; it grows from there as widths are typed.
  growSizeFields();
  for (let i = 0; i < 3; i += 1) addReqRow();
  // addLayoutRow() ends in recalcAll(), which draws everything else.
  addLayoutRow();
})();
