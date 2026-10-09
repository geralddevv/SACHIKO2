import { buildLabelFields } from "./materialStockRollLabel.js";
import { applyPrnTextPlan, buildPrnFromFields, buildQrPayloadFromFields, labelLayoutMm } from "./materialRollLabel.js";

// The label a FINISHED slit roll (models/inventory/finishedStock.js) gets stuck
// on it. It is the Deckle label (utils/materialStockRollLabel.js) with two
// deliberate differences, both asked for on the floor:
//   - WIDTH is the finished ROLL's own width (the knife position it came off),
//     not the Deckle web it was slit from;
//   - the ROLL ID starts a little smaller than the Deckle's 28pt, because a
//     finished id is longer than a Deckle id -- it carries the slot suffix
//     ("C001WB-F/26-27/G0016/00001-A"). The shared builder still auto-shrinks
//     and splits it at the first "/", so this only lowers the starting size.
const FINISHED_ROLL_ID_PT = 24;

// `roll`: { rollId, mtrs, width, lotNo, joints, prodCode } read off a
// FinishedStock doc (width = its physically cut width). Shared by the
// operator app's TSPL output and the browser-printed label, so the two can
// never disagree about which box a value goes in.
export function buildFinishedStockLabelFields(roll) {
  return buildLabelFields({
    prodCode: roll.prodCode,
    reelMtrs: roll.mtrs, // the roll's own metres -> LENGTH box
    rollId: roll.rollId,
    size: roll.width,    // the ROLL's width -> WIDTH box (not the Deckle's)
    joints: roll.joints,
    lotNo: roll.lotNo,
  });
}

// The same layout labelLayoutMm() gives a Deckle, planned exactly as the
// operator app's TSPL is (whole-point sizes, Roll ID over two lines) with the
// Roll ID's starting size lowered (see FINISHED_ROLL_ID_PT). The view still
// shrinks anything that runs past its box.
export function finishedStockLabelLayoutMm(qrModuleCount, fields) {
  return applyPrnTextPlan(labelLayoutMm(qrModuleCount), fields, { rollIdPt: FINISHED_ROLL_ID_PT });
}

export function finishedStockLabelQrPayload(roll) {
  return buildQrPayloadFromFields(buildFinishedStockLabelFields(roll));
}

export function buildFinishedStockRollLabelPrn(roll) {
  return buildPrnFromFields(buildFinishedStockLabelFields(roll), { rollIdPt: FINISHED_ROLL_ID_PT });
}
