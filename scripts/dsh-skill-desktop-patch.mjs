import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PATCH_MARKER = 'dsh-desktop skill provider isolation'
const CONTRACT_MARKER = 'dsh-desktop skill provider contract quarantine'

function replaceOnce(source, needle, replacement, file) {
  if (!source.includes(needle)) {
    throw new Error(`dsh-skill desktop patch no longer matches ${file}; update the patch for the bundled DSH version`)
  }
  return source.replace(needle, replacement)
}

/**
 * Keep a malformed third-party Skill Provider from failing an entire agent
 * turn. The upstream registry already contains provider.list() exceptions,
 * but candidate normalization and validation currently escape that boundary.
 *
 * This patch is deliberately version-asserted and idempotent. It is applied
 * to the acquired runtime, never to a user's installed third-party package.
 */
export function applyDshSkillDesktopPatch(dshModulesDir) {
  const file = join(dshModulesDir, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js')
  if (!existsSync(file)) throw new Error(`dsh-skill desktop patch missing ${file}`)

  let source = readFileSync(file, 'utf8')
  if (!source.includes(PATCH_MARKER)) source = replaceOnce(
    source,
    '\tcollectCache = /* @__PURE__ */ new Map();\n\trevision = 0;',
    `\tcollectCache = /* @__PURE__ */ new Map();
\t/** ${PATCH_MARKER}: deterministic provider contract failures stay isolated. */
\tproviderFailures = /* @__PURE__ */ new Map();
\trevision = 0;`,
    file,
  )

  if (!source.includes('this.providerFailures.delete(provider);\n\t\t\t\t\tthis.invalidateCache();')) source = replaceOnce(
    source,
    `\t\tconst control = {
\t\t\tsignal: lifecycle.signal,
\t\t\tinvalidate: () => {
\t\t\t\tconst active = registration;
\t\t\t\tif (active !== void 0 && active.layer.providers.get(active.name)?.provider === provider) this.invalidateCache();
\t\t\t}
\t\t};`,
    `\t\tconst control = {
\t\t\tsignal: lifecycle.signal,
\t\t\tinvalidate: () => {
\t\t\t\tconst active = registration;
\t\t\t\tif (active !== void 0 && active.layer.providers.get(active.name)?.provider === provider) {
\t\t\t\t\tthis.providerFailures.delete(provider);
\t\t\t\t\tthis.invalidateCache();
\t\t\t\t}
\t\t\t}
\t\t};`,
    file,
  )

  if (!source.includes(CONTRACT_MARKER)) {
    const strictContract = `\t\t\tprovider = create(control);
\t\t\tif (provider === null || typeof provider !== "object") throw new TypeError("skill provider factory returned a non-object provider");
\t\t\tconst name = provider.name;
\t\t\tif (typeof name !== "string" || name.length === 0) throw new TypeError("skill provider requires a non-empty string name");
\t\t\tif (typeof provider.list !== "function") throw new TypeError(\`skill provider "${'${name}'}" requires a list function\`);
\t\t\tif (typeof provider.get !== "function") throw new TypeError(\`skill provider "${'${name}'}" requires a get function\`);
\t\t\tif (name === RUNTIME_PROVIDER) throw new Error(\`"${'${RUNTIME_PROVIDER}'}" is reserved for runtime skill registrations\`);`
  const originalContract = `\t\t\tprovider = create(control);
\t\t\tconst name = provider.name;
\t\t\tif (name === RUNTIME_PROVIDER) throw new Error(\`"${'${RUNTIME_PROVIDER}'}" is reserved for runtime skill registrations\`);`
  const contractNeedle = source.includes(strictContract) ? strictContract : originalContract
    source = replaceOnce(
      source,
      contractNeedle,
      `\t\t\tprovider = create(control);
\t\t\tconst contractError = provider === null || typeof provider !== "object"
\t\t\t\t? new TypeError("skill provider factory returned a non-object provider")
\t\t\t\t: typeof provider.name !== "string" || provider.name.length === 0
\t\t\t\t\t? new TypeError("skill provider requires a non-empty string name")
\t\t\t\t\t: typeof provider.list !== "function"
\t\t\t\t\t\t? new TypeError(\`skill provider "${'${provider.name}'}" requires a list function\`)
\t\t\t\t\t\t: typeof provider.get !== "function"
\t\t\t\t\t\t\t? new TypeError(\`skill provider "${'${provider.name}'}" requires a get function\`)
\t\t\t\t\t\t\t: null;
\t\t\tif (contractError !== null) {
\t\t\t\t/** ${CONTRACT_MARKER}: report malformed providers without failing plugin apply. */
\t\t\t\tconst identity = provider !== null && typeof provider === "object" ? provider : {};
\t\t\t\tconst failure = this.recordProviderFailure(identity, contractError, void 0, "skill-provider-invalid-contract");
\t\t\t\tthis.ctx.logger.warn(\`skill provider quarantined: ${'${failure.message}'}\`);
\t\t\t\treturn () => {
\t\t\t\t\tthis.providerFailures.delete(identity);
\t\t\t\t\tthis.invalidateCache();
\t\t\t\t\tlifecycle.abort(contractError);
\t\t\t\t};
\t\t\t}
\t\t\tconst name = provider.name;
\t\t\tif (name === RUNTIME_PROVIDER) throw new Error(\`"${'${RUNTIME_PROVIDER}'}" is reserved for runtime skill registrations\`);`,
      file,
    )
  }

  if (!source.includes('this.providerFailures.delete(provider);\n\t\t\t\t\tundo();')) source = replaceOnce(
    source,
    `\t\t\t\treturn () => {
\t\t\t\t\tregistration = void 0;
\t\t\t\t\tundo();
\t\t\t\t\tlifecycle.abort(/* @__PURE__ */ new Error(\`skill provider "${'${name}'}" disposed\`));
\t\t\t\t};`,
    `\t\t\t\treturn () => {
\t\t\t\t\tregistration = void 0;
\t\t\t\t\tthis.providerFailures.delete(provider);
\t\t\t\t\tundo();
\t\t\t\t\tlifecycle.abort(/* @__PURE__ */ new Error(\`skill provider "${'${name}'}" disposed\`));
\t\t\t\t};`,
    file,
  )

  if (!source.includes('failures: this.diagnostics()')) source = replaceOnce(
    source,
    `\tasync snapshot(options = {}) {
\t\tconst collected = await this.collect(options);
\t\treturn {
\t\t\tskills: [...collected.entries.values()].map((entry) => toSummary(entry.candidate)).sort(compareSkillSummary),
\t\t\tcomplete: collected.cacheable
\t\t};
\t}`,
    `\tasync snapshot(options = {}) {
\t\tconst collected = await this.collect(options);
\t\treturn {
\t\t\tskills: [...collected.entries.values()].map((entry) => toSummary(entry.candidate)).sort(compareSkillSummary),
\t\t\tcomplete: collected.cacheable && this.providerFailures.size === 0,
\t\t\tfailures: this.diagnostics()
\t\t};
\t}
\t/** Structured, non-throwing diagnostics consumed by Desktop's plugin market. */
\tdiagnostics() {
\t\treturn [...this.providerFailures.values()].map((failure) => ({ ...failure }));
\t}
\trecordProviderFailure(provider, error, skill, code) {
\t\tconst failure = {
\t\t\tcode,
\t\t\tprovider: typeof provider.name === "string" ? provider.name : null,
\t\t\tskill: typeof skill === "string" ? skill : null,
\t\t\tmessage: errorMessage(error),
\t\t\tat: (/* @__PURE__ */ new Date()).toISOString()
\t\t};
\t\tthis.providerFailures.set(provider, failure);
\t\treturn failure;
\t}`,
    file,
  )

  if (!source.includes('"skill-provider-invalid-candidate"')) source = replaceOnce(
    source,
    `\t\tfor (const { provider, order } of [...layer.providers.values()]) {
\t\t\tlet localOrder = 0;
\t\t\tlet output;
\t\t\ttry {
\t\t\t\toutput = await waitWithAbort(provider.list(options), options.signal);
\t\t\t} catch (error) {
\t\t\t\tif (options.signal?.aborted === true) throw toError(options.signal.reason);
\t\t\t\tcacheable = false;
\t\t\t\tthis.ctx.logger.warn(\`skill provider "${'${provider.name}'}" skipped: ${'${errorMessage(error)}'}\`);
\t\t\t}
\t\t\tif (output === void 0) continue;
\t\t\tconst observation = normalizeProviderObservation(output, provider.name);
\t\t\tif (!observation.complete) cacheable = false;
\t\t\tfor (const candidate of observation.candidates) {
\t\t\t\tvalidateCandidate(candidate, provider.name);
\t\t\t\tcandidates.push({
\t\t\t\t\tcandidate,
\t\t\t\t\tprovider,
\t\t\t\t\tproviderOrder: order,
\t\t\t\t\tlocalOrder,
\t\t\t\t\tlayer
\t\t\t\t});
\t\t\t\tlocalOrder += 1;
\t\t\t}
\t\t}`,
    `\t\tfor (const { provider, order } of [...layer.providers.values()]) {
\t\t\tif (this.providerFailures.has(provider)) continue;
\t\t\tlet output;
\t\t\ttry {
\t\t\t\toutput = await waitWithAbort(provider.list(options), options.signal);
\t\t\t} catch (error) {
\t\t\t\tif (options.signal?.aborted === true) throw toError(options.signal.reason);
\t\t\t\tcacheable = false;
\t\t\t\tthis.ctx.logger.warn(\`skill provider "${'${provider.name}'}" skipped: ${'${errorMessage(error)}'}\`);
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (output === void 0) continue;
\t\t\tlet observation;
\t\t\tconst staged = [];
\t\t\ttry {
\t\t\t\tobservation = normalizeProviderObservation(output, provider.name);
\t\t\t\tlet localOrder = 0;
\t\t\t\tfor (const candidate of observation.candidates) {
\t\t\t\t\tvalidateCandidate(candidate, provider.name);
\t\t\t\t\tstaged.push({ candidate, provider, providerOrder: order, localOrder, layer });
\t\t\t\t\tlocalOrder += 1;
\t\t\t\t}
\t\t\t} catch (error) {
\t\t\t\tconst candidate = observation?.candidates?.find((item) => {
\t\t\t\t\ttry { validateCandidate(item, provider.name); return false; } catch { return true; }
\t\t\t\t});
\t\t\t\tconst failure = this.recordProviderFailure(provider, error, candidate?.name, "skill-provider-invalid-candidate");
\t\t\t\tthis.ctx.logger.warn(\`skill provider "${'${provider.name}'}" quarantined: ${'${failure.message}'}\`);
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (!observation.complete) cacheable = false;
\t\t\tcandidates.push(...staged);
\t\t}`,
    file,
  )

  writeFileSync(file, source)
}
