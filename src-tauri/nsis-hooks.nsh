; DSH Desktop NSIS hooks (bundle.windows.nsis.installerHooks)
; The extracted runtime tree (node/ + dsh/, created by the app on first
; launch) is not logged by the installer — remove it before the uninstaller
; deletes its own files.
!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\runtime"
  ; When the install dir is not writable the app extracts into its local app
  ; data dir instead — clean that fallback tree up too.
  RMDir /r "$LOCALAPPDATA\com.anixuil.dshdesktop\runtime"
!macroend
