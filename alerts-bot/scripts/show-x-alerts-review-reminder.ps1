Add-Type -AssemblyName PresentationFramework

$message = @'
Time to review X Alerts.

Assess the evidence collected since the rich-post update:
• useful alerts and missed catalysts
• promotional/noise rejection quality
• alert latency and X/API usage
• whether targeted sources should be broadened
• approved-versus-rejected movement results in backtest/X-SIGNAL-KEYWORD-REPORT.md

Decide whether design changes are warranted or whether to collect more data unchanged.
'@

[System.Windows.MessageBox]::Show(
  $message,
  'X Alerts — Saturday review',
  [System.Windows.MessageBoxButton]::OK,
  [System.Windows.MessageBoxImage]::Information
) | Out-Null
