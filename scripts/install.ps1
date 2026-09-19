# Installs or updates Citropy on Windows.
#
#   irm https://raw.githubusercontent.com/tinuxongit/Citropy/main/scripts/install.ps1 | iex
#   $s = irm https://raw.githubusercontent.com/tinuxongit/Citropy/main/scripts/install.ps1; & ([scriptblock]::Create($s)) -Channel lemon
#   $s = irm https://raw.githubusercontent.com/tinuxongit/Citropy/main/scripts/install.ps1; & ([scriptblock]::Create($s)) -Uninstall
#
# The stable channel installs released versions. Lemon installs the rolling
# build from main and keeps its own app, data, and settings.
[CmdletBinding()]
param(
  [string]$Channel = $env:CITROPY_CHANNEL,
  [string]$Version = $env:CITROPY_VERSION,
  [string]$BaseUrl = $env:CITROPY_BASE_URL,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$repo = "tinuxongit/Citropy"
$github = "https://github.com/$repo"

function Say([string]$Message) { Write-Host $Message }
function Fail([string]$Message) { Write-Error "Citropy install: $Message"; exit 1 }

if (-not $Channel) { $Channel = "stable" }
if ($Channel -ne "stable" -and $Channel -ne "lemon") { Fail "Unknown channel: $Channel. Use stable or lemon." }
if ($Channel -eq "lemon" -and $Version) { Fail "The Lemon channel always installs the newest build, so -Version does not apply." }

$architecture = $env:PROCESSOR_ARCHITECTURE
if ($architecture -eq "AMD64") {
  $arch = "x64"
}
elseif ($architecture -eq "ARM64") {
  $arch = "x64"
  Say "No native ARM64 build yet; installing the x64 build to run under emulation."
}
else {
  Fail "Unsupported processor: $architecture"
}

if ($Channel -eq "lemon") {
  $name = "Citropy Lemon"
  $stateHint = "$env:USERPROFILE\.citropy-lemon"
}
else {
  $name = "Citropy"
  $stateHint = "$env:USERPROFILE\.citropy"
}
$installDir = Join-Path $env:LOCALAPPDATA "Programs\$name"
$exe = Join-Path $installDir "$name.exe"
$uninstaller = Join-Path $installDir "Uninstall $name.exe"

if ($Uninstall) {
  if (Test-Path $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
    Say "Removed $name"
  }
  else {
    Say "$name is not installed in $installDir."
  }
  Say "Your conversations and settings stay in $stateHint and the $name profile."
  exit 0
}

if (-not $BaseUrl) { $BaseUrl = "$github/releases/download" }
if ($BaseUrl -match "^http://" -and $BaseUrl -notmatch "^http://(127\.0\.0\.1|localhost)") {
  Fail "Refusing to download over plain HTTP from a remote host."
}

if ($Channel -eq "lemon") {
  $tag = "lemon"
  $asset = "Citropy-lemon-$arch-Setup.exe"
  $label = "Citropy Lemon"
}
else {
  if (-not $Version) {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "Citropy" }
    $Version = $release.tag_name -replace "^v", ""
  }
  if ($Version -notmatch "^\d+\.\d+\.\d+$") { Fail "Version $Version does not look like a release. Use a version like 0.2.0." }
  $tag = "v$Version"
  $asset = "Citropy-$Version-$arch-Setup.exe"
  $label = "Citropy $Version"
}

$waitFor = $env:CITROPY_PARENT_PID
if ($waitFor) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Get-Process -Id ([int]$waitFor) -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
  }
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("citropy-install-" + ([guid]::NewGuid().ToString("N")))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $setup = Join-Path $temp $asset
  Say "Downloading $label for windows ($arch)..."
  Invoke-WebRequest -Uri "$BaseUrl/$tag/$asset" -OutFile $setup -UseBasicParsing
  $sumsFile = Join-Path $temp "SHA256SUMS"
  Invoke-WebRequest -Uri "$BaseUrl/$tag/SHA256SUMS" -OutFile $sumsFile -UseBasicParsing
  $sums = Get-Content -Path $sumsFile -Raw
  $expected = $null
  foreach ($line in ($sums -split "`n")) {
    $parts = $line.Trim() -split "\s+"
    if ($parts.Count -ge 2 -and $parts[1] -eq $asset) { $expected = $parts[0]; break }
  }
  if (-not $expected) { Fail "SHA256SUMS does not list $asset." }
  $actual = (Get-FileHash -Path $setup -Algorithm SHA256).Hash
  if ($actual.ToLower() -ne $expected.ToLower()) { Fail "The downloaded file failed its checksum. Try again." }
  if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) { Unblock-File -Path $setup }
  if ($Channel -eq "lemon") {
    try {
      $infoFile = Join-Path $temp "version.json"
      Invoke-WebRequest -Uri "$BaseUrl/$tag/version.json" -OutFile $infoFile -UseBasicParsing
      $info = Get-Content -Path $infoFile -Raw | ConvertFrom-Json
      if ($info.version) { $label = "Citropy Lemon $($info.version)" }
    }
    catch {}
  }
  Start-Process -FilePath $setup -ArgumentList "/S" -Wait
  if (-not (Test-Path $exe)) { Fail "The installer finished but $exe was not found." }
  Say "Installed $label at $installDir"
  if ($env:CITROPY_RELAUNCH -eq "1") { Start-Process -FilePath $exe }
}
finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
