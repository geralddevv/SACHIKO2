let clientName = document.querySelector("#company-name");
let asteriskClientType = document.querySelector(".asterisk");
let width = document.querySelector("#label-width");
let height = document.querySelector("#label-height");

// Auto fill date
document.addEventListener("DOMContentLoaded", function () {
  const dateInput = document.getElementById("date");

  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0"); // Months are 0-based
    const dd = String(today.getDate()).padStart(2, "0");

    const formattedDate = `${yyyy}-${mm}-${dd}`;
    dateInput.value = formattedDate;
  }
});

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

width.addEventListener("input", getValues);
height.addEventListener("input", getValues);

async function getValues() {
  const clientName = document.querySelector("#company-name").value;
  console.log(clientName);

  if (!width.value) return;
  if (!height.value) return;

  try {
    // Fetch client data
    const response = await fetch(
      `/sachiko/form/prodcalc/data?w=${width.value}&h=${height.value}&client=${encodeURIComponent(clientName)}`
    );
    if (!response.ok) throw new Error("Failed to fetch data");

    salesValues = await response.json();
    console.log(salesValues);
    feedValues(salesValues);
  } catch (error) {
    console.error("Error:", error);
  }
}


// if not salesValues then make all the values empty
function feedValues(salesValues) {
  document.getElementById("per-1k").value = salesValues.perOneK;
  document.getElementById("job-ups").value = salesValues.jobUps;
  document.getElementById("paper-type").value = salesValues.paperType;
  document.getElementById("printed").value = salesValues.printed;
  document.getElementById("job-name").value = salesValues.jobName;
  document.getElementById("order-quantity").value = salesValues.orderQuantity;
  document.getElementById("prod-sale-area").value = salesValues.sales;
  document.getElementById("prod-sales-rate").value = salesValues.salesRate;
  document.getElementById("prod-order-value").value = salesValues.orderValue;
  document.getElementById("prod-cost-percentage").value = salesValues.costPercent;
}
