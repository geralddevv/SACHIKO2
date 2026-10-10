import Counter from "../models/system/counter.js";
import Client from "../models/users/client.js";

// Next Client Id the create dialog shows (display only -- POST /form/client
// assigns the real one). Skips legacy collisions so the preview matches what
// the generator will actually hand out.
export async function getNextClientIdPreview() {
  const counterDoc = await Counter.findOne({ key: "clientId" }).select("seq").lean();
  let nextSeq = Number(counterDoc?.seq || 0) + 1;
  while (await Client.exists({ clientId: `FS | CLIENT | ${nextSeq}` })) {
    nextSeq += 1;
  }
  return `FS | CLIENT | ${nextSeq}`;
}
