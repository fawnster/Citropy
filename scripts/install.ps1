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

function Invoke-CitropyInstall {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  $repo = "tinuxongit/Citropy"
  $github = "https://github.com/$repo"

  function Say([string]$Message) { Write-Host $Message }
  function Fail([string]$Message) { throw "Citropy install: $Message" }

  $temp = $null
  $exe = $null
  try {
    if (-not $Channel) { $Channel = "stable" }
    if ($Channel -ne "stable" -and $Channel -ne "lemon") { Fail "Unknown channel: $Channel. Use stable or lemon." }
    if ($Channel -eq "lemon" -and $Version) { Fail "The Lemon channel always installs the newest build, so -Version does not apply." }

    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -eq "AMD64") {
      $arch = "x64"
    }
    elseif ($architecture -eq "ARM64") {
      $arch = "x64"
      Say "No native ARM64 build yet; installing the x64 build, which needs Windows 11 on ARM."
    }
    else {
      Fail "Unsupported processor: $architecture"
    }

    if ($Channel -eq "lemon") {
      $name = "Citropy Lemon"
      $folder = "citropy-lemon"
      $stateHint = "$env:USERPROFILE\.citropy-lemon"
    }
    else {
      $name = "Citropy"
      $folder = "citropy"
      $stateHint = "$env:USERPROFILE\.citropy"
    }
    $installDir = Join-Path $env:LOCALAPPDATA "Programs\$folder"
    $exe = Join-Path $installDir "$name.exe"
    $uninstaller = Join-Path $installDir "Uninstall $name.exe"

    if ($Uninstall) {
      if (Test-Path $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
        for ($attempt = 0; $attempt -lt 60 -and (Test-Path $installDir); $attempt++) { Start-Sleep -Milliseconds 500 }
        if (Test-Path $installDir) { Fail "The uninstaller did not remove $installDir." }
        if ($process.ExitCode -ne 0) { Say "The uninstaller exited with code $($process.ExitCode), but $installDir is gone." }
        Say "Removed $name"
      }
      else {
        Say "$name is not installed in $installDir."
      }
      Say "Your conversations and settings stay in $stateHint and the $name profile."
      return
    }

    if (-not $BaseUrl) { $BaseUrl = "$github/releases/download" }
    if ($BaseUrl -match "@") { Fail "Refusing to download from an address with embedded credentials." }
    if ($BaseUrl -match "^http://" -and $BaseUrl -notmatch "^http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)") {
      Fail "Refusing to download over plain HTTP from a remote host."
    }

    if ($Channel -eq "lemon") {
      $tag = "lemon"
      $asset = "Citropy-lemon-$arch-Setup.exe"
      $label = "Citropy Lemon"
    }
    else {
      if (-not $Version) {
        try {
          $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "Citropy" }
        }
        catch {
          Fail "Could not read the latest release from GitHub. Pass -Version or set CITROPY_VERSION. ($($_.Exception.Message))"
        }
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
    $install = Start-Process -FilePath $setup -ArgumentList "/S" -Wait -PassThru
    if ($install.ExitCode -ne 0) { Fail "The installer exited with code $($install.ExitCode), so the current installation was left alone." }
    if (-not (Test-Path $exe)) { Fail "The installer finished but $exe was not found." }
    Say "Installed $label at $installDir"
  }
  finally {
    if ($temp) { Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not $Uninstall -and $env:CITROPY_RELAUNCH -eq "1" -and $exe -and (Test-Path $exe)) { Start-Process -FilePath $exe }
  }
}

$scriptPath = $MyInvocation.MyCommand.Path

try {
  Invoke-CitropyInstall
}
catch {
  if ($scriptPath) { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
  throw
}
finally {
  foreach ($citropyName in @("Channel", "Version", "BaseUrl", "Uninstall", "scriptPath", "citropyName")) {
    Remove-Variable -Name $citropyName -ErrorAction SilentlyContinue
  }
  Remove-Item -Path "Function:\Invoke-CitropyInstall" -ErrorAction SilentlyContinue
}
