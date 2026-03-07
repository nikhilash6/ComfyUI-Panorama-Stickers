export function createHistoryController(limit = 80, initialState = null, serializeLimit = 8) {
  const entries = [];
  let index = -1;
  const maxEntries = Math.max(1, Number(limit || 80));
  const maxSerializedEntries = Math.max(1, Number(serializeLimit || 8));

  function hydrate(raw) {
    entries.splice(0, entries.length);
    index = -1;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return;
    raw.entries.forEach((entry) => {
      entries.push(String(entry || ""));
    });
    if (!entries.length) return;
    const nextIndex = Number(raw.index);
    index = Number.isInteger(nextIndex) ? Math.max(0, Math.min(entries.length - 1, nextIndex)) : (entries.length - 1);
  }

  function pushSnapshot(snapshot) {
    if (entries[index] === snapshot) return;
    entries.splice(index + 1);
    entries.push(snapshot);
    if (entries.length > maxEntries) entries.shift();
    index = entries.length - 1;
  }

  hydrate(initialState);

  return {
    beginActionGroup() {
      return { active: true };
    },
    commitActionGroup(snapshot) {
      pushSnapshot(String(snapshot || ""));
    },
    rollbackActionGroup() {
      return null;
    },
    undo() {
      const next = index - 1;
      if (next < 0 || next >= entries.length) return null;
      index = next;
      return entries[index];
    },
    redo() {
      const next = index + 1;
      if (next < 0 || next >= entries.length) return null;
      index = next;
      return entries[index];
    },
    get entries() {
      return entries.slice();
    },
    get index() {
      return index;
    },
    serialize() {
      const start = Math.max(0, entries.length - maxSerializedEntries);
      const serializedEntries = entries.slice(start);
      const serializedIndex = index < 0 ? -1 : Math.max(-1, Math.min(serializedEntries.length - 1, index - start));
      return {
        version: 1,
        entries: serializedEntries,
        index: serializedIndex,
      };
    },
    hydrate,
  };
}
