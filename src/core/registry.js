// src/core/registry.js
// Bundler-agnostic registry shared between the core transform and each adapter
// during a single compilation. Cleared at the start of each build by the
// adapter (webpack: compiler.hooks.beforeRun; rollup: buildStart).
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

  /**
   * Drop a single nugget by handler id. Used by adapters during HMR to
   * evict entries for a file that's about to be re-transformed; the next
   * transform pass re-registers the survivors with fresh hashes.
   */
  removeById(id) {
    const meta = byId.get(id);
    byId.delete(id);
    if (meta && meta.chunkName) byChunk.delete(meta.chunkName);
  },

  clear() {
    byId.clear();
    byChunk.clear();
  },
};
