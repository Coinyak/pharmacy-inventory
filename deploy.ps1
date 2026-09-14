# Cloudflare Pages 배포 스크립트
# 사용법: PowerShell에서 이 파일 실행
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== Cloudflare Pages 배포 ===" -ForegroundColor Cyan
Write-Host "프로젝트: pharmacy-inventory"
Write-Host "URL: https://pharmacy-inventory-4pv.pages.dev"
Write-Host ""

# 기존 운영 주소의 소유 권한은 이 프로젝트의 .env 전용 API 토큰에 있다.
# 브라우저 OAuth 로그인 계정은 사용하지 않는다. 토큰 값은 출력하지 않는다.
$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
    throw ".env 파일이 없어 기존 Pages 프로젝트에 안전하게 배포할 수 없습니다."
}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*(.+?)\s*$') {
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        Set-Item -Path "Env:$($Matches[1])" -Value $value
    }
}
if (-not $env:CLOUDFLARE_API_TOKEN -or -not $env:CLOUDFLARE_ACCOUNT_ID) {
    throw ".env에 Cloudflare 배포 자격증명이 완전하지 않습니다."
}

# 로그인 확인
$whoami = & "C:\Program Files\nodejs\npx.cmd" wrangler whoami 2>&1
if ($whoami -match "not authenticated") {
    Write-Host "Cloudflare 로그인이 필요합니다." -ForegroundColor Yellow
    Write-Host "브라우저가 열리면 로그인을 완료해 주세요..." -ForegroundColor Yellow
    & "C:\Program Files\nodejs\npx.cmd" wrangler login
}

Write-Host "배포 중..." -ForegroundColor Green
& "C:\Program Files\nodejs\npx.cmd" wrangler pages deploy public --project-name pharmacy-inventory --commit-dirty=true

Write-Host ""
Write-Host "배포 완료! Ctrl+F5로 새로고침 후 확인:" -ForegroundColor Green
Write-Host "https://pharmacy-inventory-4pv.pages.dev"
