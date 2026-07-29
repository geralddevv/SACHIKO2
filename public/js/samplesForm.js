(function () {
  const tabs = document.querySelectorAll(".sample-tab");
  const vendorForm = document.getElementById("vendor-sample-form");
  const clientForm = document.getElementById("client-sample-form");
  const dateInputs = document.querySelectorAll(".sample-date");

  // Sample code inputs
  const vendorCodeInput = document.getElementById("vendor-sample-code");
  const clientCodeInput = document.getElementById("client-sample-code");

  function getLocalDateValue() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().split("T")[0];
  }

  // Fetch the next sample code preview from the server and fill the input
  async function fillSampleCode(material, category, inputEl) {
    if (!material || !inputEl) return;
    inputEl.value = "Loading…";
    inputEl.readOnly = true;
    try {
      const params = new URLSearchParams({ material, category });
      const res = await fetch(`/sachiko/form/samples/next-code?${params}`);
      const data = await res.json();
      inputEl.value = data.code || "";
    } catch {
      inputEl.value = "";
      inputEl.readOnly = false;
    }
  }

  // Attach radio listeners for a given form
  function attachRadioListeners(form, category, codeInput) {
    if (!form) return;
    const radios = form.querySelectorAll('input[type="radio"][name="sampleMaterial"]');
    radios.forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          fillSampleCode(radio.value, category, codeInput);
        }
      });
    });
  }

  attachRadioListeners(vendorForm, "vendor", vendorCodeInput);
  attachRadioListeners(clientForm, "client", clientCodeInput);

  function setActiveTab(tabName) {
    const isVendor = tabName !== "client";

    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === (isVendor ? "vendor" : "client"));
    });

    if (vendorForm) vendorForm.hidden = !isVendor;
    if (clientForm) clientForm.hidden = isVendor;

    const url = new URL(window.location.href);
    url.searchParams.set("tab", isVendor ? "vendor" : "client");
    window.history.replaceState({}, "", url);
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(tab.dataset.tab);
    });
  });

  dateInputs.forEach((input) => {
    if (!input.value) {
      input.value = getLocalDateValue();
    }
  });

  const activeTab = new URLSearchParams(window.location.search).get("tab");
  setActiveTab(activeTab === "client" ? "client" : "vendor");
})();
