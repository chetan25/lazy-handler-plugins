// src/plugins/nuggetRegistry.js
// Shared singleton between the loader and plugin during a single compilation.
// Cleared at the start of each build via compiler.hooks.beforeRun.
//
// Two indexes are maintained:
//   - byId       → keyed by handler id ("nugget_onClick_a3f7c9b1")
//   - byChunk    → keyed by chunk name  ("nugget-a3f7c9b1") — used by the
//                  readResource hook to serve source for virtual modules.

const byId = new Map();
const byChunk = new Map();

module.exports = {
  register(id, meta) {
    byId.set(id, meta);
    if (meta && meta.chunkName) {
      byChunk.set(meta.chunkName, meta);
    }
  },

  get(id) {
    return byId.get(id);
  },

  getByChunk(chunkName) {
    return byChunk.get(chunkName);
  },

  getAll() {
    return Object.fromEntries(byId.entries());
  },

  clear() {
    byId.clear();
    byChunk.clear();
  },
};
