@echo off
set WORKING_DIR=%CD%
set CONFIG=%1
set SCRIPT_DIR=%~dp0
cd %~dp0
if /I "%CONFIG%" == "" set CONFIG=Release

REM Anything after the config name is passed straight to cmake, so a caller can
REM state a developer switch for this configure without a second script that
REM would drift from this one. win-build-all.bat passes
REM -DSONIC_PI_GUI_ONLY=OFF, win-build-gui-only.bat passes ...=ON: the option is
REM a cache entry, so leaving it to the default would let whichever mode ran
REM last decide what the next full build does.
REM
REM QUOTE EVERY EXTRA ARGUMENT THAT CONTAINS AN `=`. cmd's own argument splitter
REM treats `=` as a delimiter - `,` and `;` too - so an unquoted
REM -DSONIC_PI_GUI_ONLY=ON arrives here as the TWO arguments
REM "-DSONIC_PI_GUI_ONLY" and "ON", cmake is handed `-DSONIC_PI_GUI_ONLY ON`,
REM reads `ON` as a second source directory and dies with "Parse error in
REM command line argument: SONIC_PI_GUI_ONLY". `%~2` strips the quotes again
REM before the value reaches the cmake command line, which is a plain string
REM and not re-split.
set "EXTRA_CMAKE_ARGS="
:collect_extra
if "%~2"=="" goto :extra_collected
set "EXTRA_CMAKE_ARGS=%EXTRA_CMAKE_ARGS% %~2"
shift
goto :collect_extra
:extra_collected

echo "Creating build directory..."
mkdir build > nul

echo "Generating project files..."
cd build

REM Note that we pass the CMAKE_BUILD_TYPE here only to enable the correct
REM build of the external projects. Visual Studio doesn't honour this when
REM configuring the makefile - it only honours it as a --config flag to cmake
REM itself. We therefore pass this via --config in the win0build-gui.bat file
REM explicitly, but as we also pass it in here it will be used by the cmake
REM build files for app/external

if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    set "VCPKG_TRIPLET=arm64-windows-static-md"
    set "CMAKE_ARCH=ARM64"
    set "QT_ARCH_DIR=msvc2022_arm64"
) else (
    set "VCPKG_TRIPLET=x64-windows-static-md"
    set "CMAKE_ARCH=x64"
    set "QT_ARCH_DIR=msvc2022_64"
)

if "%QT_INSTALL_LOCATION%"=="" call :detect_qt

set "VCPKG_ROOT=%SCRIPT_DIR%vcpkg"
set "VCPKG_TOOLCHAIN=%VCPKG_ROOT%\scripts\buildsystems\vcpkg.cmake"
set "VCPKG_FORCE_SYSTEM_BINARIES=1"

REM No -G: cmake honours %CMAKE_GENERATOR% if set, otherwise picks the
REM newest installed Visual Studio. CI can pin via env on the workflow.
cmake -A %CMAKE_ARCH% ^
      -DCMAKE_BUILD_TYPE=%CONFIG% ^
      -DCMAKE_TOOLCHAIN_FILE="%VCPKG_TOOLCHAIN%" ^
      -DVCPKG_TARGET_TRIPLET=%VCPKG_TRIPLET% ^
      -DKISSFFT_TOOLS=OFF -DKISSFFT_PKGCONFIG=OFF ^
      %EXTRA_CMAKE_ARGS% ^
      ..\

if %ERRORLEVEL% neq 0 goto :config_failed

cd %WORKING_DIR%
exit /b 0

:config_failed
REM A `goto` and not a parenthesised block, and that is the whole point.
REM
REM These two lines used to sit inside `if %ERRORLEVEL% neq 0 ( ... )`, where
REM cmd expands every %VAR% in the block when the block is PARSED - so
REM `exit /b %RC%` was expanded before `set "RC=%ERRORLEVEL%"` ever ran, RC was
REM still undefined, and the line became a bare `exit /b`. That exits with the
REM CURRENT errorlevel, which by then was 0, because the `set` and the `cd`
REM that ran in between both succeeded. A failed configure therefore returned
REM success, and every caller - win-build-all.bat, win-build-gui-only.bat,
REM build-dev.cmd - went on to build (or skip) as if the tree were configured.
REM Verified with a deliberately bad argument: `call win-config.bat Release
REM -DBADARG` used to print WIN_CONFIG_RETURNED=0 after cmake's "Parse error
REM in command line argument".
REM
REM Reachable now only by jumping here, where %RC% is expanded after the `set`.
set "RC=%ERRORLEVEL%"
cd %WORKING_DIR%
exit /b %RC%

:detect_qt
for /f "delims=" %%V in ('dir /b /ad "C:\Qt" 2^>nul') do call :try_qt_version "%%V"
if not defined QT_INSTALL_LOCATION goto :detect_qt_missing
echo Auto-detected Qt at %QT_INSTALL_LOCATION%
exit /b 0

:detect_qt_missing
echo WARNING: QT_INSTALL_LOCATION not set and no Qt6 found under C:\Qt
echo          CMake configure will fail at find_package(Qt6).
exit /b 0

:try_qt_version
echo %~1 | findstr /r "^6\." >nul
if errorlevel 1 exit /b 0
if exist "C:\Qt\%~1\%QT_ARCH_DIR%\lib\cmake\Qt6\Qt6Config.cmake" (
    set "QT_INSTALL_LOCATION=C:\Qt\%~1\%QT_ARCH_DIR%"
)
exit /b 0
