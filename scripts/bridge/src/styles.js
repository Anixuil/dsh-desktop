// dsh-desktop-bridge — panel stylesheet (injected once per document).
// Side effect module: index.js requires it first so the styles install when
// the bundle loads, matching the pre-split bundle's load-time behavior.
const css = `
.dbb_footerItem{order:2147483647;box-sizing:border-box;flex:none;min-width:0;width:100%;display:flex;flex-direction:column}
.dbb_footerItem.dbb_footerRail{width:auto;align-items:center}
.dbb_footerStack{flex-direction:column!important;align-items:stretch!important}
.dbb_trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:44px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px 8px;padding:0 10px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dbb_trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dbb_trigger.dbb_rail{background:0 0;border:none;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}
.dbb_avatar{width:24px;height:24px;border-radius:50%;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary);flex:none;justify-content:center;align-items:center;display:flex}
.dbb_icon{color:var(--dsw-alias-state-business-primary);flex:none;display:inline-flex}
.dbb_label{white-space:nowrap;overflow:hidden}
.dbb_amount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}
.dbb_amount.dbb_low{color:var(--dsw-alias-state-warn-label)}
.dbb_amount.dbb_off{color:var(--dsw-alias-label-caption)}
.dbb_amount.dbb_err{color:var(--dsw-alias-state-error-primary)}

.dbb_panel{z-index:40;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:404px;max-width:calc(100vw - 24px);max-height:min(74vh, 680px);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;display:flex;position:fixed;bottom:136px;left:12px;overflow:hidden}
.dbb_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex}
.dbb_titleWrap{flex-direction:column;gap:1px;min-width:0;display:flex}
.dbb_title{align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;display:flex}
.dbb_title .dbb_icon{color:var(--dsw-alias-state-business-primary)}
.dbb_subtitle{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb_actions{align-items:center;gap:2px;display:flex}
.dbb_iconBtn{width:26px;height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dbb_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dbb_iconBtn:disabled{opacity:.45;cursor:default}
.dbb_spin{animation:dbb_spin .9s linear infinite}
@keyframes dbb_spin{to{transform:rotate(360deg)}}
.dbb_body{flex:1;min-height:0;padding:4px 12px 12px;overflow-y:auto}
.dbb_card{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-top:8px;padding:10px 12px}
.dbb_providerCard{box-sizing:border-box;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;display:block}
.dbb_providerCard:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dbb_providerCard:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dbb_providerCard.dbb_selected{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dbb_providerHead{justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;display:flex}
.dbb_providerName{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dbb_secTitle{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;text-transform:uppercase;letter-spacing:.4px;margin:14px 2px 6px}
.dbb_sectionHead{align-items:center;justify-content:space-between;display:flex}
.dbb_sectionHead .dbb_secTitle{margin-bottom:6px}
.dbb_resetBtn{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:0;border-radius:6px;padding:3px 6px;font:inherit;font-size:11px}
.dbb_resetBtn:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dbb_resetBtn:disabled{opacity:.5;cursor:default}
.dbb_confirmScrim{z-index:2;background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px}
.dbb_confirm{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);padding:16px;width:min(300px,100%)}
.dbb_confirmTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}
.dbb_confirmText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:8px 0 14px}
.dbb_confirmActions{display:flex;justify-content:flex-end;gap:8px}
.dbb_confirmCancel,.dbb_confirmDanger{border:0;border-radius:7px;padding:6px 10px;cursor:pointer;font:inherit;font-size:12px}
.dbb_confirmCancel{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dbb_confirmDanger{color:#fff;background:var(--dsw-alias-state-error-primary)}
.dbb_confirmError{margin-top:10px}
.dbb_balanceTop{align-items:baseline;gap:6px;display:flex}
.dbb_balanceBig{color:var(--dsw-alias-label-primary);font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;line-height:32px}
.dbb_currency{color:var(--dsw-alias-label-caption);font-size:13px;font-variant-numeric:tabular-nums}
.dbb_balanceSub{flex-wrap:wrap;gap:4px 14px;margin-top:6px;display:flex}
.dbb_kv{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dbb_kv b{color:var(--dsw-alias-label-secondary);font-weight:500;font-variant-numeric:tabular-nums}
.dbb_planList{border-top:1px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:2px}
.dbb_plan{padding:7px 0}
.dbb_plan+.dbb_plan{border-top:1px solid var(--dsw-alias-border-l2)}
.dbb_planHead{align-items:baseline;gap:10px;display:flex}
.dbb_planName{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb_planRemaining{color:var(--dsw-alias-state-business-primary);font-size:12px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto}
.dbb_planProduct{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb_planMetrics{flex-wrap:wrap;gap:2px 12px;margin-top:3px;display:flex}
.dbb_planMetrics span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.dbb_planMetrics b{color:var(--dsw-alias-label-secondary);font-weight:500;font-variant-numeric:tabular-nums}
.dbb_planMore{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;padding:4px 0 6px}
.dbb_planError{color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px;margin-top:6px;overflow-wrap:anywhere}
.dbb_badge{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px}
.dbb_badgeOk{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary)}
.dbb_badgeWarn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);color:var(--dsw-alias-state-warn-label)}
.dbb_badgeErr{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.dbb_grid{grid-template-columns:1fr 1fr;gap:8px;display:grid}
.dbb_stat{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:2px;padding:8px 10px;display:flex}
.dbb_statLabel{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dbb_statValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;font-variant-numeric:tabular-nums;line-height:20px}
.dbb_row{justify-content:space-between;gap:8px;font-size:12px;line-height:18px;display:flex}
.dbb_row+.dbb_row{margin-top:4px}
.dbb_rowLabel{color:var(--dsw-alias-label-secondary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb_rowValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none}
.dbb_modelRow{flex-direction:column;gap:4px;display:flex}
.dbb_modelRow+.dbb_modelRow{margin-top:8px}
.dbb_barTrack{background:var(--dsw-alias-interactive-bg-hover-solid);border-radius:999px;height:4px;overflow:hidden}
.dbb_barFill{background:var(--dsw-alias-state-business-primary);border-radius:999px;height:100%;transition:width .3s var(--ds-ease-in-out, ease)}
.dbb_chart{width:100%;height:auto;margin-top:4px;display:block}
.dbb_chart rect.dbb_bar{fill:var(--dsw-alias-state-business-primary);opacity:.85}
.dbb_chart rect.dbb_bar:hover{opacity:1}
.dbb_session{flex-direction:column;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:7px 0;display:flex}
.dbb_session:last-child{border-bottom:none}
.dbb_sessionTop{justify-content:space-between;align-items:baseline;gap:8px;display:flex}
.dbb_sessionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb_sessionTokens{color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;flex:none}
.dbb_sessionMeta{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb_empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center;padding:22px 8px}
.dbb_note{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-top:8px}
.dbb_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dbb_folded{margin-top:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);overflow:hidden}
.dbb_foldedSummary{box-sizing:border-box;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:8px 12px;user-select:none}
.dbb_foldedSummary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dbb_foldedItem{box-sizing:border-box;flex-wrap:wrap;align-items:center;gap:6px 10px;border-top:1px solid var(--dsw-alias-border-l2);padding:7px 12px;display:flex}
.dbb_foldedName{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dbb_foldedError{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex-basis:100%}

.dbb_about{max-width:640px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:10px;display:flex}
.dbb_aboutTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.dbb_aboutIntro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.dbb_aboutCard{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:6px;padding:14px 16px;display:flex}
.dbb_aboutHead{align-items:center;gap:12px;margin-bottom:4px;display:flex}
.dbb_aboutLogo{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary);border-radius:10px;justify-content:center;align-items:center;width:40px;height:40px;flex:none;display:flex}
.dbb_aboutTitleWrap{flex-direction:column;min-width:0;display:flex}
.dbb_aboutName{font-size:14px;font-weight:600;line-height:20px}
.dbb_aboutVer{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.dbb_aboutRows{flex-direction:column;display:flex}
.dbb_aboutLink{color:var(--dsw-alias-state-business-primary);font:inherit;cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:18px}
.dbb_aboutLink:hover{text-decoration:underline}
.dbb_aboutActions{flex-wrap:wrap;gap:8px;margin-top:6px;display:flex}
.dbb_aboutPrimary{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none;border-radius:8px;align-items:center;gap:4px;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}
.dbb_aboutPrimary:hover:not(:disabled){filter:brightness(1.06)}
.dbb_aboutPrimary:disabled{opacity:.5;cursor:default}
.dbb_aboutSecondary{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;background:0 0;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;align-items:center;gap:4px;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}
.dbb_aboutSecondary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dbb_aboutRelease{align-self:flex-start;text-align:left}
.dbb_aboutStatus{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}

.dbb_remote{max-width:640px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:10px;display:flex}
.dbb_remoteSwitch{align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:20px;display:flex}
.dbb_remoteSwitch input{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary)}
.dbb_remoteSwitchText{color:var(--dsw-alias-label-primary)}
.dbb_remoteField{flex-direction:column;gap:4px;display:flex}
.dbb_remotePersistent{flex-direction:column;gap:6px;padding-top:4px;display:flex}
.dbb_remoteLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dbb_remoteInput{box-sizing:border-box;width:100%;height:32px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-input-bg, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font-size:13px;line-height:20px}
.dbb_remoteInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dbb_remoteDefaultField{flex-direction:column;gap:4px;display:flex}
.dbb_remoteDefault{box-sizing:border-box;width:100%;min-height:32px;font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-input-bg, var(--dsw-alias-bg-base));border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:5px 10px;font-size:13px;line-height:20px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.dbb_remote .dbb_aboutActions{align-items:center}
.dbb_remoteCode{font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-business-primary);font-size:15px;font-weight:600;letter-spacing:2px;margin:2px 0 0}
.dbb_remoteQr{flex-direction:column;align-items:flex-start;gap:6px;margin-top:6px;display:flex}
.dbb_remoteQr img{width:168px;height:168px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:#fff;padding:6px;box-sizing:border-box}

.dbb_pluginNetwork{max-width:640px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:10px;display:flex}
.dbb_networkHint{margin-top:0}
.dbb_networkSelect{appearance:auto;cursor:pointer}
.dbb_networkResults{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base);flex-direction:column;gap:2px;padding:10px 12px;display:flex}
.dbb_networkRow{align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding:8px 0;display:flex}
.dbb_networkRow:first-of-type{margin-top:4px}
.dbb_networkName{color:var(--dsw-alias-label-secondary);font:12px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;min-width:72px}
.dbb_networkMeta{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dbb_builtin{box-sizing:border-box;width:min(720px,100%);color:var(--dsw-alias-label-primary);padding-bottom:84px;display:flex;flex-direction:column;gap:18px}
.dbb_builtinHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.dbb_builtinHeader>div{min-width:0}
.dbb_builtinCount{flex:none;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:4px 10px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dbb_builtinGroup{display:flex;flex-direction:column;gap:7px}
.dbb_builtinGroupTitle{margin:0 2px;color:var(--dsw-alias-label-caption);font-size:12px;font-weight:500;line-height:18px}
.dbb_builtinList{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base)}
.dbb_builtinRow{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:92px;padding:14px 16px}
.dbb_builtinRow+.dbb_builtinRow{border-top:1px solid var(--dsw-alias-border-l2)}
.dbb_builtinCopy{min-width:0;display:flex;flex-direction:column;gap:3px}
.dbb_builtinNameLine{display:flex;align-items:baseline;gap:8px;min-width:0}
.dbb_builtinName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.dbb_builtinVersion{color:var(--dsw-alias-label-caption);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dbb_builtinDescription{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dbb_builtinMeta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dbb_builtinSwitch{position:relative;flex:none;display:grid;grid-template-columns:38px 48px;align-items:center;gap:9px;cursor:pointer}
.dbb_builtinSwitch input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.dbb_builtinSwitchTrack{box-sizing:border-box;position:relative;width:38px;height:22px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-interactive-bg-hover-solid);transition:background .18s ease,border-color .18s ease}
.dbb_builtinSwitchTrack:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);transition:transform .18s ease}
.dbb_builtinSwitch input:checked+.dbb_builtinSwitchTrack{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}
.dbb_builtinSwitch input:checked+.dbb_builtinSwitchTrack:after{transform:translateX(16px)}
.dbb_builtinSwitch input:focus-visible+.dbb_builtinSwitchTrack{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dbb_builtinSwitch input:disabled+.dbb_builtinSwitchTrack{opacity:.52}
.dbb_builtinState{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.dbb_builtinFooter{position:sticky;z-index:2;bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:2px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 92%,transparent);box-shadow:var(--dsw-shadow-lv1);backdrop-filter:blur(14px)}
.dbb_builtinRestartHint{min-width:0;margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dbb_builtinFooterVisible .dbb_builtinRestartHint{color:var(--dsw-alias-state-warn-label)}
.dbb_builtinActions{flex:none;display:flex;align-items:center;gap:8px}
.dbb_builtinTextButton{height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}
.dbb_builtinTextButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dbb_builtinTextButton:disabled{opacity:.45;cursor:default}
.dbb_builtinError{padding:14px 16px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dbb_builtinSkeleton{display:flex;flex-direction:column;gap:1px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.dbb_builtinSkeleton span{height:82px;background:var(--dsw-alias-interactive-bg-hover);opacity:.65}
@media(max-width:640px){.dbb_builtinHeader{flex-direction:column;gap:10px}.dbb_builtinRow{align-items:flex-start;gap:12px;padding:13px 14px}.dbb_builtinSwitch{grid-template-columns:38px;justify-items:end}.dbb_builtinState{display:none}.dbb_builtinFooter{align-items:stretch;flex-direction:column}.dbb_builtinActions{justify-content:flex-end;flex-wrap:wrap}.dbb_builtinActions .dbb_aboutPrimary{white-space:nowrap}}
@media(prefers-reduced-motion:reduce){.dbb_builtinSwitchTrack,.dbb_builtinSwitchTrack:after{transition:none}}

.dbb_appearance{max-width:640px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:10px;display:flex}
.dbb_seg{box-sizing:border-box;align-self:flex-start;gap:3px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);display:inline-flex}
.dbb_segBtn{box-sizing:border-box;height:30px;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:8px;align-items:center;gap:6px;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}
.dbb_segBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dbb_segBtn:disabled{opacity:.5;cursor:default}
.dbb_segBtn.dbb_segActive{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);color:var(--dsw-alias-state-business-primary)}
.dbb_notificationSeg{max-width:100%;flex-wrap:wrap}

.dbb_modelBehavior{box-sizing:border-box;width:min(680px,100%);padding-bottom:36px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.dbb_modelCard{gap:8px}
.dbb_modelFieldHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dbb_modelLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.dbb_modelCount{flex:none;color:var(--dsw-alias-label-caption);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.dbb_modelTextarea{box-sizing:border-box;width:100%;min-height:140px;resize:vertical;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-input-bg,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:13px/21px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dbb_modelTextarea::placeholder{color:var(--dsw-alias-label-caption)}
.dbb_modelTextarea:focus,.dbb_modelNumber:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);outline-offset:1px;border-color:var(--dsw-alias-state-business-primary)}
.dbb_modelTemperatureHead{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.dbb_modelTemperatureHead>div{min-width:0}
.dbb_modelSubcopy{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dbb_modelToggle{flex:none;display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.dbb_modelToggle input{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary)}
.dbb_modelTemperatureControls{display:grid;grid-template-columns:minmax(0,1fr) 72px;align-items:center;gap:14px;margin-top:6px}
.dbb_modelTemperatureControls[aria-disabled=true]{opacity:.52}
.dbb_modelRange{width:100%;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dbb_modelRange:disabled{cursor:default}
.dbb_modelNumber{box-sizing:border-box;width:72px;height:34px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-input-bg,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:13px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.dbb_modelScale{display:flex;justify-content:space-between;padding-right:86px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dbb_modelFooter{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-top:2px}
.dbb_modelApplyHint{max-width:420px;margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px}
.dbb_modelFooter .dbb_aboutActions{flex:none;margin-top:0}
.dbb_modelError{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-base)}
.dbb_modelError p{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.dbb_modelSkeleton{display:flex;flex-direction:column;gap:10px}
.dbb_modelSkeleton span{height:116px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);opacity:.7}
.dbb_modelBehavior button:active:not(:disabled){transform:translateY(1px)}
@media(max-width:640px){.dbb_modelTemperatureHead,.dbb_modelFooter{align-items:stretch;flex-direction:column}.dbb_modelToggle{align-self:flex-start}.dbb_modelFooter .dbb_aboutActions{justify-content:flex-end}.dbb_modelScale{padding-right:0}.dbb_modelTextarea{min-height:170px}}
@media(prefers-reduced-motion:reduce){.dbb_modelBehavior button:active:not(:disabled){transform:none}}
`;

const TAG_ID = 'desktop-balance.css';

/** Install the stylesheet exactly once per document. */
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-desktop-bridge';
    tag.dataset.pluginCss = TAG_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }
}

// install on bundle load (the pre-split bundle did this inline at load time)
ensureStyles();

module.exports = { ensureStyles };
