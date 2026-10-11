$ErrorActionPreference = 'Stop'

# This legacy entry point now delegates to the single supported scheduled task.
# Remove its former Run-key entry so invoking it cannot create a duplicate.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'CryptoNewsRadarLocal' -ErrorAction SilentlyContinue

& (Join-Path $PSScriptRoot 'install-alertsbot-task.ps1')
