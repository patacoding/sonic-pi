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
class QSettings;
class QTimer;

class SonicPiScintilla;
class SonicPiTheme;

namespace SonicPi
{

class GlslLexer;

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
// Text editing is deliberately plain in behaviour - no autocompletion, no API docs - but it IS
// highlighted: GLSL through GlslLexer, which subclasses the QScintilla C++ lexer already in the
// tree rather than adding a lexer to the vendored fork (see GlslLexer.h for why that matters). The
// editor is the audio editor's own widget class, so key bindings, zoom and accessibility come for
// free, and the text font arrives through the lexer exactly as it does for the code buffers.
class ShaderBufferWindow : public QWidget
{
    Q_OBJECT

public:
    // `theme`, `renderThread` and `settings` are not owned, and must outlive this window. MainWindow
    // owns all three.
    //
    // `settings` is the GUI's own settings object, passed in rather than opened here so that the file
    // dialogs' remembered directory lives with the rest of the GUI's preferences instead of this
    // feature inventing a second place to keep state.
    ShaderBufferWindow(SonicPiTheme* theme, GraphicsRenderThread* renderThread, QSettings* settings,
                       QWidget* parent = nullptr);
    ~ShaderBufferWindow() override;

    // Re-read the look from the theme: the application stylesheet, the editor's syntax colours and
    // the text fonts. Public because MainWindow applies a new theme to the whole application and
    // this window is not a child of it, so it has to be told. Called on construction.
    void applyTheme();

    // Text size, as a Scintilla zoom level in the code buffers' own units.
    //
    // Two reasons this exists rather than being left to the editor's own property. The code buffers
    // START at SonicPiScintilla::kDefaultZoom (2), not 0, so an editor left at 0 is two points
    // smaller than the buffer beside it. And the zoom is per-editor state that only MainWindow's
    // Code Size actions and Ctrl+wheel touch - both of which act on the current audio buffer, so
    // without this the shader editor's font never changed at all.
    void setEditorZoom(int zoom);
    int editorZoom() const;
    void zoomIn();
    void zoomOut();

    // Write the editor's text to the shader file and ask the render thread to compile it. The reply
    // arrives at compileFinished().
    //
    // Bound to Alt+R as well as the Compile button, the same key Sonic Pi's own Run uses: the
    // semantics are the same - take what is in the buffer and put it into effect.
    void compile();

    // Import a shader from an arbitrary file into the editor, and export the editor's text to one.
    //
    // These are NOT the same thing as the buffer's own file, and the difference is the whole point of
    // having both: the buffer's file is what gets rendered, and these are how a shader gets in from or
    // out to the rest of the machine. Neither one compiles - importing changes what is being edited,
    // and the user decides when to put it into the renderer.
    void loadFromFile();
    void saveToFile();

    // The actual reading and writing, separated from the dialogs that choose a path.
    //
    // Not tidiness: while these were welded to a modal QFileDialog, nothing about them could be
    // exercised by an automated run, and "import a shader" is the kind of logic that is wrong in
    // small ways - a BOM, a truncated read, an extension that does not get appended. Split, the
    // dialog is the only untested part and the logic is testable.
    bool importFrom(const QString& fileName);
    bool exportTo(const QString& fileName);

signals:
    // Emitted when the user closes this window, so the menu action that opened it can be un-ticked.
    void closedByUser();

public slots:
    // The render thread's verdict. Connected to GraphicsRenderThread::shaderCompileFinished.
    void compileFinished(bool ok, const QString& compilerLog);

protected:
    void closeEvent(QCloseEvent* e) override;
    // Ctrl+wheel, matching what the code buffers do on Windows. Handled here rather than letting the
    // event reach MainWindow, whose handler zooms the current AUDIO buffer whichever window the
    // pointer is over.
    void wheelEvent(QWheelEvent* event) override;

private:
    // Show the compiler's output, prefixed with where the problem is (file:line). Empty text with ok
    // true clears the report.
    void showCompileReport(bool ok, const QString& compilerLog);
    // Put the cursor on `line` (1-based) and make sure it is visible. No-op for a line number that is
    // not in the document, because a diagnostic referring to a line the editor does not have would
    // otherwise move the cursor somewhere arbitrary and look like a bug.
    //
    // A convenience only: the report names the file and the line, so nothing is lost when this does
    // nothing. It is also what has to learn about includes - a diagnostic inside an included library
    // is not a line in this document at all (docs/shader-includes-plan.md 4).
    void jumpToLine(int line);
    // The file this window edits, resolved through GraphicsSettings so it is the same file the
    // renderer reads. Empty when it could not be produced.
    QString shaderFilePath() const;
    // Read the buffer's own file into the editor. Called once, on creation: the file is the
    // renderer's source, so the window opens showing what is being rendered.
    void reloadFromDisk();

    SonicPiTheme* m_theme = nullptr;
    GraphicsRenderThread* m_renderThread = nullptr;
    // Not owned. The GUI's settings, for the file dialogs' remembered directory only.
    QSettings* m_settings = nullptr;

    SonicPiScintilla* m_editor = nullptr;
    // Owned by the editor (set on it), and held here so applyTheme() can re-colour it.
    GlslLexer* m_lexer = nullptr;
    QPlainTextEdit* m_report = nullptr;
    QLabel* m_status = nullptr;
    QPushButton* m_compileButton = nullptr;
};

} // namespace SonicPi
