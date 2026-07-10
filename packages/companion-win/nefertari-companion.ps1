# Nefertari OS - Windows companion (phase 2, block 1).
# Watches the human gate inside WSL and lets you approve/deny from Windows:
# toast notification on every new pending action + interactive console approve/deny.
# Zero dependencies: Windows PowerShell 5.1 + wsl.exe. The single source of truth
# stays agentd's own CLI inside WSL - this script only *invokes* it, never
# reimplements approval logic.
#
# Usage:
#   .\nefertari-companion.ps1                 # watch mode (toast + interactive approve/deny)
#   .\nefertari-companion.ps1 -Once           # list pending actions and exit
#   .\nefertari-companion.ps1 -Approve <id>   # approve one action
#   .\nefertari-companion.ps1 -Deny <id>      # deny one action
#   .\nefertari-companion.ps1 -Journal 20     # tail the audit journal

[CmdletBinding()]
param(
  [switch]$Once,
  [string]$Approve,
  [string]$Deny,
  [int]$Journal = 0,
  [int]$PollSeconds = 3,
  [string]$Distro = ""   # optional: pass a specific WSL distro name
)

$ErrorActionPreference = "Stop"

# --- locate agentd inside WSL from where this script lives (repo layout is fixed) ---
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$drive = $repoRoot.Substring(0, 1).ToLower()
$agentdWsl = "/mnt/$drive" + ($repoRoot.Substring(2) -replace '\\', '/') + "/packages/agentd"

$wslArgs = @()
if ($Distro) { $wslArgs += @("-d", $Distro) }

function Invoke-Wsl([string]$bashCmd) {
  # -lc keeps the user's login env; $HOME/$PATH expand inside WSL, not here.
  & wsl @wslArgs -e bash -lc $bashCmd
}

function Invoke-NefertariCli([string]$verb, [string]$id) {
  $cmd = ('export PATH="$HOME/.local/node/bin:$PATH"; cd ''{0}'' && node src/cli.mjs {1} {2}' -f $agentdWsl, $verb, $id)
  Invoke-Wsl $cmd
}

function Get-Pending {
  $raw = Invoke-Wsl 'cat "$HOME/.nefertari/pending.json" 2>/dev/null || echo []'
  try { $items = ($raw -join "`n") | ConvertFrom-Json } catch { $items = @() }
  if ($null -eq $items) { return @() }
  # prune expired client-side too (authoritative pruning happens in agentd)
  return @($items | Where-Object { -not $_.approved })
}

function Show-Toast([string]$title, [string]$body) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName("text")
    [void]$texts.Item(0).AppendChild($xml.CreateTextNode($title))
    [void]$texts.Item(1).AppendChild($xml.CreateTextNode($body))
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
      (New-Object Windows.UI.Notifications.ToastNotification $xml))
  } catch {
    try { [console]::Beep(880, 200) } catch {}
  }
}

function Write-PendingList($items) {
  if (-not $items.Count) { Write-Host "No pending actions." -ForegroundColor DarkGray; return }
  $n = 0
  foreach ($i in $items) {
    $n++
    $args = ($i.args | ConvertTo-Json -Compress -Depth 5)
    if ($args.Length -gt 100) { $args = $args.Substring(0, 100) + "..." }
    Write-Host ""
    Write-Host ("[{0}] {1}  -  {2}" -f $n, $i.id, $i.tool) -ForegroundColor Yellow
    Write-Host ("    reason: {0}" -f $i.reason)
    Write-Host ("    args:   {0}" -f $args)
    Write-Host ("    since:  {0}" -f $i.createdAt) -ForegroundColor DarkGray
  }
  Write-Host ""
}

# --- one-shot modes ---
if ($Approve) { Invoke-NefertariCli "approve" $Approve; exit $LASTEXITCODE }
if ($Deny)    { Invoke-NefertariCli "deny"    $Deny;    exit $LASTEXITCODE }
if ($Journal -gt 0) { Invoke-NefertariCli "journal" $Journal; exit $LASTEXITCODE }
if ($Once) {
  $items = Get-Pending
  Write-PendingList $items
  exit 0
}

# --- watch mode ---
Write-Host "nefertari companion - watching the human gate (agentd: $agentdWsl)" -ForegroundColor Cyan
Write-Host "keys: 1-9 select a pending action, then A approve / D deny | Q quit" -ForegroundColor DarkGray

$known = @{}
$current = @()
while ($true) {
  try { $current = Get-Pending } catch { $current = @() }

  foreach ($i in $current) {
    if (-not $known.ContainsKey($i.id)) {
      $known[$i.id] = $true
      Show-Toast "Nefertari: approval needed" ("{0} - {1}" -f $i.tool, $i.reason)
      Write-Host ("`n! NEW pending action:") -ForegroundColor Red
      Write-PendingList @($i)
    }
  }

  $deadline = (Get-Date).AddSeconds($PollSeconds)
  while ((Get-Date) -lt $deadline) {
    $key = $null
    try { if ([console]::KeyAvailable) { $key = [console]::ReadKey($true) } } catch {}
    if ($key) {
      if ($key.Key -eq "Q") { Write-Host "bye."; exit 0 }
      $digit = 0
      if ([int]::TryParse($key.KeyChar, [ref]$digit) -and $digit -ge 1 -and $digit -le $current.Count) {
        $sel = $current[$digit - 1]
        Write-PendingList @($sel)
        Write-Host ("A = approve, D = deny, anything else = cancel: ") -NoNewline -ForegroundColor Cyan
        $verdict = [console]::ReadKey($true)
        Write-Host $verdict.KeyChar
        switch ($verdict.Key) {
          "A" { Invoke-NefertariCli "approve" $sel.id }
          "D" { Invoke-NefertariCli "deny" $sel.id; $known.Remove($sel.id) | Out-Null }
          default { Write-Host "cancelled." -ForegroundColor DarkGray }
        }
        break # re-poll immediately
      }
    }
    Start-Sleep -Milliseconds 150
  }
}
