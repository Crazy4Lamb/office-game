param(
  [ValidateRange(1, 65535)][int]$Port = 7778,
  [string]$InterfaceAlias,
  [switch]$Disable
)
$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator permission is required to change Windows Firewall. Open an administrator PowerShell, then run this script again.'
}
$RuleName = "OfficeGame-LAN-$Port"
if ($Disable) {
  Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue | Disable-NetFirewallRule
  Write-Host "Disabled Office Game LAN access on TCP $Port."
  exit 0
}
$Info = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/network" -TimeoutSec 3
if ($Info.app -ne 'office-game' -or -not $Info.lanEnabled) { throw 'The selected port is not a LAN-enabled Office Game server.' }
if (-not $InterfaceAlias) {
  $InterfaceAlias = ($Info.addresses | Where-Object { $_.kind -eq 'lan' } | Select-Object -First 1).interface
}
if (-not $InterfaceAlias -or -not ($Info.addresses | Where-Object { $_.interface -eq $InterfaceAlias -and $_.kind -eq 'lan' })) {
  throw 'No matching LAN adapter was found. Connect to Wi-Fi or Ethernet, then retry.'
}
$Connection = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1
$GameProcess = Get-Process -Id $Connection.OwningProcess
$ProgramPath = $GameProcess.Path
if (-not $ProgramPath -or [IO.Path]::GetFileName($ProgramPath) -ne 'node.exe') { throw 'The selected port is not served by Node.js.' }
$Existing = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($Existing) {
  $Existing | Set-NetFirewallRule -Enabled True -Action Allow -Direction Inbound -Profile Private,Public -InterfaceAlias $InterfaceAlias
  $Existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet
  $Existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
  $Existing | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $ProgramPath
} else {
  New-NetFirewallRule -Name $RuleName -DisplayName "Office Game LAN (TCP $Port)" -Direction Inbound -Action Allow `
    -Program $ProgramPath -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Private,Public -InterfaceAlias $InterfaceAlias | Out-Null
}
Write-Host "Allowed Office Game TCP $Port for devices on the local subnet only."
Write-Host "Network adapter: $InterfaceAlias"
Write-Host "LAN address: $($Info.recommendedUrl)"
