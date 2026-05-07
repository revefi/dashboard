// Shared mutable state. ES module exports are live bindings for the
// exporting module's local declarations — you can't reassign an imported
// `let` from another module, so we wrap mutables in an object and import
// the object. Mutations like `store.currentData = newData` work because
// every module sees the same object reference.

export const store = {
  currentData: null,
  cachedUntouchedList: [],
  lastFetchTs: 0,
};
