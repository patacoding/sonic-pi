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
#include "GraphicsLog.h"

#include <QDir>
#include <QFile>
#include <QSettings>

namespace SonicPi
{
namespace GraphicsSettings
{

namespace
{

// All keys live in one group.
//
// This is not cosmetic. QSettings writes a key with no group into a "[General]"
// section, but a read with a bare key name does NOT look inside that section - so a
// value written as "show-output" and then read as "show-output" travels through two
// different places and never comes back. The symptom is a setting that saves
// correctly, appears in the file, and is silently never honoured again, because the
// reader only ever sees its default.
//
// That is exactly what this module shipped with: the output window opened once, the
// app saved the preference, and from then on the window never appeared again while
// graphics.ini plainly said "show-output". Every access now goes through one of the
// two helpers below, so the two halves cannot drift apart again.
const QString kGroup = QStringLiteral("General");

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

QVariant readSetting(const QString& key, const QVariant& fallback)
{
    QSettings s(ensurePath(), QSettings::IniFormat);
    s.beginGroup(kGroup);
    const QVariant v = s.value(key, fallback);
    s.endGroup();
    return v;
}

void writeSetting(const QString& key, const QVariant& value)
{
    QSettings s(ensurePath(), QSettings::IniFormat);
    s.beginGroup(kGroup);
    s.setValue(key, value);
    s.endGroup();
    s.sync();
}

// One-time move of the keys that briefly lived in the GUI's settings file.
//
// An early revision of this feature wrote its settings to v5-gui-settings.ini under
// "prefs/graphics/", which is what the settings were explicitly meant not to do.
// Anyone who ran that build has a window preference sitting there, and dropping it
// silently would look like the window had forgotten how to remember itself. So the
// old keys are read once and copied across, then left alone in the old file -
// deleting keys from a file this module does not own is not its business, and they
// are inert.
//
// Runs at most once per process, and never when the new file already exists, so it
// cannot fight with a user's current settings.
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

    // Written through the same helper the readers use, so the migrated value lands
    // where it will actually be found.
    if (show.isValid())
        writeSetting(QStringLiteral("show-output"), show.toBool());
    if (cap.isValid())
        writeSetting(QStringLiteral("frame-cap-hz"), cap.toInt());
}

} // namespace

QString filePath()
{
    return ensurePath();
}

int frameCapHz()
{
    migrateFromGuiSettingsOnce();
    return readSetting(QStringLiteral("frame-cap-hz"), 0).toInt();
}

QSize outputSize()
{
    migrateFromGuiSettingsOnce();

    const int w = readSetting(QStringLiteral("output-width"), kDefaultOutputWidth).toInt();
    const int h = readSetting(QStringLiteral("output-height"), kDefaultOutputHeight).toInt();

    // Guard here rather than at every use: a size of zero or less would make the
    // render target allocation fail, and a config file is easy to get wrong by
    // hand. Falling back to the default keeps the feature usable after a typo
    // instead of leaving a blank window.
    if (w <= 0 || h <= 0)
    {
        GraphicsLog::warn(QStringLiteral("graphics.ini has an invalid output size %1x%2; using %3x%4")
                              .arg(w).arg(h)
                              .arg(kDefaultOutputWidth)
                              .arg(kDefaultOutputHeight));
        return QSize(kDefaultOutputWidth, kDefaultOutputHeight);
    }

    return QSize(w, h);
}

void setOutputSize(const QSize& size)
{
    writeSetting(QStringLiteral("output-width"), size.width());
    writeSetting(QStringLiteral("output-height"), size.height());
}

bool showOutput()
{
    migrateFromGuiSettingsOnce();
    return readSetting(QStringLiteral("show-output"), false).toBool();
}

void setFrameCapHz(int hz)
{
    writeSetting(QStringLiteral("frame-cap-hz"), hz);
}

void setShowOutput(bool show)
{
    writeSetting(QStringLiteral("show-output"), show);
}

} // namespace GraphicsSettings
} // namespace SonicPi
