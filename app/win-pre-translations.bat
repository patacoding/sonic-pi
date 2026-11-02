@echo off
set WORKING_DIR=%CD%

cd %~dp0

REM Prefer the vendored Ruby (server\native\ruby, a junction/symlink created
REM by CI) if present, otherwise fall back to whatever `ruby` is on PATH.
REM Mirrors mac-prebuild.sh so a fresh checkout with only a system Ruby can
REM still run the prebuild tooling.
set RUBY=server\native\ruby\bin\ruby
if exist "%RUBY%.exe" (
    echo Found bundled Ruby: %RUBY%
) else (
    echo Bundled Ruby not found - using system Ruby
    set RUBY=ruby
)

echo Translating tutorial...
"%RUBY%" server/ruby/bin/i18n-tool.rb -t
if %ERRORLEVEL% neq 0 (
    cd %WORKING_DIR%
    exit /b %ERRORLEVEL%
)

echo Generating docs for the Qt GUI...

REM Snapshot before generating, restore timestamps after.
REM
REM qt-doc.rb writes its outputs unconditionally and the `copy /Y` below does the
REM same, so every build rewrote gui/utils/ruby_help.h - unchanged, but with a new
REM timestamp. MSBuild took that as a real edit and recompiled every translation
REM unit including it, mainwindow.cpp among them: a build with no source changes
REM measured 220s. The helper puts the original modification time back on any file
REM whose CONTENT is identical, so a generated file only looks new when it is.
REM
REM A failure here is not fatal: worst case an unchanged file is left with a fresh
REM timestamp and the build is merely as slow as it was before.
set "GEN_SNAP=%TEMP%\sp-icons"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0utils\keep-unchanged-files.ps1" -Mode Snapshot -LiveDir "%~dp0gui\utils" -Store "%GEN_SNAP%" >nul 2>&1

copy /Y gui\utils\ruby_help.tmpl gui\utils\ruby_help.h
"%RUBY%" server/ruby/bin/qt-doc.rb
if %ERRORLEVEL% neq 0 (
    cd %WORKING_DIR%
    exit /b %ERRORLEVEL%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0utils\keep-unchanged-files.ps1" -Mode Restore -LiveDir "%~dp0gui\utils" -Store "%GEN_SNAP%"
if exist "%GEN_SNAP%" rmdir /S /Q "%GEN_SNAP%" >nul 2>&1

cd %WORKING_DIR%
exit /b 0
