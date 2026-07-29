const elements = {
  ratePerLabel: document.getElementById("rate-per-label"),
  ratePerK: document.getElementById("rate-per-k"),
  ratePerRoll: document.getElementById("per-roll"),
  qtyPerRoll: document.getElementById("per-roll-qty"),
  userContact: document.getElementById("user-contact"),
  clientLocation: document.getElementById("client-location"),
  clientName: document.getElementById("client-name"),
  userName: document.getElementById("client-user-name"),
  userObjId: document.getElementById("user-obj-id"),
  jobType: document.getElementById("job-type"),
  jobName: document.getElementById("job-name"),
  instructions: document.getElementById("instructions"),
};

let asteriskClientType = document.querySelector(".asterisk");
let fetchedClientData = null;

function toggleJobFields() {
  const isPlainJob = elements.jobType.value === "PLAIN";
  elements.jobName.disabled = isPlainJob;
}

// Calculate and update rates
function updateRates() {
  const labelRate = elements.ratePerK.value / 1000;
  elements.ratePerLabel.value = labelRate;
  elements.ratePerRoll.value = (labelRate * elements.qtyPerRoll.value).toFixed(2);
}

// Initialize Choices.js dropdown
function initDropdown(selector, config = {}) {
  return new Choices(selector, {
    searchEnabled: true,
    itemSelectText: "",
    shouldSort: false,
    allowHTML: false,
    ...config,
  });
}

// Update username dropdown options
function updateUsernameDropdown(usernames, choicesInstance) {
  choicesInstance.setChoices(
    usernames.map((name) => ({ value: name, label: name })),
    "value",
    "label",
    true
  );
}

// Find matching client record
function findMatchingRecord(clientName, userName) {
  return (
    fetchedClientData.users?.find(
      (item) =>
        item.clientName.toLowerCase() === clientName.toLowerCase() &&
        item.userName.toLowerCase() === userName.toLowerCase()
    ) || null
  );
}

// Handle username selection
function handleUsernameChange() {
  const clientName = elements.clientName.value;
  const userName = elements.userName.value;
  console.log(clientName, userName);
  const record = findMatchingRecord(clientName, userName);

  if (record) {
    elements.userContact.value = record.userContact;
    elements.clientLocation.value = record.userLocation;
    elements.userObjId.value = record._id;
  }
}

// Calculate sales cost
function getSalesCost() {
  if (!asteriskClientType) return;
  
  const clientType = asteriskClientType.textContent.trim();
  
  if (!labelWidth.value || !labelHeight.value || !ratePerLabel.value) {
    salesCost.value = "0.00";
    return;
  }

  if (clientType === "(CLIENT)") {
    const x = (labelWidth.value * labelHeight.value) / 625;
    const salesCostVal = ratePerLabel.value / x;
    salesCost.value = salesCostVal.toFixed(4);
  } else if (clientType === "(DEALER)") {
    const x = (labelWidth.value * labelHeight.value) / 645;
    const salesCostVal = ratePerLabel.value / x;
    salesCost.value = salesCostVal.toFixed(4);
  } else {
    salesCost.value = "0.00";
  }
}

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
  // Initialize dropdowns
  const usernameChoices = initDropdown("#client-user-name");
  initDropdown("#client-name");

  // Initialize job type fields
  if (elements.jobType) {
    // Set initial state
    toggleJobFields();
    // Add change listener
    elements.jobType.addEventListener("change", toggleJobFields);
  }

  // Rate calculation listeners
  [elements.ratePerK, elements.qtyPerRoll].forEach((el) => {
    el?.addEventListener("input", updateRates);
  });

  // Client name change handler
  elements.clientName?.addEventListener("change", async function () {
    console.log("Client changed (triggered once):", this.value);
    const clientName = this.value;
    elements.userContact.value = "";
    elements.clientLocation.value = "";
    usernameChoices.removeActiveItems();
    usernameChoices.clearStore();

    if (!clientName) return;

    try {
      const response = await fetch(`/sachiko/form/labels/${encodeURIComponent(clientName)}`);
      if (!response.ok) throw new Error("Network response not ok");

      fetchedClientData = await response.json();
      
      console.log(fetchedClientData.clientType);
      const usernames = [...new Set(fetchedClientData.users.map((item) => item.userName))];
      asteriskClientType.textContent = `(${fetchedClientData.clientType})`;
      
      if (asteriskClientType.textContent == "(DEALER)") {
        asteriskClientType.style.color = "red";
      } else if (asteriskClientType.textContent == "(CLIENT)") {
        asteriskClientType.style.color = "green";
      }
      
      getSalesCost();
      
      // Update dropdown with all usernames
      updateUsernameDropdown(usernames, usernameChoices);
      
      // If only one username exists, set it as the selected value
      if (usernames.length === 1) {
        usernameChoices.setChoiceByValue(usernames[0]);
        elements.userName.value = usernames[0];
        elements.userName.dispatchEvent(new Event('change'));
      }
    } catch (error) {
      console.error("Fetch error:", error);
      updateUsernameDropdown(["Failed to load users"], usernameChoices);
    }
  });

  // Username change handler
  elements.userName?.addEventListener("change", handleUsernameChange);
  elements.userName?.addEventListener("change", getSalesCost);
});

// Form input elements
const labelWidth = document.querySelector("#width");
const labelHeight = document.querySelector("#height");
const salesCost = document.querySelector("#sale-cost");
const ratePerLabel = document.querySelector("#rate-per-label");

// Add event listeners with null checks
labelWidth?.addEventListener("input", getSalesCost);
labelHeight?.addEventListener("input", getSalesCost);
ratePerLabel?.addEventListener("input", getSalesCost);
elements.ratePerK?.addEventListener("input", getSalesCost);