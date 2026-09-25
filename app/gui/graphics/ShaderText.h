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

// The source with comments blanked out, newlines and length kept.
//
// Only ever used to ask "does this shader say X in code?", a question a comment must not be able to
// answer: a shader with `// uniform float iTime;` commented out still has to be given iTime, and a
// shader whose only mention of iTime is in its explanatory header must still work.
//
// A character-for-character scan rather than a regular expression, because the two comment forms nest
// the only way they can nest (`//` inside `/* */` is not a thing, but `/*` inside `//` is text) and a
// regex for that is a puzzle. GLSL has no string literals, so there is no third case a `//` could be
// hiding in.
inline QString withoutComments(const QString& source)
{
    QString out;
    out.reserve(source.size());

    bool inLine = false;
    bool inBlock = false;
    for (int i = 0; i < source.size(); ++i)
    {
        const QChar c = source.at(i);
        const QChar next = (i + 1 < source.size()) ? source.at(i + 1) : QChar();

        if (inLine)
        {
            if (c == QLatin1Char('\n'))
            {
                inLine = false;
                out += c;
            }
            else
            {
                out += QLatin1Char(' ');
            }
            continue;
        }

        if (inBlock)
        {
            if (c == QLatin1Char('*') && next == QLatin1Char('/'))
            {
                inBlock = false;
                out += QLatin1String("  ");
                ++i;
            }
            else
            {
                out += (c == QLatin1Char('\n')) ? c : QLatin1Char(' ');
            }
            continue;
        }

        if (c == QLatin1Char('/') && next == QLatin1Char('/'))
        {
            inLine = true;
            out += QLatin1String("  ");
            ++i;
            continue;
        }
        if (c == QLatin1Char('/') && next == QLatin1Char('*'))
        {
            inBlock = true;
            out += QLatin1String("  ");
            ++i;
            continue;
        }

        out += c;
    }

    return out;
}

// The offset just past the end of the `#version` line, or -1 when the source has none.
//
// The pattern is the one ShaderInclude's versionDirective() uses, deliberately: "what counts as a version
// directive" must not have two answers. A shader whose version line the expander recognises but this does
// not would get its declarations pushed in front of `#version` - a compile error about #version, pointing
// at a line the user never wrote.
inline int endOfVersionLine(const QString& source)
{
    static const QRegularExpression re(QStringLiteral("^\\s*#\\s*version\\b"));

    int lineStart = 0;
    while (lineStart <= source.size())
    {
        int lineEnd = source.indexOf(QLatin1Char('\n'), lineStart);
        if (lineEnd < 0)
            lineEnd = source.size();

        if (re.match(source.mid(lineStart, lineEnd - lineStart)).hasMatch())
            return (lineEnd < source.size()) ? lineEnd + 1 : lineEnd;   // past the newline

        if (lineEnd >= source.size())
            break;
        lineStart = lineEnd + 1;
    }

    return -1;
}

} // namespace detail

// The four frame values, declared FOR the shader: what makes a ShaderToy-style shader work as it is.
//
// The renderer has always PUSHED these four values, but only into uniforms the shader declares itself -
// and a ShaderToy shader declares none of them, because ShaderToy declares them for you. So the claim in
// docs/graphics-uniforms.md 1 ("a ShaderToy shader can be used directly") was true of the names and
// false in practice: pasting a shader that used `iTime` gave "undefined variable iTime". Found by the
// user doing exactly that, which is how a contract that was never exercised gets found.
//
// WHERE THEY GO: immediately after `#version`, which is the only place GLSL allows - the version
// directive must be the first thing in the shader. The include expander puts its own `#line` resync
// right after that directive, and this goes IN FRONT of it, so the numbers the driver reports for the
// user's own lines do not move.
//
// NOT DECLARED TWICE: a name the shader already declares is left exactly as it is. Declaring it here as
// well is a redefinition error, and shaders written before this existed DO declare them - the examples
// in the docs do. Their declaration wins, and which names were added travels back to the caller so it
// can be reported rather than assumed.
struct BuiltinUniforms
{
    QString text;
    // Names declared by this function, in the order they are written into the source.
    QStringList declared;
    // Names the shader declares itself, therefore left alone.
    QStringList leftToShader;
};

inline BuiltinUniforms withBuiltinUniforms(const QString& source)
{
    struct Entry
    {
        const char* name;
        const char* declaration;
    };

    // The types are the contract, not a choice made here: the renderer sets iResolution with a vec2 and
    // iFrame with an int, and a wrong declaration would receive a silently wrong value rather than
    // failing (docs/graphics-uniforms.md 1).
    static const Entry kEntries[] = {
        { "iResolution", "uniform vec2  iResolution;" },
        { "iTime", "uniform float iTime;" },
        { "iTimeDelta", "uniform float iTimeDelta;" },
        { "iFrame", "uniform int   iFrame;" },
    };

    BuiltinUniforms result;
    result.text = source;

    // Comments are removed for the QUESTION only; the source itself keeps them. A commented-out
    // declaration must not stop the real declaration from being added: `// uniform float iTime;` is not
    // a declaration, and a shader left with it would report "undefined variable iTime" while showing the
    // user a line that looks like it declares it.
    const QString code = detail::withoutComments(source);

    QStringList declarations;
    for (const Entry& entry : kEntries)
    {
        const QString name = QString::fromLatin1(entry.name);

        // A DECLARATION, not a mention: `uniform` before the name, and identifier boundaries around it,
        // so `uniform float iTimeScale;` is not read as `iTime`. The scan stops at `;` and braces, so it
        // cannot run from one statement into the next.
        const QRegularExpression re(QStringLiteral("\\buniform\\b[^;{}]*\\b%1\\b").arg(name));
        if (re.match(code).hasMatch())
        {
            result.leftToShader << name;
            continue;
        }

        result.declared << name;
        declarations << QString::fromLatin1(entry.declaration);
    }

    if (declarations.isEmpty())
        return result;   // the shader declares all four itself: nothing to add, source untouched

    // Two lines of explanation, because this text ends up in front of the user's shader in the source
    // that was compiled - and because the second line is the answer to "why does my own declaration
    // still work?".
    QString preamble = QStringLiteral(
        "// The four frame values, declared by Sonic Pi (ShaderToy naming and semantics).\n"
        "// Declare one of them yourself and yours is kept instead of this one.\n");
    preamble += declarations.join(QLatin1Char('\n'));
    preamble += QLatin1Char('\n');

    const int afterVersion = detail::endOfVersionLine(source);
    if (afterVersion >= 0)
    {
        result.text = source.left(afterVersion) + preamble + source.mid(afterVersion);
    }
    else
    {
        // No `#version` to sit under, so they go first - and a `#line` of our own hands the user's own
        // line numbers back, which the insertion would otherwise shift by the length of this preamble. A
        // shader with no version directive has a problem of its own, and that problem must still be
        // reported where it really is rather than ten lines further down.
        result.text = preamble + QStringLiteral("#line 1 0\n") + source;
    }

    return result;
}

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
