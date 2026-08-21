// dsh-desktop-file-upload — client-side pending-file store.
//
// Module-level observable shared by the composer button (writes) and the dock
// card list (reads). Files live here only until the next send: the dock
// appends each file's `[File #N ...]` hint to the draft at submit time, so the
// model still receives the path and reads the full file with its own read
// tool. The hint never sits in the draft while the user is composing, so the
// textarea stays clean and the dock card is the only visible representation.
let files = []
const listeners = new Set()

function emit() {
  const snapshot = files
  for (const fn of listeners) fn(snapshot)
}

module.exports = {
  getFiles: () => files,
  addFile: (file) => { files = [...files, file]; emit() },
  removeFile: (id) => { files = files.filter((f) => f.id !== id); emit() },
  clearFiles: () => { files = []; emit() },
  subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}
