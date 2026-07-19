# Cloudflare Pages 배포 스크립트
# 사용법: PowerShell에서 이 파일 실행
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== Cloudflare Pages 배포 ===" -ForegroundColor Cyan
Write-Host "프로젝트: pharmacy-inventory"
Write-Host "URL: https://pharmacy-inventory-4pv.pages.dev"
Write-Host ""

# 이 머신의 CLOUDFLARE_API_TOKEN은 다른 계정으로 연결되어 있어
# Pages 프로젝트 소유 계정의 저장된 Wrangler 자격증명을 우선 사용한다.
if (Test-Path Env:CLOUDFLARE_API_TOKEN) {
    Write-Host "CLOUDFLARE_API_TOKEN을 무시하고 Pages 저장 자격증명으로 배포합니다." -ForegroundColor Yellow
    Remove-Item Env:CLOUDFLARE_API_TOKEN
    Write-Host ""
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
