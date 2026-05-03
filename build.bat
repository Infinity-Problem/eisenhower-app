@echo off
REM Build Eisenhower.exe — single-file Windows binary.
REM Run from this folder. Output lands in dist\Eisenhower.exe.

setlocal
cd /d "%~dp0"

where pyinstaller >nul 2>&1
if errorlevel 1 (
    echo Installing PyInstaller...
    python -m pip install --upgrade pyinstaller
)

echo.
echo Cleaning old build artifacts...
if exist build rmdir /s /q build
if exist dist  rmdir /s /q dist

echo.
echo Building Eisenhower.exe...
python -m PyInstaller --noconfirm Eisenhower.spec
if errorlevel 1 (
    echo BUILD FAILED.
    exit /b 1
)

echo.
echo Done. Output: dist\Eisenhower.exe
echo.
endlocal
