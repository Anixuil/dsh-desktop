const react = require('react');
const { jsx, jsxs } = require('react/jsx-runtime');
const { ensureStyles } = require('./styles.js');
const { showMessage } = require('./message.js');

const PROMPT_MAX_CHARS = 20000;

async function getJson(path, init) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${String(response.status)}`);
  }
  return payload;
}

function ModelBehaviorSectionView(props) {
  const {
    t, loading, loadError, systemPrompt, temperatureEnabled, temperature,
    dirty, busy, notice, onPromptChange, onTemperatureEnabledChange,
    onTemperatureChange, onReset, onSave, onRetry,
  } = props;
  const safeTemperature = Number.isFinite(temperature) ? temperature : 1;

  if (loading) {
    return jsxs('section', { className: 'dbb_modelBehavior', 'aria-label': t('modelBehavior.title'), children: [
      jsx('h2', { className: 'dbb_aboutTitle', children: t('modelBehavior.title') }),
      jsxs('div', { className: 'dbb_modelSkeleton', 'aria-label': t('modelBehavior.loading'), children: [jsx('span', {}), jsx('span', {})] }),
    ] });
  }

  if (loadError !== null) {
    return jsxs('section', { className: 'dbb_modelBehavior', 'aria-label': t('modelBehavior.title'), children: [
      jsx('h2', { className: 'dbb_aboutTitle', children: t('modelBehavior.title') }),
      jsxs('div', { className: 'dbb_modelError', role: 'alert', children: [
        jsx('p', { children: t('modelBehavior.offline') }),
        jsx('button', { type: 'button', className: 'dbb_aboutSecondary', onClick: onRetry, children: t('modelBehavior.retry') }),
      ] }),
    ] });
  }

  return jsxs('section', { className: 'dbb_modelBehavior', 'aria-label': t('modelBehavior.title'), children: [
    jsx('h2', { className: 'dbb_aboutTitle', children: t('modelBehavior.title') }),
    jsx('p', { className: 'dbb_aboutIntro', children: t('modelBehavior.intro') }),
    jsxs('div', { className: 'dbb_aboutCard dbb_modelCard', children: [
      jsxs('div', { className: 'dbb_modelFieldHead', children: [
        jsx('label', { className: 'dbb_modelLabel', htmlFor: 'dbb-system-prompt', children: t('modelBehavior.promptLabel') }),
        jsx('span', { className: 'dbb_modelCount', children: t('modelBehavior.promptCount').replace('{count}', String(systemPrompt.length)).replace('{max}', String(PROMPT_MAX_CHARS)) }),
      ] }),
      jsx('textarea', {
        id: 'dbb-system-prompt',
        className: 'dbb_modelTextarea',
        value: systemPrompt,
        maxLength: PROMPT_MAX_CHARS,
        rows: 7,
        placeholder: t('modelBehavior.promptPlaceholder'),
        disabled: busy,
        onChange: (event) => onPromptChange(event.target.value),
      }),
      jsx('p', { className: 'dbb_note', children: t('modelBehavior.promptHint') }),
    ] }),
    jsxs('div', { className: 'dbb_aboutCard dbb_modelCard', children: [
      jsxs('div', { className: 'dbb_modelTemperatureHead', children: [
        jsxs('div', { children: [
          jsx('span', { className: 'dbb_modelLabel', children: t('modelBehavior.temperatureLabel') }),
          jsx('p', { className: 'dbb_modelSubcopy', children: t('modelBehavior.temperatureHint') }),
        ] }),
        jsxs('label', { className: 'dbb_modelToggle', children: [
          jsx('input', {
            type: 'checkbox', checked: temperatureEnabled, disabled: busy,
            onChange: (event) => onTemperatureEnabledChange(event.target.checked),
          }),
          jsx('span', { children: temperatureEnabled ? t('modelBehavior.custom') : t('modelBehavior.modelDefault') }),
        ] }),
      ] }),
      jsxs('div', { className: 'dbb_modelTemperatureControls', 'aria-disabled': !temperatureEnabled, children: [
        jsx('input', {
          className: 'dbb_modelRange', type: 'range', min: '0', max: '2', step: '0.1',
          value: safeTemperature, disabled: busy || !temperatureEnabled,
          'aria-label': t('modelBehavior.temperatureLabel'),
          onChange: (event) => onTemperatureChange(Number(event.target.value)),
        }),
        jsx('input', {
          className: 'dbb_modelNumber', type: 'number', min: '0', max: '2', step: '0.1',
          value: safeTemperature.toFixed(1), disabled: busy || !temperatureEnabled,
          'aria-label': t('modelBehavior.temperatureValue'),
          onChange: (event) => onTemperatureChange(Number(event.target.value)),
        }),
      ] }),
      jsxs('div', { className: 'dbb_modelScale', 'aria-hidden': 'true', children: [
        jsx('span', { children: t('modelBehavior.precise') }),
        jsx('span', { children: t('modelBehavior.balanced') }),
        jsx('span', { children: t('modelBehavior.creative') }),
      ] }),
      jsx('p', { className: 'dbb_note', children: t('modelBehavior.compatibility') }),
    ] }),
    jsxs('div', { className: 'dbb_modelFooter', children: [
      jsx('p', { className: 'dbb_modelApplyHint', children: t('modelBehavior.applyHint') }),
      jsxs('div', { className: 'dbb_aboutActions', children: [
        jsx('button', { type: 'button', className: 'dbb_aboutSecondary', disabled: busy, onClick: onReset, children: t('modelBehavior.reset') }),
        jsx('button', { type: 'button', className: 'dbb_aboutPrimary', disabled: busy || !dirty, onClick: onSave, children: busy ? t('modelBehavior.saving') : t('modelBehavior.save') }),
      ] }),
    ] }),
    notice?.kind === 'ok' ? jsx('p', { className: 'dbb_aboutStatus', role: 'status', children: notice.text }) : null,
  ] });
}

function ModelBehaviorSection({ t }) {
  const [loading, setLoading] = react.useState(true);
  const [loadError, setLoadError] = react.useState(null);
  const [systemPrompt, setSystemPrompt] = react.useState('');
  const [temperatureEnabled, setTemperatureEnabled] = react.useState(false);
  const [temperature, setTemperature] = react.useState(1);
  const [saved, setSaved] = react.useState({ systemPrompt: '', temperature: undefined });
  const [busy, setBusy] = react.useState(false);
  const [notice, setNotice] = react.useState(null);

  const load = react.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await getJson('/desktop/model-behavior');
      const nextPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : '';
      const nextTemperature = Number.isFinite(payload.temperature) ? payload.temperature : undefined;
      setSystemPrompt(nextPrompt);
      setTemperatureEnabled(nextTemperature !== undefined);
      setTemperature(nextTemperature ?? 1);
      setSaved({ systemPrompt: nextPrompt, temperature: nextTemperature });
    } catch (error) {
      setLoadError(String(error?.message ?? error));
    } finally {
      setLoading(false);
    }
  }, []);

  react.useEffect(() => { ensureStyles(); load(); }, [load]);
  react.useEffect(() => {
    if (loadError !== null) showMessage(`${t('modelBehavior.offline')}（${loadError}）`);
  }, [loadError, t]);
  react.useEffect(() => {
    if (notice?.kind === 'err') showMessage(notice.text);
  }, [notice]);

  const selectedTemperature = temperatureEnabled ? temperature : undefined;
  const dirty = systemPrompt !== saved.systemPrompt || selectedTemperature !== saved.temperature;
  const onTemperatureChange = (next) => {
    if (!Number.isFinite(next)) return;
    setTemperature(Math.min(2, Math.max(0, Math.round(next * 10) / 10)));
  };
  const onReset = () => {
    setSystemPrompt('');
    setTemperatureEnabled(false);
    setTemperature(1);
    setNotice(null);
  };
  const onSave = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = await getJson('/desktop/model-behavior-save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ systemPrompt, ...(temperatureEnabled ? { temperature } : {}) }),
      });
      const nextTemperature = Number.isFinite(payload.temperature) ? payload.temperature : undefined;
      setSaved({ systemPrompt: payload.systemPrompt ?? '', temperature: nextTemperature });
      setSystemPrompt(payload.systemPrompt ?? '');
      setTemperatureEnabled(nextTemperature !== undefined);
      setTemperature(nextTemperature ?? 1);
      setNotice({ kind: 'ok', text: t('modelBehavior.saved') });
    } catch (error) {
      setNotice({ kind: 'err', text: String(error?.message ?? error) });
    } finally {
      setBusy(false);
    }
  };

  return jsx(ModelBehaviorSectionView, {
    t, loading, loadError, systemPrompt, temperatureEnabled, temperature,
    dirty, busy, notice, onPromptChange: setSystemPrompt,
    onTemperatureEnabledChange: setTemperatureEnabled, onTemperatureChange,
    onReset, onSave, onRetry: load,
  });
}

module.exports = { ModelBehaviorSection, ModelBehaviorSectionView };
