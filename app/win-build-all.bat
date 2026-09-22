@echo off
set WORKING_DIR=%CD%
set CONFIG=%1
if /I "%CONFIG%" == "" (set CONFIG=Release)

call "%~dp0win-prebuild.bat"
if errorlevel 1 goto :build_failed
call "%~dp0win-config.bat" %CONFIG%
if errorlevel 1 goto :build_failed
call "%~dp0win-build-gui.bat" %CONFIG%
if errorlevel 1 goto :build_failed

cd %WORKING_DIR%
exit /b 0

:build_failed
REM Capture the failing code BEFORE anything else runs.
REM
REM Both `echo` and `cd` reset ERRORLEVEL to 0, so the original
REM   echo ... %errorlevel% ... / cd %WORKING_DIR% / exit /b %errorlevel%
REM reported the failure and then returned 0. Any caller relying on the exit code
REM - CI, a wrapper script - saw success after a failed build, which is worse than
REM no reporting at all: the failure resurfaces much later as a mystery.
set "RC=%errorlevel%"
echo *** Build FAILED with errorlevel %RC% ***
cd %WORKING_DIR%
exit /b %RC%
