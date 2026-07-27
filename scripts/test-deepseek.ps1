$ErrorActionPreference = "Stop"

try {
  $result = Invoke-RestMethod `
    -Uri "http://127.0.0.1:5173/api/ai-status/test" `
    -Method Post `
    -ContentType "application/json" `
    -Body "{}" `
    -TimeoutSec 45

  Write-Host "DeepSeek live connection succeeded." -ForegroundColor Green
  Write-Host "Model: $($result.model)"
  Write-Host "Latency: $($result.latencyMs) ms"
}
catch {
  Write-Host "DeepSeek connection test failed." -ForegroundColor Red
  $message = $_.ErrorDetails.Message
  if (-not $message -and $_.Exception.Response) {
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = [IO.StreamReader]::new($stream)
    $message = $reader.ReadToEnd()
    $reader.Dispose()
  }
  if ($message) {
    try { Write-Host (($message | ConvertFrom-Json).error) }
    catch { Write-Host $message }
  }
  else {
    Write-Host $_.Exception.Message
  }
  exit 1
}
