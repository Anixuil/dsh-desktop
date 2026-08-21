import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  applyDshContentScrollPatch,
  CONTENT_SCROLL_FLEX_MARKER,
  CONTENT_SCROLL_GROUP_MARKER,
  CONTENT_SCROLL_PATCH_MARKER,
} from './dsh-content-scroll-patch.mjs'

const root = join(import.meta.dirname, '..')
const sourceModules = join(root, 'runtime', 'dsh', 'node_modules')
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-content-scroll-'))
const targetConversation = join(tempRoot, '@deepseek-ai', 'dsh-client-ui-conversation')
const targetTool = join(tempRoot, '@deepseek-ai', 'dsh-client-ui-tool')

try {
  mkdirSync(dirname(targetConversation), { recursive: true })
  cpSync(join(sourceModules, '@deepseek-ai', 'dsh-client-ui-conversation'), targetConversation, { recursive: true })
  cpSync(join(sourceModules, '@deepseek-ai', 'dsh-client-ui-tool'), targetTool, { recursive: true })

  const conversationClient = join(targetConversation, 'lib', 'client.js')
  let conversation = readFileSync(conversationClient, 'utf8')
  if (conversation.includes(CONTENT_SCROLL_PATCH_MARKER)) {
    conversation = conversation
      .replace(`\n\t\t/** ${CONTENT_SCROLL_GROUP_MARKER}: intermediate assistant steps and Tool calls share one scroll boundary. */`, '')
      .replace(`/** ${CONTENT_SCROLL_PATCH_MARKER}: tool Input and Output scroll independently. */\n\t\t`, '\t\t')
      .replace('.Md3f7G_column{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:16px;width:100%;margin:0 auto;display:flex}.Md3f7G_processGroup{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;padding-right:8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:16px;display:flex}', '.Md3f7G_column{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:16px;width:100%;margin:0 auto;display:flex}')
      .replace('max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;margin-bottom:16px;overflow:auto', 'margin-bottom:16px')
      .replace('max-height:min(36vh,320px);scrollbar-gutter:stable;overscroll-behavior:contain;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 8px 4px 22px;font-size:14px;line-height:24px;overflow-y:auto', 'color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 0 4px 22px;font-size:14px;line-height:24px')
      .replace(/\t\tfunction processChatFlow[\s\S]*?\n\t\t\/\*\*\n\t\t\* The chat view slot entry:/, '\t\t/**\n\t\t* The chat view slot entry:')
      .replace('\t\t\tconst nodeStore = useSession((s) => s.chat.nodes);\n\t\t\tconst flow = processChatFlow(order, nodeStore);', '\t\t\tconst nodeStore = useSession((s) => s.chat.nodes);')
      .replace(/flow\.map\(\(item\) => item\.kind === "process"[\s\S]*?}, item\.key\)\)/, `order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
\t\t\t\t\t\t\t\tnodeKey,
\t\t\t\t\t\t\t\tuseSession,
\t\t\t\t\t\t\t\tselectedCallId,
\t\t\t\t\t\t\t\tcwd,
\t\t\t\t\t\t\t\topenFile: requestOpenFile,
\t\t\t\t\t\t\t\tinspectCall,
\t\t\t\t\t\t\t\tforkAt,
\t\t\t\t\t\t\t\trenderMessageImages,
\t\t\t\t\t\t\t\tfileMentions,
\t\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\t\tt
\t\t\t\t\t\t\t}, nodeKey))`)
      .replace('\t\t\t"openError": "Md3f7G_openError",\n\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",', '\t\t\t"openError": "Md3f7G_openError",')
    writeFileSync(conversationClient, conversation)
  }

  const toolClient = join(targetTool, 'lib', 'client.js')
  let tool = readFileSync(toolClient, 'utf8')
  if (tool.includes(CONTENT_SCROLL_PATCH_MARKER)) {
    tool = tool
      .replace(`/** ${CONTENT_SCROLL_PATCH_MARKER}: expanded Tool rows keep their own scroll boundary. */\n\t\t/** ${CONTENT_SCROLL_FLEX_MARKER}: expanded cards retain intrinsic height inside that boundary. */\n\t\t`, '\t\t')
      .replaceAll('.o3BgMG_bodyWrap>*{flex-shrink:0}', '')
      .replaceAll('.CY-8Ka_bodyWrap>*{flex-shrink:0}', '')
      .replaceAll('max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto', 'flex-direction:column;display:flex')
    writeFileSync(toolClient, tool)
  }

  assert.deepEqual(applyDshContentScrollPatch(tempRoot), { conversation: true, tool: true })
  assert.deepEqual(applyDshContentScrollPatch(tempRoot), { conversation: false, tool: false })

  const patchedConversation = readFileSync(conversationClient, 'utf8')
  assert.match(patchedConversation, /\.ydkMvW_section\{max-height:min\(46vh,520px\);[^}]*overscroll-behavior:contain[^}]*overflow:auto\}/)
  assert.match(patchedConversation, /\.QWLzlG_thinkBody\{max-height:min\(36vh,320px\);[^}]*overflow-y:auto\}/)
  assert.match(patchedConversation, /\.Md3f7G_processGroup\{max-height:min\(46vh,520px\);[^}]*overscroll-behavior:contain[^}]*overflow-y:auto\}/)
  assert.match(patchedConversation, /function processChatFlow\(order, nodeStore\)/)
  assert.match(patchedConversation, /node\.kind === "turn-tail" && node\.data\.closing !== null/)
  assert.match(patchedConversation, /node\?\.kind === "tool-call" \|\| node\?\.kind === "assistant-step"/)
  assert.match(patchedConversation, /data-chat-process-group/)
  assert.match(patchedConversation, /new ResizeObserver/)
  assert.equal((patchedConversation.match(new RegExp(CONTENT_SCROLL_PATCH_MARKER, 'g')) ?? []).length, 1)
  assert.equal((patchedConversation.match(new RegExp(CONTENT_SCROLL_GROUP_MARKER, 'g')) ?? []).length, 1)

  const processFlowSource = patchedConversation.match(/function processChatFlow\(order, nodeStore\) \{[\s\S]*?\n\t\t\}/)?.[0]
  assert.ok(processFlowSource, 'processChatFlow source should remain extractable for behavior checks')
  const processChatFlow = Function(`return (${processFlowSource})`)()
  const nodes = new Map([
    ['user:1', { kind: 'user', data: {} }],
    ['assistant:1:1', { kind: 'assistant-step', data: { finalNode: { seq: 20 } } }],
    ['tool:1', { kind: 'tool-call', data: {} }],
    ['assistant:1:2', { kind: 'assistant-step', data: { finalNode: { seq: 30 } } }],
    ['tail:1', { kind: 'turn-tail', data: { closing: { finalNode: { seq: 30 } } } }],
  ])
  assert.deepEqual(
    processChatFlow([...nodes.keys()], nodes),
    [
      { kind: 'node', key: 'user:1', nodeKey: 'user:1' },
      { kind: 'process', key: 'process:assistant:1:1', nodeKeys: ['assistant:1:1', 'tool:1'] },
      { kind: 'node', key: 'assistant:1:2', nodeKey: 'assistant:1:2' },
      { kind: 'node', key: 'tail:1', nodeKey: 'tail:1' },
    ],
  )

  const patchedTool = readFileSync(toolClient, 'utf8')
  assert.match(patchedTool, /\.o3BgMG_bodyWrap\{max-height:min\(46vh,520px\);[^}]*overflow-y:auto\}/)
  assert.match(patchedTool, /\.o3BgMG_bodyWrap>\*\{flex-shrink:0\}/)
  assert.match(patchedTool, /\.CY-8Ka_bodyWrap\{max-height:min\(46vh,520px\);[^}]*overflow-y:auto\}/)
  assert.match(patchedTool, /\.CY-8Ka_bodyWrap>\*\{flex-shrink:0\}/)
  assert.equal((patchedTool.match(new RegExp(CONTENT_SCROLL_PATCH_MARKER, 'g')) ?? []).length, 1)
  assert.equal((patchedTool.match(new RegExp(CONTENT_SCROLL_FLEX_MARKER, 'g')) ?? []).length, 1)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

console.log('bounded reasoning and tool detail scroll tests passed')
