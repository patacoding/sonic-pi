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

#include "GraphicsSettings.h"

#include <QDir>
#include <QFile>
#include <QSettings>

namespace SonicPi
{
namespace GraphicsSettings
{

namespace
{

// Resolved once, on first use, the same way GraphicsLog resolves its directory.
//
// This module finds its own settings rather than being handed a QSettings by the
// GUI, for the same reason the log does: the render side has to work without the
// GUI, and depending on the GUI to say where its settings live would couple the
// two.
QString& cachedPath()
{
    static QString p;
    return p;
}

QString ensurePath()
{
    if (cachedPath().isEmpty())
    {
        QString home = qEnvironmentVariable("SONIC_PI_HOME");
        if (home.isEmpty())
            home = qEnvironmentVariable("USERPROFILE");
        if (home.isEmpty())
            home = QDir::homePath();

        const QString dir = home + QStringLiteral("/.sonic-pi/config");
        QDir().mkpath(dir);
        cachedPath() = dir + QStringLiteral("/graphics.ini");
    }
    return cachedPath();
}

// One-time move of the keys that used to live in the GUI's settings file.
//
// The feature's settings were briefly written to v5-gui-settings.ini under
// "prefs/graphics/". Anyone who ran that build has a window preference there, and
// silently resetting it would look like the window had forgotten how to remember
// itself. This reads the old file once and copies across only what the new file
// does not already have, then leaves the old keys alone - removing them from a
// file this module does not own is not its business, and they are inert.
//
// Runs at most once per process, and never after the new file exists, so it cannot
// fight with a user's current settings.
void migrateFromGuiSettingsOnce()
{
    static bool done = false;
    if (done)
        return;
    done = true;

    if (QFile::exists(ensurePath()))
        return;

    QString home = qEnvironmentVariable("SONIC_PI_HOME");
    if (home.isEmpty())
        home = qEnvironmentVariable("USERPROFILE");
    if (home.isEmpty())
        home = QDir::homePath();

    const QString oldPath = home + QStringLiteral("/.sonic-pi/config/v5-gui-settings.ini");
    if (!QFile::exists(oldPath))
        return;

    QSettings oldSettings(oldPath, QSettings::IniFormat);
    const QVariant show = oldSettings.value(QStringLiteral("prefs/graphics/show-output"));
    const QVariant cap = oldSettings.value(QStringLiteral("prefs/graphics/frame-cap-hz"));

    if (!show.isValid() && !cap.isValid())
        return;

    QSettings newSettings(ensurePath(), QSettings::IniFormat);
    if (show.isValid())
        newSettings.setValue(QStringLiteral("show-output"), show.toBool());
    if (cap.isValid())
        newSettings.setValue(QStringLiteral("frame-cap-hz"), cap.toInt());
    newSettings.sync();
}

QSettings open()
{
    migrateFromGuiSettingsOnce();
    return QSettings(ensurePath(), QSettings::IniFormat);
}

} // namespace

QString filePath()
{
    return ensurePath();
}

int frameCapHz()
{
    return open().value(QStringLiteral("frame-cap-hz"), 0).toInt();
}

bool showOutput()
{
    return open().value(QStringLiteral("show-output"), false).toBool();
}

void setFrameCapHz(int hz)
{
    QSettings s = open();
    s.setValue(QStringLiteral("frame-cap-hz"), hz);
    s.sync();
}

void setShowOutput(bool show)
{
    QSettings s = open();
    s.setValue(QStringLiteral("show-output"), show);
    s.sync();
}

} // namespace GraphicsSettings
} // namespace SonicPi
