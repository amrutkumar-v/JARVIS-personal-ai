' JARVIS Core backend autostart (Phase 2.8).
' Launched at logon by the scheduled task installed via install-startup.ps1.
' Starts the persistent backend in a hidden window; logs go to server\data\autostart.log.
Option Explicit

Dim fso, scriptDir, repo, dataDir, sh, shellCmd
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repo = fso.GetAbsolutePathName(scriptDir & "\..\..")
dataDir = repo & "\server\data"

If Not fso.FolderExists(dataDir) Then
  fso.CreateFolder(dataDir)
End If

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = repo
shellCmd = "cmd /c npm run backend > """ & dataDir & "\autostart.log"" 2>&1"
sh.Run shellCmd, 0, False