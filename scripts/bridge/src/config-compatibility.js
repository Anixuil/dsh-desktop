const { showMessage } = require('./message.js');

const PROMPT_KEY = 'dsh-desktop.config-compatibility.prompted';

function storageCall(action, fallback) {
  try {
    return action(window.sessionStorage);
  } catch {
    return fallback;
  }
}

async function getJson(path, init) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${String(response.status)}`);
  }
  return payload;
}

function registerConfigCompatibilityPrompt(ctx, t) {
  return ctx.effect(() => {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return;
    let cancelled = false;
    const run = async () => {
      try {
        const health = await getJson('/desktop/config-health');
        if (cancelled || health?.compatible !== false) return;
        if (storageCall((storage) => storage?.getItem(PROMPT_KEY), null) === '1') return;
        storageCall((storage) => storage?.setItem(PROMPT_KEY, '1'));
        const accepted = window.confirm(t('configCompatibility.prompt', {
          reason: health?.reason ?? t('configCompatibility.unknownReason'),
        }));
        if (!accepted) {
          showMessage(t('configCompatibility.deferred'));
          return;
        }
        const result = await getJson('/desktop/config-replace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        });
        if (!cancelled) {
          showMessage(t('configCompatibility.replaced', {
            backup: result?.backupFile ?? 'config.incompatible.json',
          }));
        }
      } catch (error) {
        if (!cancelled) {
          storageCall((storage) => storage?.removeItem(PROMPT_KEY));
          showMessage(t('configCompatibility.failed', {
            error: String(error?.message ?? error),
          }));
        }
      }
    };
    run();
    return () => { cancelled = true; };
  }, 'dsh-desktop-bridge: config compatibility prompt');
}

module.exports = { PROMPT_KEY, registerConfigCompatibilityPrompt, storageCall };
