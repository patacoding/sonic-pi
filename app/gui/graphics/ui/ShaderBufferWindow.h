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

#include <QWidget>

#include <memory>

#include "GraphicsRenderThread.h"

class QLabel;
class QPlainTextEdit;
class QPushButton;
class QTimer;

class SonicPiScintilla;
class SonicPiTheme;

namespace SonicPi
{

// The shader editor: a text pane, a Compile action, and the compiler's own answer.
//
// SAVING AND COMPILING ARE ONE ACTION, deliberately. There is no useful state in which the file on
// disk differs from what is being rendered and the user believes otherwise: an edited-but-uncompiled
// shader is the same as an unsaved one, except that it makes "why has nothing changed" a question
// worth asking. One button that writes the file and asks the render thread to rebuild removes the
// question.
//
// THE COMPILER RUNS ON THE RENDER THREAD, NEVER HERE. This window never compiles anything and has no
// GL context to compile with; it writes a file and asks GraphicsRenderThread to try. The failure that
// already cost this feature a rewrite was compiling against whatever context happened to be current
// on the GUI thread, so the request goes one way and the verdict comes back through
// shaderCompileFinished.
//
// Text editing is deliberately plain: no GLSL lexer, because QScintilla has none and a lexer for
// another language highlighting GLSL wrongly would be worse than no highlighting. The editor is the
// audio editor's own widget class so that theme, zoom, key bindings and accessibility come for free,
// and so that adding a real GLSL lexer later is a one-line change rather than a rewrite.
class ShaderBufferWindow : public QWidget
{
    Q_OBJECT

public:
    // `theme` and `renderThread` are not owned. Both must outlive this window; MainWindow owns the
    // window, the theme and the render thread, so that holds.
    ShaderBufferWindow(SonicPiTheme* theme, GraphicsRenderThread* renderThread, QWidget* parent = nullptr);
    ~ShaderBufferWindow() override;

    // Load the shader from disk into the editor. Called on creation and by Revert.
    void reloadFromDisk();

    // Write the editor's text to the shader file and ask the render thread to compile it. The reply
    // arrives at compileFinished().
    void compile();

signals:
    // Emitted when the user closes this window, so the menu action that opened it can be un-ticked.
    void closedByUser();

public slots:
    // The render thread's verdict. Connected to GraphicsRenderThread::shaderCompileFinished.
    void compileFinished(bool ok, const QString& compilerLog);

protected:
    void closeEvent(QCloseEvent* e) override;

private:
    // Show the compiler's output. Empty text with ok true clears the report.
    void showCompileReport(bool ok, const QString& compilerLog);
    // The file this window edits, resolved through GraphicsSettings so it is the same file the
    // renderer reads. Empty when it could not be produced.
    QString shaderFilePath() const;

    SonicPiTheme* m_theme = nullptr;
    GraphicsRenderThread* m_renderThread = nullptr;

    SonicPiScintilla* m_editor = nullptr;
    QPlainTextEdit* m_report = nullptr;
    QLabel* m_status = nullptr;
    QPushButton* m_compileButton = nullptr;

    // Where the text last written to disk came from, so Revert has something to go back to and so a
    // compile of unchanged text can say so instead of pretending to work.
    QString m_lastWrittenText;
};

} // namespace SonicPi
