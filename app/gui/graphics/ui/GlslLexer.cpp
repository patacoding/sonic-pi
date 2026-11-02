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

#include "GlslLexer.h"

#include "sonicpitheme.h"
#include "sonicpilexer.h"

namespace SonicPi
{

namespace
{

// Style numbers are QsciLexerCPP's, named for readability at the setColor() calls below.
using Cpp = QsciLexerCPP;

// GLSL's own vocabulary, split by what it IS so each group can carry its own colour:
//
//   set 1  control flow and storage qualifiers
//   set 2  types
//   set 4  built-in functions (the C++ lexer's "global classes" slot)
//
// The C++ lexer's set 3 and 5 (doc-comment keywords, global variables) have no GLSL meaning and
// are left empty - an empty set costs nothing and highlighting an identifier that is not special
// would only add noise.
const char* kGlslKeywords = R"(
        attribute const uniform varying buffer shared coherent volatile restrict readonly writeonly
        layout centroid flat smooth noperspective patch sample invariant precise
        in out inout void return if else for while do break continue discard struct switch case default
        precision highp mediump lowp
        )";

const char* kGlslTypes = R"(
        bool int uint float double
        vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 dvec2 dvec3 dvec4
        mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4
        sampler1D sampler2D sampler3D samplerCube sampler1DShadow sampler2DShadow
        sampler2DArray samplerCubeArray sampler2DMS isampler2D usampler2D
        image2D atomic_uint
        )";

const char* kGlslBuiltins = R"(
        radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh
        pow exp log exp2 log2 sqrt inversesqrt abs sign floor trunc round roundEven ceil fract
        mod modf min max clamp mix step smoothstep isnan isinf
        length distance dot cross normalize faceforward reflect refract
        matrixCompMult outerProduct transpose determinant inverse
        lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not
        texture textureLod textureProj textureGrad textureOffset texelFetch textureSize
        dFdx dFdy fwidth
        )";

} // namespace

GlslLexer::GlslLexer(SonicPiTheme* theme, QObject* parent)
    : QsciLexerCPP(parent)
    , m_theme(theme)
{
    // No keyword setup here: QsciLexerCPP has no setKeywords(), and its own header says the way to
    // change the tables is to subclass and re-implement keywords() - which keywords() below does.
    // Everything else the tokenizer needs (comments, strings, numbers, the `#` preprocessor line,
    // operators) comes from QsciLexerCPP unchanged.

    // Folding is the code buffers' business, not the shader's: a shader is a screenful, and fold
    // margin markers in it would be noise.
    setFoldComments(false);
    setFoldCompact(true);

    applyTheme();
}

// The keyword tables. QsciLexerCPP looks these up by style, so replacing them is the whole of the
// language adaptation: set 1 is the primary keyword style, set 2 the secondary one (types, here),
// and set 4 the "global classes" style, which is a good home for the built-in functions.
//
// Sets 3 and 5 (documentation-comment keywords and global variables) have no GLSL meaning and are
// left empty rather than filled with something that would only add colour noise.
const char* GlslLexer::keywords(int set) const
{
    if (set == 1)
        return kGlslKeywords;
    if (set == 2)
        return kGlslTypes;
    if (set == 4)
        return kGlslBuiltins;

    return nullptr;
}

QFont GlslLexer::editorFont(SonicPiTheme* theme, int zoom)
{
    QFont font;

    if (theme)
    {
        // Ask the CODE BUFFERS' OWN LEXER for the font, rather than restating its rule here.
        //
        // The rule is not simple enough to copy safely - SonicPiLexer::defaultFont resolves the
        // family from the theme and the size from a constant, and italicises comments - and a copy
        // would silently drift the day someone changes it. Constructing one Ruby lexer to ask it a
        // question is cheap, has no side effects, and makes the two editors structurally unable to
        // disagree. Keyword is a non-italic style, i.e. the font ordinary text is read in.
        SonicPiLexer codeBuffers(theme);
        font = codeBuffers.defaultFont(QsciLexerRuby::Keyword);
    }
    else
    {
        // No theme: the same face and size SonicPiLexer falls back to.
        font = QFont(QStringLiteral("Hack"), 15);
    }

    if (zoom != 0 && font.pointSize() > 0)
        font.setPointSize(font.pointSize() + zoom);

    return font;
}

void GlslLexer::applyTheme()
{
    if (!m_theme)
        return;

    setDefaultColor(m_theme->color(QStringLiteral("DefaultForeground")));
    setDefaultPaper(m_theme->color(QStringLiteral("Background")));

    // The same theme keys the code buffers' lexer uses, so the shader editor reads as part of the
    // same application in every colour scheme - including the hue-rotated and monochrome variants,
    // which theme->color() applies transformations for.
    setColor(m_theme->color(QStringLiteral("DefaultForeground")), Cpp::Default);
    setColor(m_theme->color(QStringLiteral("CommentForeground")), Cpp::Comment);
    setColor(m_theme->color(QStringLiteral("CommentForeground")), Cpp::CommentLine);
    setColor(m_theme->color(QStringLiteral("CommentForeground")), Cpp::CommentDoc);
    setColor(m_theme->color(QStringLiteral("CommentForeground")), Cpp::CommentLineDoc);
    setColor(m_theme->color(QStringLiteral("NumberForeground")), Cpp::Number);
    setColor(m_theme->color(QStringLiteral("KeywordForeground")), Cpp::Keyword);
    setColor(m_theme->color(QStringLiteral("KeywordForeground")), Cpp::PreProcessor);
    setColor(m_theme->color(QStringLiteral("FunctionMethodNameForeground")), Cpp::KeywordSet2);
    setColor(m_theme->color(QStringLiteral("DemotedKeywordForeground")), Cpp::GlobalClass);
    setColor(m_theme->color(QStringLiteral("DoubleQuotedStringForeground")), Cpp::DoubleQuotedString);
    setColor(m_theme->color(QStringLiteral("DoubleQuotedStringForeground")), Cpp::SingleQuotedString);
    setColor(m_theme->color(QStringLiteral("ErrorBackground")), Cpp::UnclosedString);
    setColor(m_theme->color(QStringLiteral("DefaultForeground")), Cpp::Operator);
    setColor(m_theme->color(QStringLiteral("DefaultForeground")), Cpp::Identifier);

    // Paper is one colour everywhere: the editor's background, not a per-token decision.
    const QColor paper = m_theme->color(QStringLiteral("Background"));
    for (int style = 0; style <= Cpp::GlobalClass; ++style)
        setPaper(paper, style);
}

QColor GlslLexer::defaultColor(int style) const
{
    if (!m_theme)
        return QsciLexerCPP::defaultColor(style);

    switch (style)
    {
    case Cpp::Default:
    case Cpp::Operator:
    case Cpp::Identifier:
        return m_theme->color(QStringLiteral("DefaultForeground"));
    case Cpp::Comment:
    case Cpp::CommentLine:
    case Cpp::CommentDoc:
    case Cpp::CommentLineDoc:
        return m_theme->color(QStringLiteral("CommentForeground"));
    case Cpp::Number:
        return m_theme->color(QStringLiteral("NumberForeground"));
    case Cpp::Keyword:
    case Cpp::PreProcessor:
        return m_theme->color(QStringLiteral("KeywordForeground"));
    case Cpp::KeywordSet2:
        return m_theme->color(QStringLiteral("FunctionMethodNameForeground"));
    case Cpp::GlobalClass:
        return m_theme->color(QStringLiteral("DemotedKeywordForeground"));
    case Cpp::DoubleQuotedString:
    case Cpp::SingleQuotedString:
        return m_theme->color(QStringLiteral("DoubleQuotedStringForeground"));
    case Cpp::UnclosedString:
        return m_theme->color(QStringLiteral("ErrorBackground"));
    default:
        return m_theme->color(QStringLiteral("DefaultForeground"));
    }
}

QColor GlslLexer::defaultPaper(int style) const
{
    Q_UNUSED(style)
    return m_theme ? m_theme->color(QStringLiteral("Background"))
                   : QsciLexerCPP::defaultPaper(style);
}

QFont GlslLexer::defaultFont(int style) const
{
    QFont f = editorFont(m_theme);

    // Comments in italics, as the code buffers do it. Everything else upright: a shader is short
    // and mostly types and numbers, and slanting identifiers would make it harder to scan.
    switch (style)
    {
    case Cpp::Comment:
    case Cpp::CommentLine:
    case Cpp::CommentDoc:
    case Cpp::CommentLineDoc:
        f.setItalic(true);
        break;
    default:
        break;
    }

    return f;
}

const char* GlslLexer::language() const
{
    return "GLSL";
}

} // namespace SonicPi
