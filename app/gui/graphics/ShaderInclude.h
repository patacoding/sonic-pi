#pragma once

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

#include <QHash>
#include <QRegularExpression>
#include <QSet>
#include <QString>
#include <QStringList>

#include <functional>

namespace SonicPi
{
namespace ShaderInclude
{

// `#include` for GLSL, which has none of its own.
//
// Core GLSL has no include directive, and GL_ARB_shading_language_include is an extension that wants
// each file handed to the driver separately - not something to depend on. So the expansion happens
// here, in text, before the source is compiled, and the driver sees one ordinary shader.
//
// WHY THIS IS A PURE FUNCTION. Everything difficult about includes is text: what a directive looks
// like, what happens when two files include each other, what happens when the same function is
// pulled in twice. None of that needs a GL context, a window or a running Sonic Pi, so none of it is
// tested through one - tools/settings-probe/shader-include-check.cpp includes THIS header and
// asserts on it directly (docs/dev-discipline.md 4.1). Reading files is the caller's job: a
// Resolver returns the source it found, which also lets the probe run entirely in memory.
//
// Design and rationale: docs/shader-includes-plan.md.
//
// THE LINE NUMBERS. Inlining moves every line after the insertion point, which would make a
// compiler diagnostic point at the wrong place - and, for an error inside an included file, point at
// a line of the user's file that means nothing at all. GLSL's `#line line source-string-number`
// fixes this properly: the second argument is the SOURCE STRING NUMBER the driver reports in its
// diagnostics, which is what the leading `0` in "ERROR: 0:5:" has always been. Each included file
// gets its own number, so:
//
//     #line 1 1          ← "the lines that follow are line 1 of source string 1"
//     <contents of the included file>
//     #line k+1 0        ← "back to line k+1 of source string 0", the shader being compiled
//
// The driver then reports the ORIGINAL numbers, with the source string saying which file - so
// attributing a diagnostic needs a lookup, not arithmetic. fileBySourceString below is that lookup.

// One resolved file: where it came from and what it says. `found` false means the caller could not
// find it, and the message it returns is what the user is shown.
struct Source
{
    bool found = false;
    // Identity used for de-duplication and in the report. It should be the CANONICAL path of the file,
    // because two spellings of one file ("lib/a.frag" and "./lib/a.frag", or a difference of case on
    // Windows) are one file and would otherwise be inlined twice - which is a redefinition error that
    // reads as if the user wrote the same function twice.
    QString path;
    QString text;
    // Why not, when the resolver can say something more specific than "cannot find" - an absolute path,
    // say, which is never used here. The expander prefixes this with the file and line, so the user is
    // told where the mistake is written and what is wrong with it.
    QString error;
};

// Resolve the name written in a directive.
//
// THE RULE, and there is only one: a name is a path RELATIVE TO THE FILE BEING COMPILED (the root of
// the expansion), and nothing else is searched. Not the including file's own directory, not a search
// path, not the source tree. One base directory, stated in the report whenever resolution fails, and
// the user is left to organise the files - which is the whole of the design (KISS: the directory IS
// the library).
//
// `includingPath` is passed for the message, not for the lookup: with one base directory it cannot
// change the answer, and it is what lets the report name the file that wrote the directive.
//
// The expander itself knows nothing about directories: reading files is the caller's job, which is
// what lets the probe run the whole thing in memory (docs/dev-discipline.md 4.1).
using Resolver = std::function<Source(const QString& name, const QString& includingPath)>;

// One file that was inlined: which one, and how much of it arrived. The two travel together
// because a log line that named a file without saying how much of it was taken would not answer
// "did the whole library come in?" - which is the question a reader has.
struct Included
{
    QString path;
    int lines = 0;
};

struct Result
{
    bool ok = false;
    // The source to compile: the root file with every include expanded.
    QString text;
    // One line, for the user, when ok is false.
    QString error;
    // What was inlined, in the order it was first inlined. For the log line, and for the reader who
    // wants to know what a shader actually pulled in.
    QList<Included> included;
    // The file behind each source-string number the driver will report. 0 is not in here: it is the
    // root, which the caller already knows.
    QHash<int, QString> fileBySourceString;

    // The file a diagnostic came from, given the source-string number the driver reported. A number
    // nobody assigned means the driver ignored the directives, and the honest answer is the root.
    QString fileForSourceString(int sourceString) const
    {
        if (sourceString <= 0)
            return QString();
        return fileBySourceString.value(sourceString);
    }
};

namespace detail
{

// A directive, at the start of a line: `#include "name"` or `#include <name>`, with an optional
// trailing // comment. Leading whitespace is allowed because GLSL allows it before `#`.
inline const QRegularExpression& includeDirective()
{
    static const QRegularExpression re(
        QStringLiteral("^\\s*#\\s*include\\s*([<\"])([^\">]+)[\">]\\s*(?://.*)?$"));
    return re;
}

inline const QRegularExpression& versionDirective()
{
    static const QRegularExpression re(QStringLiteral("^\\s*#\\s*version\\b"));
    return re;
}

// A line that MEANT to be an include but is not a well formed one. Checked after the strict form has
// failed, so a typo gets an explanation from us rather than a driver error about an unknown
// directive.
inline const QRegularExpression& includeKeyword()
{
    static const QRegularExpression re(QStringLiteral("^\\s*#\\s*include\\b"));
    return re;
}

// Blocks of the same line count we can leave alone, but a `#include` that LOOKS like a directive
// while sitting inside a /* */ comment would be inlined into the comment and corrupt the file. A
// one-bit comment state per line is enough to avoid that trap: GLSL strings cannot span lines.
inline bool startsOrEndsInsideComment(const QString& line, bool inComment)
{
    for (int i = 0; i < line.size(); ++i)
    {
        if (inComment)
        {
            if (line.at(i) == QLatin1Char('*') && i + 1 < line.size()
                && line.at(i + 1) == QLatin1Char('/'))
            {
                inComment = false;
                ++i;
            }
        }
        else
        {
            if (line.at(i) == QLatin1Char('/') && i + 1 < line.size())
            {
                const QChar next = line.at(i + 1);
                if (next == QLatin1Char('/'))
                    break;   // line comment: nothing after it is code
                if (next == QLatin1Char('*'))
                {
                    inComment = true;
                    ++i;
                }
            }
        }
    }
    return inComment;
}

} // namespace detail

// How many lines a file has, the way an editor counts them: a trailing newline ends the last line
// rather than starting an empty one, and an empty file has none.
inline int countLines(const QString& text)
{
    if (text.isEmpty())
        return 0;
    const int newlines = text.count(QLatin1Char('\n'));
    return text.endsWith(QLatin1Char('\n')) ? newlines : newlines + 1;
}

// The line of an entry point definition in `text`, or 0 when there is none.
//
// WHY THIS IS A RULE AND NOT A STYLE POINT. A root shader and a shared library are told apart by one
// thing the user decided: the library has no entry point, only utility functions. That is what makes
// "check a library, install a root" possible at all - and it is checked here, at the include, because
// the alternative is the driver's own wording for the same mistake:
//
//     ERROR: 0:9: 'main' : function already has a body
//
// (measured - tools/settings-probe/gl-main-probe.cpp). True, but it says nothing about libraries, and
// it points into the concatenated source rather than at the line the user wrote. This function lets the
// report say which file, which line, and why.
//
// Comment state is tracked because a library may well *discuss* main in a comment, and a `//` or `/* */`
// line is not a definition. The pattern is strict for the same reason: GLSL's entry point is declared
// `void main(...)`, so a line has to begin with that to match.
inline int entryPointLine(const QString& text)
{
    static const QRegularExpression re(QStringLiteral("^\\s*void\\s+main\\s*\\("));

    const QStringList lines = text.split(QLatin1Char('\n'));
    bool inComment = false;
    for (int i = 0; i < lines.size(); ++i)
    {
        const bool wasInComment = inComment;
        inComment = detail::startsOrEndsInsideComment(lines.at(i), inComment);
        if (!wasInComment && re.match(lines.at(i)).hasMatch())
            return i + 1;
    }
    return 0;
}

// Expand every include in `source`, in place, depth first.
//
// Rules, each with a reason:
//
//   * The same file is inlined ONCE, however many times it is included. Inlining a function
//     definition twice is a redefinition error, so C's "expand every time" semantics would be wrong
//     here. The skip still emits a `#line` resync, because it removes a line from the output.
//   * A cycle is an error naming the chain, not a recursion to death.
//   * An included file must not carry `#version`: GLSL allows one, and it belongs to the shader being
//     compiled. Two would not compile, so this is caught here where it can be explained.
//   * An include above the root's `#version` is an error: GLSL requires #version to come first, and
//     inlining before it would break that quietly.
//
// AND ONE THING THIS DOES FOR EVERY SHADER, INCLUDES OR NOT. Qt's QOpenGLShaderProgram does not pass
// the source through unchanged: it hoists a `#version` directive to the top, inserts its own
// `#version`-relative preamble, and then emits `#line 1` before the rest. A shader that starts with
// `#version` therefore has every line AFTER it reported one line early - measured, not deduced, in
// tools/settings-probe/gl-line-directive-probe.cpp, which prints the processed source Qt hands the
// driver. The fix is a `#line` of our own right after the directive: "the next line really is line
// k+1 of source string 0". Correct whether or not Qt hoists anything, because it is simply true.
inline Result expand(const QString& source, const QString& rootPath, const Resolver& resolve)
{
    Result result;

    QString out;
    int nextSourceString = 1;
    bool inBlockComment = false;

    // The root's own #version, if it has one: its line number is both the last line an include may
    // not precede, and where the line-number resync has to go.
    int rootVersionLine = 0;
    {
        const QStringList rootLines = source.split(QLatin1Char('\n'));
        for (int i = 0; i < rootLines.size(); ++i)
        {
            if (detail::versionDirective().match(rootLines.at(i)).hasMatch())
            {
                rootVersionLine = i + 1;
                break;
            }
        }
    }

    QSet<QString> expanded;
    expanded.insert(rootPath);
    QStringList stack;
    stack << rootPath;

    // Every refusal below reports the same three things: WHERE the directive is written, WHAT is wrong
    // with it, and the CHAIN of includes that led there. The chain is not decoration: with libraries
    // including other libraries, "cannot find lib/noise.frag" is a question about which file to open
    // and fix, and the answer is the last name in the chain.
    const auto failure = [&stack](const QString& file, int line, const QString& what) {
        return QStringLiteral("%1:%2: %3\n  include chain: %4")
            .arg(file)
            .arg(line)
            .arg(what, stack.join(QStringLiteral(" -> ")));
    };

    // Depth-first, writing into `out`. Returns false with result.error set on the first problem.
    std::function<bool(const QString&, const QString&, int, bool)> expandInto;

    expandInto = [&](const QString& file, const QString& text, int sourceString, bool isRoot) -> bool
    {
        // \r is stripped rather than kept: a shader saved on Windows would otherwise carry a stray
        // character into the driver's view of the line.
        QStringList lines = text.split(QLatin1Char('\n'));
        for (QString& line : lines)
        {
            if (line.endsWith(QLatin1Char('\r')))
                line.chop(1);
        }

        for (int i = 0; i < lines.size(); ++i)
        {
            const QString& line = lines.at(i);
            const int lineNumber = i + 1;

            const bool wasInComment = inBlockComment;
            inBlockComment = detail::startsOrEndsInsideComment(line, inBlockComment);

            if (!wasInComment)
            {
                const QRegularExpressionMatch match = detail::includeDirective().match(line);
                if (!match.hasMatch() && detail::includeKeyword().match(line).hasMatch())
                {
                    // Meant as an include, is not one. Saying so beats handing the driver an unknown
                    // directive and reporting whatever it makes of that.
                    result.error = failure(file, lineNumber,
                                           QStringLiteral("#include needs a file name in quotes, as in "
                                                          "#include \"common.frag\""));
                    return false;
                }

                if (match.hasMatch())
                {
                    const QString name = match.captured(2);
                    const QString delimiter = match.captured(1);

                    if (name.isEmpty())
                    {
                        result.error = failure(file, lineNumber,
                                               QStringLiteral("#include needs a file name"));
                        return false;
                    }

                    // Only the root's own #version matters, and only as a line to stay below: GLSL
                    // requires it first, and an expansion above it would break that quietly.
                    if (isRoot && rootVersionLine > 0 && lineNumber < rootVersionLine)
                    {
                        result.error = failure(file, lineNumber,
                                               QStringLiteral("#include comes before #version. GLSL "
                                                              "requires #version to be the first thing "
                                                              "in the shader, so move the include below "
                                                              "it."));
                        return false;
                    }

                    const Source found = resolve(name, file);
                    if (!found.found)
                    {
                        // A resolver that can say something specific (an absolute path, say) is
                        // preferred over the generic message: it is the difference between "I cannot
                        // find it" and "this is not how files are named here".
                        result.error = failure(file, lineNumber,
                                               found.error.isEmpty()
                                                   ? QStringLiteral("cannot find \"%1\"").arg(name)
                                                   : found.error);
                        return false;
                    }

                    // A directive that closes with the other delimiter is a typo, not a lookup.
                    if (delimiter == QLatin1String("<") && !line.contains(QLatin1Char('>')))
                    {
                        result.error = failure(file, lineNumber,
                                               QStringLiteral("#include \"%1\" is missing its closing "
                                                              "bracket").arg(name));
                        return false;
                    }

                    // A cycle first, and NOT as a special case of "already expanded": a file that is
                    // on the stack right now is being expanded at this moment, which is a cycle
                    // however many times it has been seen before. Being in `expanded` while NOT on
                    // the stack is the ordinary duplicate - inlined once, skipped afterwards.
                    if (stack.contains(found.path))
                    {
                        QStringList chain = stack;
                        chain << found.path;
                        result.error = QStringLiteral("%1:%2: \"%3\" includes itself: %4")
                                           .arg(file).arg(lineNumber).arg(found.path,
                                                                          chain.join(QStringLiteral(" -> ")));
                        return false;
                    }

                    const bool duplicate = expanded.contains(found.path);

                    if (!duplicate && detail::versionDirective().match(found.text).hasMatch())
                    {
                        result.error = failure(file, lineNumber,
                                               QStringLiteral("\"%1\" contains a #version directive. "
                                                              "GLSL allows only one, and it belongs to "
                                                              "the shader being compiled, so an included "
                                                              "file must not have one.").arg(found.path));
                        return false;
                    }

                    // The other thing an included file must not be: a program. A library is utility
                    // functions; the entry point belongs to the shader that includes it (see
                    // entryPointLine above for why the driver's own message is not enough).
                    if (!duplicate)
                    {
                        const int entryPoint = entryPointLine(found.text);
                        if (entryPoint > 0)
                        {
                            result.error = failure(
                                file, lineNumber,
                                QStringLiteral("\"%1\" defines an entry point (line %2: void main). An "
                                               "included file is a shared library and must be utility "
                                               "functions only - the entry point belongs to the shader "
                                               "that includes it.").arg(found.path).arg(entryPoint));
                            return false;
                        }
                    }

                    if (!duplicate)
                    {
                        // Recorded BEFORE expanding, so a second include of the same file is seen as a
                        // duplicate rather than expanded again.
                        expanded.insert(found.path);

                        const int assigned = nextSourceString++;
                        result.included.append(Included{ found.path, countLines(found.text) });
                        result.fileBySourceString.insert(assigned, found.path);

                        // The lines of the included file are numbered from 1 in the driver's
                        // diagnostics because of this directive, which is what makes attribution a
                        // lookup rather than arithmetic.
                        out += QStringLiteral("#line 1 %1\n").arg(assigned);

                        stack << found.path;
                        const bool ok = expandInto(found.path, found.text, assigned, false);
                        stack.removeLast();
                        if (!ok)
                            return false;
                    }

                    // Back to the root's own numbering. Emitted for a skip as well as for an
                    // expansion, because a skipped directive still disappears from the output and the
                    // driver would otherwise number everything after it one line early.
                    //
                    // A file whose text does not end with a newline leaves its last line unterminated,
                    // and the directive would then be read as part of that line: "preprocessor
                    // directive cannot be preceded by another token". Found by running the real
                    // renderer against a library saved without a final newline, which is a normal
                    // thing for an editor to do - and a case the in-memory probe had missed, because
                    // every file in a test tends to end the same tidy way. Both are covered now.
                    if (!out.isEmpty() && !out.endsWith(QLatin1Char('\n')))
                        out += QLatin1Char('\n');
                    out += QStringLiteral("#line %1 %2\n").arg(lineNumber + 1).arg(sourceString);
                    continue;
                }
            }

            out += line;
            if (i + 1 < lines.size())
                out += QLatin1Char('\n');

            // Right after the root's #version: declare the next line's real number, so that the line
            // numbers Qt's processing would otherwise shift by one are the file's own again. See the
            // note on expand() - it is correct whether or not anything upstream reorders the source.
            if (isRoot && lineNumber == rootVersionLine)
            {
                out += QStringLiteral("#line %1 0\n").arg(lineNumber + 1);
            }
        }

        return true;
    };

    if (!expandInto(rootPath, source, 0, true))
        return result;

    result.ok = true;
    result.text = out;
    return result;
}

} // namespace ShaderInclude
} // namespace SonicPi
