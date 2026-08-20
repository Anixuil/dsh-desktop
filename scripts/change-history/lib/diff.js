// dsh-desktop-change-history — bounded line-level unified diff.
//
// Turns a `before`/`after` pair (LF-normalized text, the same diff basis the
// fs backend already produces) into a compact unified-diff string the client
// renders in a <pre> with +/−/context coloring. An LCS dynamic-programming
// pass is bounded so one oversized file never blows up memory; past the cap it
// degrades to a counts-only marker instead of a diff.

/** Lines shown above and below each changed block. */
const CONTEXT = 3
/** Cap on the LCS product (lines × lines); beyond it, degrade. */
const MAX_OPS = 4_000_000

function splitLines(text) {
  return (text ?? '').replaceAll('\r\n', '\n').split('\n')
}

/**
 * Longest-common-subsequence op list for `a`/`b`, or `null` when the product
 * exceeds {@link MAX_OPS}. Ops are `eq`/`del`/`ins` with the matched index.
 */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  if (n * m > MAX_OPS) return null
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i]
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = ai === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', a: i, b: j })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: 'del', a: i })
      i++
    } else {
      ops.push({ type: 'ins', b: j })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: 'del', a: i })
    i++
  }
  while (j < m) {
    ops.push({ type: 'ins', b: j })
    j++
  }
  return ops
}

/** Group changed runs into hunks and render each in unified format. */
function renderHunks(a, b, ops) {
  const changed = []
  ops.forEach((op, index) => {
    if (op.type !== 'eq') changed.push(index)
  })
  if (changed.length === 0) return ''

  // Merge changed runs separated by no more than 2*CONTEXT lines.
  const runs = []
  let runStart = changed[0]
  let runEnd = changed[0]
  for (let k = 1; k < changed.length; k++) {
    const idx = changed[k]
    if (idx - runEnd <= CONTEXT * 2 + 1) {
      runEnd = idx
    } else {
      runs.push([runStart, runEnd])
      runStart = idx
      runEnd = idx
    }
  }
  runs.push([runStart, runEnd])

  const lines = []
  for (const [rs, re] of runs) {
    const from = Math.max(0, rs - CONTEXT)
    const to = Math.min(ops.length - 1, re + CONTEXT)
    const slice = ops.slice(from, to + 1)
    let oldBefore = 0
    let newBefore = 0
    for (let k = 0; k < from; k++) {
      if (ops[k].type !== 'ins') oldBefore++
      if (ops[k].type !== 'del') newBefore++
    }
    let oldCount = 0
    let newCount = 0
    for (const op of slice) {
      if (op.type !== 'ins') oldCount++
      if (op.type !== 'del') newCount++
    }
    lines.push(`@@ -${oldBefore + 1},${oldCount} +${newBefore + 1},${newCount} @@`)
    for (const op of slice) {
      if (op.type === 'eq') lines.push(` ${a[op.a]}`)
      else if (op.type === 'del') lines.push(`-${a[op.a]}`)
      else lines.push(`+${b[op.b]}`)
    }
  }
  return lines.join('\n')
}

/**
 * Unified diff between `before` and `after`.
 * @param before - pre-change text (or null for a create).
 * @param after - post-change text.
 * @returns a unified-diff string, or a counts-only marker when too large.
 */
export function unifiedDiff(before, after) {
  const a = splitLines(before ?? '')
  const b = splitLines(after ?? '')
  if (a.join('\n') === b.join('\n')) return ''
  const ops = lcsOps(a, b)
  if (ops === null) {
    return `(diff omitted: ${a.length} lines -> ${b.length} lines exceeds the display limit)`
  }
  return renderHunks(a, b, ops)
}

/** +/− line counts for a record, derived from the diff ops. */
export function diffStats(before, after) {
  const a = splitLines(before ?? '')
  const b = splitLines(after ?? '')
  const ops = lcsOps(a, b)
  if (ops === null) return { added: null, removed: null }
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'ins') added++
    else if (op.type === 'del') removed++
  }
  return { added, removed }
}
