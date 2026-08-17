// dsh-desktop-bridge — web client module entry.
//
// Registered into the sidebar footer (list slot, order 100): the account /
// usage badge and its panel. Also registers the 关于 (About) page into the
// in-app settings modal (`settings.section`, id "about", order 30 — last in
// the nav rail). Implementation lives in the modules under src/: styles
// (load-time stylesheet), helpers (formatting + cost estimate), locales
// (desktop-balance dictionaries), balance-badge (footer trigger),
// balance-panel (panel host + pure view), about-section (shell identity +
// check-update page).
require('./styles.js');
const { BalanceBadge } = require('./balance-badge.js');
const { BalancePanelView } = require('./balance-panel.js');
const { AboutSection, AboutSectionView } = require('./about-section.js');
const { zh, en, NS } = require('./locales.js');

/** Services required from the client root context. */
const inject = ["slots", "locale"];

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-desktop-bridge: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "desktop-balance",
    order: 100,
    locale: NS,
    inject: () => ({
      t,
      // follow the current session's model selection so the card shows
      // the platform actually in use (resolved lazily, both optional)
      sessions: ctx.get?.("sessions") ?? null,
      modelDirectories: ctx.get?.("modelDirectories") ?? null,
    })
  }, BalanceBadge));
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
exports.views = { BalancePanelView, AboutSectionView };
