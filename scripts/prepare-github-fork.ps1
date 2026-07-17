param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[^/\s]+/[^/\s]+$")]
    [string]$Repository,

    [string]$RemoteUrl = "",

    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$SourceRepository = "csbsgyl/ztnet-custom"
$Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$image = "ghcr.io/${Repository}:latest"
$remote = if ($RemoteUrl) { $RemoteUrl } else { "https://github.com/$Repository.git" }
$sourceImage = "ghcr.io/${SourceRepository}:latest"
$targetImage = "ghcr.io/${Repository}:latest"

$repositoryFiles = @(
    "README.md",
    "docs/docs/Installation/docker-compose.md",
    "SECONDARY_DEVELOPMENT.md",
    "scripts/prepare-github-fork.ps1",
    "src/server/systemUpdate.ts",
    "src/server/api/__tests__/systemUpdate/systemUpdate.test.ts",
    "src/__tests__/pages/admin/systemUpdate.test.tsx"
)

foreach ($file in $repositoryFiles) {
    if (-not (Test-Path $file)) {
        throw "Expected file not found: $file"
    }

    $content = Get-Content -Raw -LiteralPath $file
    $content = $content.Replace($SourceRepository, $Repository)
    [System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $file).Path, $content, $Utf8NoBom)
}

$imageFiles = @(
    "deploy/.env.example",
    "deploy/docker-compose.yml",
    "deploy/one-click-install.sh"
)

foreach ($file in $imageFiles) {
    if (-not (Test-Path $file)) {
        throw "Expected file not found: $file"
    }

    $content = Get-Content -Raw -LiteralPath $file
    $content = $content.Replace($sourceImage, $targetImage)
    [System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $file).Path, $content, $Utf8NoBom)
}

$installerTest = "deploy/tests/one-click-install-test.sh"
if (-not (Test-Path $installerTest)) {
    throw "Expected file not found: $installerTest"
}
$sourceRepositoryDeclaration = '$SourceRepository = "' + $SourceRepository + '"'
$targetRepositoryDeclaration = '$SourceRepository = "' + $Repository + '"'
$content = Get-Content -Raw -LiteralPath $installerTest
$content = $content.Replace($sourceImage, $targetImage)
$content = $content.Replace($sourceRepositoryDeclaration, $targetRepositoryDeclaration)
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $installerTest).Path, $content, $Utf8NoBom)

$installerPath = "deploy/one-click-install.sh"
$installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
$deploymentGuide = "deploy/README.md"
if (-not (Test-Path $deploymentGuide)) {
    throw "Expected file not found: $deploymentGuide"
}
$content = Get-Content -Raw -LiteralPath $deploymentGuide
$content = $content.Replace("repo='$SourceRepository'", "repo='$Repository'")
$content = $content.Replace($sourceImage, $targetImage)
$checksumLinePattern = '(?m)^printf .*sha256sum -c -\r?$'
$checksumLines = [regex]::Matches($content, $checksumLinePattern)
if ($checksumLines.Count -ne 2) {
    throw "Expected exactly two installer checksum lines in $deploymentGuide"
}
foreach ($checksumLine in $checksumLines) {
    if (-not [regex]::IsMatch($checksumLine.Value, '[0-9a-f]{64}')) {
        throw "Installer checksum line did not contain a lowercase SHA-256 value."
    }
    $updatedChecksumLine = [regex]::Replace(
        $checksumLine.Value,
        '[0-9a-f]{64}',
        $installerSha256
    )
    $content = $content.Replace($checksumLine.Value, $updatedChecksumLine)
}
[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $deploymentGuide).Path, $content, $Utf8NoBom)

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
Write-Host "Installer SHA-256: $installerSha256"
Write-Host "Deployment guide: https://github.com/$Repository/blob/$Branch/deploy/README.md"
Write-Host "Download the installer at an immutable commit, verify its SHA-256, and run the verified local file."
