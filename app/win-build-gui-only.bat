@echo off
REM ============================================================================
REM  GUI-only iteration build - the fast path for work under app/gui/
REM
REM  Use it while editing app/gui (the graphics subsystem among it). It skips
REM  everything a GUI edit cannot have invalidated:
REM
REM    win-prebuild.bat   Ruby tutorial translation and Qt doc generation
REM                       (~73s), vcpkg install, submodule update
REM    win-config.bat     cmake configure (~12s) - except the one-off below
REM    SuperSonic         the nested CMake + cargo engine build
REM    windeployqt        the Qt runtime / translation deploy step
REM
REM  Measured on this tree: 129s for win-build-all.bat versus ~15s here, with
REM  the engine and deployment both untouched.
REM
REM  Usage:
REM     win-build-gui-only.bat            -> Release
REM     win-build-gui-only.bat Debug      -> Debug
REM
REM  A GUI-only build is NOT a Sonic Pi build. It does not promise that the
REM  audio engine, the audio-side sources under app/external/... or the
REM  deployed Qt runtime are current - it assumes a full build has already
REM  produced them, and it says so on every run. Before testing anything
REM  audio-side, or packaging, run win-build-all.bat (or ..\..\build-dev.cmd).
REM ============================================================================
setlocal

set "SCRIPT_DIR=%~dp0"
set "CONFIG=%~1"
if /I "%CONFIG%"=="" set "CONFIG=Release"

set "BUILD_DIR=%SCRIPT_DIR%build"
if not exist "%BUILD_DIR%\CMakeCache.txt" (
    echo ERROR: no build tree at %BUILD_DIR%
    echo        Run win-build-all.bat once first: this path assumes a tree that
    echo        already built, because it takes the engine binary and the Qt
    echo        deployment as they are.
    exit /b 1
)

REM SONIC_PI_GUI_ONLY is a cache entry. Configure only when it is not already
REM ON, so consecutive GUI-only builds cost nothing for configure - but never
REM assume it: a full build turns it back off, on purpose.
findstr /C:"SONIC_PI_GUI_ONLY:BOOL=ON" "%BUILD_DIR%\CMakeCache.txt" >nul 2>&1
if errorlevel 1 (
    echo Configuring the build tree for GUI-only iteration ^(one-off^)...
    REM Quoted: `=` is an argument delimiter to cmd, so an unquoted
    REM -DSONIC_PI_GUI_ONLY=ON would arrive at win-config.bat as two arguments.
    call "%SCRIPT_DIR%win-config.bat" %CONFIG% "-DSONIC_PI_GUI_ONLY=ON"
    if errorlevel 1 (
        echo ERROR: configure failed; nothing was built.
        exit /b 1
    )
)

echo.
echo === GUI-only build: the audio engine and the Qt deploy step are NOT rebuilt ===
echo === Run a full build before testing audio or packaging                    ===
echo.

REM win-build-gui.bat does the generated-docs freshness check and then builds,
REM so this shares one code path with the normal build instead of copying it.
REM "sonic-pi" as the second argument builds the executable and its project
REM references only - see the note in win-build-gui.bat. Measured here, that is
REM ~12s instead of ~19s for a no-change build, and it is exactly the right
REM scope for this mode: nothing else in the tree can have changed either.
call "%SCRIPT_DIR%win-build-gui.bat" %CONFIG% sonic-pi
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo GUI-ONLY BUILD FAILED with errorlevel %RC%
    endlocal & exit /b %RC%
)

echo GUI-ONLY BUILD SUCCEEDED
echo Output: %SCRIPT_DIR%build\gui\%CONFIG%\sonic-pi.exe
endlocal & exit /b 0
