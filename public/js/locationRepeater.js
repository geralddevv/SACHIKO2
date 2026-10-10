/* Location repeater for the New User / Edit User dialogs (one card per
   location, re-rendered wholesale on every +/- click, per-location dispatch
   mode). Load before the dialog's inline script.

     window.formatMobileInput(input)            digits only, "12345 67890"
     const rep = createLocationRepeater({ container, countInput, minus, plus });
     rep.setCount(n)                            grow/shrink, keeping typed values
     rep.setRows([{ userLocation, dispatchAddress, selfDispatch, ... }])
                                                replace every row (Edit dialog)
   The row field names (locationDetails[i][...]) are what POST /form/user and
   POST /form/edit/user/:id read. */
(function () {
  "use strict";

  function formatMobileValue(value) {
    const digits = String(value ?? "").replace(/\D/g, "").slice(0, 10);
    return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
  }

  function formatMobileInput(input) {
    input.addEventListener("keydown", (e) => {
      const allowedKeys = ["Backspace", "ArrowLeft", "ArrowRight", "Tab", "Delete"];
      if ((e.ctrlKey || e.metaKey) && ["v", "V", "c", "C", "x", "X", "a", "A"].includes(e.key)) return;
      if (!/^\d$/.test(e.key) && !allowedKeys.includes(e.key)) e.preventDefault();
    });
    input.addEventListener("input", function () {
      this.value = formatMobileValue(this.value);
    });
  }

  window.formatMobileInput = formatMobileInput;

  window.createLocationRepeater = function (opts) {
    const locationContainer = opts.container;
    const locationCountInput = opts.countInput;
    const locationMinusBtn = opts.minus;
    const locationPlusBtn = opts.plus;

    function normalizeLocationCount(value) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return 1;
      return Math.min(parsed, 25);
    }

    function setLocationCount(value) {
      if (!locationCountInput || !locationContainer) return;
      const safeCount = normalizeLocationCount(value);
      locationCountInput.value = String(safeCount);
      renderLocationRows(safeCount);
    }

    const EMPTY_ROW = {
      userLocation: "", dispatchAddress: "", selfDispatch: "", transportName: "",
      transportContact: "", dropLocation: "", deliveryMode: "", deliveryLocation: "", clientPayment: "",
    };

    function readRowValues(row) {
      const get = (suffix) => row.querySelector(`[name$="[${suffix}]"]`)?.value || "";
      return {
        userLocation: get("userLocation"), dispatchAddress: get("dispatchAddress"), selfDispatch: get("selfDispatch"),
        transportName: get("transportName"), transportContact: get("transportContact"), dropLocation: get("dropLocation"),
        deliveryMode: get("deliveryMode"), deliveryLocation: get("deliveryLocation"), clientPayment: get("clientPayment"),
      };
    }

    function escapeAttr(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function buildRowHtml(i, v) {
      const isSelf = v.selfDispatch === "Self Dispatch";
      const sel = (val, opt) => (val === opt ? "selected" : "");
      return `
        <div class="location-row">
          <div class="loc-line">
            <input type="text" name="locationDetails[${i}][userLocation]"
              placeholder="Enter Location" aria-label="Location ${i + 1}"
              value="${escapeAttr(v.userLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
            <input type="text" name="locationDetails[${i}][dispatchAddress]"
              placeholder="Enter Address" aria-label="Address ${i + 1}"
              value="${escapeAttr(v.dispatchAddress.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
          </div>
          <div class="loc-dispatch">
            <span class="loc-title">Dispatch Details — Location ${i + 1}</span>
            <div class="loc-fields">
              <select class="loc-dispatch-mode" aria-label="Dispatch Type for location ${i + 1}">
                <option value="TRANSPORT" ${isSelf ? "" : "selected"}>Transport</option>
                <option value="SELF" ${isSelf ? "selected" : ""}>Self Dispatch</option>
              </select>
              <input type="hidden" class="loc-self-dispatch" name="locationDetails[${i}][selfDispatch]" value="${isSelf ? "Self Dispatch" : ""}" />
              <div class="loc-transport" style="${isSelf ? "display:none;" : ""}">
                <input type="text" name="locationDetails[${i}][transportName]"
                  placeholder="Transport Name" value="${escapeAttr(v.transportName.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
                <input type="text" class="loc-transport-contact" name="locationDetails[${i}][transportContact]"
                  placeholder="Transport Contact" value="${escapeAttr(v.transportContact)}" />
                <input type="text" name="locationDetails[${i}][dropLocation]"
                  placeholder="Drop Location" value="${escapeAttr(v.dropLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
                <select name="locationDetails[${i}][deliveryMode]">
                  <option value="">Delivery Mode</option>
                  <option value="DOOR" ${sel(v.deliveryMode, "DOOR")}>DOOR</option>
                  <option value="GODOWN" ${sel(v.deliveryMode, "GODOWN")}>GODOWN</option>
                </select>
                <input type="text" name="locationDetails[${i}][deliveryLocation]"
                  placeholder="Delivery Location" value="${escapeAttr(v.deliveryLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
                <select name="locationDetails[${i}][clientPayment]">
                  <option value="">Payment</option>
                  <option value="PAY" ${sel(v.clientPayment, "PAY")}>PAY</option>
                  <option value="TO PAY" ${sel(v.clientPayment, "TO PAY")}>TO PAY</option>
                </select>
              </div>
              <div class="loc-self" style="${isSelf ? "" : "display:none;"}">
                <span class="loc-self-badge">Self Dispatch</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    function renderLocationRows(count) {
      if (!locationContainer) return;
      const safeCount = normalizeLocationCount(count);
      const existingRows = Array.from(locationContainer.querySelectorAll(".location-row"));
      const currentValues = existingRows.map(readRowValues);
      let html = "";
      for (let i = 0; i < safeCount; i += 1) {
        html += buildRowHtml(i, currentValues[i] || { ...EMPTY_ROW });
      }
      locationContainer.innerHTML = html;
    }

    function applyDispatchMode(row, mode) {
      if (!row) return;
      const transport = row.querySelector(".loc-transport");
      const self = row.querySelector(".loc-self");
      const hidden = row.querySelector(".loc-self-dispatch");
      const isSelf = mode === "SELF";
      if (transport) transport.style.display = isSelf ? "none" : "";
      if (self) self.style.display = isSelf ? "" : "none";
      if (hidden) hidden.value = isSelf ? "Self Dispatch" : "";
    }

    if (locationCountInput && locationContainer) {
      setLocationCount(locationCountInput.value || 1);

      locationMinusBtn?.addEventListener("click", () => {
        setLocationCount(Math.max(1, normalizeLocationCount(locationCountInput.value || 1) - 1));
      });
      locationPlusBtn?.addEventListener("click", () => {
        setLocationCount(Math.min(25, normalizeLocationCount(locationCountInput.value || 1) + 1));
      });

      locationContainer.addEventListener("change", (e) => {
        const modeSel = e.target.closest(".loc-dispatch-mode");
        if (!modeSel) return;
        applyDispatchMode(modeSel.closest(".location-row"), modeSel.value);
      });
      locationContainer.addEventListener("input", (e) => {
        const el = e.target.closest(".loc-transport-contact");
        if (!el) return;
        el.value = formatMobileValue(el.value);
      });
    }


    function setRows(rows) {
      const list = (rows && rows.length ? rows : [{}]).slice(0, 25).map((r) => ({ ...EMPTY_ROW, ...r }));
      Object.keys(EMPTY_ROW).forEach((k) => list.forEach((r) => { r[k] = String(r[k] ?? ""); }));
      locationContainer.innerHTML = list.map((r, i) => buildRowHtml(i, r)).join("");
      locationCountInput.value = String(list.length);
    }

    return { setCount: setLocationCount, setRows };
  };
})();
