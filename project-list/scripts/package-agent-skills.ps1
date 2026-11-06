$ErrorActionPreference = 'Stop'
$applicationRoot = Split-Path -Parent $PSScriptRoot
$skillRoot = Join-Path $applicationRoot 'agent-skills'
$bundlePath = Join-Path $applicationRoot 'public/agent-skills.zip'
foreach ($skillName in @('board-update', 'project-capture', 'daily-focus')) {
    $skillPath = Join-Path $skillRoot "$skillName/SKILL.md"
    $content = Get-Content -LiteralPath $skillPath -Raw
    if ($content -notmatch ('(?s)^---\r?\nname: ' + [regex]::Escape($skillName) + '\r?\ndescription: [^\r\n]+\r?\n---\r?\n')) {
        throw "Invalid skill metadata: $skillPath"
    }
}
Compress-Archive -Path (Join-Path $skillRoot '*') -DestinationPath $bundlePath -Force
Write-Output "Packaged $bundlePath"
