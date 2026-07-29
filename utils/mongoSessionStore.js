import session from "express-session";
import SessionModel from "../models/system/Session.js";

function resolveExpiry(sessionData, fallbackMs) {
  const maxAge = Number(sessionData?.cookie?.maxAge ?? sessionData?.cookie?.originalMaxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    return new Date(Date.now() + maxAge);
  }

  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const date = new Date(expires);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date(Date.now() + fallbackMs);
}

class MongoSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = options.ttlMs ?? 1000 * 60 * 60;
    this.model = options.model ?? SessionModel;
  }

  get(sid, callback) {
    this.model
      .findById(sid)
      .lean()
      .then((doc) => {
        if (!doc) return callback?.();

        if (doc.expiresAt && new Date(doc.expiresAt) <= new Date()) {
          this.destroy(sid, () => callback?.());
          return;
        }

        callback?.(null, doc.session);
      })
      .catch((err) => callback?.(err));
  }

  set(sid, sessionData, callback) {
    const expiresAt = resolveExpiry(sessionData, this.ttlMs);

    this.model
      .updateOne(
        { _id: sid },
        {
          $set: {
            session: sessionData,
            expiresAt,
          },
        },
        { upsert: true },
      )
      .then(() => callback?.(null))
      .catch((err) => callback?.(err));
  }

  touch(sid, sessionData, callback) {
    const expiresAt = resolveExpiry(sessionData, this.ttlMs);

    this.model
      .updateOne(
        { _id: sid },
        {
          $set: {
            session: sessionData,
            expiresAt,
          },
        },
      )
      .then(() => callback?.(null))
      .catch((err) => callback?.(err));
  }

  destroy(sid, callback) {
    this.model
      .deleteOne({ _id: sid })
      .then(() => callback?.(null))
      .catch((err) => callback?.(err));
  }

  length(callback) {
    this.model
      .countDocuments()
      .then((count) => callback?.(null, count))
      .catch((err) => callback?.(err));
  }

  clear(callback) {
    this.model
      .deleteMany({})
      .then(() => callback?.(null))
      .catch((err) => callback?.(err));
  }

  all(callback) {
    this.model
      .find({})
      .lean()
      .then((docs) => callback?.(null, docs.map((doc) => doc.session)))
      .catch((err) => callback?.(err));
  }
}

export default MongoSessionStore;
