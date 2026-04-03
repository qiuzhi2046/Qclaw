; Custom NSIS script — runs after installation to register the OpenClaw Gateway scheduled task.
; The installer already runs with admin privileges, so schtasks /Create will succeed.

!macro customInstall
  DetailPrint "正在注册 OpenClaw Gateway 服务..."
  nsExec::ExecToLog 'cmd.exe /c openclaw gateway install'
  ; Ignore exit code — if openclaw is not yet on PATH the user can trigger it from Qclaw UI
!macroend

!macro customUnInstall
  DetailPrint "正在移除 OpenClaw Gateway 服务..."
  nsExec::ExecToLog 'schtasks /Delete /TN "OpenClaw Gateway" /F'
!macroend
