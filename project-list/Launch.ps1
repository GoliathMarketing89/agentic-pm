param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:4173'

function Open-ProjectList {
    if (-not $NoBrowser) {
        $browserCandidates = @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
        )
        $appBrowser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($appBrowser) { Start-Process -FilePath $appBrowser -ArgumentList "--app=$appUrl" -WindowStyle Normal }
        else { Start-Process $appUrl }
    }
    Write-Output "Project list: $appUrl"
}

try {
    $health = Invoke-RestMethod "$appUrl/health" -TimeoutSec 2
    if ($health.app -eq 'agentic-pm') { Open-ProjectList; exit 0 }
    throw 'Port 4173 is being used by another app.'
} catch {
    if ($_.Exception.Message -like '*being used by another app*') { throw }
}

$foundNode = Get-Command node -ErrorAction SilentlyContinue
$runtimeCandidates = @()
if ($foundNode) { $runtimeCandidates += $foundNode.Source }
$runtimeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
$nodeRuntime = $null
foreach ($candidate in ($runtimeCandidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate) {
        $runtimeVersion = & $candidate --version
        if ($LASTEXITCODE -eq 0 -and $runtimeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 24) { $nodeRuntime = $candidate; break }
    }
}
if (-not $nodeRuntime) { throw 'Node.js 24 or newer is required. This laptop normally uses the runtime bundled with Codex. No software was installed automatically.' }

$dataDir = Join-Path $appRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$serverProcess = Start-Process -FilePath $nodeRuntime -ArgumentList @('--disable-warning=ExperimentalWarning', 'server.mjs') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) { throw "The local app could not start. See $dataDir\server-error.log" }
    try {
        $health = Invoke-RestMethod "$appUrl/health" -TimeoutSec 1
        if ($health.app -eq 'agentic-pm') {
            @{ id = $serverProcess.Id; startedUtc = $serverProcess.StartTime.ToUniversalTime().Ticks.ToString(); executable = $nodeRuntime } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDir 'server-process.json') -Encoding utf8
            Open-ProjectList
            exit 0
        }
    } catch { }
}
throw "The local app did not become ready. See $dataDir\server-error.log"
