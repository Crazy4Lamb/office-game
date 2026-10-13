param(
  [ValidateRange(0, 65535)][int]$Port = 0,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Get-GameInfo([int]$Candidate) {
  try {
    $Info = Invoke-RestMethod -Uri "http://127.0.0.1:$Candidate/api/network" -TimeoutSec 2
    if ($Info.app -eq 'office-game' -and $Info.version -ge 4) { return $Info }
  } catch {}
  return $null
}
function Test-FreePort([int]$Candidate) {
  $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Candidate)
  try { $Listener.Start(); return $true } catch { return $false } finally { $Listener.Stop() }
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$NodePath = if ($NodeCommand) { $NodeCommand.Source } else { $null }
if (-not $NodePath) {
  $BundledNodes = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
  if (Test-Path -LiteralPath $BundledNodes) {
    $NodePath = Get-ChildItem -LiteralPath $BundledNodes -Directory | Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName 'node.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
}
if (-not $NodePath) { throw 'Node.js 18+ was not found. Install Node.js and run start.cmd again.' }

$ExplicitPort = $Port -gt 0 -or [bool]$env:PORT
$FirstPort = if ($Port -gt 0) { $Port } elseif ($env:PORT) { [int]$env:PORT } else { 7777 }
if ($FirstPort -lt 1 -or $FirstPort -gt 65535) { throw 'PORT must be between 1 and 65535.' }
$SelectedPort = 0
$ExistingGame = $null
$LastPort = if ($ExplicitPort) { $FirstPort } else { [Math]::Min(65535, $FirstPort + 20) }
for ($Candidate = $FirstPort; $Candidate -le $LastPort; $Candidate++) {
  $ExistingGame = Get-GameInfo $Candidate
  if ($ExistingGame -or (Test-FreePort $Candidate)) { $SelectedPort = $Candidate; break }
  Write-Host "Port $Candidate is occupied by another or older service; checking the next port."
}
if (-not $SelectedPort) { throw 'No free port was found. Close the old service or choose another PORT.' }
$Url = "http://localhost:$SelectedPort/"
if ($ExistingGame) {
  Write-Host "Office Game is already running: $Url"
  if ($ExistingGame.recommendedUrl) { Write-Host "LAN: $($ExistingGame.recommendedUrl)" }
  if (-not $NoBrowser) { Start-Process -FilePath $Url -WindowStyle Hidden }
  exit 0
}

$env:PORT = [string]$SelectedPort
if (-not $env:HOST) { $env:HOST = '0.0.0.0' }
Write-Host "Starting Office Game: $Url"
Write-Host 'Keep this window open. Share the LAN invitation inside the page, not localhost.'
if (-not $NoBrowser) {
  $BrowserJob = Start-Job -ArgumentList $Url,$SelectedPort -ScriptBlock {
    param($GameUrl,$GamePort)
    for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
      try {
        $Ready = Invoke-RestMethod -Uri "http://127.0.0.1:$GamePort/api/network" -TimeoutSec 2
        if ($Ready.app -eq 'office-game' -and $Ready.version -ge 4) {
          Start-Process -FilePath $GameUrl -WindowStyle Hidden
          break
        }
      } catch {}
      Start-Sleep -Milliseconds 200
    }
  }
}
try {
  & $NodePath (Join-Path $PSScriptRoot 'server.js')
  $NodeExitCode = $LASTEXITCODE
} finally {
  if ($BrowserJob) { Stop-Job -Job $BrowserJob -ErrorAction SilentlyContinue; Remove-Job -Job $BrowserJob -Force -ErrorAction SilentlyContinue }
}
exit $NodeExitCode
