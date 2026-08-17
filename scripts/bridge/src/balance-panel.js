// dsh-desktop-bridge — balance/usage panel.
//
// Split into a stateful wrapper (BalancePanel: usage loading, Escape /
// outside-click dismissal, refresh) and a pure view (BalancePanelView) that
// renders whatever data the wrapper holds. The view is exported for
// fixture-driven tests; every render branch below is a verbatim move from the
// pre-split bundle.
const react = require('react');
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { fmtTokens, fmtMoney, fmtUsd, fmtDate, estimateCost } = require('./helpers.js');

/** Pure render layer: props in, panel markup out (no fetch, no effects). */
function BalancePanelView(props) {
  const { t, balance, error, usage, usageError, refreshing, onRefresh, onClose, panelRef } = props;

  const providers = balance?.providers ?? null;
  const legacyInfo = balance?.balance?.balance_infos?.[0];
  const legacyTotal = legacyInfo?.total_balance ?? null;
  const legacyCurrency = legacyInfo?.currency ?? "";
  const legacyBadge = !balance || balance.configured === false
    ? jsx("span", { className: "dbb_badge dbb_badgeWarn", children: t("balance.none") })
    : balance.balance?.is_available === false
      ? jsx("span", { className: "dbb_badge dbb_badgeErr", children: t("balance.unavailable") })
      : balance.low === true
        ? jsx("span", { className: "dbb_badge dbb_badgeWarn", children: t("balance.low") })
        : jsx("span", { className: "dbb_badge dbb_badgeOk", children: t("balance.ok") });

  const providerBadge = (p) => {
    if (!p.configured) return jsx("span", { className: "dbb_badge dbb_badgeWarn", children: t("badge.unconfigured") });
    if (p.kind === "unsupported") return jsx("span", { className: "dbb_badge dbb_badgeWarn", children: t("balance.unsupported") });
    if (p.error) return jsx("span", { className: "dbb_badge dbb_badgeErr", children: t("badge.offline") });
    if (p.kind === "balance") {
      if (p.balance?.is_available === false) return jsx("span", { className: "dbb_badge dbb_badgeErr", children: t("balance.unavailable") });
      if (balance?.low === true) return jsx("span", { className: "dbb_badge dbb_badgeWarn", children: t("balance.low") });
      return jsx("span", { className: "dbb_badge dbb_badgeOk", children: t("balance.ok") });
    }
    if (p.usage) return jsx("span", { className: "dbb_badge dbb_badgeOk", children: t("balance.ok") });
    return jsx("span", { className: "dbb_badge dbb_badgeWarn", children: t("balance.none") });
  };

  const providerCard = (p) => {
    const info = p.kind === "balance" ? p.balance?.balance_infos?.[0] : null;
    const usageData = p.kind === "usage" ? p.usage : null;
    const unsupported = p.kind === "unsupported";
    const big = p.kind === "balance"
      ? info?.total_balance ?? "—"
      : Number.isFinite(usageData?.total_usage_usd) ? `$${usageData.total_usage_usd.toFixed(2)}` : "—";
    const cur = p.kind === "balance" ? info?.currency ?? "" : "USD";
    return jsxs("section", { className: "dbb_card", children: [
      jsxs("div", { className: "dbb_providerHead", children: [
        jsx("span", { className: "dbb_providerName", children: p.display_name }),
        providerBadge(p)
      ] }),
      !unsupported && jsxs("div", { className: "dbb_balanceTop", children: [
        jsx("span", { className: "dbb_balanceBig", children: big }),
        cur !== "" && jsx("span", { className: "dbb_currency", children: cur })
      ] }),
      unsupported && jsx("div", { className: "dbb_note", children: t("balance.unsupportedNote") }),
      p.kind === "balance" && info && jsxs("div", { className: "dbb_balanceSub", children: [
        jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("balance.topped"), " ", jsx("b", { children: info.topped_up_balance ?? "—" })] }) }),
        jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("balance.granted"), " ", jsx("b", { children: info.granted_balance ?? "—" })] }) })
      ] }),
      p.kind === "usage" && usageData && jsxs(Fragment, { children: [
        jsxs("div", { className: "dbb_balanceSub", children: [
          jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("usage.softLimit"), " ", jsx("b", { children: fmtUsd(usageData.soft_limit_usd) })] }) }),
          jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("usage.hardLimit"), " ", jsx("b", { children: fmtUsd(usageData.hard_limit_usd) })] }) }),
          jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("usage.payment"), " ", jsx("b", { children: usageData.has_payment_method === true ? t("usage.paymentYes") : usageData.has_payment_method === false ? t("usage.paymentNo") : "—" })] }) })
        ] }),
        jsx("div", { className: "dbb_note", children: t("balance.usageNote") })
      ] }),
      p.error && jsx("div", { className: "dbb_error", children: p.error })
    ] }, p.id);
  };

  const maxDay = usage?.byDay?.reduce((m, d) => Math.max(m, d.total), 0) ?? 0;
  const bars = (usage?.byDay ?? []).map((d, i) => {
    const h = maxDay > 0 ? Math.max(d.total > 0 ? 3 : 1.5, 54 * (d.total / maxDay)) : 1.5;
    return {
      x: i * 26 + 2,
      w: 20,
      h,
      y: 62 - h,
      title: `${d.date} · ${fmtTokens(d.total)} tokens`,
    };
  });
  const topModels = (usage?.byModel ?? []).slice(0, 6);
  const maxModel = topModels.reduce((m, r) => Math.max(m, r.tokens.total), 0);
  const topSessions = (usage?.sessions ?? []).slice(0, 6);

  return jsx("section", {
    ref: panelRef,
    className: "dbb_panel",
    "aria-label": t("panel.title"),
    children: jsxs(Fragment, { children: [
      jsxs("header", { className: "dbb_header", children: [
        jsxs("div", { className: "dbb_titleWrap", children: [
          jsxs("div", { className: "dbb_title", children: [
            jsx("span", { className: "dbb_icon", children: jsx(primitives.FishLogo, { size: 16 }) }),
            t("panel.title")
          ] }),
          jsx("div", { className: "dbb_subtitle", children: balance?.registeredAt
            ? `${t("registeredAt")} ${fmtDate(balance.registeredAt)}`
            : t("registeredAt.none") })
        ] }),
        jsxs("div", { className: "dbb_actions", children: [
          jsx("button", {
            type: "button",
            className: "dbb_iconBtn",
            "aria-label": t("panel.refresh"),
            disabled: refreshing,
            onClick: onRefresh,
            children: jsx(primitives.IconRefreshOutline14, { size: 14, className: refreshing ? "dbb_spin" : void 0 })
          }),
          jsx("button", {
            type: "button",
            className: "dbb_iconBtn",
            "aria-label": t("panel.close"),
            onClick: onClose,
            children: jsx(primitives.IconCloseOutline16, { size: 14 })
          })
        ] })
      ] }),
      jsxs("div", { className: "dbb_body", children: [
        providers === null
          ? jsxs("section", { className: "dbb_card", children: [
            jsxs("div", { className: "dbb_balanceTop", children: [
              jsx("span", { className: "dbb_balanceBig", children: legacyTotal ?? "—" }),
              legacyCurrency !== "" && jsx("span", { className: "dbb_currency", children: legacyCurrency }),
              legacyBadge
            ] }),
            legacyInfo && jsxs("div", { className: "dbb_balanceSub", children: [
              jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("balance.topped"), " ", jsx("b", { children: legacyInfo.topped_up_balance ?? "—" })] }) }),
              jsx("span", { className: "dbb_kv", children: jsxs(Fragment, { children: [t("balance.granted"), " ", jsx("b", { children: legacyInfo.granted_balance ?? "—" })] }) })
            ] }),
            error && jsx("div", { className: "dbb_error", children: t("badge.offline") })
          ] })
          : providers.map(providerCard),
        jsx("div", { className: "dbb_secTitle", children: t("usage.title") }),
        usageError
          ? jsx("div", { className: "dbb_error", children: t("usage.error") })
          : usage === null
            ? jsx("div", { className: "dbb_empty", children: t("usage.empty") })
            : usage.counts.sessions === 0
              ? jsx("div", { className: "dbb_empty", children: t("usage.empty") })
              : jsxs(Fragment, { children: [
                jsxs("div", { className: "dbb_grid", children: [
                  jsxs("div", { className: "dbb_stat", children: [
                    jsx("span", { className: "dbb_statLabel", children: t("usage.total") }),
                    jsx("span", { className: "dbb_statValue", children: fmtTokens(usage.totals.total) })
                  ] }),
                  jsxs("div", { className: "dbb_stat", children: [
                    jsx("span", { className: "dbb_statLabel", children: t("usage.input") }),
                    jsx("span", { className: "dbb_statValue", children: fmtTokens(usage.totals.input) })
                  ] }),
                  jsxs("div", { className: "dbb_stat", children: [
                    jsx("span", { className: "dbb_statLabel", children: t("usage.cacheRead") }),
                    jsx("span", { className: "dbb_statValue", children: fmtTokens(usage.totals.cacheRead) })
                  ] }),
                  jsxs("div", { className: "dbb_stat", children: [
                    jsx("span", { className: "dbb_statLabel", children: t("usage.output") }),
                    jsx("span", { className: "dbb_statValue", children: fmtTokens(usage.totals.output) })
                  ] })
                ] }),
                jsxs("div", { className: "dbb_card", children: [
                  jsxs("div", { className: "dbb_row", children: [
                    jsx("span", { className: "dbb_rowLabel", children: t("usage.cost") }),
                    jsx("span", { className: "dbb_rowValue", children: fmtMoney(estimateCost(usage)) })
                  ] }),
                  jsxs("div", { className: "dbb_row", children: [
                    jsx("span", { className: "dbb_rowLabel", children: t("usage.sessionsCount", { count: usage.counts.sessions, days: usage.counts.activeDays }) }),
                    jsx("span", { className: "dbb_rowValue", children: usage.fromAllTime ? "—" : "" })
                  ] }),
                  jsx("div", { className: "dbb_note", children: t("usage.costNote") })
                ] }),
                topModels.length > 0 && jsxs(Fragment, { children: [
                  jsx("div", { className: "dbb_secTitle", children: t("usage.models") }),
                  jsxs("div", { children: [
                    topModels.map((row) => jsxs("div", { className: "dbb_modelRow", children: [
                      jsxs("div", { className: "dbb_row", children: [
                        jsx("span", { className: "dbb_rowLabel", children: row.model }),
                        jsx("span", { className: "dbb_rowValue", children: fmtTokens(row.tokens.total) })
                      ] }),
                      jsx("div", { className: "dbb_barTrack", children: jsx("div", {
                        className: "dbb_barFill",
                        style: { width: maxModel > 0 ? `${Math.max(2, 100 * row.tokens.total / maxModel)}%` : "0%" }
                      }) })
                    ] }, row.model))
                  ] })
                ] }),
                jsx("div", { className: "dbb_secTitle", children: t("usage.days") }),
                jsxs("svg", {
                  className: "dbb_chart",
                  viewBox: "0 0 364 66",
                  role: "img",
                  "aria-label": t("usage.days"),
                  children: [
                    bars.map((bar) => jsx("rect", {
                      className: "dbb_bar",
                      x: bar.x,
                      y: bar.y,
                      width: bar.w,
                      height: bar.h,
                      rx: 3,
                      children: jsx("title", { children: bar.title })
                    }, bar.title)),
                    jsx("line", {
                      x1: 0, x2: 364, y1: 62, y2: 62,
                      stroke: "var(--dsw-alias-border-l2)",
                      strokeWidth: 1
                    })
                  ]
                }),
                topSessions.length > 0 && jsxs(Fragment, { children: [
                  jsx("div", { className: "dbb_secTitle", children: t("usage.sessions") }),
                  jsxs("div", { children: [
                    topSessions.map((s) => jsxs("div", { className: "dbb_session", children: [
                      jsxs("div", { className: "dbb_sessionTop", children: [
                        jsx("span", { className: "dbb_sessionTitle", children: s.title || t("session.untitled") }),
                        jsx("span", { className: "dbb_sessionTokens", children: fmtTokens(s.tokens.total) })
                      ] }),
                      jsx("span", { className: "dbb_sessionMeta", children: `${fmtDate(s.createdAt)} · ${s.model ?? t("session.unknown")}${typeof s.turns === "number" ? ` · ${t("turns", { count: s.turns })}` : ""}` })
                    ] }, s.id))
                  ] })
                ] })
              ] })
      ] })
    ] })
  });
}

/** Stateful wrapper: usage loading, dismissal wiring, refresh. */
function BalancePanel(props) {
  const { t, balance, error, loadBalance, onClose } = props;
  const [usage, setUsage] = react.useState(null);
  const [usageError, setUsageError] = react.useState(false);
  const [refreshing, setRefreshing] = react.useState(false);
  const panelRef = react.useRef(null);

  const loadUsage = react.useCallback(async (registeredAt) => {
    try {
      const since = typeof registeredAt === "number" ? registeredAt : 0;
      const resp = await fetch("/desktop/usage" + (since > 0 ? `?since=${since}` : ""));
      if (!resp.ok) throw new Error("http " + resp.status);
      const data = await resp.json();
      if (data?.ok !== true) throw new Error(data?.error ?? "usage error");
      setUsage(data);
      setUsageError(false);
    } catch {
      setUsageError(true);
    }
  }, []);

  react.useEffect(() => {
    loadUsage(balance?.registeredAt);
  }, [loadUsage, balance?.registeredAt]);

  react.useEffect(() => {
    const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);

  react.useEffect(() => {
    const onPointerDown = (e) => {
      // let the trigger's own toggle own clicks on it
      if (e.target instanceof Element && e.target.closest(".dbb_trigger") !== null) return;
      if (panelRef.current !== null && !panelRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); };
  }, [onClose]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const resp = await fetch("/desktop/refresh");
      if (resp.ok) {
        const data = await resp.json();
        if (data?.ok === true && data.configured !== undefined) {
          // also re-read usage against the fresh registration window
          loadUsage(data.registeredAt);
        }
      }
      await loadBalance(undefined);
    } catch { /* keep stale data */ }
    finally { setRefreshing(false); }
  };

  return jsx(BalancePanelView, {
    t,
    balance,
    error,
    usage,
    usageError,
    refreshing,
    onRefresh: refresh,
    onClose,
    panelRef,
  });
}

module.exports = { BalancePanel, BalancePanelView };
