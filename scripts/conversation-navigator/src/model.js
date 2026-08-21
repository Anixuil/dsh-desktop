// Pure conversation projection helpers. They intentionally consume only the
// public session snapshot shape so the navigator stays independent of DOM text.

function normalizeText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function firstParagraph(value) {
  const normalized = normalizeText(value)
  if (normalized === '') return ''
  return normalized.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
  }
  return normalizeText(parts.join('\n'))
}

function assistantText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return normalizeText(blocks
    .filter((block) => block?.kind === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n'))
}

function turnOf(node) {
  const location = node?.location
  if (location?.kind === 'turn') return location.turn?.turn
  if (location?.kind === 'step') return location.turn?.turn
  return undefined
}

function buildTurnEntries(snapshot, copy = {}) {
  const chat = snapshot?.chat
  if (!chat || !Array.isArray(chat.order) || typeof chat.nodes?.get !== 'function') return []

  const byTurn = new Map()
  for (const key of chat.order) {
    const node = chat.nodes.get(key)
    if (!node || node.visibility === 'hidden') continue
    const turn = turnOf(node)
    if (!Number.isFinite(turn)) continue
    let entry = byTurn.get(turn)
    if (!entry) {
      entry = {
        turn,
        anchorKey: key,
        title: '',
        summary: '',
        running: false,
      }
      byTurn.set(turn, entry)
    }

    const data = node.data ?? {}
    if ((node.kind === 'user' || node.kind === 'steering') && entry.title === '') {
      entry.anchorKey = key
      entry.title = firstParagraph(contentText(data.content))
      if (entry.title === '' && Array.isArray(data.content) && data.content.length > 0) {
        entry.title = copy.imageMessage ?? '图片消息'
      }
    }
    if (node.kind === 'assistant-step') {
      const text = firstParagraph(assistantText(data.blocks))
      if (text !== '') entry.summary = text
      if (data.status === 'running') entry.running = true
    }
  }

  const entries = [...byTurn.values()].sort((left, right) => left.turn - right.turn)
  return entries.map((entry, index) => ({
    ...entry,
    index,
    title: entry.title || (typeof copy.turnFallback === 'function'
      ? copy.turnFallback(entry.turn)
      : (copy.turnFallback ?? '第 {turn} 轮对话').replace('{turn}', String(entry.turn))),
    summary: entry.summary || (entry.running
      ? copy.generating ?? '正在生成回复'
      : copy.noReply ?? '这一轮暂无可预览的回复'),
  }))
}

module.exports = {
  normalizeText,
  firstParagraph,
  contentText,
  assistantText,
  turnOf,
  buildTurnEntries,
}
