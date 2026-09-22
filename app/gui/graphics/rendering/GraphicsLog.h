//--
// This file is part of Sonic Pi: http://sonic-pi.net
// Full project source: https://github.com/sonic-pi-net/sonic-pi
// License: https://github.com/sonic-pi-net/sonic-pi/blob/main/LICENSE.md
//
// Copyright 2026 by Sam Aaron (http://sam.aaron.name).
// All rights reserved.
//
// Permission is granted for use, copying, modification, and
// distribution of modified versions of this work as long as this
// notice is included.
//++

#pragma once

#include <QString>

namespace SonicPi
{
namespace GraphicsLog
{

// The graphics feature's own log, <home>/.sonic-pi/log/graphics.log.
//
// Why a separate file rather than the GUI's stdout redirection and why the
// module resolves the path itself are both explained in GraphicsLog.cpp. The
// short version is that graphics must not depend on the GUI's startup order,
// and its records have to survive independently so a development run leaves
// evidence behind.
//
// Every entry is timestamped and written with a single fwrite, so entries from
// different threads cannot interleave.
//
// SonicPiAPI::CycleLogs() rotates this file with the other logs on startup: the
// previous session is copied to log/history/<timestamp>/ and the live file is
// truncated. So after a fresh start, graphics.log contains only the current
// session - look in the history directory for earlier ones.

// Level prefix, so a run can be skimmed for problems.
enum class Level
{
    Info,
    Warn,
    Error,
};

// Append one timestamped line. Safe to call from any thread.
void write(Level level, const QString& msg);

// Convenience wrappers.
void info(const QString& msg);
void warn(const QString& msg);
void error(const QString& msg);

// Fire-and-forget logging for code that can run every frame.
//
// Repeated identical messages are suppressed within a rolling window, with a
// note recording how many were dropped. This exists because a log call inside a
// render loop is an easy mistake with a disproportionate result: one such call
// produced 7790 entries and a 3.2 MB log in 154 seconds. Prefer this over
// info()/warn()/error() in anything frame-rate driven.
void throttled(Level level, const QString& msg, int intervalMs = 1000);

// Where the log actually goes, resolved. Useful to report in the one place that
// can still reach the user if the log itself cannot be opened.
QString filePath();

// Absolute path to the log directory, for callers that want to place related
// artefacts beside the log.
QString directoryPath();

} // namespace GraphicsLog
} // namespace SonicPi
