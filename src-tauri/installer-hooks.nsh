; Older Windows builds launch comote-node.exe outside Tauri's managed process
; tree. An installer can therefore terminate Comote.exe while the sidecar still
; holds its executable open. Stop all shipped sidecar names before replacing or
; removing files. /T also releases descendants such as the Codex app-server.
!macro ComoteStopSidecars
  Push $0
  Push $1

  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "comote-node.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "comote-node-x86_64-pc-windows-msvc.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "comote-node-aarch64-pc-windows-msvc.exe"'
  Pop $0
  Pop $1
  Sleep 500

  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ComoteStopSidecars
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ComoteStopSidecars
!macroend
