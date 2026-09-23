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

#include <QRegularExpression>
#include <QString>
#include <QStringList>

namespace SonicPi
{

// The two rules about shader text that are reached only through a click, and are therefore the ones
// that would otherwise never be checked.
//
// They live in a header with no Qt widgets and no window so that tools/settings-probe can include this
// exact source and assert on it. Testing a copy would prove nothing: the copy is not what ships. This
// is the same reasoning that put the settings parsers in GraphicsSettings as free functions.
namespace ShaderText
{

// The first line number mentioned in a compiler diagnostic, or 0 when none is recognisable.
//
// Deliberately loose, because every driver words its diagnostics differently:
//
//   AMD Windows   ERROR: 0:5: '' :  syntax error, unexpected RIGHT_BRACE      (observed, real)
//   Mesa          0:12(5): error: syntax error, unexpected '}'
//   NVIDIA        0(12) : error C0000: syntax error, unexpected '}'
//
// They agree only that a line number appears among the first tokens, so this looks for a number in
// that position rather than trying to match any one vendor. Returning 0 means "offer no jump", which
// is the honest answer: a wrong guess moves the cursor to an unrelated line and reads as a bug in the
// editor rather than as a limitation of the message.
inline int firstErrorLine(const QString& compilerLog)
{
    // The longest line a shader is going to have. Also stops a large number in a driver's internal
    // code being read as a line number.
    constexpr int kMaxPlausibleLine = 100000;

    const QStringList lines = compilerLog.split(QLatin1Char('\n'), Qt::SkipEmptyParts);
    for (const QString& raw : lines)
    {
        const QString line = raw.trimmed();

        static const QRegularExpression colonForm(QStringLiteral("^\\d+\\s*:\\s*(\\d+)"));
        static const QRegularExpression parenForm(QStringLiteral("^\\d+\\s*\\(\\s*(\\d+)\\s*\\)"));
        static const QRegularExpression prefixedForm(
            QStringLiteral("^(?:ERROR|WARNING)\\s*:\\s*\\d*\\s*:?\\s*(\\d+)\\s*[:(]"));

        const QRegularExpression* forms[] = { &colonForm, &parenForm, &prefixedForm };
        for (const QRegularExpression* re : forms)
        {
            if (const QRegularExpressionMatch m = re->match(line); m.hasMatch())
            {
                const int n = m.captured(1).toInt();
                if (n > 0 && n <= kMaxPlausibleLine)
                    return n;
            }
        }
    }
    return 0;
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
