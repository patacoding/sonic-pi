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

#include <Qsci/qscilexercpp.h>

class SonicPiTheme;

namespace SonicPi
{

// Syntax highlighting for the shader editor.
//
// WHY THIS SUBCLASSES QsciLexerCPP RATHER THAN ADDING A LEXER TO QSCINTILLA
//
// The vendored QScintilla has no GLSL lexer, and adding one there means editing third-party C++:
// a Scintilla `LexGLSL.cxx`, a `QsciLexerGLSL` wrapper, and an entry in that tree's build. Sonic Pi
// maintains a fork of QScintilla (see QScintilla_src-2.14.1/SONIC-PI-CHANGES.md), and every
// deviation from stock 2.14.1 has to be recorded and carried forward - a lexer is a large thing to
// carry for one editor.
//
// GLSL is C-like enough that the stock C++ lexer already gets the hard parts right: comments
// (line, block, doc), string literals, numbers, preprocessor lines (`#version` is a preprocessor
// directive), operators, and unclosed-string error states. All that is missing is the keyword
// table, and QsciLexerCPP has five of those, settable from outside via setKeywords(). So this
// class is ~100 lines in OUR tree, touches no vendored file, and reuses the tokenizer that is
// already compiled and shipped.
//
// If the highlighting ever proves too coarse (GLSL has no real need for most of the C++ lexer's
// distinctions), the next step is QsciLexerCustom with our own scanner - which is also public
// QScintilla API and also stays out of the fork. There is deliberately no third option in between.
//
// THE FONT COMES FROM HERE, NOT FROM THE WIDGET
//
// This is not only about colour. In Sonic Pi an editor's text font is supplied by its LEXER
// (QsciLexer::defaultFont), which is why the shader editor's text was too small while no lexer was
// installed: it fell back to Scintilla's own default font. editorFont() below is the same rule the
// code buffers use - see SonicPiLexer::defaultFont in widgets/sonicpilexer.cpp, which resolves the
// family from the theme and the size as a constant. Keep the two in step.
class GlslLexer : public QsciLexerCPP
{
    Q_OBJECT

public:
    explicit GlslLexer(SonicPiTheme* theme, QObject* parent = nullptr);

    // The font the Sonic Pi code buffers use, resolved from the theme, at the size the code
    // buffers use. Static and public so the editor's own text and the compiler-report pane can be
    // given the same font from one place.
    //
    // It asks the code buffers' lexer (SonicPiLexer) for its font rather than restating the rule,
    // so a change there cannot leave this editor behind - see the definition.
    static QFont editorFont(SonicPiTheme* theme);

    // Re-read every colour from the theme. Called when the user picks a different colour scheme,
    // so an open editor follows it instead of keeping the colours it was built with.
    void applyTheme();

    QColor defaultColor(int style) const override;
    QColor defaultPaper(int style) const override;
    QFont defaultFont(int style) const override;
    const char* language() const override;

    // The keyword tables (sets 1, 2 and 4). QsciLexerCPP has no setKeywords(): its own header
    // documents re-implementing this as THE way to adapt it to another C-like language.
    const char* keywords(int set) const override;

private:
    SonicPiTheme* m_theme = nullptr;
};

} // namespace SonicPi
