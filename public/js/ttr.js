// DOM Elements
const clientNameEl = document.getElementById("client-name");
const userNameEl = document.getElementById("client-user-name");
const userContactEl = document.getElementById("user-contact");
const clientLocationEl = document.getElementById("client-location");
const userIdEl = document.getElementById("user-id");
const asteriskClientType = document.querySelector(".asterisk");

let clientData = null; // Stores fetched client data

// Initialize Choices dropdowns
document.addEventListener("DOMContentLoaded", () => {
  // Client name dropdown
  const clientNameChoices = new Choices(clientNameEl, {
    searchEnabled: true,
    shouldSort: false,
    itemSelectText: "",
  });

  // Username dropdown
  const userNameChoices = new Choices(userNameEl, {
    searchEnabled: true,
    shouldSort: false,
    itemSelectText: "",
  });

  // Client name change handler
  clientNameEl.addEventListener("change", async function () {
    const clientName = this.value;

    // Reset fields
    userContactEl.value = "";
    clientLocationEl.value = "";
    userNameChoices.removeActiveItems();
    userNameChoices.clearStore();

    if (!clientName) return;

    try {
      // Fetch client data
      const response = await fetch(`/sachiko/form/labels/${encodeURIComponent(clientName)}`);
      if (!response.ok) throw new Error("Failed to fetch data");

      clientData = await response.json();

    //   console.log(clientData);

      if (clientData.clientType == "DEALER") {
        asteriskClientType.textContent = "(DEALER)";
        asteriskClientType.style.color = "red";
      } else if (clientData.clientType == "CLIENT") {
        asteriskClientType.textContent = "(CLIENT)";
        asteriskClientType.style.color = "green";
      }

      // Update username dropdown
      const usernames = [...new Set(clientData.users.map((item) => item.userName))]; // Remove duplicates

      userNameChoices.setChoices(
        usernames.map((name) => ({ value: name, label: name })),
        "value",
        "label",
        true
      );

      // If only one username exists, set it as the selected value
      if (usernames.length === 1) {
        // Set Choices.js value
        userNameChoices.setChoiceByValue(usernames);
        // Manually set the underlying select element's value
        userNameEl.value = usernames;
        // Trigger change event to update contact and location
        userNameEl.dispatchEvent(new Event("change"));
      }
    } catch (error) {
      console.error("Error:", error);
      userNameChoices.setChoices([{ value: "", label: "Error loading users" }], "value", "label", true);
    }
  });

  // Username change handler
  userNameEl.addEventListener("change", function () {
    const clientName = clientNameEl.value;
    const userName = this.value;

    if (!clientData || !clientName || !userName) return;

    // Find matching record
    const record = clientData.users.find(
      (item) =>
        item.clientName.toLowerCase() === clientName.toLowerCase() &&
        item.userName.toLowerCase() === userName.toLowerCase()
    );

    
    // Update contact and location
    if (record) {
        console.log(record._id);
      userContactEl.value = record.userContact || "";
      clientLocationEl.value = record.userLocation || "";
      userIdEl.value = record._id;
    }
  });
});
