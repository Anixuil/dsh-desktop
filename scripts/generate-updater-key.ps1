$ErrorActionPreference = 'Stop'

$keyDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tauri'
$keyPath = Join-Path $keyDirectory 'dsh-desktop-updater.key'
$tauri = Join-Path $PSScriptRoot '..\node_modules\.bin\tauri.cmd'

New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
if (Test-Path -LiteralPath $keyPath) {
  Write-Host "Updater private key already exists: $keyPath" -ForegroundColor Yellow
  Write-Host 'For safety this script will not overwrite it.'
  Read-Host 'Press Enter to close'
  exit 2
}

# Let the official signer own the hidden password + confirmation prompts. The
# password is never materialized by this wrapper or passed on the command line.
& $tauri signer generate --write-keys $keyPath
if ($LASTEXITCODE -ne 0) { throw "Tauri signer exited with code $LASTEXITCODE" }
Write-Host "Updater key generated: $keyPath" -ForegroundColor Green
Write-Host "Public key: $keyPath.pub"

Read-Host 'Press Enter to close'
