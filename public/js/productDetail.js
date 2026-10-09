// Product Code details dialog, shared by the Slitting Queue and Label Stock View.
//   ProductDetail.open("C001WB", { items })        -- items = Label Stock rows already on the page
//   ProductDetail.open("C001WB", { url: "/app/slitting/product/" })  -- fetched as url + code
// `items` may hold the code and its "-A"/"-B" variants; chips switch between them.
// Same look as the View dialog on Label Stock View, without its layer diagram. Styles: /css/productDetail.css.
(function () {
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const val = (v) => (v === undefined || v === null || v === "" ? null : v);
  const gsm = (v) => (v != null && v !== "" ? v + " GSM" : null);
  const mic = (v) => (v != null && v !== "" ? v + " MIC" : null);

  let dialog, content, head;
  const cache = new Map();

  function ensureDialog() {
    if (dialog) return;
    if (!document.querySelector('link[href^="/css/productDetail.css"]')) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/css/productDetail.css?v=7";
      document.head.appendChild(l);
    }
    dialog = document.createElement("div");
    dialog.id = "productDetailDialog";
    dialog.setAttribute("aria-hidden", "true");
    dialog.innerHTML =
      '<div class="pd-box" role="dialog" aria-modal="true">' +
      '<div class="pd-head"><div><h2 id="pd-title"></h2><p id="pd-subtitle"></p></div>' +
      '<button type="button" class="pd-close" id="pd-close-btn" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="pd-content" id="pd-content"></div></div>';
    document.body.appendChild(dialog);
    content = dialog.querySelector("#pd-content");
    dialog.querySelector("#pd-close-btn").addEventListener("click", close);
    dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dialog.classList.contains("show")) close();
    });
  }

  function close() {
    dialog.classList.remove("show");
    dialog.setAttribute("aria-hidden", "true");
  }

  // `baseRows` = the same section on the base code's card; a cell whose text
  // differs from it is marked, so a variant shows what it changed.
  const cellText = (v) => (val(v) === null ? "—" : String(v));
  const sectionHtml = (title, rows, baseRows) => `
    <div class="pd-section">
      <p class="pd-section-title">${esc(title)}</p>
      <div class="pd-table-wrap"><table class="pd-table">
        <thead><tr>${rows.map((r) => `<th>${esc(r[0])}</th>`).join("")}</tr></thead>
        <tbody><tr>${rows.map((r, i) => {
          const changed = baseRows && cellText(r[1]) !== cellText(baseRows[i]?.[1]);
          return `<td${changed ? ' class="pd-changed" title="Differs from the base code"' : ""}>${esc(cellText(r[1]))}</td>`;
        }).join("")}</tr></tbody>
      </table></div>
    </div>`;

  // Same sections, same order per roll type as the Label Stock View dialog.
  function layoutOf(ds) {
    const rollType = ds.rollType || "NORMAL";
    const f1 = ds.facestock || {}, a1 = ds.adhesive || {}, r1 = ds.releaseLiner || {};
    const f2 = ds.facestock2 || {}, a2 = ds.adhesive2 || {}, r2 = ds.releaseLiner2 || {};
    const product = [
      ["Roll Type", rollType === "NORMAL" ? "STANDARD" : rollType], ["Family", ds.family], ["Roll / Sheet", ds.rollOrSheet],
      ["Printing Technology", ds.printingTechnology], ["Laser / Ink", ds.digitalPrintType],
    ];
    const fs = (o, n) => [[`Family${n}`, o.facestockFamily], [`Type${n}`, o.facestockType], [`Make${n}`, o.facestockMake],
      [`Vendor Name${n}`, o.facestockVendorName], [`Vendor SKU Code${n}`, o.facestockVendorSkuCode],
      [`GSM${n}`, gsm(o.facestockGsm)], [`Micron${n}`, mic(o.facestockMicron)]];
    const ad = (o, n) => [[`Type${n}`, o.adhesiveType], [`Make${n}`, o.adhesiveMake],
      [`Vendor Name${n}`, o.adhesiveVendorName], [`Vendor SKU Code${n}`, o.adhesiveVendorSkuCode], [`GSM${n}`, gsm(o.adhesiveGsm)]];
    const rl = (o, n) => [[`Type${n}`, o.releaseLinerType], [`Make${n}`, o.releaseLinerMake], [`Sensing${n}`, o.releaseLinerSensing],
      [`Vendor Name${n}`, o.releaseLinerVendorName], [`Vendor SKU Code${n}`, o.releaseLinerVendorSkuCode],
      [`Color${n}`, o.releaseLinerColor], [`GSM${n}`, gsm(o.releaseLinerGsm)]];
    const L2 = " (Layer 2)";
    let sections;
    if (rollType === "DOUBLE FACESTOCK") {
      sections = [["FACESTOCK", fs(f1, "")], ["ADHESIVE", ad(a1, "")], ["FACESTOCK (LAYER 2)", fs(f2, L2)],
        ["ADHESIVE (LAYER 2)", ad(a2, L2)], ["RELEASE LINER", rl(r1, "")]];
    } else if (rollType === "DOUBLE RELEASE") {
      sections = [["FACESTOCK", fs(f1, "")], ["ADHESIVE", ad(a1, "")], ["RELEASE LINER", rl(r1, "")],
        ["ADHESIVE (LAYER 2)", ad(a2, L2)], ["RELEASE LINER (LAYER 2)", rl(r2, L2)]];
    } else {
      sections = [["FACESTOCK", fs(f1, "")], ["ADHESIVE", ad(a1, "")], ["RELEASE LINER", rl(r1, "")]];
    }
    return [["PRODUCT DETAILS", product], ...sections];
  }

  function render(items, active) {
    const ds = items[active];

    dialog.querySelector("#pd-title").textContent = ds.productCode || "";
    dialog.querySelector("#pd-subtitle").textContent = ds.labelStockId || "";
    const chips = items.length > 1
      ? `<div class="pd-variants">${items.map((x, i) => `<button type="button" class="pd-chip${i === active ? " is-active" : ""}" data-i="${i}">${esc(x.productCode)}</button>`).join("")}</div>`
      : "";
    // The base code is the one with no "-A"/"-B" suffix; a variant is compared to it.
    const base = items.find((x) => !/-[A-Z]+$/i.test(String(x.productCode || "")));
    const diffAgainst = base && base !== ds ? layoutOf(base) : null;
    const mine = layoutOf(ds);
    const note = diffAgainst
      ? `<p class="pd-legend"><span class="pd-swatch"></span>Highlighted = differs from ${esc(base.productCode)}</p>`
      : "";
    content.innerHTML = chips + note + mine.map(([t, r], i) => {
      const other = diffAgainst && diffAgainst.find(([bt]) => bt === t);
      return sectionHtml(t, r, other ? other[1] : null);
    }).join("");
    content.querySelectorAll(".pd-chip").forEach((b) => b.addEventListener("click", () => render(items, Number(b.dataset.i))));
  }

  // The code itself plus its "-A"/"-B" variants, out of rows already on the page.
  function familyOf(code, rows) {
    const re = new RegExp("^" + code.replace(/-[A-Z]+$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(-[A-Z]+)?$", "i");
    return (rows || []).filter((r) => re.test(String(r.productCode || ""))).sort((a, b) => String(a.productCode).localeCompare(String(b.productCode)));
  }

  async function open(code, opts = {}) {
    ensureDialog();
    dialog.querySelector("#pd-title").textContent = code;
    dialog.querySelector("#pd-subtitle").textContent = "";
    dialog.classList.add("show");
    dialog.setAttribute("aria-hidden", "false");
    try {
      const baseCode = code.replace(/-[A-Z]+$/i, "");
      let items = opts.items ? familyOf(code, opts.items) : cache.get(baseCode);
      if (!items) {
        content.innerHTML = '<div class="pd-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
        const res = await fetch(opts.url + encodeURIComponent(code), { headers: { Accept: "application/json" } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load the product.");
        items = data.items;
        cache.set(baseCode, items);
      }
      if (!items.length) throw new Error(`No Label Stock found for ${code}.`);
      const exact = items.findIndex((x) => String(x.productCode).toUpperCase() === code.toUpperCase());
      render(items, exact >= 0 ? exact : 0);
    } catch (err) {
      content.innerHTML = `<div class="pd-state">${esc(err.message || "Could not load the product.")}</div>`;
    }
  }

  window.ProductDetail = { open, close: () => dialog && close() };
})();
