$ErrorActionPreference = 'Stop'
$recordPath = Join-Path $PSScriptRoot 'data\server-process.json'
if (-not (Test-Path -LiteralPath $recordPath)) { Write-Output 'No launched server was recorded.'; exit 0 }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
$serverProcess = Get-Process -Id $record.id -ErrorAction SilentlyContinue
if ($serverProcess -and $serverProcess.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startedUtc -and $serverProcess.Path -eq $record.executable) {
    $serverProcess.Kill()
    Write-Output 'Local project list stopped. Your data is saved.'
} else { Write-Output 'The recorded server is no longer running.' }
