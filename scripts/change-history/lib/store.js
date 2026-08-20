// dsh-desktop-change-history — append-only change store.
//
// One JSONL file (`index.jsonl`) under the plugin's data directory holds every
// recorded write/edit, one lossless JSON record per line, appended in order.
// The store also keeps the records in memory so list/get are cheap and never
// re-read disk; a failed append is contained (the in-memory copy still serves
// the current process) because recording must never break the tool pipeline
// it observes.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const FILE = 'index.jsonl'
const REVIEWED_FILE = 'reviewed.json'

/** Parse one line as a record; malformed lines are skipped, not fatal. */
function parseLine(line) {
  if (line.trim() === '') return null
  try {
    const parsed = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export class ChangeStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, FILE)
    this.reviewedFile = join(dir, REVIEWED_FILE)
    this.records = []
    this.reviewed = new Set()
    this.#load()
    this.#loadReviewed()
  }

  /** Load existing records (newest-last, matching file append order). */
  #load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return // first run: no file yet
    }
    for (const line of raw.split('\n')) {
      const record = parseLine(line)
      if (record !== null && typeof record.id === 'string') this.records.push(record)
    }
  }

  /** Load the reviewed id set (a plain JSON array of change ids). */
  #loadReviewed() {
    let raw
    try {
      raw = readFileSync(this.reviewedFile, 'utf8')
    } catch {
      return // no review state yet
    }
    try {
      const ids = JSON.parse(raw)
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') this.reviewed.add(id)
    } catch {
      /* malformed review state is discarded */
    }
  }

  /** Persist the reviewed id set (best-effort; failure keeps in-memory state). */
  #saveReviewed() {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.reviewedFile, JSON.stringify([...this.reviewed]))
    } catch {
      /* review marking must not break the review flow */
    }
  }

  /**
   * Persist one record and keep it in memory. `record` already carries the
   * captured fields; the store stamps `id` and `createdAt` when absent.
   * @returns the stored record.
   */
  append(record) {
    const stored = {
      ...record,
      id: typeof record.id === 'string' ? record.id : randomUUID(),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    }
    this.records.push(stored)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file, JSON.stringify(stored) + '\n')
    } catch {
      /* recording must not break tool execution; in-memory copy still works */
    }
    return stored
  }

  /** All records, newest first. */
  list() {
    return this.records.slice().reverse()
  }

  /** Find one record by id (undefined when absent). */
  get(id) {
    return this.records.find((record) => record.id === id)
  }

  /** Find the newest record produced by a given tool call id (undefined when absent). */
  findByCallId(callId) {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].callId === callId) return this.records[i]
    }
    return undefined
  }

  /** Whether a change id is marked reviewed. */
  isReviewed(id) {
    return this.reviewed.has(id)
  }

  /** Mark or unmark a change id as reviewed, persisting the set. */
  setReviewed(id, reviewed) {
    if (reviewed) this.reviewed.add(id)
    else this.reviewed.delete(id)
    this.#saveReviewed()
  }
}
