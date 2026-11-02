cmake_minimum_required(VERSION 3.13)
set(APP_ROOT ${CMAKE_CURRENT_LIST_DIR})

# Read canonical version from /VERSION (one repo-root file, also read by
# Ruby runtime). Strip any dev/RC suffix so PROJECT_VERSION stays X.Y.Z
# for CMake/macOS bundle plumbing; the full string goes to config.h.
file(READ "${APP_ROOT}/../VERSION" SONIC_PI_VERSION)
string(STRIP "${SONIC_PI_VERSION}" SONIC_PI_VERSION)
string(REGEX MATCH "^[0-9]+\\.[0-9]+\\.[0-9]+" SONIC_PI_VERSION_NUMERIC "${SONIC_PI_VERSION}")

# Different triplet for windows
if (WIN32)
    if(CMAKE_SYSTEM_PROCESSOR STREQUAL "ARM64" OR CMAKE_SYSTEM_PROCESSOR STREQUAL "aarch64")
        set(VCPKG_TARGET_TRIPLET arm64-windows-static-md CACHE STRING "triplet")
    else()
        set(VCPKG_TARGET_TRIPLET x64-windows-static-md CACHE STRING "triplet")
    endif()
endif()

# vcpkg toolchain - Must be declared before project

if (WIN32 OR APPLE)
  set(CMAKE_TOOLCHAIN_FILE ${APP_ROOT}/vcpkg/scripts/buildsystems/vcpkg.cmake CACHE STRING "Vcpkg toolchain file")
endif()

project(SonicPi)

message(STATUS "CMakeLists: Sonic Pi")



# Sonic Pi Requires a C++ 20 Compiler to build it
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set_property(GLOBAL PROPERTY USE_FOLDERS ON)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set_property(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR} PROPERTY VS_STARTUP_PROJECT ${PROJECT_NAME})

if(APPLE)
  # Must stay in sync with LSMinimumSystemVersion in mac-release-03-info-plist.sh
  # and the MACOSX_DEPLOYMENT_TARGET export in mac-build-all.sh. The release
  # pipeline's stage 08 compat audit fails if any bundled Mach-O's minos
  # exceeds this floor.
  set(CMAKE_OSX_DEPLOYMENT_TARGET "14")
endif()


if (NOT APP_INSTALL_ROOT)
    set(APP_INSTALL_ROOT ${APP_ROOT})
endif()

# Absolute location of the installed Sonic Pi tree (the directory holding
# etc/ and app/). Left empty for development and for the macOS/Windows
# bundles, which locate their own resources relative to the executable.
# Distribution packagers that split the tree across the filesystem set this
# to the fixed install prefix, e.g. -DSONIC_PI_INSTALL_ROOT=/usr/lib/sonic-pi
set(SONIC_PI_INSTALL_ROOT "" CACHE PATH "Absolute root of an installed Sonic Pi tree")

list(APPEND CMAKE_MODULE_PATH ${APP_ROOT}/cmake)
include(cmake/utils.cmake)
include(cmake/common.cmake)

# GUI-only iteration (a developer switch, not a way to build Sonic Pi).
#
# Two things here have nothing to do with the GUI and between them dominate a
# no-change rebuild:
#
#   * SuperSonic, the audio engine. external/CMakeLists.txt adds it with
#     BUILD_ALWAYS ON, so that an edit under app/external/... is picked up
#     without deleting stamp files - which means the nested CMake + cargo
#     build is re-entered on every single build.
#   * windeployqt (gui/CMakeLists.txt), which re-copies the Qt runtime and
#     every .qm translation into the output directory after every link.
#
# With this ON both are dropped: the engine binary is taken as the last engine
# build left it, and the deployed Qt runtime is left alone. What remains is
# compiling and linking the GUI, which is all that changes while working on
# app/gui (the graphics subsystem among it).
#
# It is a cache entry, so it STICKS until something sets it again. Every entry
# point in this tree therefore states the mode it configures rather than
# relying on the default: win-build-all.bat passes OFF, win-build-gui-only.bat
# passes ON. Otherwise a full build would silently inherit a leftover ON and
# produce a binary with a stale engine and no deployed Qt.
#
# OFF by default, and not a supported way to build or package Sonic Pi: a tree
# built this way is only guaranteed complete for GUI work.
option(SONIC_PI_GUI_ONLY "Developer: skip rebuilding the audio engine and the Qt deploy step (GUI-only iteration)" OFF)
if(SONIC_PI_GUI_ONLY)
    message(STATUS "SONIC_PI_GUI_ONLY=ON: the audio engine will not be rebuilt and windeployqt will not run.")
endif()

configure_file(${APP_ROOT}/cmake/config.h.cmake ${CMAKE_BINARY_DIR}/config.h)

add_subdirectory(external)
# Vendored Spout2 — Windows-only sibling to external/Syphon-Framework.
if(WIN32)
    add_subdirectory(external/Spout2)
endif()
add_subdirectory(api)
add_subdirectory(api-tests)
add_subdirectory(gui)
add_subdirectory(gui-tests)

option(BUILD_SPOUT_SMOKETEST "Build tools/spout-receiver smoke-test (Windows)" OFF)
if(WIN32 AND BUILD_SPOUT_SMOKETEST)
    add_subdirectory(tools/spout-receiver)
endif()
