// dsh-desktop-bridge — web client module entry.
//
// Registered into the sidebar footer (list slot, order 100): the account /
// usage badge and its panel. Also registers the 外观与动效 (appearance) and
// 关于 (About) pages into the in-app settings modal (`settings.section`).
// Implementation lives in the modules under src/: styles (load-time
// stylesheet), helpers (formatting + cost estimate), locales
// (desktop-balance dictionaries), balance-badge (footer trigger),
// balance-panel (panel host + pure view), appearance-section (motion
// intensity picker), about-section (shell identity + check-update page), and
// remote-section (relay-client configuration).
require('./styles.js');
const { BalanceBadge } = require('./balance-badge.js');
const { BalancePanelView } = require('./balance-panel.js');
const { AboutSection, AboutSectionView } = require('./about-section.js');
const { AppearanceSection, AppearanceSectionView } = require('./appearance-section.js');
const { RemoteSection, RemoteSectionView } = require('./remote-section.js');
const { zh, en, NS } = require('./locales.js');

/** Services required from the client root context. */
const inject = ["slots", "locale", "sessions"];

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-desktop-bridge: dictionaries");
  const t = ctx.locale.bind(NS);

  // Publish the currently focused session to the host bridge (POST
  // /desktop/current-session) so the wave-state classifier tracks THIS
  // conversation's activity instead of every background conversation's.
  ctx.effect(() => {
    const list = ctx.sessions?.list;
    if (list === undefined || typeof list.subscribe !== "function") return;
    const publish = () => {
      if (typeof fetch !== "function") return;
      let sessionId = null;
      try {
        sessionId = list.getSnapshot?.()?.current ?? null;
      } catch {
        /* sessions list not ready — stay focused on none */
      }
      fetch("/desktop/current-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    };
    const unsubscribe = list.subscribe(publish);
    publish();
    return unsubscribe;
  }, "dsh-desktop-bridge: focus publisher");

  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "desktop-balance",
    order: 100,
    locale: NS,
    inject: () => ({
      t,
      // follow the current session's model selection so the card shows
      // the platform actually in use (modelDirectories stays lazily optional)
      sessions: ctx.sessions ?? null,
      modelDirectories: ctx.get?.("modelDirectories") ?? null,
    })
  }, BalanceBadge));
  // 远程访问 (Remote access) page in the in-app settings modal: relay-client
  // configuration (enabled switch, relay url, secret, device id) plus live
  // status and the phone entry URL.
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "remote-access",
    order: 10,
    label: () => t("remote.nav"),
    inject: () => ({ t }),
  }, RemoteSection));
  // 外观与动效 (Appearance & motion) page in the in-app settings modal:
  // two-way motion-intensity picker persisted by the shell.
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "appearance",
    order: 5,
    label: () => t("appearance.nav"),
    inject: () => ({ t }),
  }, AppearanceSection));
  // 关于 (About) page in the in-app settings modal: shell identity, blog /
  // repo links into the default browser, and a shell+dsh check-update action.
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "about",
    order: 30,
    label: () => t("about.nav"),
    inject: () => ({ t }),
  }, AboutSection));
}

exports.apply = apply;
exports.inject = inject;
// Pure view + helpers re-exported for fixture-driven tests and future
// in-browser consumers (the pre-split bundle exposed nothing but apply).
exports.views = { BalancePanelView, AboutSectionView, AppearanceSectionView, RemoteSectionView };
exports.qr = require('./qr.js');