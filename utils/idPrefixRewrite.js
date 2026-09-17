import mongoose from "mongoose";

// Moving every id from one company code to another: "GM | LS | 000047" ->
// "XY | LS | 000047". Run when the Company master's id code changes (see
// routes/system/company.js), so a rename doesn't leave the system reading half
// in the old code and half in the new.
//
// It rewrites ONLY ids that start with the outgoing code. Ids minted under an
// earlier code are left exactly as they are -- they belong to a period that is
// over, and rewriting them would make old stickers and paper records disagree
// with the screen for a second time.
//
// Deliberately a blind scan of every string field rather than a list of
// "the fields that hold ids". The same id string is copied across documents --
// an order's Lot No is stamped onto its Deckles and its Job Cards, and those
// copies are how they are matched back up -- so a field missed from a list
// would quietly break a link. A scan cannot miss one.

// Where ids are NOT rewritten:
//   - the audit log and every *logs collection: they record what happened at
//     the time, under the code in force then. Editing them would be falsifying
//     a record, and they are read as history, never as a link.
//   - sessions: throwaway, and rewriting live session data is asking for
//     trouble.
const SKIP_COLLECTIONS = new Set(["auditlogs", "sessions"]);
const isSkipped = (name) => SKIP_COLLECTIONS.has(name) || name.endsWith("logs");

// "GM | LS | 000047" -- the shape every id this app mints has. The code is what
// changes; everything after the first separator is carried across untouched.
const idStart = (prefix) => `${prefix} | `;

// Walks a document and reports every string field holding an id in `from`.
// Paths are dotted, with array indexes, so the update can address them.
function findIds(node, from, path = "", out = []) {
  if (node == null) return out;
  if (typeof node === "string") {
    if (node.startsWith(idStart(from))) out.push({ path, value: node });
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => findIds(item, from, path ? `${path}.${i}` : String(i), out));
    return out;
  }
  // Only plain sub-documents; never ObjectIds, Dates, Buffers...
  if (typeof node === "object" && !node._bsontype && !(node instanceof Date)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "_id") continue;
      findIds(value, from, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.from   outgoing id code, e.g. "GM"
 * @param {string} opts.to     incoming id code, e.g. "XY"
 * @param {boolean} opts.apply false (default) reports what would change
 * @returns {Promise<{from, to, changed, documents, byField, collisions, skipped}>}
 */
export async function rewriteIdPrefix({ from, to, apply = false } = {}) {
  const result = { from, to, changed: 0, documents: 0, byField: {}, collisions: [], skipped: [] };
  if (!from || !to || from === to) return result;

  const db = mongoose.connection.db;
  if (!db) throw new Error("No database connection");

  const collections = (await db.listCollections().toArray()).map((c) => c.name);

  for (const name of collections) {
    if (isSkipped(name)) { result.skipped.push(name); continue; }
    const coll = db.collection(name);

    // Only documents that actually carry one: a cheap regex on the whole
    // document isn't possible, so this walks the collection. These are master
    // and transaction collections in the thousands, not millions.
    const cursor = coll.find({});
    for await (const doc of cursor) {
      const hits = findIds(doc, from);
      if (!hits.length) continue;

      const $set = {};
      let touched = 0;
      for (const { path, value } of hits) {
        const next = `${to}${value.slice(from.length)}`;

        // Renaming back to a code used before can land on an id that already
        // exists. Leave those alone and say so rather than dying on a unique
        // index half way through the collection.
        const clash = await coll.findOne({ [path]: next, _id: { $ne: doc._id } }, { projection: { _id: 1 } });
        if (clash) {
          result.collisions.push({ collection: name, path, from: value, to: next });
          continue;
        }

        $set[path] = next;
        touched += 1;
        const key = `${name}.${path.replace(/\.\d+(?=\.|$)/g, ".$")}`;
        result.byField[key] = (result.byField[key] || 0) + 1;
      }

      if (!touched) continue;
      result.changed += touched;
      result.documents += 1;
      if (apply) await coll.updateOne({ _id: doc._id }, { $set });
    }
  }

  return result;
}

// One-line summary for a console or a flash message.
export function describeRewrite(result) {
  if (!result.changed && !result.collisions.length) return `No ids were carrying "${result.from}".`;
  const parts = [`${result.changed} id${result.changed === 1 ? "" : "s"} in ${result.documents} record${result.documents === 1 ? "" : "s"} moved from ${result.from} to ${result.to}`];
  if (result.collisions.length) parts.push(`${result.collisions.length} left alone (an id with that number already exists under ${result.to})`);
  return parts.join("; ") + ".";
}
