$ErrorActionPreference = 'Stop'
$desktopPath = [Environment]::GetFolderPath('Desktop')
if (-not $desktopPath) { throw 'Windows could not find your Desktop folder.' }
$shortcutPath = Join-Path $desktopPath 'My Projects.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'Launch.ps1') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = (Join-Path $PSScriptRoot 'public\project-list-sharp.ico') + ',0'
$shortcut.Description = 'Open your private, local project list'
$shortcut.Save()
Write-Output "Created desktop shortcut: $shortcutPath"
