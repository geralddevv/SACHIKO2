/*
 * Live feed to the operator app (GET /sachiko/api/operator/events).
 *
 * Each signed-in tablet holds one Server-Sent Events request open. When
 * something changes an operator's work queue -- a job allocated to them, taken
 * off, moved -- the route that did it calls notifyOperatorQueue(), and the
 * tablet's queue reloads itself. Nothing polls: a quiet queue sends nothing but
 * a comment line every HEARTBEAT_MS, which keeps proxies from closing the
 * stream and lets the app tell a dead connection from a quiet one.
 *
 * In-memory and per process: it works as long as the API runs as ONE process.
 * Behind several (cluster / pm2 -i N) a notify only reaches the tablets
 * connected to the process that handled it -- that would need a shared channel
 * (Redis pub/sub or a Mongo change stream) in place of the Map below.
 */
const HEARTBEAT_MS = 25 * 1000;
// A signed-in operator can have a couple of tablets; this only stops a runaway
// client from piling up connections.
const MAX_PER_OPERATOR = 6;

const clients = new Map(); // empObjId (string) -> Set<res>

export function addOperatorClient(empObjId, res) {
  const key = String(empObjId);
  let set = clients.get(key);
  if (!set) {
    set = new Set();
    clients.set(key, set);
  }
  while (set.size >= MAX_PER_OPERATOR) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    oldest.end();
  }
  set.add(res);
  return () => {
    set.delete(res);
    if (!set.size && clients.get(key) === set) clients.delete(key);
  };
}

const write = (res, chunk) => {
  try {
    res.write(chunk);
    // `compression` buffers; a no-op when it isn't in the way.
    if (typeof res.flush === "function") res.flush();
  } catch {
    // The close handler removes it.
  }
};

// Tell these operators their queue changed. Ids may be repeated, null or
// undefined (an unassigned order has no previous operator) -- those are skipped.
export function notifyOperatorQueue(...empObjIds) {
  new Set(empObjIds.flat().filter(Boolean).map(String)).forEach((key) => {
    clients.get(key)?.forEach((res) => write(res, "event: queue\ndata: {}\n\n"));
  });
}

let heartbeat = null;
function ensureHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    clients.forEach((set) => set.forEach((res) => write(res, ": ping\n\n")));
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

// Opens the stream on `res`; the caller has already authenticated `empObjId`.
export function openOperatorStream(req, res, empObjId) {
  res.status(200).set({
    "Content-Type": "text/event-stream",
    // no-transform keeps `compression` from buffering the stream.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx and friends: do not hold the response back.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  req.socket?.setTimeout?.(0);
  req.socket?.setNoDelay?.(true);
  write(res, ": connected\n\n");
  const remove = addOperatorClient(empObjId, res);
  ensureHeartbeat();
  req.on("close", remove);
}

export function operatorStreamCount() {
  let n = 0;
  clients.forEach((set) => (n += set.size));
  return n;
}
