let width = document.querySelector("#label-width");
let height = document.querySelector("#label-height");
let salesArea = document.querySelector("#sales-area");
let clientName = document.querySelector("#company-name");
let asteriskClientType = document.querySelector(".asterisk");
let calcBtn = document.querySelector("#calc-btn");
let perK = document.querySelector("#per-1k");
let salesRate = document.querySelector("#sales-rate");
let orderQty = document.querySelector("#order-quantity");
let orderValue = document.querySelector("#order-value");
let costPercent = document.querySelector("#cost");

// Auto fill date
document.addEventListener("DOMContentLoaded", function () {
  const dateInput = document.getElementById("date");

  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const dd = String(today.getDate()).padStart(2, '0');

    const formattedDate = `${yyyy}-${mm}-${dd}`;
    dateInput.value = formattedDate;
  }
});
// Calculate
calcBtn.addEventListener("click", () => {
  getValues();
});

// Get values
function getValues() {
    let salesAreaVal;
  if (asteriskClientType.textContent == "(Client)") {
    let x = (width.value * height.value) / 625;
    salesArea.value = x.toFixed(4);
    salesAreaVal = x.toFixed(4);
  } else if (asteriskClientType.textContent == "(Dealer)") {
    let x = (width.value * height.value) / 645;
    salesArea.value = x.toFixed(4);
    salesAreaVal = x.toFixed(4);
  }

  let salesRateval = perK.value / 1000 / salesAreaVal;
  salesRate.value = salesRateval.toFixed(4);

  let orderValueVal = (orderQty.value * perK.value) / 1000;
  orderValue.value = orderValueVal.toFixed(0);
}

// Fetch client data
clientName.addEventListener("change", async function () {
  const clientName = this.value;

  if (!clientName) return;

  try {
    // Fetch client data
    const response = await fetch(`/sachiko/form/labels/${encodeURIComponent(clientName)}`);
    if (!response.ok) throw new Error("Failed to fetch data");

    clientData = await response.json();

    console.log(clientData);

    if (clientData[0].clientType == "Dealer") {
      asteriskClientType.textContent = "(Dealer)";
      asteriskClientType.style.color = "red";
    } else if (clientData[0].clientType == "Client") {
      asteriskClientType.textContent = "(Client)";
      asteriskClientType.style.color = "green";
    }

  } catch (error) {
    console.error("Error:", error);
    userNameChoices.setChoices([{ value: "", label: "Error loading users" }], "value", "label", true);
  }
});
