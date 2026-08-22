import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONTENT_SCROLL_PATCH_MARKER = 'dsh-desktop bounded long content 2026-08-21'
export const CONTENT_SCROLL_FLEX_MARKER = 'dsh-desktop bounded tool flex content 2026-08-21'
export const CONTENT_SCROLL_GROUP_MARKER = 'dsh-desktop grouped process flow 2026-08-21'
export const CONTENT_SCROLL_FOLD_MARKER = 'dsh-desktop collapsible process flow 2026-08-21'
export const CONTENT_SCROLL_POLISH_MARKER = 'dsh-desktop polished process disclosure 2026-08-21'
export const CONTENT_SCROLL_LIFECYCLE_MARKER = 'dsh-desktop process lifecycle disclosure 2026-08-21'
export const CONTENT_SCROLL_SETTLED_GROUP_MARKER = 'dsh-desktop settled process grouping 2026-08-22'

const SUPPORTED_CONVERSATION_VERSIONS = new Set(['0.1.0-rc.8', '0.1.1-rc.2'])
const SUPPORTED_TOOL_VERSIONS = new Set(['0.1.0-rc.8', '0.1.1-rc.2'])

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
      '.Md3f7G_column{max-width:var(--dsh-chat-content-width);flex-direction:column;gap:16px;width:100%;margin:0 auto;display:flex}.Md3f7G_processGroup{min-width:0;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-base) 92%,var(--dsw-alias-interactive-bg-hover));border-radius:10px;transition:border-color .12s,background-color .12s;overflow:hidden}.Md3f7G_processGroup[data-expanded]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.Md3f7G_processGroup[data-running]{border-color:var(--dsw-alias-state-business-secondary)}.Md3f7G_processGroupHeader{width:100%;height:36px;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;padding:0 10px;display:flex}.Md3f7G_processGroupHeader:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Md3f7G_processGroupHeader:active{background:var(--dsw-alias-interactive-bg-hover-solid)}.Md3f7G_processGroupHeader:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:-2px}.Md3f7G_processGroupIcon{color:var(--dsw-alias-label-tertiary);flex:none}.Md3f7G_processGroupLabel{color:var(--dsw-alias-label-primary-dimmed);font-size:14px;line-height:24px}.Md3f7G_processGroupMeta{color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums;line-height:18px}.Md3f7G_processGroupChevron{color:var(--dsw-alias-label-secondary);flex:none;margin-left:auto;transition:transform .12s cubic-bezier(.16,1,.3,1)}.Md3f7G_processGroup[data-expanded] .Md3f7G_processGroupChevron{transform:rotate(90deg)}.Md3f7G_processGroupScroll{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 10px 12px 8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:12px;display:flex}@media (prefers-reduced-motion:reduce){.Md3f7G_processGroup,.Md3f7G_processGroupChevron{transition:none}}',
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
\t\t\tconst active = useSession((snapshot) => nodeKeys.some((nodeKey) => {
\t\t\t\tconst node = snapshot.chat.nodes.get(nodeKey);
\t\t\t\treturn node?.kind === "assistant-step" && node.data.status === "running" || node?.kind === "tool-call" && isRunningTool(node.data.root);
\t\t\t}));
\t\t\tconst [expanded, setExpanded] = (0, react.useState)(active);
\t\t\tconst regionId = (0, react.useId)();
\t\t\tconst scrollRef = (0, react.useRef)(null);
\t\t\tconst contentRef = (0, react.useRef)(null);
\t\t\tconst followRef = (0, react.useRef)(true);
\t\t\tconst onScroll = (0, react.useCallback)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tif (element !== null) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
\t\t\t}, []);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tsetExpanded(active);
\t\t\t}, [active]);
\t\t\t(0, react.useLayoutEffect)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tif (element !== null && followRef.current) element.scrollTop = element.scrollHeight;
\t\t\t}, [expanded, nodeKeys.length]);
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
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ChatView_module_css_default.processGroup,
\t\t\t\t"data-chat-process-group": "",
\t\t\t\t"data-expanded": expanded || void 0,
\t\t\t\t"data-running": active || void 0,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("button", {
\t\t\t\t\ttype: "button",
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupHeader,
\t\t\t\t\t"aria-expanded": expanded,
\t\t\t\t\t"aria-controls": regionId,
\t\t\t\t\tonClick: () => {
\t\t\t\t\t\tsetExpanded((value) => !value);
\t\t\t\t\t},
\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupIcon
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupLabel,
\t\t\t\t\t\tchildren: "Process"
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupMeta,
\t\t\t\t\t\tchildren: \`\${nodeKeys.length} \${nodeKeys.length === 1 ? "step" : "steps"}\`
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupChevron
\t\t\t\t\t})]
\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tref: scrollRef,
\t\t\t\t\tid: regionId,
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupScroll,
\t\t\t\t\trole: "region",
\t\t\t\t\t"aria-label": "Process details",
\t\t\t\t\thidden: !expanded,
\t\t\t\t\tonScroll,
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tref: contentRef,
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupContent,
\t\t\t\t\t\tchildren: nodeKeys.map((nodeKey) => (0, react_jsx_runtime.jsx)(ChatNodeSeat, {
\t\t\t\t\t\t\tnodeKey,
\t\t\t\t\t\t\tuseSession,
\t\t\t\t\t\t\tselectedCallId,
\t\t\t\t\t\t\tcwd,
\t\t\t\t\t\t\topenFile,
\t\t\t\t\t\t\tinspectCall,
\t\t\t\t\t\t\tforkAt,
\t\t\t\t\t\t\trenderMessageImages,
\t\t\t\t\t\t\tfileMentions,
\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\tt
\t\t\t\t\t\t}, nodeKey))
\t\t\t\t\t})
\t\t\t\t})]
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
      '\t\t\t"openError": "Md3f7G_openError",\n\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",\n\t\t\t"processGroupChevron": "Md3f7G_processGroupChevron",\n\t\t\t"processGroupHeader": "Md3f7G_processGroupHeader",\n\t\t\t"processGroupIcon": "Md3f7G_processGroupIcon",\n\t\t\t"processGroupLabel": "Md3f7G_processGroupLabel",\n\t\t\t"processGroupMeta": "Md3f7G_processGroupMeta",\n\t\t\t"processGroupScroll": "Md3f7G_processGroupScroll",',
      conversationClientFile,
    )
    writeFileSync(conversationClientFile, conversation)
  }

  const patchConversationFold = !conversation.includes(CONTENT_SCROLL_FOLD_MARKER)
  if (patchConversationFold) {
    conversation = replaceOnce(
      conversation,
      `/** ${CONTENT_SCROLL_GROUP_MARKER}: intermediate assistant steps and Tool calls share one scroll boundary. */`,
      `/** ${CONTENT_SCROLL_GROUP_MARKER}: intermediate assistant steps and Tool calls share one scroll boundary. */\n\t\t/** ${CONTENT_SCROLL_FOLD_MARKER}: process groups collapse to one disclosure row by default. */`,
      conversationClientFile,
    )
    if (!patchConversationGroup) {
      conversation = replaceOnce(
        conversation,
        '.Md3f7G_processGroup{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;padding-right:8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:16px;display:flex}',
        '.Md3f7G_processGroup{min-width:0}.Md3f7G_processGroupHeader{width:100%;height:28px;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;padding:0 4px;display:flex}.Md3f7G_processGroupHeader:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Md3f7G_processGroupHeader:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:2px}.Md3f7G_processGroupLabel{font-size:14px;line-height:24px}.Md3f7G_processGroupCount{color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums}.Md3f7G_processGroupScroll{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;margin-top:4px;padding-right:8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:16px;display:flex}',
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\tfunction ProcessFlowGroup({ nodeKeys, useSession, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, renderSlot, t }) {\n\t\t\tconst scrollRef = (0, react.useRef)(null);',
        '\t\tfunction ProcessFlowGroup({ nodeKeys, useSession, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, renderSlot, t }) {\n\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);\n\t\t\tconst scrollRef = (0, react.useRef)(null);',
        conversationClientFile,
      )
      conversation = replaceOnce(conversation, '}, [nodeKeys.length]);', '}, [expanded, nodeKeys.length]);', conversationClientFile)
      conversation = replaceOnce(
        conversation,
        `\t\t\treturn (0, react_jsx_runtime.jsx)("div", {
\t\t\t\tref: scrollRef,
\t\t\t\tclassName: ChatView_module_css_default.processGroup,
\t\t\t\t"data-chat-process-group": "",
\t\t\t\tonScroll,
\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("div", {`,
        `\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ChatView_module_css_default.processGroup,
\t\t\t\t"data-chat-process-group": "",
\t\t\t\t"data-expanded": expanded || void 0,
\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("button", {
\t\t\t\t\ttype: "button",
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupHeader,
\t\t\t\t\t"aria-expanded": expanded,
\t\t\t\t\tonClick: () => {
\t\t\t\t\t\tsetExpanded((value) => !value);
\t\t\t\t\t},
\t\t\t\t\tchildren: [expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupLabel,
\t\t\t\t\t\tchildren: "Process"
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupCount,
\t\t\t\t\t\tchildren: nodeKeys.length
\t\t\t\t\t})]
\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\tref: scrollRef,
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupScroll,
\t\t\t\t\thidden: !expanded,
\t\t\t\t\tonScroll,
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("div", {`,
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        `\t\t\t\t\t}, nodeKey))
\t\t\t\t})
\t\t\t});`,
        `\t\t\t\t\t\t}, nodeKey))
\t\t\t\t\t})
\t\t\t\t})]
\t\t\t});`,
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",',
        '\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",\n\t\t\t"processGroupCount": "Md3f7G_processGroupCount",\n\t\t\t"processGroupHeader": "Md3f7G_processGroupHeader",\n\t\t\t"processGroupLabel": "Md3f7G_processGroupLabel",\n\t\t\t"processGroupScroll": "Md3f7G_processGroupScroll",',
        conversationClientFile,
      )
    }
    writeFileSync(conversationClientFile, conversation)
  }

  const patchConversationPolish = !conversation.includes(CONTENT_SCROLL_POLISH_MARKER)
  if (patchConversationPolish) {
    const alreadyPolished = conversation.includes('Md3f7G_processGroupMeta')
    conversation = replaceOnce(
      conversation,
      `/** ${CONTENT_SCROLL_FOLD_MARKER}: process groups collapse to one disclosure row by default. */`,
      `/** ${CONTENT_SCROLL_FOLD_MARKER}: process groups collapse to one disclosure row by default. */\n\t\t/** ${CONTENT_SCROLL_POLISH_MARKER}: compact disclosure styling and active-run behavior. */`,
      conversationClientFile,
    )
    if (!alreadyPolished) {
      conversation = replaceOnce(
        conversation,
        '.Md3f7G_processGroup{min-width:0}.Md3f7G_processGroupHeader{width:100%;height:28px;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;padding:0 4px;display:flex}.Md3f7G_processGroupHeader:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Md3f7G_processGroupHeader:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:2px}.Md3f7G_processGroupLabel{font-size:14px;line-height:24px}.Md3f7G_processGroupCount{color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums}.Md3f7G_processGroupScroll{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;margin-top:4px;padding-right:8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:16px;display:flex}',
        '.Md3f7G_processGroup{min-width:0;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-base) 92%,var(--dsw-alias-interactive-bg-hover));border-radius:10px;transition:border-color .12s,background-color .12s;overflow:hidden}.Md3f7G_processGroup[data-expanded]{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.Md3f7G_processGroup[data-running]{border-color:var(--dsw-alias-state-business-secondary)}.Md3f7G_processGroupHeader{width:100%;height:36px;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;padding:0 10px;display:flex}.Md3f7G_processGroupHeader:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Md3f7G_processGroupHeader:active{background:var(--dsw-alias-interactive-bg-hover-solid)}.Md3f7G_processGroupHeader:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill);outline-offset:-2px}.Md3f7G_processGroupIcon{color:var(--dsw-alias-label-tertiary);flex:none}.Md3f7G_processGroupLabel{color:var(--dsw-alias-label-primary-dimmed);font-size:14px;line-height:24px}.Md3f7G_processGroupMeta{color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums;line-height:18px}.Md3f7G_processGroupChevron{color:var(--dsw-alias-label-secondary);flex:none;margin-left:auto;transition:transform .12s cubic-bezier(.16,1,.3,1)}.Md3f7G_processGroup[data-expanded] .Md3f7G_processGroupChevron{transform:rotate(90deg)}.Md3f7G_processGroupScroll{max-height:min(46vh,520px);scrollbar-gutter:stable;overscroll-behavior:contain;border-top:1px solid var(--dsw-alias-border-l1);padding:10px 10px 12px 8px;overflow-y:auto}.Md3f7G_processGroupContent{flex-direction:column;gap:12px;display:flex}@media (prefers-reduced-motion:reduce){.Md3f7G_processGroup,.Md3f7G_processGroupChevron{transition:none}}',
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);\n\t\t\tconst scrollRef = (0, react.useRef)(null);',
        '\t\t\tconst active = useSession((snapshot) => nodeKeys.some((nodeKey) => {\n\t\t\t\tconst node = snapshot.chat.nodes.get(nodeKey);\n\t\t\t\treturn node?.kind === "assistant-step" && node.data.status === "running" || node?.kind === "tool-call" && isRunningTool(node.data.root);\n\t\t\t}));\n\t\t\tconst [expanded, setExpanded] = (0, react.useState)(active);\n\t\t\tconst regionId = (0, react.useId)();\n\t\t\tconst scrollRef = (0, react.useRef)(null);',
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        `\t\t\tconst onScroll = (0, react.useCallback)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tif (element !== null) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
\t\t\t}, []);`,
        `\t\t\tconst onScroll = (0, react.useCallback)(() => {
\t\t\t\tconst element = scrollRef.current;
\t\t\t\tif (element !== null) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
\t\t\t}, []);
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tsetExpanded(active);
\t\t\t}, [active]);`,
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\t\t\t"data-expanded": expanded || void 0,',
        '\t\t\t\t"data-expanded": expanded || void 0,\n\t\t\t\t"data-running": active || void 0,',
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        `\t\t\t\t\tclassName: ChatView_module_css_default.processGroupHeader,
\t\t\t\t\t"aria-expanded": expanded,
\t\t\t\t\tonClick: () => {
\t\t\t\t\t\tsetExpanded((value) => !value);
\t\t\t\t\t},
\t\t\t\t\tchildren: [expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupLabel,
\t\t\t\t\t\tchildren: "Process"
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupCount,
\t\t\t\t\t\tchildren: nodeKeys.length
\t\t\t\t\t})]`,
        `\t\t\t\t\tclassName: ChatView_module_css_default.processGroupHeader,
\t\t\t\t\t"aria-expanded": expanded,
\t\t\t\t\t"aria-controls": regionId,
\t\t\t\t\tonClick: () => {
\t\t\t\t\t\tsetExpanded((value) => !value);
\t\t\t\t\t},
\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupIcon
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupLabel,
\t\t\t\t\t\tchildren: "Process"
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupMeta,
\t\t\t\t\t\tchildren: \`\${nodeKeys.length} \${nodeKeys.length === 1 ? "step" : "steps"}\`
\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, {
\t\t\t\t\t\tclassName: ChatView_module_css_default.processGroupChevron
\t\t\t\t\t})]`,
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        `\t\t\t\t\tref: scrollRef,
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupScroll,
\t\t\t\t\thidden: !expanded,`,
        `\t\t\t\t\tref: scrollRef,
\t\t\t\t\tid: regionId,
\t\t\t\t\tclassName: ChatView_module_css_default.processGroupScroll,
\t\t\t\t\trole: "region",
\t\t\t\t\t"aria-label": "Process details",
\t\t\t\t\thidden: !expanded,`,
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",\n\t\t\t"processGroupCount": "Md3f7G_processGroupCount",\n\t\t\t"processGroupHeader": "Md3f7G_processGroupHeader",\n\t\t\t"processGroupLabel": "Md3f7G_processGroupLabel",\n\t\t\t"processGroupScroll": "Md3f7G_processGroupScroll",',
        '\t\t\t"processGroup": "Md3f7G_processGroup",\n\t\t\t"processGroupContent": "Md3f7G_processGroupContent",\n\t\t\t"processGroupChevron": "Md3f7G_processGroupChevron",\n\t\t\t"processGroupHeader": "Md3f7G_processGroupHeader",\n\t\t\t"processGroupIcon": "Md3f7G_processGroupIcon",\n\t\t\t"processGroupLabel": "Md3f7G_processGroupLabel",\n\t\t\t"processGroupMeta": "Md3f7G_processGroupMeta",\n\t\t\t"processGroupScroll": "Md3f7G_processGroupScroll",',
        conversationClientFile,
      )
    }
    writeFileSync(conversationClientFile, conversation)
  }

  const patchConversationLifecycle = !conversation.includes(CONTENT_SCROLL_LIFECYCLE_MARKER)
  if (patchConversationLifecycle) {
    conversation = replaceOnce(
      conversation,
      `/** ${CONTENT_SCROLL_POLISH_MARKER}: compact disclosure styling and active-run behavior. */`,
      `/** ${CONTENT_SCROLL_POLISH_MARKER}: compact disclosure styling and active-run behavior. */\n\t\t/** ${CONTENT_SCROLL_LIFECYCLE_MARKER}: open while generating and collapse when the run settles. */`,
      conversationClientFile,
    )
    if (conversation.includes('\t\t\tconst touchedRef = (0, react.useRef)(false);')) {
      conversation = replaceOnce(
        conversation,
        '\t\t\tconst touchedRef = (0, react.useRef)(false);\n',
        '',
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\t\t\tif (active && !touchedRef.current) setExpanded(true);',
        '\t\t\t\tsetExpanded(active);',
        conversationClientFile,
      )
      conversation = replaceOnce(
        conversation,
        '\t\t\t\t\t\ttouchedRef.current = true;\n',
        '',
        conversationClientFile,
      )
    }
    writeFileSync(conversationClientFile, conversation)
  }

  const patchConversationSettledGroup = !conversation.includes(CONTENT_SCROLL_SETTLED_GROUP_MARKER)
  if (patchConversationSettledGroup) {
    conversation = replaceOnce(
      conversation,
      `/** ${CONTENT_SCROLL_LIFECYCLE_MARKER}: open while generating and collapse when the run settles. */`,
      `/** ${CONTENT_SCROLL_LIFECYCLE_MARKER}: open while generating and collapse when the run settles. */\n\t\t/** ${CONTENT_SCROLL_SETTLED_GROUP_MARKER}: keep live reasoning and Tool calls in their native rows; group only settled turns. */`,
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      `\t\t\tconst flushProcess = () => {
\t\t\t\tif (processKeys.length === 0) return;
\t\t\t\tflow.push({
\t\t\t\t\tkind: "process",
\t\t\t\t\tkey: \`process:\${processKeys[0]}\`,
\t\t\t\t\tnodeKeys: processKeys
\t\t\t\t});
\t\t\t\tprocessKeys = [];
\t\t\t};`,
      `\t\t\tconst flushProcess = (settled) => {
\t\t\t\tif (processKeys.length === 0) return;
\t\t\t\tif (settled) {
\t\t\t\t\tflow.push({
\t\t\t\t\t\tkind: "process",
\t\t\t\t\t\tkey: \`process:\${processKeys[0]}\`,
\t\t\t\t\t\tnodeKeys: processKeys
\t\t\t\t\t});
\t\t\t\t} else {
\t\t\t\t\tfor (const nodeKey of processKeys) flow.push({ kind: "node", key: nodeKey, nodeKey });
\t\t\t\t}
\t\t\t\tprocessKeys = [];
\t\t\t};`,
      conversationClientFile,
    )
    conversation = replaceOnce(
      conversation,
      `\t\t\t\tflushProcess();
\t\t\t\tflow.push({`,
      `\t\t\t\tconst settlesProcess = node?.kind === "assistant-step" && node.data.finalNode !== void 0 && finalAssistantSeqs.has(node.data.finalNode.seq) || node?.kind === "turn-tail" && node.data.closing !== null;
\t\t\t\tflushProcess(settlesProcess);
\t\t\t\tflow.push({`,
      conversationClientFile,
    )
    conversation = replaceOnce(conversation, '\t\t\tflushProcess();\n\t\t\treturn flow;', '\t\t\tflushProcess(false);\n\t\t\treturn flow;', conversationClientFile)
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

  return { conversation: patchConversation || patchConversationGroup || patchConversationFold || patchConversationPolish || patchConversationLifecycle || patchConversationSettledGroup, tool: patchTool || patchToolFlex }
}
