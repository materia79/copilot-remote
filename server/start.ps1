# start.ps1 — Launch the Copilot web proxy server + relay
#
# Usage:
#   .\start.ps1                          # default hidden CLI
#   .\start.ps1 -Foreground             # visible CLI terminal window
#   .\start.ps1 -Token mynewtoken        # override auth token for this launch
#   .\start.ps1 -Token newtoken -Foreground

param(
  [string]$Token = "",
  [switch]$Foreground
)

$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = (Get-Location).Path
$serverScript = Join-Path $dir "server.js"
$relayScript = Join-Path $dir "relay.mjs"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { "node" }
$logsDir = Join-Path $dir "logs"

if (!(Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

# Build arg lists
$srvArgs   = @($serverScript)
$relayArgs = @($relayScript)

if ($Token)      { $srvArgs += "--token"; $srvArgs += $Token
                   $relayArgs += "--token"; $relayArgs += $Token }
if ($Foreground) { $relayArgs += "--foreground" }

$env:COPILOT_WORKSPACE_ROOT = $workspaceRoot

Write-Host "Starting server..."
$srv = Start-Process -FilePath $node -ArgumentList $srvArgs `
  -WorkingDirectory $workspaceRoot `
  -RedirectStandardOutput "$logsDir\server.log" `
  -RedirectStandardError  "$logsDir\server-err.log" `
  -WindowStyle Hidden -PassThru
Write-Host "Server PID: $($srv.Id)"

Start-Sleep -Seconds 2

Write-Host "Starting relay$(if ($Foreground) { ' (foreground CLI window)' })..."
$relay = Start-Process -FilePath $node -ArgumentList $relayArgs `
  -WorkingDirectory $workspaceRoot `
  -RedirectStandardOutput "$logsDir\relay.log" `
  -RedirectStandardError  "$logsDir\relay-err.log" `
  -WindowStyle Hidden -PassThru
Write-Host "Relay PID: $($relay.Id)"

Start-Sleep -Seconds $(if ($Foreground) { 8 } else { 5 })

# Verify
$authToken = if ($Token) { $Token } else { (Get-Content "$dir\config.json" | ConvertFrom-Json).authToken }
try {
  $status = Invoke-RestMethod -Uri "http://localhost:3333/api/status" -Headers @{ Authorization = "Bearer $authToken" } -Method GET
  Write-Host ""
  Write-Host "Server running — CLI online: $($status.cliOnline)"
  Write-Host "  http://localhost:3333/"
} catch {
  Write-Host "Server health check failed — check logs\\server.log"
}

Write-Host ""
Write-Host "To watch logs:"
Write-Host "  Get-Content $logsDir\server.log -Wait"
Write-Host "  Get-Content $logsDir\relay.log  -Wait"
