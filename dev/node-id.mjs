// Stable n8n node ids, derived from the node NAME.
//
// Why this matters: the builders used `Math.random()` for every node id, so each
// build produced a fresh set. n8n stores a workflow's canvas GROUPS with the node
// ids they were drawn around, and rejects a PATCH when a group points at an id
// that no longer exists:
//
//   400 Group "Answer customer chat" references node ID "gpu0v6" that does not
//   exist in the workflow.
//
// (Same trap as the workflow-settings merge noted in PLAN.md: n8n MERGES parts of
// a workflow on update, so anything absent from the new JSON survives.)
//
// Deriving the id from the name means a rebuilt workflow keeps the same ids, so
// groups keep resolving and a redeploy is a clean in-place update. New node names
// get new ids, which is correct.
const cache = new Map();

export function stableId(name) {
  let id = cache.get(name);
  if (id) return id;
  // djb2-ish; the salt keeps the hash from colliding with n8n's own naming.
  let h = 5381;
  const s = 'n8n-node::' + name;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  id = h.toString(36).slice(0, 8);
  cache.set(name, id);
  return id;
}

// True when the node already has an explicit id (a fixed webhookId-backed node,
// a shared id we must not touch). Those are left alone.
export function nodeId(name, explicit) {
  return explicit || stableId(name);
}
