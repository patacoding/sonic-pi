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

#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QRegularExpression>
#include <QString>
#include <QStringList>

namespace SonicPi
{

// The rules about shader text that are reached only through a click, and are therefore the ones that
// would otherwise never be checked.
//
// They live in a header with no Qt widgets and no window so that tools/settings-probe can include this
// exact source and assert on it. Testing a copy would prove nothing: the copy is not what ships. This
// is the same reasoning that put the settings parsers in GraphicsSettings as free functions.
namespace ShaderText
{

// Where a compiler diagnostic points: a source string, and a line inside it.
//
// TWO numbers rather than one, because GLSL's own `#line line source-string-number` is what makes
// `#include` usable at all: inlining moves every line after the insertion point, so the renderer
// renumbers each included file as its own source string (graphics/ShaderInclude.h), and the driver
// reports the numbers it was given. Source string 0 is always the shader being compiled - which is
// also the honest reading of a driver that reports no source string at all, since such a driver
// cannot have been shown an include.
struct Diagnostic
{
    int sourceString = 0;
    int line = 0;

    bool found() const { return line > 0; }
};

namespace detail
{

// `ERROR: 0:5: ...` and `WARNING: 0:5: ...` are Qt's own prefixes in front of the driver's position.
// They are separated out so that every shape below can be anchored at the start of what follows,
// which is what keeps a number in the message text from being mistaken for a position.
inline QString severityPrefix(const QString& trimmedLine)
{
    static const QRegularExpression re(QStringLiteral("^((?:ERROR|WARNING)\\s*:\\s*)"));
    const QRegularExpressionMatch m = re.match(trimmedLine);
    return m.hasMatch() ? m.captured(1) : QString();
}

// A position as it appears in a line, once the severity prefix is off.
struct PositionText
{
    bool found = false;
    int sourceString = 0;
    int line = 0;
    int length = 0;   // how many characters of the line the position occupies
};

// The shapes real drivers use, tried in order because only they agree on anything:
//
//   AMD / Qt      0:5        source string then line
//   Mesa          0:12(5)    the same, with the column in brackets after it
//   NVIDIA        0(12)      source string then line, in brackets
//   bare          5:         a position with no source string at all
//
// The longest line a shader is going to have. Also stops a large number in a driver's internal code
// being read as a line number.
constexpr int kMaxPlausibleLine = 100000;

inline PositionText positionAt(const QString& textAfterPrefix)
{
    static const QRegularExpression colonForm(QStringLiteral("^(\\d+)\\s*:\\s*(\\d+)"));
    static const QRegularExpression parenForm(QStringLiteral("^(\\d+)\\s*\\(\\s*(\\d+)\\s*\\)"));
    static const QRegularExpression bareForm(QStringLiteral("^(\\d+)\\s*:"));

    struct Form
    {
        const QRegularExpression* re;
        bool namesSourceString;
    };
    const Form forms[] = { { &colonForm, true }, { &parenForm, true }, { &bareForm, false } };

    for (const Form& form : forms)
    {
        const QRegularExpressionMatch m = form.re->match(textAfterPrefix);
        if (!m.hasMatch())
            continue;

        const int sourceString = form.namesSourceString ? m.captured(1).toInt() : 0;
        const int line = (form.namesSourceString ? m.captured(2) : m.captured(1)).toInt();
        if (line <= 0 || line > kMaxPlausibleLine)
            continue;   // not a plausible line: try the next shape rather than reporting a guess

        PositionText position;
        position.found = true;
        position.sourceString = sourceString;
        position.line = line;
        position.length = m.capturedLength(0);
        return position;
    }

    return PositionText();
}

} // namespace detail

// The first position mentioned in a compiler diagnostic, or a Diagnostic with line 0 when none is
// recognisable.
//
// Deliberately loose, because every driver words its diagnostics differently:
//
//   AMD Windows   ERROR: 0:5: '' :  syntax error, unexpected RIGHT_BRACE      (observed, real)
//   Mesa          0:12(5): error: syntax error, unexpected '}'
//   NVIDIA        0(12) : error C0000: syntax error, unexpected '}'
//
// They agree only that a position appears among the first tokens, so this looks for one in that
// position rather than trying to match any one vendor. Not found means "offer no jump", which is the
// honest answer: a wrong guess moves the cursor to an unrelated line and reads as a bug in the editor
// rather than as a limitation of the message.
inline Diagnostic firstDiagnostic(const QString& compilerLog)
{
    const QStringList lines = compilerLog.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    for (const QString& raw : lines)
    {
        const QString line = raw.trimmed();
        const detail::PositionText position =
            detail::positionAt(line.mid(detail::severityPrefix(line).size()));
        if (position.found)
            return Diagnostic{ position.sourceString, position.line };
    }
    return Diagnostic();
}

// How a diagnostic should name a file: relative to the shader directory when the file is inside it,
// otherwise the whole path.
//
// Short enough to read in a report - "lib/noise.frag" rather than the user's home directory spelled
// out - and unambiguous either way, which the editor depends on: it decides whether to move the
// cursor by comparing this name with its own. A file outside the shader directory would come back as
// a trail of "..", which is longer than the path it was derived from and says nothing.
inline QString diagnosticName(const QString& filePath, const QString& shaderDirectory)
{
    if (shaderDirectory.isEmpty() || filePath.isEmpty())
        return QFileInfo(filePath).fileName();

    const QString relative = QDir(shaderDirectory).relativeFilePath(filePath);
    if (relative.startsWith(QLatin1String("..")))
        return filePath;
    return relative;
}

// A compiler log with every position named by the FILE it is in, plus the first position on its own.
//
// WHAT THIS IS FOR. The driver reports "1:11" for an error inside an included library, because that is
// the source string the renderer assigned it. The user has never seen that number and cannot act on
// it; what they need is "lib/noise.frag:11". The number is turned back into a name by looking it up in
// the table the expander produced - a lookup, not arithmetic, because the driver did the line
// renumbering for us (measured in tools/settings-probe/gl-line-directive-probe.cpp).
//
// The driver's wording is left exactly as it is: only the position it printed is replaced. A
// driver's diagnostic is the most useful thing in the report, and paraphrasing it would lose the part
// that matters.
struct Attribution
{
    QString log;
    // Empty when no diagnostic named a position, which is a normal outcome: some do not.
    QString file;
    int line = 0;

    bool found() const { return line > 0; }
};

inline Attribution attributeDiagnostics(const QString& compilerLog,
                                        const QString& rootPath,
                                        const QHash<int, QString>& fileBySourceString,
                                        const QString& shaderDirectory)
{
    const QString rootName = diagnosticName(rootPath, shaderDirectory);

    Attribution attribution;
    QStringList out;
    const QStringList lines = compilerLog.split(QLatin1Char('\n'));
    out.reserve(lines.size());

    for (const QString& line : lines)
    {
        const QString trimmed = line.trimmed();
        const QString prefix = detail::severityPrefix(trimmed);
        const int positionStart = line.indexOf(trimmed) + prefix.size();
        const detail::PositionText position = detail::positionAt(trimmed.mid(prefix.size()));

        if (!position.found)
        {
            out << line;
            continue;
        }

        const QString included = fileBySourceString.value(position.sourceString);
        const QString name = included.isEmpty() ? rootName
                                                : diagnosticName(included, shaderDirectory);

        if (attribution.line == 0)
        {
            attribution.file = name;
            attribution.line = position.line;
        }

        QString rewritten = line;
        rewritten.replace(positionStart, position.length,
                          QStringLiteral("%1:%2").arg(name).arg(position.line));
        out << rewritten;
    }

    attribution.log = out.join(QLatin1Char('\n'));
    return attribution;
}

// A shader file name with an extension, for a name that was saved without one.
//
// A shader the next dialog will not recognise is a file the user has to hunt for, so the extension is
// added - the same courtesy the audio buffer's save dialog extends.
//
// The check is on the FINAL path component, and getting that wrong is easy: "/home/me/v1.2/shader" has
// a dot but no extension and should gain one, while "/home/me/v1.2/shader.frag" must be left alone.
// Testing the whole string for a dot gets the first case wrong.
inline QString withFragmentExtension(const QString& fileName)
{
    const int slash = fileName.lastIndexOf(QLatin1Char('/'));
    const QString leaf = fileName.mid(slash + 1);
    if (leaf.contains(QLatin1Char('.')) && !leaf.endsWith(QLatin1Char('.')))
        return fileName;

    return fileName + QStringLiteral(".frag");
}

} // namespace ShaderText
} // namespace SonicPi
