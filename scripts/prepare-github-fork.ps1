param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[^/\s]+/[^/\s]+$")]
    [string]$Repository,

    [string]$RemoteUrl = "",

    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$rawBaseUrl = "https://raw.githubusercontent.com/$Repository/$Branch"
$image = "ghcr.io/${Repository}:latest"
$remote = if ($RemoteUrl) { $RemoteUrl } else { "https://github.com/$Repository.git" }

$filesToPatch = @(
    "deploy/README.md",
    "deploy/.env.example",
    "SECONDARY_DEVELOPMENT.md"
)

foreach ($file in $filesToPatch) {
    if (-not (Test-Path $file)) {
        throw "Expected file not found: $file"
    }

    $content = Get-Content -Raw -LiteralPath $file
    $content = $content.Replace("<your-org>/<your-repo>", $Repository)
    $content = $content.Replace("https://raw.githubusercontent.com/$Repository/main", $rawBaseUrl)
    Set-Content -LiteralPath $file -Value $content -Encoding UTF8 -NoNewline
}

if (Get-Command git -ErrorAction SilentlyContinue) {
    $origin = git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0) {
        git remote set-url origin $remote
    }
    else {
        git remote add origin $remote
    }
}
else {
    Write-Warning "git was not found in PATH. Remote was not updated."
}

Write-Host "Prepared fork metadata for $Repository"
Write-Host "Origin remote: $remote"
Write-Host "Container image: $image"
Write-Host "One-click command:"
Write-Host "curl -fsSL $rawBaseUrl/deploy/one-click-install.sh | sudo env ZTNET_IMAGE=$image bash"
