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

#include "GraphicsLog.h"

#include <QDateTime>
#include <QDir>
#include <QHash>
#include <QMutex>
#include <QMutexLocker>

#include <cstdio>

namespace SonicPi
{
namespace GraphicsLog
{

namespace
{

// Resolved once, on first use.
//
// Graphics resolves this itself rather than being handed a path by the GUI. The
// feature has to work the same whether or not the GUI is up, and depending on
// the GUI to tell it where to log would couple the two - which is exactly what
// this module exists to avoid.
//
// The convention is Sonic Pi's own, matching app/server/ruby/paths.rb and
// app/api/src/sonicpi_api.cpp: $SONIC_PI_HOME, else %USERPROFILE%, then
// "<home>/.sonic-pi/log".
QString resolveDirectory()
{
    QString home = qEnvironmentVariable("SONIC_PI_HOME");
    if (home.isEmpty())
        home = qEnvironmentVariable("USERPROFILE");
    if (home.isEmpty())
        home = QDir::homePath();

    QString dir = home + QStringLiteral("/.sonic-pi/log");
    QDir().mkpath(dir);
    return dir;
}

QMutex& logMutex()
{
    static QMutex m;
    return m;
}

QString& cachedDirectory()
{
    static QString d;
    return d;
}

QString& cachedPath()
{
    static QString p;
    return p;
}

QString ensurePath()
{
    if (cachedPath().isEmpty())
    {
        cachedDirectory() = resolveDirectory();
        cachedPath() = cachedDirectory() + QStringLiteral("/graphics.log");
    }
    return cachedPath();
}

const char* levelTag(Level level)
{
    switch (level)
    {
    case Level::Warn:  return "WARN ";
    case Level::Error: return "ERROR";
    default:           return "info ";
    }
}

Sink& sinkSlot()
{
    static Sink s;
    return s;
}

// Guards the sink against being replaced while an entry is being delivered, and
// lets the copy be taken without holding the log mutex - a sink is free to log
// again, and doing that under the mutex would deadlock.
QMutex& sinkMutex()
{
    static QMutex m;
    return m;
}

} // namespace

void setSink(Sink sink)
{
    QMutexLocker lock(&sinkMutex());
    sinkSlot() = std::move(sink);
}

QString directoryPath()
{
    QMutexLocker lock(&logMutex());
    ensurePath();
    return cachedDirectory();
}

QString filePath()
{
    QMutexLocker lock(&logMutex());
    return ensurePath();
}

void write(Level level, const QString& msg)
{
    const QString stamp =
        QDateTime::currentDateTime().toString(QStringLiteral("HH:mm:ss.zzz"));

    // Multiline messages are indented so a multi-line block reads as one record.
    const QString payload = QStringLiteral("[%1] [%2] %3\n")
                                .arg(stamp, QString::fromLatin1(levelTag(level)),
                                     QString(msg).replace(QLatin1Char('\n'),
                                                          QStringLiteral("\n           ")));

    {
        QMutexLocker lock(&logMutex());

        const QString path = ensurePath();

        // Opened per entry rather than kept open: CycleLogs() truncates and
        // replaces files underneath us at startup, so a handle held across that
        // would keep writing to a rotated file. Opening per write is cheap at the
        // rate this logs, and is correct regardless of what else touches the
        // directory.
        //
        // Written with a single fwrite so concurrent writers cannot interleave
        // mid-line even if the file is opened by more than one handle.
        if (FILE* f = _wfopen(reinterpret_cast<const wchar_t*>(path.utf16()), L"ab"))
        {
            const QByteArray utf8 = payload.toUtf8();
            std::fwrite(utf8.constData(), 1, size_t(utf8.size()), f);
            std::fclose(f);
        }
        // If the open fails there is nowhere left to report it: stdout is not
        // reliable here (it is only redirected once the GUI boots) and stderr is
        // not redirected at all. The failure is therefore silent by necessity,
        // which is why directoryPath() exists - a caller that needs to prove
        // logging works can check the resolved location instead of trusting this
        // call.
    }

    // Hand the entry to the GUI, if one registered a sink.
    //
    // Deliberately after the file mutex is released and on a copy of the sink:
    // a sink is allowed to log, and doing that while holding the mutex would
    // deadlock on a non-recursive QMutex. The message is passed as written
    // rather than as the file's padded payload, so a sink decides its own
    // layout.
    Sink sink;
    {
        QMutexLocker lock(&sinkMutex());
        sink = sinkSlot();
    }
    if (sink)
        sink(level, msg);
}

void info(const QString& msg)
{
    write(Level::Info, msg);
}

void warn(const QString& msg)
{
    write(Level::Warn, msg);
}

void error(const QString& msg)
{
    write(Level::Error, msg);
}

void throttled(Level level, const QString& msg, int intervalMs)
{
    struct Entry
    {
        qint64 lastMs = 0;
        int    suppressed = 0;
    };
    // Keyed on level+message. Only touched here, and the state update happens
    // under the same mutex write() uses, so it is safe from several threads.
    static QHash<QString, Entry> seen;

    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const QString key = QString::number(int(level)) + QLatin1Char('\x1f') + msg;

    bool shouldEmit = false;
    int dropped = 0;
    {
        QMutexLocker lock(&logMutex());
        Entry& e = seen[key];
        if (e.lastMs == 0 || now - e.lastMs >= intervalMs)
        {
            shouldEmit = true;
            dropped = e.suppressed;
            e.suppressed = 0;
            e.lastMs = now;
        }
        else
        {
            ++e.suppressed;
        }
    }

    if (!shouldEmit)
        return;

    if (dropped > 0)
    {
        write(level, QStringLiteral("%1  (+%2 identical suppressed)").arg(msg).arg(dropped));
    }
    else
    {
        write(level, msg);
    }
}

} // namespace GraphicsLog
} // namespace SonicPi
