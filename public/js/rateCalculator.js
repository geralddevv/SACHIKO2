document.addEventListener("DOMContentLoaded", function () {
  let date = document.querySelector("#date");
  // Setting today's date by default.
  date.value = new Date().toISOString().split("T")[0];
});


// user input fields.
let calcBtn = document.querySelector("#calc-btn");
let labelHeight = document.querySelector("#label-height");
let labelWidth = document.querySelector("#label-width");
let paperSize = document.querySelector("#paper-size");
let dieAcross = document.querySelector("#die-across");
let perOneK = document.querySelector("#per-1k");
let mRate = document.querySelector("#m-rate");
let orderQuantity = document.querySelector("#order-quantity");
let costPercentage = document.querySelector("#cost");
let printed = document.querySelector("#printed");

// Auto fill fields.
let production = document.querySelector("#production");
let sales = document.querySelector("#sales");
let productionRate = document.querySelector("#production-rate");
let actualCost = document.querySelector("#actual-cost");
let salesRate = document.querySelector("#sales-rate");
let totalSqMeter = document.querySelector("#tot-sqr-m");
let mCost = document.querySelector("#m-cost");
let orderValue = document.querySelector("#order-value");
let margin = document.querySelector("#margin");
let marginAmount = document.querySelector("#margin-amount");
let marginPercentage = document.querySelector("#margin-percent");

calcBtn.addEventListener("click", () => {
  const paperSizeVal = Number(paperSize.value);
  const dieAcrossVal = Number(dieAcross.value);
  const labelHeightVal = Number(labelHeight.value);
  const labelWidthVal = Number(labelWidth.value);
  const perOneKVal = Number(perOneK.value);
  const mRateVal = Number(mRate.value);
  const orderQuantityVal = Number(orderQuantity.value);
  const costPercentageVal = Number(costPercentage.value);

  const productionVal = ((paperSizeVal / dieAcrossVal) * (labelHeightVal + 3)) / 645;
  const salesVal = (labelWidthVal * labelHeightVal) / 645;
  const productionRateVal = perOneKVal / 1000 / productionVal;
  const actualCostVal = (productionRateVal * 1550) / mRateVal;
  const salesRateVal = perOneKVal / 1000 / salesVal;
  const totalSqMeterVal = (orderQuantityVal * productionVal) / 1550;
  const mCostVal = mRateVal * totalSqMeterVal;
  const orderValueVal = (orderQuantityVal * perOneKVal) / 1000;
  const marginVal = orderValueVal - mCostVal;
  const marginAmountVal = orderValueVal - mCostVal * costPercentageVal;
  const marginPercentageVal = (marginAmountVal / orderValueVal) * 100;

  production.value = productionVal.toFixed(3);
  sales.value = salesVal.toFixed(3);
  productionRate.value = productionRateVal.toFixed(3);
  actualCost.value = actualCostVal.toFixed(3);
  salesRate.value = salesRateVal.toFixed(3);
  totalSqMeter.value = totalSqMeterVal.toFixed(1);
  mCost.value = mCostVal.toFixed(0);
  orderValue.value = orderValueVal.toFixed(0);
  margin.value = marginVal.toFixed(2);
  marginAmount.value = marginAmountVal.toFixed(0);
  marginPercentage.value = marginPercentageVal.toFixed(2);
});

function limitToTwoChars(elem) {
  if (elem.value.length > 2) {
    elem.value = elem.value.slice(0, 2);
  }
}

printed.addEventListener("change", () => {
  if (printed.value == "Plain") {
    costPercentage.value = 1.35;
  } else if (printed.value == "Printed") {
    costPercentage.value = 1.55;
  }
});

// View details panel.
let viewDetails = document.querySelector(".view-details-contain");
let viewBtn = document.querySelector(".view-btn");
let closeBtn = document.querySelector(".close-btn");

console.log(viewBtn);

viewDetails.addEventListener("click", (event) => {
    if (event.target === viewDetails) {
        viewDetails.classList.toggle("toggle-disp");
    }
});

viewBtn.addEventListener("click", () => {
  console.log("btn clicked");
    viewDetails.classList.toggle("toggle-disp");    
});

closeBtn.addEventListener("click", () => {
    viewDetails.classList.toggle("toggle-disp");
});