$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distDirectory = (Resolve-Path (Join-Path $projectRoot "dist")).Path
$releaseDirectory = Join-Path $projectRoot "release"
$manifest = Get-Content -Raw (Join-Path $distDirectory "manifest.json") | ConvertFrom-Json
$archivePath = Join-Path $releaseDirectory "joy-of-nav-$($manifest.version).zip"
$latestArchivePath = Join-Path $releaseDirectory "joy-of-nav-latest.zip"

if (-not $distDirectory.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Build directory must be inside the project."
}
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
Compress-Archive -Path (Join-Path $distDirectory "*") -DestinationPath $archivePath -Force
Copy-Item -LiteralPath $archivePath -Destination $latestArchivePath -Force
Write-Output "Packaged extension: $archivePath"
Write-Output "Latest extension: $latestArchivePath"
