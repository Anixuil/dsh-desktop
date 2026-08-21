// dsh-desktop-bridge — sidebar footer badge: balance/usage trigger + panel host.
const react = require('react');
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { BalancePanel } = require('./balance-panel.js');
const { fmtQuantity } = require('./helpers.js');

const noopSub = () => () => {};
const SELECTED_PROVIDER_KEY = "dsh-desktop:selected-balance-provider";

/** Move the footer-stack marker when React mounts, replaces, or removes us. */
function footerContainer(node) {
  const slotAnchor = node?.closest?.('[data-slot="sidebar.footer.action"]');
  return slotAnchor?.parentElement ?? node?.parentElement ?? null;
}

function setFooterStack(previousNode, node) {
  const previousFooter = footerContainer(previousNode);
  if (previousFooter) previousFooter.classList.remove("dbb_footerStack");
  const footer = footerContainer(node);
  if (footer) footer.classList.add("dbb_footerStack");
  return node;
}

/** The active platform entry for an explicit card selection or model selection. */
function activeProvider(providers, selection, selectedProviderId) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  if (selectedProviderId) {
    const selected = providers.find((p) => p.id === selectedProviderId);
    if (selected) return selected;
  }
  if (selection?.provider) {
    const match = providers.find((p) => p.id === selection.provider);
    if (match) return match;
  }
  return providers.find((p) => p.id === "deepseek-official") ?? providers[0];
}

/** Card amount text for one provider entry, or null when unavailable. */
function providerAmount(provider) {
  if (!provider || !provider.configured) return null;
  const primaryPlan = Array.isArray(provider.plans) ? provider.plans[0] : null;
  if (Number.isFinite(primaryPlan?.remaining)) {
    return `${fmtQuantity(primaryPlan.remaining)} ${primaryPlan.unit ?? ""}`.trim();
  }
  if (provider.plans_error) return null;
  if (provider.kind === "balance") {
    const info = provider.balance?.balance_infos?.[0];
    if (info && provider.balance?.is_available !== false) {
      return `${info.total_balance} ${info.currency ?? ""}`.trim();
    }
    return null;
  }
  if (provider.kind === "usage") {
    const remaining = provider.usage?.remaining;
    const unit = provider.usage?.unit ?? "USD";
    if (Number.isFinite(remaining)) return `${remaining.toFixed(2)} ${unit}`;
    const u = provider.usage?.total_usage_usd;
    if (Number.isFinite(u)) return `$${u.toFixed(2)}`;
    return null;
  }
  return null;
}

function BalanceBadge(props) {
  const { wide, t, sessions, modelDirectories } = props;
  const [balance, setBalance] = react.useState(null);
  const [error, setError] = react.useState(false);
  const [open, setOpen] = react.useState(false);
  const footerItemRef = react.useRef(null);
  const bindFooterItem = react.useCallback((node) => {
    footerItemRef.current = setFooterStack(footerItemRef.current, node);
  }, []);
  const [selectedProviderId, setSelectedProviderId] = react.useState(() => {
    try {
      return window.localStorage?.getItem(SELECTED_PROVIDER_KEY) ?? null;
    } catch {
      return null;
    }
  });

  // The upstream footer slot is a horizontal flex row. Mark the actual slot
  // node as soon as React commits this item so every other plugin action stacks
  // above the full-width balance card. The renderer's stable data-slot anchor
  // is display:contents, so setFooterStack steps through it to the real flex
  // container. This stays independent from upstream CSS-module hashes and
  // :has() support in the host WebView.

  react.useEffect(() => {
    try {
      if (selectedProviderId) {
        window.localStorage?.setItem(SELECTED_PROVIDER_KEY, selectedProviderId);
      } else {
        window.localStorage?.removeItem(SELECTED_PROVIDER_KEY);
      }
    } catch { /* selection persistence is best-effort */ }
  }, [selectedProviderId]);

  const loadBalance = react.useCallback(async (signal) => {
    try {
      const resp = await fetch("/desktop/balance", { signal });
      if (!resp.ok) throw new Error("http " + resp.status);
      const data = await resp.json();
      if (data?.ok !== true) throw new Error(data?.error ?? "shell error");
      setBalance(data);
      setError(false);
      return data;
    } catch (e) {
      if (e?.name === "AbortError") return null;
      setError(true);
      return null;
    }
  }, []);

  // Dynamic cadence: 5s while a turn is running or right after it ends,
  // 5s during startup / while no platform has healthy data yet, and the
  // normal 60s idle cadence otherwise. This makes the card populate as
  // soon as the shell is ready instead of waiting a full minute.
  react.useEffect(() => {
    let alive = true;
    let timer = null;
    let prevRunning = false;
    const schedule = (delay) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, delay);
    };
    const tick = async () => {
      if (!alive) return;
      let running = false;
      try {
        const resp = await fetch("/desktop/status", { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const status = await resp.json();
          running = status?.running === true;
        }
      } catch { /* status probe is best-effort */ }
      const data = await loadBalance(undefined);
      if (!alive) return;
      const providers = data?.providers;
      const healthy = Array.isArray(providers)
        && providers.some((p) => p.configured && !p.error);
      if (running) {
        schedule(5000);
      } else if (prevRunning) {
        schedule(5000);
      } else if (!healthy) {
        schedule(5000);
      } else {
        schedule(60000);
      }
      prevRunning = running;
    };
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [loadBalance]);

  // follow the current session's model selection so the card tracks the
  // platform in use (DeepSeek model → balance; gateway model → usage)
  const sessionsSnap = react.useSyncExternalStore(
    (fn) => (sessions?.list?.subscribe ?? noopSub)(fn),
    () => sessions?.list?.getSnapshot?.() ?? null,
  );
  const sessionId = sessionsSnap?.current ?? null;
  const [directory, setDirectory] = react.useState(null);
  react.useEffect(() => {
    if (!sessionId) { setDirectory(null); return; }
    let dir = null;
    try { dir = modelDirectories?.directoryFor?.(sessionId) ?? null; } catch { dir = null; }
    setDirectory(dir);
  }, [sessionId, modelDirectories]);
  const dirSnap = react.useSyncExternalStore(
    (fn) => (directory?.subscribe ?? noopSub)(fn),
    () => directory?.getSnapshot?.() ?? null,
  );
  const selection = dirSnap?.current ?? null;

  const providers = balance?.providers ?? null;
  const active = activeProvider(providers, selection, selectedProviderId);
  const amount = providers === null
    // legacy shell without multi-provider payload
    ? (() => {
      const info = balance?.balance?.balance_infos?.[0];
      if (!balance || !info || !balance.configured) return null;
      if (balance.balance.is_available !== false) return `${info.total_balance} ${info.currency ?? ""}`.trim();
      return null;
    })()
    : providerAmount(active);
  const low = balance?.low === true && (active === null || active.kind === "balance");
  const off = providers === null
    ? (!balance || balance.configured === false)
    : !providers.some((p) => p.configured);
  const amountLabel = (Array.isArray(active?.plans) && active.plans.length > 0) || active?.plans_error
    ? t("badge.plan")
    : active !== null && active.kind === "usage" ? t("badge.usage") : t("badge");

  return jsxs("div", {
    ref: bindFooterItem,
    className: "dbb_footerItem" + (wide ? "" : " dbb_footerRail"),
    children: [
    jsx(primitives.Tooltip, {
      label: error ? t("badge.offline") : amount !== null ? `${amountLabel}: ${amount}` : off ? t("badge.unconfigured") : amountLabel,
      delayMs: 500,
      disabled: wide,
      children: jsx("button", {
        type: "button",
        className: "dbb_trigger" + (wide ? "" : " dbb_rail"),
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => { setOpen((v) => !v); },
        children: wide
          ? [
            jsx("span", { className: "dbb_avatar", children: jsx(primitives.FishLogo, { size: 14 }) }),
            jsx("span", { className: "dbb_label", children: amountLabel }),
            jsx("span", {
              className: "dbb_amount" + (low ? " dbb_low" : "") + (off ? " dbb_off" : "") + (error ? " dbb_err" : ""),
              children: error ? "—" : amount !== null ? amount : off ? t("badge.unconfigured") : "—",
            })
          ]
          : [
            jsx("span", { className: "dbb_icon", children: jsx(primitives.FishLogo, { size: 18 }) })
          ]
      })
    }),
    open && jsx(BalancePanel, {
      t,
      balance,
      error,
      loadBalance,
      selectedProviderId: active?.id ?? null,
      onSelectProvider: setSelectedProviderId,
      onClose: () => { setOpen(false); },
    })
    ]
  });
}

module.exports = { noopSub, setFooterStack, activeProvider, providerAmount, BalanceBadge };
