; DSH Desktop NSIS hooks (bundle.windows.nsis.installerHooks)
; The extracted runtime tree (node/ + dsh/, created by the app on first
; launch) is not logged by the installer — remove it before the uninstaller
; deletes its own files.
!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\runtime"
!macroend
