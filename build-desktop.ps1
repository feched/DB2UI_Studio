# Сборка DB2UI Studio: один exe + установщик.
#
#   .\build-desktop.ps1
#   .\build-desktop.ps1 -SkipInstaller
#   .\build-desktop.ps1 -InstallInno     # поставить Inno Setup через winget
#
# Результат:
#   dist\DB2UI Studio.exe
#   dist\installer\DB2UI-Studio-Setup-<версия>.exe

param(
    [switch]$SkipInstaller,
    [switch]$SkipDeps,
    [switch]$InstallInno,
    [string]$Version = "1.2.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "Не найден .venv. Создайте окружение: python -m venv .venv"
}

if (-not $SkipDeps) {
    Write-Host "[1/4] Проверка зависимостей сборки..." -ForegroundColor Cyan
    & $python -m pip install --disable-pip-version-check -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) { throw "Не удалось установить зависимости." }
} else {
    Write-Host "[1/4] Зависимости пропущены (-SkipDeps)." -ForegroundColor DarkGray
}

Write-Host "[2/4] Иконка приложения..." -ForegroundColor Cyan
& $python tools\make_icon.py
if ($LASTEXITCODE -ne 0) { throw "Не удалось создать иконку." }

Write-Host "[3/4] Сборка exe (PyInstaller)..." -ForegroundColor Cyan
& $python -m PyInstaller --noconfirm --clean desktop.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller завершился с ошибкой." }

$exe = Join-Path $root "dist\DB2UI Studio.exe"
if (-not (Test-Path $exe)) { throw "Не найден собранный файл: $exe" }
$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "      Готово: $exe ($sizeMb МБ)" -ForegroundColor Green

if ($SkipInstaller) {
    Write-Host "[4/4] Установщик пропущен (-SkipInstaller)." -ForegroundColor DarkGray
    return
}

function Find-Iscc {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

$iscc = Find-Iscc
if (-not $iscc -and $InstallInno) {
    Write-Host "      Inno Setup не найден, устанавливаю через winget..." -ForegroundColor Yellow
    & winget install --id JRSoftware.InnoSetup --exact --silent `
        --accept-package-agreements --accept-source-agreements
    $iscc = Find-Iscc
}

if (-not $iscc) {
    Write-Warning "Inno Setup не найден. EXE собран, установщик пропущен."
    Write-Warning "Установите Inno Setup 6 (https://jrsoftware.org/isdl.php) и повторите:"
    Write-Warning "  .\build-desktop.ps1 -SkipDeps"
    return
}

Write-Host "[4/4] Сборка установщика (Inno Setup)..." -ForegroundColor Cyan
& $iscc "/DMyAppVersion=$Version" "installer\db2ui.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup завершился с ошибкой." }

$setup = Get-ChildItem (Join-Path $root "dist\installer") -Filter "DB2UI-Studio-Setup-*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($setup) {
    $setupMb = [math]::Round($setup.Length / 1MB, 1)
    Write-Host "      Установщик: $($setup.FullName) ($setupMb МБ)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Готово. Установщик создаёт ярлыки и не требует прав администратора." -ForegroundColor Green
exit 0
