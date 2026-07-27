$ErrorActionPreference = "Stop"

$secureKey = Read-Host "Enter a new DeepSeek API Key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "API Key cannot be empty."
  }

  $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
  $content = @(
    "DEEPSEEK_API_KEY=$apiKey"
    "DEEPSEEK_MODEL=deepseek-chat"
    ""
  ) -join [Environment]::NewLine

  [IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "DeepSeek configuration was saved to the local .env file." -ForegroundColor Green
  Write-Host "Run npm.cmd run test:deepseek, then refresh JobFlow."
}
finally {
  if ($pointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}
