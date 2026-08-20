# Starts the local tracker server and makes sure the Tailscale Funnel is serving it.
# Idempotent: safe to run repeatedly. Launched at logon by the "MarathonTracker" scheduled task.
# Public URL (fixed, never changes): https://valencia-marathon.tail098b53.ts.net
# The old cloudflared version of this script is kept as start-tracker-cloudflared.ps1.bak.
$ErrorActionPreference = 'SilentlyContinue'
$dir = 'C:\Users\aiman\marathon-server'
$ts  = 'C:\Program Files\Tailscale\tailscale.exe'

# 1. Local server (node) — start only if port 8787 is not already listening.
$listening = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# 2. Funnel — the serve config persists across reboots, so re-apply only if it is off.
#    Tailscale may need a few seconds after logon to connect, hence the retries.
for ($i = 0; $i -lt 10; $i++) {
  $status = & $ts funnel status 2>&1
  if ($status -match 'Funnel on') { break }
  & $ts funnel --bg 8787 | Out-Null
  Start-Sleep -Seconds 5
}

Set-Content -Path (Join-Path $dir 'url.txt') -Value 'https://valencia-marathon.tail098b53.ts.net' -Encoding utf8
