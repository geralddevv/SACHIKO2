(function () {
  // DOM Elements
  const dom = {
    clientSwitch: document.querySelector(".client-switch"),
    userSwitch: document.querySelector(".user-switch"),
    clientContent: document.querySelector(".client-content"),
    userContent: document.querySelector(".user-content"),
    ownerMobNo: document.querySelector("#owner-mob-no"),
    vendorNameSelect: document.getElementById("userform-client-name"),
    userContactNo: document.querySelector("#user-contact-no"),
    locationCountInput: document.getElementById("locations-count"),
    locationContainer: document.getElementById("locations-details"),
    locationMinusBtn: document.getElementById("locations-minus"),
    locationPlusBtn: document.getElementById("locations-plus"),
    commoditiesSelect: document.getElementById("commodities-select"),
    otherCommodityInput: document.getElementById("other-commodity-input"),
    vendorStatusSelect: document.getElementById("client-status"),
    otherStatusInput: document.getElementById("other-status-input"),
    gstInput: document.getElementById("client-gst"),
    panInput: document.getElementById("client-pan"),
  };

  // Initialize Choices only once
  let choicesInstance = null;
  let commoditiesChoices = null;
  let isHandlingChange = false; // Guard against multiple triggers

  // Initialize the page
  function init() {
    // View switching
    if (dom.clientSwitch && dom.userSwitch) {
      dom.clientSwitch.addEventListener("click", () => toggleViews("client"));
      dom.userSwitch.addEventListener("click", () => toggleViews("user"));
    }

    // Format mobile inputs
    if (dom.ownerMobNo) formatMobileInput(dom.ownerMobNo);
    if (dom.userContactNo) formatMobileInput(dom.userContactNo);

    // Initialize Choices
    if (dom.vendorNameSelect) {
      initChoicesSelect();
    }

    if (dom.locationCountInput && dom.locationContainer) {
      initLocationRepeater();
    }

    if (dom.commoditiesSelect) {
      initCommoditiesSelect();
    }

    if (dom.gstInput) {
      dom.gstInput.addEventListener("input", function () {
        const gst = this.value.toUpperCase();
        this.value = gst;

        if (gst.length >= 12) {
          const pan = gst.substring(2, 12);
          if (dom.panInput) {
            dom.panInput.value = pan;
            // Trigger validation for PAN field
            dom.panInput.dispatchEvent(new Event("input"));
          }
        } else if (dom.panInput) {
          // If GST is less than 12 chars, clear or reset PAN if it was auto-filled
          // This handles backspacing
          dom.panInput.value = "";
          dom.panInput.dispatchEvent(new Event("input"));
        }

        const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        if (gst.length > 0 && !gstRegex.test(gst)) {
          this.setCustomValidity("Invalid GST format (e.g., 22AAAAA0000A1Z5)");
        } else {
          this.setCustomValidity("");
        }
      });
    }

    if (dom.panInput) {
      dom.panInput.addEventListener("input", function () {
        const pan = this.value.toUpperCase();
        this.value = pan;
        const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
        if (pan.length > 0 && !panRegex.test(pan)) {
          this.setCustomValidity("Invalid PAN format (e.g., ABCDE1234F)");
        } else {
          this.setCustomValidity("");
        }
      });
    }

    // Handle URL query parameter for tab switching
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get("tab");
    if (tabParam === "user" && dom.userSwitch) {
      toggleViews("user");
    } else if (tabParam === "client" && dom.clientSwitch) {
      toggleViews("client");
    }

    const vendorNameParam = urlParams.get("vendorName") || (dom.vendorNameSelect ? dom.vendorNameSelect.value : null);
    if (vendorNameParam && dom.vendorNameSelect && vendorNameParam !== "") {
      if (choicesInstance) {
        choicesInstance.setChoiceByValue(vendorNameParam);
      } else {
        dom.vendorNameSelect.value = vendorNameParam;
      }
      handleVendorChange(vendorNameParam);
    }
  }

  function toggleViews(activeView) {
    const isClient = activeView === "client";
    dom.clientSwitch.classList.toggle("active", isClient);
    dom.userSwitch.classList.toggle("active", !isClient);
    dom.clientContent.style.display = isClient ? "grid" : "none";
    dom.userContent.style.display = isClient ? "none" : "grid";

    if (!isClient) {
      dom.userContent.style.gridTemplateColumns = "repeat(32, 1fr)";
      dom.userContent.style.gap = "1.25rem";
    }
  }

  // Format a phone string to "##### #####" (max 10 digits).
  function formatMobileValue(value) {
    const digits = String(value ?? "").replace(/\D/g, "").slice(0, 10);
    return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
  }

  function formatMobileInput(input) {
    input.addEventListener("keydown", (e) => {
      const allowedKeys = ["Backspace", "ArrowLeft", "ArrowRight", "Tab", "Delete"];

      // Allow Ctrl+V / Cmd+V
      if ((e.ctrlKey || e.metaKey) && ["v", "V", "c", "C", "x", "X", "a", "A"].includes(e.key)) {
        return; // allow paste, copy, cut, select all
      }

      if (!/^\d$/.test(e.key) && !allowedKeys.includes(e.key)) {
        e.preventDefault();
      }
    });

    input.addEventListener("input", function () {
      this.value = formatMobileValue(this.value);
    });
  }

  function initChoicesSelect() {
    try {
      choicesInstance = new Choices(dom.vendorNameSelect, {
        searchEnabled: true,
        itemSelectText: "",
        shouldSort: false,
        callbackOnInit: function () {
          // Add ONE event listener after initialization
          this.passedElement.element.addEventListener("change", (e) => {
            if (isHandlingChange) return;
            isHandlingChange = true;

            setTimeout(() => {
              isHandlingChange = false;
            }, 100);

            handleVendorChange(e.target.value);
          });
        },
      });
    } catch (e) {
      console.error("Choices initialization failed:", e);
      // Fallback to native select
      dom.vendorNameSelect.addEventListener("change", (e) => {
        handleVendorChange(e.target.value);
      });
    }
  }

  function normalizeLocationCount(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, 20);
  }

  function setLocationCount(value) {
    if (!dom.locationCountInput || !dom.locationContainer) return;
    const safeCount = normalizeLocationCount(value);
    dom.locationCountInput.value = String(safeCount);
    renderLocationRows(safeCount);
  }

  const EMPTY_ROW = {
    userLocation: "",
    dispatchAddress: "",
    selfDispatch: "",
    transportName: "",
    transportContact: "",
    dropLocation: "",
    dropLocation1: "",
    deliveryMode: "",
    deliveryLocation: "",
    deliveryLocation1: "",
    vendorPayment: "",
  };

  // Read all field values from a rendered .location-row.
  function readRowValues(row) {
    const get = (suffix) => row.querySelector(`[name$="[${suffix}]"]`)?.value || "";
    return {
      userLocation: get("userLocation"),
      dispatchAddress: get("dispatchAddress"),
      selfDispatch: get("selfDispatch"),
      transportName: get("transportName"),
      transportContact: get("transportContact"),
      dropLocation: get("dropLocation"),
      dropLocation1: get("dropLocation1"),
      deliveryMode: get("deliveryMode"),
      deliveryLocation: get("deliveryLocation"),
      deliveryLocation1: get("deliveryLocation1"),
      vendorPayment: get("vendorPayment"),
    };
  }

  // Build the per-location block (location + address + per-location pick up details).
  function buildRowHtml(i, v) {
    const isSelf = v.selfDispatch === "Self Dispatch";
    const sel = (val, opt) => (val === opt ? "selected" : "");
    return `
      <div class="location-row">
        <div class="loc-line">
          <input type="text" class="form-control input-tag" name="locationDetails[${i}][userLocation]"
            placeholder="Enter Location" aria-label="Location ${i + 1}"
            value="${escapeAttr(v.userLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
          <input type="text" class="form-control input-tag" name="locationDetails[${i}][dispatchAddress]"
            placeholder="Enter Address" aria-label="Address ${i + 1}"
            value="${escapeAttr(v.dispatchAddress.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
        </div>
        <div class="loc-dispatch">
          <span class="loc-title">Pick Up Details — Location ${i + 1}</span>
          <div class="loc-fields">
            <select class="loc-dispatch-mode form-control select-tag" aria-label="Pick Up Type for location ${i + 1}">
              <option value="TRANSPORT" ${isSelf ? "" : "selected"}>Transport</option>
              <option value="SELF" ${isSelf ? "selected" : ""}>Self Pick Up</option>
            </select>
            <input type="hidden" class="loc-self-dispatch" name="locationDetails[${i}][selfDispatch]" value="${isSelf ? "Self Dispatch" : ""}" />
            <div class="loc-transport" style="${isSelf ? "display:none;" : ""}">
              <input type="text" class="form-control input-tag" name="locationDetails[${i}][transportName]"
                placeholder="Transport Name" value="${escapeAttr(v.transportName.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <input type="text" class="form-control input-tag loc-transport-contact" name="locationDetails[${i}][transportContact]"
                placeholder="Transport Contact" value="${escapeAttr(v.transportContact)}" />
              <input type="text" class="form-control input-tag" name="locationDetails[${i}][dropLocation]"
                placeholder="Drop Location 1" value="${escapeAttr(v.dropLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <input type="text" class="form-control input-tag" name="locationDetails[${i}][dropLocation1]"
                placeholder="Drop Location 2" value="${escapeAttr(v.dropLocation1.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <select class="form-control select-tag" name="locationDetails[${i}][deliveryMode]">
                <option value="">Pick Up Mode</option>
                <option value="DOOR" ${sel(v.deliveryMode, "DOOR")}>DOOR</option>
                <option value="GODOWN" ${sel(v.deliveryMode, "GODOWN")}>GODOWN</option>
              </select>
              <input type="text" class="form-control input-tag" name="locationDetails[${i}][deliveryLocation]"
                placeholder="Pick Up Loc" value="${escapeAttr(v.deliveryLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <input type="text" class="form-control input-tag" name="locationDetails[${i}][deliveryLocation1]"
                placeholder="Pick Up Loc 1" value="${escapeAttr(v.deliveryLocation1.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <select class="form-control select-tag" name="locationDetails[${i}][vendorPayment]">
                <option value="">Payment</option>
                <option value="PAY" ${sel(v.vendorPayment, "PAY")}>PAY</option>
                <option value="TO PAY" ${sel(v.vendorPayment, "TO PAY")}>TO PAY</option>
                <option value="NA" ${sel(v.vendorPayment, "NA")}>NA</option>
              </select>
            </div>
            <div class="loc-self" style="${isSelf ? "" : "display:none;"}">
              <span class="loc-self-badge">Self Pick Up</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderLocationRows(count) {
    if (!dom.locationContainer) return;

    const safeCount = normalizeLocationCount(count);
    const existingRows = Array.from(dom.locationContainer.querySelectorAll(".location-row"));
    const currentValues = existingRows.map(readRowValues);

    let html = "";
    for (let i = 0; i < safeCount; i += 1) {
      html += buildRowHtml(i, currentValues[i] || { ...EMPTY_ROW });
    }
    dom.locationContainer.innerHTML = html;
  }

  // Show/hide a row's transport sub-fields and set its hidden selfDispatch flag.
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

  function initLocationRepeater() {
    setLocationCount(dom.locationCountInput.value || 1);

    dom.locationMinusBtn?.addEventListener("click", () => {
      const current = normalizeLocationCount(dom.locationCountInput.value || 1);
      setLocationCount(Math.max(1, current - 1));
    });

    dom.locationPlusBtn?.addEventListener("click", () => {
      const current = normalizeLocationCount(dom.locationCountInput.value || 1);
      setLocationCount(Math.min(20, current + 1));
    });

    // Per-row pick up type toggle (event delegation survives re-renders).
    dom.locationContainer.addEventListener("change", (e) => {
      const modeSel = e.target.closest(".loc-dispatch-mode");
      if (!modeSel) return;
      applyDispatchMode(modeSel.closest(".location-row"), modeSel.value);
    });

    // Mobile formatting for each row's transport contact.
    dom.locationContainer.addEventListener("input", (e) => {
      const el = e.target.closest(".loc-transport-contact");
      if (!el) return;
      el.value = formatMobileValue(el.value);
    });
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function initCommoditiesSelect() {
    if (!dom.commoditiesSelect) return;

    try {
      commoditiesChoices = new Choices(dom.commoditiesSelect, {
        removeItemButton: true,
        searchEnabled: true,
        shouldSort: false,
        placeholder: true,
        placeholderValue: "Select Commodities",
        itemSelectText: "",
      });

      if (dom.otherCommodityInput) {
        dom.commoditiesSelect.addEventListener("change", () => {
          const selectedValues = commoditiesChoices.getValue(true);
          const isOthersSelected = selectedValues.includes("Others");

          if (isOthersSelected) {
            dom.otherCommodityInput.style.display = "block";
            dom.otherCommodityInput.required = true;
            dom.otherCommodityInput.disabled = false;
          } else {
            dom.otherCommodityInput.style.display = "none";
            dom.otherCommodityInput.required = false;
            dom.otherCommodityInput.disabled = true;
            dom.otherCommodityInput.value = "";
          }
        });

        dom.otherCommodityInput.addEventListener("input", function () {
          this.value = this.value.toUpperCase();
        });
      }
    } catch (e) {
      console.error("Commodities Choices initialization failed:", e);
    }
  }

  function handleVendorChange(vendorName) {
    if (!vendorName) {
      const hoEl = document.getElementById("coordinator-ho-location");
      const whEl = document.getElementById("coordinator-warehouse-location");
      const statusEl = document.getElementById("coordinator-vendor-status");
      const statusHiddenEl = document.getElementById("coordinator-vendor-status-hidden");
      const gstEl = document.getElementById("coordinator-vendor-gst");
      const msmeEl = document.getElementById("coordinator-vendor-msme");
      const idEl = document.getElementById("object-id");
      if (hoEl) hoEl.value = "";
      if (whEl) whEl.value = "";
      if (statusEl) statusEl.value = "";
      if (statusHiddenEl) statusHiddenEl.value = "";
      if (gstEl) gstEl.value = "";
      if (msmeEl) msmeEl.value = "";
      if (idEl) idEl.value = "";
      return;
    }

    console.log("Vendor changed (triggered once):", vendorName);

    fetch(`/sachiko/form/vendor/${encodeURIComponent(vendorName)}`)
      .then((response) => response.json())
      .then((data) => {
        console.log("Response:", data);
        feedVendorData(data);
      })
      .catch((error) => console.error("Error:", error));
  }

  // Start when DOM is ready
  if (document.readyState !== "loading") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();

function feedVendorData(data) {
  console.log(data._id);
  const idEl = document.getElementById("user-client-id");
  const hoEl = document.getElementById("coordinator-ho-location");
  const whEl = document.getElementById("coordinator-warehouse-location");
  const statusEl = document.getElementById("coordinator-vendor-status");
  const statusHiddenEl = document.getElementById("coordinator-vendor-status-hidden");
  const gstEl = document.getElementById("coordinator-vendor-gst");
  const msmeEl = document.getElementById("coordinator-vendor-msme");
  const objEl = document.getElementById("object-id");

  if (idEl) idEl.value = data.vendorId || "";
  if (hoEl) hoEl.value = data.hoLocation || "";
  if (whEl) whEl.value = data.warehouseLocation || data.hoLocation || "";
  if (statusEl) statusEl.value = data.vendorStatus || "";
  if (statusHiddenEl) statusHiddenEl.value = data.vendorStatus || "";
  if (gstEl) gstEl.value = data.vendorGst || "";
  if (msmeEl) msmeEl.value = data.vendorMsme || "";
  if (objEl) objEl.value = data._id || "";

  // Prefill first location row if empty
  const firstLocationInput = document.querySelector('input[name="locationDetails[0][userLocation]"]');
  const firstAddressInput = document.querySelector('input[name="locationDetails[0][dispatchAddress]"]');
  if (firstLocationInput && !firstLocationInput.value) {
    firstLocationInput.value = (data.hoLocation || "").toUpperCase();
  }
  if (firstAddressInput && !firstAddressInput.value) {
    firstAddressInput.value = (data.hoLocation || "").toUpperCase();
  }
}
