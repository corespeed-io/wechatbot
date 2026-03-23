# WeChatBot Echo Bot — Windows install script
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/corespeed-io/wechatbot/main/install.ps1 | iex
#   install.ps1 -Version v0.1.0
#   install.ps1 -Dir C:\tools

param(
    [string]$Version = "",
    [string]$Dir = "$env:LOCALAPPDATA\wechatbot\bin"
)

$ErrorActionPreference = "Stop"

$Repo = "corespeed-io/wechatbot"
$BinaryName = "wechatbot-echo-bot"

# ── Detect architecture ──────────────────────────────────────────────

function Get-Platform {
    $arch = if ([Environment]::Is64BitOperatingSystem) {
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or
            (Get-CimInstance Win32_Processor).Architecture -eq 12) {
            "arm64"
        } else {
            "amd64"
        }
    } else {
        Write-Error "32-bit systems are not supported"
        exit 1
    }
    return "windows-$arch"
}

# ── Resolve latest version ──────────────────────────────────────────

function Get-LatestVersion {
    if ($Version -ne "") { return $Version }

    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
        return $release.tag_name
    } catch {
        Write-Error "Could not determine latest version. Use -Version to specify."
        exit 1
    }
}

# ── Main ─────────────────────────────────────────────────────────────

$platform = Get-Platform
$ver = Get-LatestVersion
$url = "https://github.com/$Repo/releases/download/$ver/$BinaryName-$platform.exe"

Write-Host ""
Write-Host "  WeChatBot Echo Bot Installer" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Version:  $ver"
Write-Host "  Platform: $platform"
Write-Host "  URL:      $url"
Write-Host ""

# Create install directory
if (!(Test-Path $Dir)) {
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
}

$targetFile = Join-Path $Dir "$BinaryName.exe"

Write-Host "  Downloading..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $url -OutFile $targetFile -UseBasicParsing

Write-Host "  Installed to: $targetFile" -ForegroundColor Green
Write-Host ""

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$Dir*") {
    $addToPath = Read-Host "  Add $Dir to PATH? (Y/n)"
    if ($addToPath -ne "n" -and $addToPath -ne "N") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$Dir", "User")
        $env:Path = "$env:Path;$Dir"
        Write-Host "  Added to PATH (restart terminal to take effect)" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  To add manually, run:" -ForegroundColor Yellow
        Write-Host "  `$env:Path += `";$Dir`"" -ForegroundColor White
        Write-Host ""
    }
}

Write-Host ""
Write-Host "  Run: $BinaryName" -ForegroundColor Cyan
Write-Host ""
