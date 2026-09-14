# Windows: 폴더를 복사한 뒤 이 파일을 실행합니다.
# Cloudflare 서버는 건드리지 않습니다. 데이터는 ..\local-data 에 저장됩니다.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$python = $null
foreach ($name in @("python3", "python", "py")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source; break }
}
if (-not $python) {
    throw "Python 3이 없습니다. https://www.python.org/downloads/ 에서 설치한 뒤 다시 실행하세요."
}
if ((Split-Path $python -Leaf) -eq "py.exe") {
    & $python -3 "local/server.py" @args
} else {
    & $python "local/server.py" @args
}
