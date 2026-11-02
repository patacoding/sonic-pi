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
#include "GraphicsDocuments.h"
#include "GraphicsLog.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QRegularExpression>
#include <QSettings>

namespace SonicPi
{
namespace GraphicsSettings
{

namespace
{

// Keys are read and written at the ROOT of the file, with no group.
//
// This is the opposite of what an earlier version of this module did, and the earlier
// version was wrong in a way that was invisible for exactly as long as nobody set a value:
//
//   QSettings with IniFormat treats "[General]" as the file's ROOT section. A key written
//   with beginGroup("General") does NOT land there - it lands in a real child group
//   literally named "General", which Qt then has to escape on disk as "[%General]" because
//   a child group must not be called "General". And a key inside that child group is
//   invisible to a root-level read.
//
//   Measured, with a standalone QSettings reproduction against a file containing
//   "[General] frame-cap-hz=144":
//
//     allKeys()                    -> ("frame-cap-hz", "output-height", "output-width", ...)
//     beginGroup("General"); allKeys() -> ()          <- the child group is empty
//     value("General/frame-cap-hz")-> -1              <- and so is this
//     value("frame-cap-hz")        -> 144             <- the root read is the one that works
//
//   So every getter returned its default and every setter wrote somewhere nothing reads.
//   The symptom was twofold and looked like two unrelated bugs: a file that grows a
//   mysterious empty "[%General]" section, and preferences that appear in the file yet are
//   never honoured - the frame rate cap silently ran at the renderer's default 60Hz while
//   graphics.ini said 144.
//
// Both halves are fixed by using no group at all, which is what Qt means by "[General]".

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
    return s.value(key, fallback);
}

void writeSetting(const QString& key, const QVariant& value)
{
    QSettings s(ensurePath(), QSettings::IniFormat);
    s.setValue(key, value);
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

bool parseOutputSize(const QString& text, QSize* sizeOut)
{
    static const QRegularExpression pair(
        QStringLiteral("^\\s*(\\d+)\\s*[xX*\u00d7,]\\s*(\\d+)\\s*$"));
    static const QRegularExpression single(QStringLiteral("^\\s*(\\d+)\\s*$"));

    int w = 0;
    int h = 0;
    if (const QRegularExpressionMatch m = pair.match(text); m.hasMatch())
    {
        w = m.captured(1).toInt();
        h = m.captured(2).toInt();
    }
    else if (const QRegularExpressionMatch m = single.match(text); m.hasMatch())
    {
        w = h = m.captured(1).toInt();
    }
    else
    {
        return false;
    }

    if (w <= 0 || h <= 0 || w > kMaxOutputDimension || h > kMaxOutputDimension)
        return false;

    if (sizeOut)
        *sizeOut = QSize(w, h);
    return true;
}

bool parseFrameRateHz(const QString& text, int* hzOut)
{
    static const QRegularExpression number(QStringLiteral("^\\s*(\\d+)\\s*$"));
    const QRegularExpressionMatch m = number.match(text);
    if (!m.hasMatch())
        return false;

    const int hz = m.captured(1).toInt();
    if (hz <= 0 || hz > kMaxFrameRateHz)
        return false;

    if (hzOut)
        *hzOut = hz;
    return true;
}

// ---------------------------------------------------------------------------------------------
// Shader files
// ---------------------------------------------------------------------------------------------

QString shaderDirectoryPath()
{
    QString home = qEnvironmentVariable("SONIC_PI_HOME");
    if (home.isEmpty())
        home = qEnvironmentVariable("USERPROFILE");
    if (home.isEmpty())
        home = QDir::homePath();

    return home + QStringLiteral("/.sonic-pi/graphics/shaders");
}

QString fragmentFileName(const QString& shaderName)
{
    // A name that already looks like a file is not double-suffixed: callers pass a name, but the
    // editor's own import path can hand over a file name, and "default.frag.frag" would be a file
    // nobody can find.
    if (shaderName.endsWith(QStringLiteral(".frag")))
        return shaderName;

    return shaderName + QStringLiteral(".frag");
}

QString activeShaderName()
{
    migrateFromGuiSettingsOnce();
    const QString stored = readSetting(QStringLiteral("active-buffer"), QString()).toString().trimmed();
    if (stored.isEmpty())
        return defaultShaderName();

    // A name is a file name without its extension; a stored "noise.frag" is accepted rather than
    // treated as a different buffer, because the two spellings can only mean the same file.
    return stored.endsWith(QStringLiteral(".frag")) ? stored.chopped(5) : stored;
}

void setActiveShaderName(const QString& shaderName)
{
    if (shaderName.trimmed().isEmpty())
        return;
    writeSetting(QStringLiteral("active-buffer"), shaderName);
}

QStringList shaderNames()
{
    const QDir dir(shaderDirectoryPath());
    if (!dir.exists())
        return QStringList{ defaultShaderName() };

    QStringList names;
    const QStringList files = dir.entryList(QStringList{ QStringLiteral("*.frag") }, QDir::Files,
                                            QDir::Name | QDir::IgnoreCase);
    for (const QString& file : files)
        names << file.chopped(5);   // ".frag"

    // The default buffer always exists as a name, even before its file does: it is what a fresh session
    // renders, and a menu or tab bar with nothing in it would look broken rather than empty.
    if (!names.contains(defaultShaderName(), Qt::CaseInsensitive))
        names.prepend(defaultShaderName());

    return names;
}

QStringList documentNames()
{
    QStringList names;

    // Both kinds come from one scan: the rule for "what is a document" lives there, and nowhere else.
    const QList<GraphicsDocument> documents = scanGraphicsDocuments(shaderDirectoryPath());
    for (const GraphicsDocument& document : documents)
        names << document.name;

    // Same guarantee as shaderNames(): the default buffer is always a name, even before its file exists.
    if (!names.contains(defaultShaderName(), Qt::CaseInsensitive))
        names.prepend(defaultShaderName());

    return names;
}

bool spoutPublish()
{
    migrateFromGuiSettingsOnce();
    return readSetting(QStringLiteral("publish-spout"), false).toBool();
}

void setSpoutPublish(bool publish)
{
    writeSetting(QStringLiteral("publish-spout"), publish);
}


QString writableShaderPath(const QString& fileName)
{
    return shaderDirectoryPath() + QLatin1Char('/') + fileName;
}

QString shippedShaderDirectory()
{
    // WHERE THE SHADERS THAT SHIP WITH THE APPLICATION LIVE, resolved AT RUNTIME, beside the executable.
    //
    // This used to be a COMPILE-TIME ABSOLUTE PATH into the checkout, expanded by CMake at configure time
    // (`GRAPHICS_SHADER_DIR`). That is wrong in three ways, and a packaged build shows all three at once:
    //
    //   * IT NAMES A DIRECTORY THAT ONLY EXISTS ON THE MACHINE THAT BUILT IT. Every other machine got a
    //     fallback pointing at `C:/Users/<the builder>/...`, so a fresh install with no ~/.sonic-pi had no
    //     shader at all - the graphics output could not start - and every failure message printed the
    //     builder's home directory into the user's log. Measured on a packaged build:
    //         renderer: shader 'default/image.frag' not found. Looked in:
    //             <user home>/.sonic-pi/graphics/shaders/default/image.frag
    //             C:/Users/<builder>/my/dev/.../app/gui/graphics/shaders/default/image.frag
    //   * The files WERE copied next to the executable by CMake, but the compiled-in path did not point
    //     there, so the copy was invisible to the code that needed it.
    //   * It baked a developer's directory layout into a shipped binary.
    //
    // The candidates now, in order - all relative to the running executable, which is the one place every
    // packager carries (the portable build ships `app/gui/build/Release/` wholesale; the MSI stages the same
    // directory, and a full development build is no different):
    //
    //     <exe>/graphics/shaders      ← beside the executable
    //     <exe>/../graphics/shaders   ← one level up, for a layout that keeps binaries in a subdirectory
    //
    // The second is what makes this independent of how deep the executable sits: Sonic Pi's own tree keeps
    // it three levels down, and that is a packaging decision, not something this function should assume.
    const QString beside = QCoreApplication::applicationDirPath() + QStringLiteral("/graphics/shaders");
    if (QFileInfo::exists(beside))
        return beside;

    const QString oneUp = QDir(QCoreApplication::applicationDirPath() + QStringLiteral("/.."))
                              .absoluteFilePath(QStringLiteral("graphics/shaders"));
    if (QFileInfo::exists(oneUp))
        return oneUp;

    // Nothing found. The executable-relative path is the honest answer to report, because that is where a
    // packaged copy belongs - and a message naming a path inside the installation is actionable, while one
    // naming the build machine is not.
    return beside;
}

QString shaderPath(const QString& fileName)
{
    // AN ABSOLUTE PATH IS ALREADY AN ANSWER. The callers that resolve a document's pass files know exactly
    // which file they mean (that is what graphicsDocumentPassFilePath() computed), so re-resolving it against
    // a directory can only lose information - and when the document is a single-pass .frag it DID lose it:
    // the pass chain asked for "<name>/image.frag" while the file was "<name>.frag", which is the
    // "shader 'default/image.frag' not found" this fixes.
    if (QDir::isAbsolutePath(fileName))
        return QFile::exists(fileName) ? fileName : QString();

    // User copy first: this is the one to edit, and editing it cannot dirty the source tree.
    const QString userPath = writableShaderPath(fileName);
    if (QFile::exists(userPath))
        return userPath;

    // Then the copy shipped with the application.
    const QString shipped = shippedShaderDirectory() + QLatin1Char('/') + fileName;
    if (QFile::exists(shipped))
        return shipped;

    return QString();
}


QString ensureShaderFile(const QString& fileName)
{
    const QString target = writableShaderPath(fileName);
    if (QFile::exists(target))
        return target;   // already the user's, and left exactly as they left it

    const QString shipped = shippedShaderDirectory() + QLatin1Char('/') + fileName;
    if (!QFile::exists(shipped))
    {
        GraphicsLog::warn(QStringLiteral("shader: no shipped copy of %1 to seed from (looked in %2)")
                              .arg(fileName, shipped));
        return QString();
    }

    QDir().mkpath(shaderDirectoryPath());
    if (!QFile::copy(shipped, target))
    {
        GraphicsLog::warn(QStringLiteral("shader: could not copy %1 to %2; the editor will open the "
                                         "shipped copy instead")
                              .arg(shipped, target));
        return QString();
    }

    // Reported because this is the moment the file the user edits comes into existence, and knowing
    // which directory that is saves looking it up.
    GraphicsLog::info(QStringLiteral("shader: seeded %1 from the shipped copy").arg(target));
    return target;
}

} // namespace GraphicsSettings
} // namespace SonicPi
