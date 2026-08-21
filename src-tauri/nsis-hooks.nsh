; DSH Desktop NSIS hooks (bundle.windows.nsis.installerHooks)
; The extracted runtime tree (node/ + dsh/, created by the app on first
; launch) is not logged by the installer — remove it before the uninstaller
; deletes its own files.
;
; RMDir /r walks the tree file-by-file inside NSIS and is painfully slow for
; the unpacked node_modules tree (tens of thousands of files; Defender
; real-time scanning multiplies the cost). `cmd /c rmdir /s /q` removes the
; whole tree in one native pass and is the difference between a multi-minute
; and a few-second uninstall. The trailing RMDir /r is a cheap no-op fallback
; for any file that stays locked while the app is still running.
!macro NSIS_HOOK_PREUNINSTALL
  ; /UPDATE is a shell replacement. Keep the extracted runtime so the new
  ; shell can compare it with the bundled archive and preserve a newer dsh
  ; kernel. A real uninstall still removes both possible runtime locations.
  ${If} $UpdateMode <> 1
    nsExec::ExecToLog '$SYSDIR\cmd.exe /c if exist "$INSTDIR\runtime" rmdir /s /q "$INSTDIR\runtime"'
    RMDir /r "$INSTDIR\runtime"
    ; When the install dir is not writable the app extracts into its local app
    ; data dir instead - clean that fallback tree up too.
    nsExec::ExecToLog '$SYSDIR\cmd.exe /c if exist "$LOCALAPPDATA\com.anixuil.dshdesktop\runtime" rmdir /s /q "$LOCALAPPDATA\com.anixuil.dshdesktop\runtime"'
    RMDir /r "$LOCALAPPDATA\com.anixuil.dshdesktop\runtime"
  ${EndIf}
!macroend

; Keep the installer compact (one runtime archive), but start the existing
; hidden boot mode after every resource has been copied. If the user opens the
; app while preparation is still running, the single-instance handler simply
; reveals this same splash window — no second decompression race.
!macro NSIS_HOOK_POSTINSTALL
  ; Toast attribution comes from the shortcut's AppUserModelID. The stock
  ; update path preserves existing shortcuts and may skip rewriting this
  ; property, so refresh every shortcut that already exists after an upgrade.
  !if "${STARTMENUFOLDER}" != ""
    IfFileExists "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" 0 +2
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    IfFileExists "$SMPROGRAMS\${PRODUCTNAME}.lnk" 0 +2
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" 0 +2
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

  ; Windows caches executable and shortcut icons by path, so overwriting the
  ; same EXE during an upgrade can otherwise leave the old black whale visible.
  ; Ask the current user's shell to discard that cache after the new EXE and
  ; shortcuts are in place. `-show` also refreshes Explorer on Windows builds
  ; where `-ClearIconCache` only invalidates the database lazily.
  nsExec::ExecToLog '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
  nsExec::ExecToLog '"$SYSDIR\ie4uinit.exe" -show'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ExecShell "open" "$INSTDIR\DSH Desktop.exe" "--hidden"
!macroend
