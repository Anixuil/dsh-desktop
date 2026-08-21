import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONTENT_SCROLL_PATCH_MARKER = 'dsh-desktop bounded long content 2026-08-21'
export const CONTENT_SCROLL_FLEX_MARKER = 'dsh-desktop bounded tool flex content 2026-08-21'
export const CONTENT_SCROLL_GROUP_MARKER = 'dsh-desktop grouped process flow 2026-08-21'

const SUPPORTED_CONVERSATION_VERSIONS = new Set(['0.1.0-rc.8'])
const SUPPORTED_TOOL_VERSIONS = new Set(['0.1.0-rc.8'])

function replaceOnce(source, needle, replacement, file) {
  if (!source.includes(needle)) {
    throw new Error(`DSH content scroll patch no longer matches ${file}; review the selectors before acquiring this runtime`)
  }
  return source.replace(needle, replacement)
}

/**
 * Keep long reasoning and tool Input/Output content readable without letting a
 * single block take over the entire conversation or details panel.
 *
 * The patch is version-asserted because DSH ships CSS modules inside its
 * client bundle. It changes only the acquired desktop runtime and is
 * idempotent across repeated runtime preparation.
 */
export function applyDshContentScrollPatch(dshModulesDir) {
  const conversationDir = join(dshModulesDir, '@deepseek-ai', 'dsh-client-ui-conversation')
  const conversationPackageFile = join(conversationDir, 'package.json')
  const conversationClientFile = join(conversationDir, 'lib', 'client.js')
  const toolDir = join(dshModulesDir, '@deepseek-ai', 'dsh-client-ui-tool')
  const toolPackageFile = join(toolDir, 'package.json')
  const toolClientFile = join(toolDir, 'lib', 'client.js')

  for (const file of [conversationPackageFile, conversationClientFile, toolPackageFile, toolClientFile]) {
    if (!existsSync(file)) throw new Error(`DSH content scroll patch missing ${file}`)
  }

  const conversationVersion = JSON.parse(readFileSync(conversationPackageFile, 'utf8')).version
  if (!SUPPORTED_CONVERSATION_VERSIONS.has(conversationVersion)) {
    throw new Error(`DSH content scroll patch has not been reviewed for ${conversationPackageFile} version ${conversationVersion}`)
  }
  const toolVersion = JSON.parse(readFileSync(toolPackageFile, 'utf8')).version
  if (!SUPPORTED_TOOL_VERSIONS.has(toolVersion)) {
    throw new Error(`DSH content scroll patch has not been reviewed for ${toolPackageFile} version ${toolVersion}`)
  }

  let conversation = readFileSync(conversationClientFile, 'utf8')
  const patchConversation = !conversation.includes(CONTENT_SCROLL_PATCH_MARKER)
  if (patchConversation) {
    conversation = replaceOnce(
      conversation,
      '//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/DetailsPanel.module.css.mjs',
      `/** ${CONTENT_SCROLL_PATCH_MARKER}: tool Input and Output scroll independently. */\n\t\t//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/DetailsPanel.module.css.mjs`,
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      '.ydkMvW_section{margin-bottom:16px}',
      '.ydkMvW_section{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;margin-bottom:16px;overflow:auto}',
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      '.QWLzlG_thinkBody{color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 0 4px 22px;font-size:14px;line-height:24px}',
      '.QWLzlG_thinkBody{max-height:min(36vh,320px);scrollbar-gutter:stable;overscroll-behavior:contain;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;padding:4px 8px 4px 22px;font-size:14px;line-height:24px;overflow-y:auto}',
      conversationClientFile,
    )
    writeFileSync(conversationClientFile, conversation)
  }

  const patchConversationGroup = !conversation.includes(CONTENT_SCROLL_GROUP_MARKER)
  if (patchConversationGroup) {
    conversation = replaceOnce(
      conversation,
      `/** dsh-desktop bounded long content 2026-08-21: tool Input and Output scroll independently. */`,
      `/** dsh-desktop bounded long content 2026-08-21: tool Input and Output scroll independently. */\n\t\t/** ${CONTENT_SCROLL_GROUP_MARKER}: intermediate assistant steps and Tool calls share one scroll boundary. */`,
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      '.Md3f7G_column{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:16px;width:100%;margin:0 auto;display:flex}',
      '.Md3f7G_column{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:16px;width:100%;margin:0 auto;display:flex}.Md3f7G_processGroup{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;padding-right:8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:16px;display:flex}',
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      '\t\t/**\n\t\t* The chat view slot entry: pure component over the composed props; each\n\t\t* ordered business Node crosses the keyed renderer seat.\n\t\t*/\n\t\tfunction ChatView',
      `\t\tfunction processChatFlow(order, nodeStore) {
\t\t\tconst finalAssistantSeqs = new Set();
\t\t\tfor (const node of nodeStore.values()) {
\t\t\t\tif (node.kind === "turn-tail" && node.data.closing !== null) finalAssistantSeqs.add(node.data.closing.finalNode.seq);
\t\t\t}
\t\t\tconst flow = [];
\t\t\tlet processKeys = [];
\t\t\tconst flushProcess = () => {
\t\t\t\tif (processKeys.length === 0) return;
\t\t\t\tflow.push({
\t\t\t\t\tkind: "process",
\t\t\t\t\tkey: \`process:\${processKeys[0]}\`,
\t\t\t\t\tnodeKeys: processKeys
\t\t\t\t});
\t\t\t\tprocessKeys = [];
\t\t\t};
\t\t\tfor (const nodeKey of order) {
\t\t\t\tconst node = nodeStore.get(nodeKey);
\t\t\t\tconst processNode = node?.kind === "tool-call" || node?.kind === "assistant-step" && (node.data.finalNode === void 0 || !finalAssistantSeqs.has(node.data.finalNode.seq));
\t\t\t\tif (processNode) {
\t\t\t\t\tprocessKeys.push(nodeKey);
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\tflushProcess();
\t\t\t\tflow.push({
\t\t\t\t\tkind: "node",
\t\t\t\t\tkey: nodeKey,
\t\t\t\t\tnodeKey
\t\t\t\t});
\t\t\t}
\t\t\tflushProcess();
\t\t\treturn flow;
\t\t}
\t\tfunction ProcessFlowGroup({ nodeKeys, useSession, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, renderSlot, t }) {
\t\t\tconst scrollRef = (0, react.useRef)(null);
\t\t\tconst contentRef = (0, react.useRef)(null);
\t\t\tconst followRef = (0, react.useRef)(true);
\t\t\tconst onScroll = (0, react.useCallback)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tif (element !== null) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
\t\t\t}, []);
\t\t\t(0, react.useLayoutEffect)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tif (element !== null && followRef.current) element.scrollTop = element.scrollHeight;
\t\t\t}, [nodeKeys.length]);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tconst content = contentRef.current;
\t\t\t\tif (element === null || content === null || typeof ResizeObserver === "undefined") return;
\t\t\t\tconst observer = new ResizeObserver(() => {
\t\t\t\t\tif (followRef.current) element.scrollTop = element.scrollHeight;
\t\t\t\t});
\t\t\t\tobserver.observe(content);
\t\t\t\treturn () => {
\t\t\t\t\tobserver.disconnect();
\t\t\t\t};
\t\t\t}, []);
\t\t\treturn (0, react_jsx_runtime.jsx)("div", {
\t\t\t\tref: scrollRef,
\t\t\t\tclassName: ChatView_module_css_default.processGroup,
\t\t\t\t"data-chat-process-group": "",
\t\t\t\tonScroll,
\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tref: contentRef,
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupContent,
\t\t\t\t\tchildren: nodeKeys.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
\t\t\t\t\t\tnodeKey,
\t\t\t\t\t\tuseSession,
\t\t\t\t\t\tselectedCallId,
\t\t\t\t\t\tcwd,
\t\t\t\t\t\topenFile,
\t\t\t\t\t\tinspectCall,
\t\t\t\t\t\tforkAt,
\t\t\t\t\t\trenderMessageImages,
\t\t\t\t\t\tfileMentions,
\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\tt
\t\t\t\t\t}, nodeKey))
\t\t\t\t})
\t\t\t});
\t\t}
\t\t/**
\t\t* The chat view slot entry: pure component over the composed props; each
\t\t* ordered business Node crosses the keyed renderer seat.
\t\t*/
\t\tfunction ChatView`,
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      '\t\t\tconst nodeStore = useSession((s) => s.chat.nodes);',
      '\t\t\tconst nodeStore = useSession((s) => s.chat.nodes);\n\t\t\tconst flow = processChatFlow(order, nodeStore);',
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      `order.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
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
\t\t\t\t\t\t\t}, nodeKey))`,
      `flow.map((item) => item.kind === "process" ? (0, react_jsx_runtime.jsx)(ProcessFlowGroup, {
\t\t\t\t\t\t\t\tnodeKeys: item.nodeKeys,
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
\t\t\t\t\t\t\t}, item.key) : (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
\t\t\t\t\t\t\t\tnodeKey: item.nodeKey,
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
\t\t\t\t\t\t\t}, item.key))`,
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      '\t\t\t"openError": "Md3f7G_openError",',
      '\t\t\t"openError": "Md3f7G_openError",\n\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",',
      conversationClientFile,
    )
    writeFileSync(conversationClientFile, conversation)
  }

  let tool = readFileSync(toolClientFile, 'utf8')
  const patchTool = !tool.includes(CONTENT_SCROLL_PATCH_MARKER)
  if (patchTool) {
    tool = replaceOnce(
      tool,
      '//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css.mjs',
      `/** ${CONTENT_SCROLL_PATCH_MARKER}: expanded Tool rows keep their own scroll boundary. */\n\t\t//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css.mjs`,
      toolClientFile,
    )
    tool = replaceOnce(
      tool,
      '.o3BgMG_bodyWrap{flex-direction:column;display:flex}',
      '.o3BgMG_bodyWrap{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto}',
      toolClientFile,
    )
    tool = replaceOnce(
      tool,
      '.CY-8Ka_bodyWrap{flex-direction:column;display:flex}',
      '.CY-8Ka_bodyWrap{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto}',
      toolClientFile,
    )
  }
  const patchToolFlex = !tool.includes(CONTENT_SCROLL_FLEX_MARKER)
  if (patchToolFlex) {
    tool = replaceOnce(
      tool,
      `/** ${CONTENT_SCROLL_PATCH_MARKER}: expanded Tool rows keep their own scroll boundary. */`,
      `/** ${CONTENT_SCROLL_PATCH_MARKER}: expanded Tool rows keep their own scroll boundary. */\n\t\t/** ${CONTENT_SCROLL_FLEX_MARKER}: expanded cards retain intrinsic height inside that boundary. */`,
      toolClientFile,
    )
    tool = replaceOnce(
      tool,
      '.o3BgMG_bodyWrap{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto}',
      '.o3BgMG_bodyWrap{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto}.o3BgMG_bodyWrap>*{flex-shrink:0}',
      toolClientFile,
    )
    tool = replaceOnce(
      tool,
      '.CY-8Ka_bodyWrap{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto}',
      '.CY-8Ka_bodyWrap{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;flex-direction:column;display:flex;overflow-y:auto}.CY-8Ka_bodyWrap>*{flex-shrink:0}',
      toolClientFile,
    )
  }
  if (patchTool || patchToolFlex) writeFileSync(toolClientFile, tool)

  return { conversation: patchConversation || patchConversationGroup, tool: patchTool || patchToolFlex }
}
