# Starts the local tracker server + Cloudflare tunnel if not already running.
# Idempotent: safe to run repeatedly. Writes the current public URL to url.txt.
$ErrorActionPreference = 'SilentlyContinue'
$dir = 'C:\Users\aiman\marathon-server'
$cf  = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$log = Join-Path $dir 'tunnel.log'

# 1. Local static server (node) — start only if port 8787 is not listening.
$listening = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

# 2. Cloudflare tunnel — start only if cloudflared is not already running.
$running = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $running) {
  if (Test-Path $log) { Remove-Item $log -Force }
  Start-Process -FilePath $cf -ArgumentList "tunnel --url http://127.0.0.1:8787 --logfile `"$log`"" -WindowStyle Hidden
}

# 3. Wait for the public URL to appear, then save it.
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue
  if ($m) {
    $url = ($m.Matches | Select-Object -First 1).Value
    Set-Content -Path (Join-Path $dir 'url.txt') -Value $url -Encoding utf8
    break
  }
}
