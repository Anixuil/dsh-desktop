import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REASONING_PATCH_MARKER = 'dsh-desktop model reasoning compatibility 2026-08-21'
const SUPPORTED_DSH_VERSIONS = new Set(['0.1.0-rc.8', '0.1.1-rc.2'])
const SUPPORTED_PI_AI_VERSIONS = new Set(['0.82.1'])

function replaceOnce(source, needle, replacement, file) {
  if (!source.includes(needle)) {
    throw new Error(`DSH model reasoning patch no longer matches ${file}; review the compatibility rules before acquiring this runtime`)
  }
  return source.replace(needle, replacement)
}

function replaceRegexOnce(source, pattern, replacement, file) {
  if (!pattern.test(source)) {
    throw new Error(`DSH model reasoning patch no longer matches ${file}; review the compatibility rules before acquiring this runtime`)
  }
  return source.replace(pattern, replacement)
}

function packageVersion(modulesDir, ...segments) {
  const file = join(modulesDir, ...segments, 'package.json')
  if (!existsSync(file)) throw new Error(`DSH model reasoning patch missing ${file}`)
  return { file, version: JSON.parse(readFileSync(file, 'utf8')).version }
}

function assertVersion(actual, supported, file) {
  if (!supported.has(actual)) {
    throw new Error(`DSH model reasoning patch has not been reviewed for ${file} version ${actual}`)
  }
}

const runtimeHelpers = String.raw`
/** ${REASONING_PATCH_MARKER}: identify only endpoints with an unambiguous official protocol. */
function desktopReasoningPlatform(provider, baseURL) {
	const route = String(provider).toLowerCase();
	let host = "";
	try { host = new URL(baseURL ?? "https://invalid.local").hostname.toLowerCase(); } catch {}
	if (["openai", "openai-codex"].includes(route) || host === "api.openai.com") return "openai";
	if (route === "openrouter" || host === "openrouter.ai") return "openrouter";
	if (route === "deepseek" || host === "api.deepseek.com") return "deepseek";
	if (["anthropic"].includes(route) || host === "api.anthropic.com") return "anthropic";
	if (["google", "google-vertex"].includes(route) || host === "generativelanguage.googleapis.com") return "google";
	if (["qwen-token-plan", "qwen-token-plan-cn", "dashscope"].includes(route) || host.endsWith("dashscope.aliyuncs.com") || host.endsWith("maas.aliyuncs.com")) return "qwen";
	if (["zai", "zai-coding-cn"].includes(route) || host === "api.z.ai" || host === "open.bigmodel.cn") return "zai";
	if (["moonshotai", "moonshotai-cn"].includes(route) || host.startsWith("api.moonshot.")) return "moonshot";
	if (["minimax", "minimax-cn"].includes(route) || host.includes("minimax")) return "minimax";
	return void 0;
}
const DESKTOP_REASONING_CATALOGS = {
	openai: ["openai"], openrouter: ["openrouter"], deepseek: ["deepseek"],
	anthropic: ["anthropic"], google: ["google"],
	qwen: ["qwen-token-plan", "qwen-token-plan-cn"],
	zai: ["zai", "zai-coding-cn"], moonshot: ["moonshotai", "moonshotai-cn"],
	minimax: ["minimax", "minimax-cn"]
};
const DESKTOP_REASONING_PROTOCOL_CATALOGS = {
	"openai-responses": ["openai"],
	"anthropic-messages": ["anthropic"],
	"google-generative-ai": ["google"]
};
function desktopReasoningCatalogs(provider, baseURL, api) {
	const platform = desktopReasoningPlatform(provider, baseURL);
	return platform === void 0 ? DESKTOP_REASONING_PROTOCOL_CATALOGS[api] ?? [] : DESKTOP_REASONING_CATALOGS[platform] ?? [];
}
function desktopPlatformCatalogModels(provider, baseURL, api) {
	const platform = desktopReasoningPlatform(provider, baseURL);
	const models = /* @__PURE__ */ new Map();
	for (const catalog of desktopReasoningCatalogs(provider, baseURL, api)) for (const model of catalogModels(catalog).values()) if (platform !== void 0 || model.api === api) if (!models.has(model.id)) models.set(model.id, model);
	return [...models.values()];
}
function desktopReasoningSignature(model) {
	return JSON.stringify({ api: model.api, reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap ?? null, thinkingFormat: model.compat?.thinkingFormat ?? null, forceAdaptiveThinking: model.compat?.forceAdaptiveThinking ?? null });
}
function desktopCatalogReasoning(provider, baseURL, id, api) {
	const platform = desktopReasoningPlatform(provider, baseURL);
	const matches = [];
	for (const catalog of desktopReasoningCatalogs(provider, baseURL, api)) {
		const model = catalogModels(catalog).get(id);
		if (model?.reasoning === true && (platform !== void 0 || model.api === api)) matches.push(model);
	}
	const unique = new Map(matches.map((model) => [desktopReasoningSignature(model), model]));
	if (unique.size === 1) return [...unique.values()][0];
	const compat = platform === void 0 ? void 0 : desktopReasoningCompatibility(platform, id);
	return compat;
}
/** Small official-protocol fallback; catalog data remains authoritative whenever present. */
function desktopReasoningCompatibility(platform, id) {
	if (platform === "deepseek" && ["deepseek-reasoner", "deepseek-chat"].includes(id)) return { api: "openai-completions", reasoning: true, compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true }, thinkingLevelMap: { off: "disabled", minimal: null, low: "low", medium: "high", high: "high", xhigh: "high", max: null } };
	if (platform === "zai" && /^glm-(?:4\\.7|5)(?:[.-]|$)/.test(id)) return { api: "openai-completions", reasoning: true, compat: { thinkingFormat: "zai", supportsReasoningEffort: /^glm-5\\.2(?:[.-]|$)/.test(id) }, thinkingLevelMap: /^glm-5\\.2(?:[.-]|$)/.test(id) ? { off: "disabled", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } : { off: "disabled", minimal: null, low: null, medium: null, high: "enabled", xhigh: null, max: null } };
	if (platform === "qwen" && /^(?:qwen3|qwq-|deepseek-|glm-|kimi-|MiniMax-)/i.test(id)) return { api: "openai-completions", reasoning: true, compat: { thinkingFormat: "qwen", supportsReasoningEffort: false }, thinkingLevelMap: { off: "disabled", minimal: null, low: null, medium: null, high: "enabled", xhigh: null, max: null } };
	return void 0;
}
`;

function upgradeAdapterProtocolCatalog(source, file) {
  source = replaceOnce(source,
    '};\nfunction desktopPlatformCatalogModels(provider, baseURL) {\n\tconst platform = desktopReasoningPlatform(provider, baseURL);\n\tif (platform === void 0) return [];\n\tconst models = /* @__PURE__ */ new Map();\n\tfor (const catalog of DESKTOP_REASONING_CATALOGS[platform] ?? []) for (const model of catalogModels(catalog).values()) if (!models.has(model.id)) models.set(model.id, model);\n\treturn [...models.values()];\n}',
    '};\nconst DESKTOP_REASONING_PROTOCOL_CATALOGS = {\n\t"openai-responses": ["openai"],\n\t"anthropic-messages": ["anthropic"],\n\t"google-generative-ai": ["google"]\n};\nfunction desktopReasoningCatalogs(provider, baseURL, api) {\n\tconst platform = desktopReasoningPlatform(provider, baseURL);\n\treturn platform === void 0 ? DESKTOP_REASONING_PROTOCOL_CATALOGS[api] ?? [] : DESKTOP_REASONING_CATALOGS[platform] ?? [];\n}\nfunction desktopPlatformCatalogModels(provider, baseURL, api) {\n\tconst platform = desktopReasoningPlatform(provider, baseURL);\n\tconst models = /* @__PURE__ */ new Map();\n\tfor (const catalog of desktopReasoningCatalogs(provider, baseURL, api)) for (const model of catalogModels(catalog).values()) if (platform !== void 0 || model.api === api) if (!models.has(model.id)) models.set(model.id, model);\n\treturn [...models.values()];\n}',
    file,
  )
  source = replaceOnce(source,
    'function desktopCatalogReasoning(provider, baseURL, id) {\n\tconst platform = desktopReasoningPlatform(provider, baseURL);\n\tif (platform === void 0) return void 0;\n\tconst matches = [];\n\tfor (const catalog of DESKTOP_REASONING_CATALOGS[platform] ?? []) {\n\t\tconst model = catalogModels(catalog).get(id);\n\t\tif (model?.reasoning === true) matches.push(model);\n\t}\n\tconst unique = new Map(matches.map((model) => [desktopReasoningSignature(model), model]));\n\tif (unique.size === 1) return [...unique.values()][0];\n\tconst compat = desktopReasoningCompatibility(platform, id);',
    'function desktopCatalogReasoning(provider, baseURL, id, api) {\n\tconst platform = desktopReasoningPlatform(provider, baseURL);\n\tconst matches = [];\n\tfor (const catalog of desktopReasoningCatalogs(provider, baseURL, api)) {\n\t\tconst model = catalogModels(catalog).get(id);\n\t\tif (model?.reasoning === true && (platform !== void 0 || model.api === api)) matches.push(model);\n\t}\n\tconst unique = new Map(matches.map((model) => [desktopReasoningSignature(model), model]));\n\tif (unique.size === 1) return [...unique.values()][0];\n\tconst compat = platform === void 0 ? void 0 : desktopReasoningCompatibility(platform, id);',
    file,
  )
  source = replaceOnce(source,
    'desktopCatalogReasoning(provider, request.baseURL ?? providerBaseUrl, entry.id)',
    'desktopCatalogReasoning(provider, request.baseURL ?? providerBaseUrl, entry.id, request.api)',
    file,
  )
  source = replaceOnce(source,
    'desktopPlatformCatalogModels(request.provider ?? "", request.baseURL)',
    'desktopPlatformCatalogModels(request.provider ?? "", request.baseURL, request.api)',
    file,
  )
  writeFileSync(file, source)
  return true
}

function patchAdapter(file) {
  let source = readFileSync(file, 'utf8')
  if (source.includes('const DESKTOP_REASONING_PROTOCOL_CATALOGS =')) return false
  if (source.includes(REASONING_PATCH_MARKER)) return upgradeAdapterProtocolCatalog(source, file)

  source = replaceOnce(source,
    'function sharedCatalogApi(defaults) {\n\tconst apis = /* @__PURE__ */ new Set();\n\tfor (const model of defaults.values()) apis.add(model.api);\n\treturn apis.size === 1 ? [...apis][0] : void 0;\n}',
    'function sharedCatalogApi(defaults) {\n\tconst apis = /* @__PURE__ */ new Set();\n\tfor (const model of defaults.values()) apis.add(model.api);\n\treturn apis.size === 1 ? [...apis][0] : void 0;\n}' + runtimeHelpers,
    file,
  )
  source = replaceOnce(source,
    'import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";',
    'import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";\nimport { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";',
    file,
  )
  source = replaceOnce(source,
    '\t"openai-responses": openAIResponsesApi,\n\t"anthropic-messages": anthropicMessagesApi',
    '\t"openai-responses": openAIResponsesApi,\n\t"anthropic-messages": anthropicMessagesApi,\n\t"google-generative-ai": googleGenerativeAIApi',
    file,
  )
  source = replaceOnce(source,
    'function resolveModelReasoning(provider, entry, base) {\n\tconst efforts = entry.reasoningEfforts;\n\tif (efforts === void 0) return { reasoning: base?.reasoning ?? false };',
    'function resolveModelReasoning(provider, entry, base) {\n\tconst efforts = entry.reasoningEfforts;\n\tconst mandatory = base?.reasoning === true && !getSupportedThinkingLevels(base).includes("off");\n\tconst inherited = {\n\t\treasoning: base?.reasoning ?? false,\n\t\t...base?.thinkingLevelMap === void 0 ? {} : { thinkingLevelMap: { ...base.thinkingLevelMap } },\n\t\t...base?.thinkingBudgets === void 0 ? {} : { thinkingBudgets: { ...base.thinkingBudgets } }\n\t};\n\tif (efforts === void 0 || efforts === false && mandatory) return inherited;',
    file,
  )
  source = replaceOnce(source,
    '\tconst declared = THINKING_LEVELS.flatMap((level) => {\n\t\tconst wire = efforts[level];',
    '\tconst declared = THINKING_LEVELS.flatMap((level) => {\n\t\tif (mandatory && level === "off") return [];\n\t\tconst wire = efforts[level];',
    file,
  )
  source = replaceOnce(source,
    '\tfor (const level of THINKING_LEVELS) {\n\t\tconst wire = efforts[level];',
    '\tfor (const level of THINKING_LEVELS) {\n\t\tif (mandatory && level === "off") { map[level] = null; continue; }\n\t\tconst wire = efforts[level];',
    file,
  )
  source = replaceOnce(source,
    '\t\tconst base = defaults.get(entry.id);\n\t\tconst api = request.api ?? base?.api ?? routeApi;',
    '\t\tconst base = defaults.get(entry.id);\n\t\tconst reasoningBase = base ?? desktopCatalogReasoning(provider, request.baseURL ?? providerBaseUrl, entry.id, request.api);\n\t\tconst api = request.api ?? base?.api ?? reasoningBase?.api ?? routeApi;',
    file,
  )
  source = replaceOnce(source,
    '\t\t\t...resolveModelReasoning(provider, entry, base),\n\t\t\t...resolveModelCompat(provider, entry, request.compat, base, api)',
    '\t\t\t...resolveModelReasoning(provider, entry, reasoningBase),\n\t\t\t...resolveModelCompat(provider, entry, request.compat, reasoningBase, api),\n\t\t\t...entry.thinkingBudgets === void 0 ? {} : { thinkingBudgets: { ...entry.thinkingBudgets } }',
    file,
  )
  source = replaceOnce(source,
    '\tif (Object.keys(configured).length === 0) return {};\n\treturn { compat: {',
    '\tif (Object.keys(configured).length === 0) return base?.api === api && base.compat !== void 0 ? { compat: { ...base.compat } } : {};\n\treturn { compat: {',
    file,
  )
  source = replaceOnce(source,
    '\t...profile.thinkingBudgets === void 0 ? {} : { thinkingBudgets: profile.thinkingBudgets },',
    '\t...model.thinkingBudgets === void 0 && profile.thinkingBudgets === void 0 ? {} : { thinkingBudgets: model.thinkingBudgets ?? profile.thinkingBudgets },',
    file,
  )
  source = replaceOnce(source,
    'function profileOptions(profile, reasoning, apiKey) {\n\tconst enabledReasoning = reasoning === "off" ? void 0 : reasoning;\n\treturn {',
    'function profileOptions(profile, model, reasoning, apiKey) {\n\treturn {',
    file,
  )
  source = replaceOnce(source,
    '\t\t...enabledReasoning === void 0 ? {} : { reasoning: enabledReasoning },',
    '\t\t...reasoning === void 0 ? {} : { reasoning },',
    file,
  )
  source = replaceOnce(source,
    '...profileOptions(profile, reasoning, apiKey),',
    '...profileOptions(profile, model, reasoning, apiKey),',
    file,
  )
  source = source.replace('const modelFields = {\n\tname: z.string(),', 'const modelFields = {\n\tname: z.string(),\n\tthinkingBudgets,')
  if (!source.includes('const modelFields = {\n\tname: z.string(),\n\tthinkingBudgets,')) throw new Error(`DSH model reasoning schema patch no longer matches ${file}`)
  source = replaceOnce(source,
    '\tif (!model.reasoning) return {};\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: `${level.charAt(0).toUpperCase()}${level.slice(1)}`\n\t\t})),',
    '\tif (!model.reasoning) return {};\n\tconst toggleOnly = model.compat?.thinkingFormat === "qwen" && model.thinkingLevelMap === void 0;\n\tconst levels = toggleOnly ? ["off", "high"] : getSupportedThinkingLevels(model);\n\treturn { reasoning: {\n\t\tefforts: levels.map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: toggleOnly ? level === "off" ? "Off" : "On" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`\n\t\t})),',
    file,
  )
  source = replaceOnce(source,
    'function readListing(body) {',
    'function desktopDiscoveredReasoning(entry) {\n\tconst raw = entry?.reasoning;\n\tconst supported = raw?.supported_efforts ?? entry?.supported_efforts;\n\tconst advertised = Array.isArray(supported) ? supported.filter((value) => THINKING_LEVELS.includes(value)) : [];\n\tconst parameters = Array.isArray(entry?.supported_parameters) ? entry.supported_parameters : [];\n\tif (advertised.length === 0 && raw?.mandatory !== true && !parameters.includes("reasoning")) return void 0;\n\treturn { efforts: advertised, ...typeof raw?.default_effort === "string" ? { defaultEffort: raw.default_effort } : {}, mandatory: raw?.mandatory === true };\n}\nfunction readListing(body) {',
    file,
  )
  source = replaceOnce(source,
    '\t\t\t...maxTokens === void 0 ? {} : { maxTokens }\n\t\t});',
    '\t\t\t...maxTokens === void 0 ? {} : { maxTokens },\n\t\t\t...desktopDiscoveredReasoning(entry) === void 0 ? {} : { reasoning: desktopDiscoveredReasoning(entry) }\n\t\t});',
    file,
  )
  source = replaceOnce(source,
    '\t\t\tcontextWindow: model.contextWindow,\n\t\t\tmaxTokens: model.maxTokens\n\t\t}));',
    '\t\t\tcontextWindow: model.contextWindow,\n\t\t\tmaxTokens: model.maxTokens,\n\t\t\t...model.reasoning ? { reasoning: { efforts: getSupportedThinkingLevels(model), mandatory: !getSupportedThinkingLevels(model).includes("off") } } : {}\n\t\t}));',
    file,
  )
  source = replaceOnce(source,
    '\t}\n\tif (request.baseURL === void 0 || request.baseURL.length === 0) throw new LlmError',
    '\t}\n\tconst compatibleCatalog = desktopPlatformCatalogModels(request.provider ?? "", request.baseURL, request.api);\n\tif (compatibleCatalog.length > 0) return compatibleCatalog.map((model) => ({\n\t\tid: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,\n\t\t...model.reasoning ? { reasoning: { efforts: getSupportedThinkingLevels(model), mandatory: !getSupportedThinkingLevels(model).includes("off") } } : {}\n\t}));\n\tif (request.baseURL === void 0 || request.baseURL.length === 0) throw new LlmError',
    file,
  )
  source += '\nexport { desktopReasoningPlatform as __dshDesktopReasoningPlatform, desktopCatalogReasoning as __dshDesktopCatalogReasoning, resolveRouteModels as __dshDesktopResolveRouteModels };\n'
  writeFileSync(file, source)
  return true
}

function patchPiAi(file) {
  let source = readFileSync(file, 'utf8')
  if (source.includes(`${REASONING_PATCH_MARKER}: qwen budget`)) return false
  source = replaceOnce(source,
    '    else if (compat.thinkingFormat === "qwen" && model.reasoning) {\n        params.enable_thinking = !!options?.reasoningEffort;\n    }',
    `    else if (compat.thinkingFormat === "qwen" && model.reasoning) {\n        params.enable_thinking = !!options?.reasoningEffort;\n        /** ${REASONING_PATCH_MARKER}: qwen budget */\n        const budget = options?.reasoningEffort ? options?.thinkingBudgets?.[options.reasoningEffort] : undefined;\n        if (Number.isInteger(budget) && budget > 0) params.thinking_budget = budget;\n    }`,
    file,
  )
  source = replaceOnce(source,
    '        reasoningEffort,\n        toolChoice,',
    '        reasoningEffort,\n        ...options?.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets },\n        toolChoice,',
    file,
  )
  writeFileSync(file, source)
  return true
}

const uiHelpers = String.raw`
		const DESKTOP_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const DESKTOP_REASONING_FORMATS = ["openai", "deepseek", "openrouter", "qwen", "zai", "together"];
		function desktopKnownReasoningProbe(probe) {
			const route = String(probe.provider ?? "").toLowerCase();
			if (["openai", "openrouter", "deepseek", "anthropic", "google", "google-vertex", "qwen-token-plan", "qwen-token-plan-cn", "zai", "zai-coding-cn", "moonshotai", "moonshotai-cn", "minimax", "minimax-cn"].includes(route)) return true;
			if (["openai-responses", "anthropic-messages", "google-generative-ai"].includes(probe.api)) return true;
			try { const host = new URL(probe.baseURL).hostname.toLowerCase(); return host === "api.openai.com" || host === "openrouter.ai" || host === "api.deepseek.com" || host === "api.anthropic.com" || host === "generativelanguage.googleapis.com" || host.endsWith("dashscope.aliyuncs.com") || host.endsWith("maas.aliyuncs.com") || host === "api.z.ai" || host === "open.bigmodel.cn" || host.startsWith("api.moonshot.") || host.includes("minimax"); } catch { return false; }
		}
		function DesktopReasoningEditor({ model, index, disabled, patch, t, api, automatic }) {
			const custom = Object.prototype.hasOwnProperty.call(model, "reasoningEfforts") || model.compat?.thinkingFormat !== void 0 || model.thinkingBudgets !== void 0;
			const efforts = typeof model.reasoningEfforts === "object" && model.reasoningEfforts !== null ? model.reasoningEfforts : {};
			const editableEfforts = automatic?.mandatory ? DESKTOP_REASONING_EFFORTS.filter((level) => level !== "off") : DESKTOP_REASONING_EFFORTS;
			const format = model.compat?.thinkingFormat ?? "";
			const formatSelectable = api === void 0 || api === "openai-completions";
			const budgetFormat = format === "qwen" || api === "google-generative-ai" || api === "anthropic-messages";
			const setAutomatic = () => {
				const compat = { ...model.compat };
				delete compat.thinkingFormat;
				patch(index, { reasoningEfforts: void 0, thinkingBudgets: void 0, compat: Object.keys(compat).length === 0 ? void 0 : compat });
			};
			const setCustom = () => patch(index, { reasoningEfforts: automatic?.mandatory ? { low: "low", medium: "medium", high: "high" } : { off: "none", low: "low", medium: "medium", high: "high" } });
			const updateEffort = (level, enabled, wire) => {
				const next = { ...efforts };
				if (!enabled) delete next[level]; else next[level] = wire ?? (level === "off" ? "none" : level);
				patch(index, { reasoningEfforts: next });
			};
			const updateBudget = (level, raw) => {
				const next = { ...model.thinkingBudgets };
				if (raw === "") delete next[level]; else next[level] = Number(raw);
				patch(index, { thinkingBudgets: Object.keys(next).length === 0 ? void 0 : next });
			};
			return (0, react_jsx_runtime.jsxs)("fieldset", { className: ModelsSection_module_css_default["reasoningPanel"], children: [
				(0, react_jsx_runtime.jsx)("legend", { className: ModelsSection_module_css_default["modelFieldLabel"], children: t("modelReasoning") }),
				(0, react_jsx_runtime.jsxs)("div", { className: ModelsSection_module_css_default["reasoningMode"], children: [
					(0, react_jsx_runtime.jsx)("button", { type: "button", className: ModelsSection_module_css_default["reasoningModeButton"] + " " + (!custom ? ModelsSection_module_css_default["reasoningModeButtonActive"] : ""), disabled, onClick: setAutomatic, children: t("reasoningAuto") }),
					(0, react_jsx_runtime.jsx)("button", { type: "button", className: ModelsSection_module_css_default["reasoningModeButton"] + " " + (custom ? ModelsSection_module_css_default["reasoningModeButtonActive"] : ""), disabled, onClick: setCustom, children: t("reasoningCustom") })
				] }),
				!custom ? (0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["reasoningHint"], children: automatic === void 0 ? t("reasoningAutoHint") : t("reasoningAutoResolved").replace("{efforts}", automatic.efforts.join(" / ")).replace("{mandatory}", automatic.mandatory ? t("reasoningMandatory") : "") }) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					!formatSelectable ? null : (0, react_jsx_runtime.jsxs)("label", { className: ModelsSection_module_css_default["modelField"], children: [(0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelFieldLabel"], children: t("reasoningFormat") }), (0, react_jsx_runtime.jsxs)("select", { className: ModelsSection_module_css_default["input"] + " " + ModelsSection_module_css_default["selectInput"], value: format, disabled, onChange: (event) => { const compat = { ...model.compat }; if (event.target.value === "") delete compat.thinkingFormat; else compat.thinkingFormat = event.target.value; patch(index, { compat: Object.keys(compat).length === 0 ? void 0 : compat }); }, children: [(0, react_jsx_runtime.jsx)("option", { value: "", children: t("reasoningFormatAuto") }), ...DESKTOP_REASONING_FORMATS.map((value) => (0, react_jsx_runtime.jsx)("option", { value, children: value === "zai" ? "Z.AI" : value.charAt(0).toUpperCase() + value.slice(1) }, value))] })] }),
					(0, react_jsx_runtime.jsx)("div", { className: ModelsSection_module_css_default["reasoningEfforts"], children: editableEfforts.map((level) => { const checked = Object.prototype.hasOwnProperty.call(efforts, level); return (0, react_jsx_runtime.jsxs)("div", { className: ModelsSection_module_css_default["reasoningEffort"], children: [(0, react_jsx_runtime.jsxs)("label", { className: ModelsSection_module_css_default["reasoningCheck"], children: [(0, react_jsx_runtime.jsx)("input", { type: "checkbox", checked, disabled, onChange: (event) => updateEffort(level, event.target.checked) }), (0, react_jsx_runtime.jsx)("span", { children: level })] }), checked ? (0, react_jsx_runtime.jsx)("input", { className: ModelsSection_module_css_default["input"], value: efforts[level] ?? "", disabled, "aria-label": t("reasoningWireValue") + " " + level, onChange: (event) => updateEffort(level, true, event.target.value) }) : null, budgetFormat && checked && level !== "off" ? (0, react_jsx_runtime.jsx)("input", { className: ModelsSection_module_css_default["input"], type: "number", min: 1, step: 1, value: model.thinkingBudgets?.[level] ?? "", placeholder: t("reasoningBudget"), disabled, "aria-label": t("reasoningBudget") + " " + level, onChange: (event) => updateBudget(level, event.target.value) }) : null] }, level); }) })
				] })
			] });
		}
`;

function patchUi(file) {
  let source = readFileSync(file, 'utf8')
  const protocolProbe = 'if (["openai-responses", "anthropic-messages", "google-generative-ai"].includes(probe.api)) return true;'
  if (source.includes(protocolProbe)) return false
  if (source.includes(`${REASONING_PATCH_MARKER}: settings editor`)) {
    source = replaceOnce(source,
      '\t\t\tif (["openai", "openrouter", "deepseek", "anthropic", "google", "google-vertex", "qwen-token-plan", "qwen-token-plan-cn", "zai", "zai-coding-cn", "moonshotai", "moonshotai-cn", "minimax", "minimax-cn"].includes(route)) return true;',
      '\t\t\tif (["openai", "openrouter", "deepseek", "anthropic", "google", "google-vertex", "qwen-token-plan", "qwen-token-plan-cn", "zai", "zai-coding-cn", "moonshotai", "moonshotai-cn", "minimax", "minimax-cn"].includes(route)) return true;\n\t\t\t' + protocolProbe,
      file,
    )
    writeFileSync(file, source)
    return true
  }
  source = replaceOnce(source, '\t\tfunction ModelListEditor(props) {', `${uiHelpers}\n\t\t/** ${REASONING_PATCH_MARKER}: settings editor */\n\t\tfunction ModelListEditor(props) {`, file)
  source = replaceOnce(source,
    '\t\t\t\t\t\t\t})]\n\t\t\t\t\t\t}) : null]',
    '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(DesktopReasoningEditor, { model, index, disabled, patch, t, api: probe.api, automatic: reasoningCatalog.get(textOf(model, "id")) })]\n\t\t\t\t\t\t}) : null]',
    file,
  )
  source = replaceOnce(source,
    '\t\t\tconst [editing, setEditing] = (0, react.useState)(/* @__PURE__ */ new Map());',
    '\t\t\tconst [editing, setEditing] = (0, react.useState)(/* @__PURE__ */ new Map());\n\t\t\tconst [reasoningCatalog, setReasoningCatalog] = (0, react.useState)(/* @__PURE__ */ new Map());\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (!desktopKnownReasoningProbe(probe)) { setReasoningCatalog(/* @__PURE__ */ new Map()); return; }\n\t\t\t\tlet active = true;\n\t\t\t\tapi.llm.discoverModels({ settingsNs: probe.settingsNs, ...probe.provider === void 0 ? {} : { provider: probe.provider }, ...probe.baseURL === void 0 ? {} : { baseURL: probe.baseURL }, ...probe.api === void 0 ? {} : { api: probe.api } }).then((response) => { if (active && response.result.ok) setReasoningCatalog(new Map(response.result.value.models.filter((candidate) => candidate.reasoning !== void 0).map((candidate) => [candidate.id, candidate.reasoning]))); }).catch(() => {});\n\t\t\t\treturn () => { active = false; };\n\t\t\t}, [api, probe.settingsNs, probe.provider, probe.baseURL, probe.api]);',
    file,
  )
  const cssNeedle = '.zGbnIq_modelFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}'
  const cssExtra = '.zGbnIq_modelFieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.zGbnIq_reasoningPanel{grid-column:1/-1;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-width:0;margin:2px 0 0;padding:10px}.zGbnIq_reasoningMode{background:var(--dsw-alias-bg-layer-1);border-radius:7px;width:fit-content;padding:2px;display:flex}.zGbnIq_reasoningModeButton{height:26px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:transparent;border:0;border-radius:6px;padding:0 10px;font-size:12px}.zGbnIq_reasoningModeButtonActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}.zGbnIq_reasoningHint{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:18px}.zGbnIq_reasoningEfforts{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin-top:8px;display:grid}.zGbnIq_reasoningEffort{grid-template-columns:72px minmax(0,1fr);align-items:center;gap:6px;display:grid}.zGbnIq_reasoningEffort:has(input[type=number]){grid-template-columns:72px minmax(0,1fr) minmax(0,1fr)}.zGbnIq_reasoningCheck{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;display:flex}'
  source = replaceOnce(source, cssNeedle, cssExtra, file)
  source = replaceOnce(source, '\t\t\t"modelFieldLabel": "zGbnIq_modelFieldLabel",', '\t\t\t"modelFieldLabel": "zGbnIq_modelFieldLabel",\n\t\t\t"reasoningPanel": "zGbnIq_reasoningPanel",\n\t\t\t"reasoningMode": "zGbnIq_reasoningMode",\n\t\t\t"reasoningModeButton": "zGbnIq_reasoningModeButton",\n\t\t\t"reasoningModeButtonActive": "zGbnIq_reasoningModeButtonActive",\n\t\t\t"reasoningHint": "zGbnIq_reasoningHint",\n\t\t\t"reasoningEfforts": "zGbnIq_reasoningEfforts",\n\t\t\t"reasoningEffort": "zGbnIq_reasoningEffort",\n\t\t\t"reasoningCheck": "zGbnIq_reasoningCheck",', file)
  source = replaceOnce(source, '\t\t\tmodelAdvanced: "Capacities",', '\t\t\tmodelAdvanced: "Model capabilities",\n\t\t\tmodelReasoning: "Reasoning capability",\n\t\t\treasoningAuto: "Use automatic",\n\t\t\treasoningCustom: "Custom",\n\t\t\treasoningAutoHint: "Automatically resolved from the installed pi-ai catalog, provider and Base URL. Unknown models keep the provider default.",\n\t\t\treasoningAutoResolved: "Automatically resolved: {efforts} {mandatory}",\n\t\t\treasoningMandatory: "(always on)",\n\t\t\treasoningFormat: "Parameter format",\n\t\t\treasoningFormatAuto: "Auto",\n\t\t\treasoningWireValue: "Wire value",\n\t\t\treasoningBudget: "Token budget",\n\t\t\treasoningDetected: "Reasoning",', file)
  source = replaceOnce(source, '\t\t\tmodelAdvanced: "容量",', '\t\t\tmodelAdvanced: "模型能力",\n\t\t\tmodelReasoning: "思考能力",\n\t\t\treasoningAuto: "使用自动配置",\n\t\t\treasoningCustom: "自定义",\n\t\t\treasoningAutoHint: "根据已安装的 pi-ai catalog、Provider 和 Base URL 自动解析；未知模型保留提供方默认。",\n\t\t\treasoningAutoResolved: "自动识别：{efforts} {mandatory}",\n\t\t\treasoningMandatory: "（强制开启）",\n\t\t\treasoningFormat: "参数格式",\n\t\t\treasoningFormatAuto: "Auto",\n\t\t\treasoningWireValue: "实际发送值",\n\t\t\treasoningBudget: "Token 预算",\n\t\t\treasoningDetected: "已识别思考",', file)
  source = replaceRegexOnce(source,
    /(\t+children: candidate\.id\r?\n)(\t+)\}\)\]/,
    '$1$2}), candidate.reasoning === void 0 ? null : (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["rowTag"], title: candidate.reasoning.efforts?.join(", "), children: t("reasoningDetected") })]',
    file,
  )
  writeFileSync(file, source)
  return true
}

export function applyDshModelReasoningPatch(dshModulesDir) {
  const adapter = packageVersion(dshModulesDir, '@deepseek-ai', 'dsh-llm-pi-ai')
  const ui = packageVersion(dshModulesDir, '@deepseek-ai', 'dsh-client-ui-settings-models')
  const pi = packageVersion(dshModulesDir, '@earendil-works', 'pi-ai')
  assertVersion(adapter.version, SUPPORTED_DSH_VERSIONS, adapter.file)
  assertVersion(ui.version, SUPPORTED_DSH_VERSIONS, ui.file)
  assertVersion(pi.version, SUPPORTED_PI_AI_VERSIONS, pi.file)
  return {
    adapter: patchAdapter(join(dshModulesDir, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')),
    ui: patchUi(join(dshModulesDir, '@deepseek-ai', 'dsh-client-ui-settings-models', 'lib', 'client.js')),
    piAi: patchPiAi(join(dshModulesDir, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js')),
  }
}
