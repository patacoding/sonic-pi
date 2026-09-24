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
class QTabWidget;
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

    // Write the CURRENT TAB's text to that buffer's file and ask the render thread to compile it and put
    // it on screen. The reply arrives at compileFinished().
    //
    // Bound to Ctrl+Return as well as the Compile button - the audio editor's Run key, and the habit of
    // every shader tool.
    void compile();

    // Show the window on one buffer, creating its tab if it is not there yet, and make it current.
    void showBuffer(const QString& shaderName);

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
    //
    // `errorFile` is named the way ShaderText::diagnosticName() names files - relative to the shader
    // directory when it is inside it - which is what makes it comparable with this window's own file.
    void compileFinished(bool ok, const QString& compilerLog, const QString& errorFile,
                         int errorLine);

protected:
    void closeEvent(QCloseEvent* e) override;
    // Ctrl+wheel, matching what the code buffers do on Windows. Handled here rather than letting the
    // event reach MainWindow, whose handler zooms the current AUDIO buffer whichever window the
    // pointer is over.
    void wheelEvent(QWheelEvent* event) override;
    // The tab bar's wheel: turn it into "previous/next buffer". Handled here rather than left to Qt, so
    // the behaviour is OURS to state - the bar is a list that can overflow, and a wheel over it should
    // walk the buffers rather than depend on whether the tabs happen to fit.
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    // Show the compiler's output, prefixed with where the problem is (file:line). Empty text with ok
    // true clears the report.
    //
    // The report belongs to the BUFFER it is about, not to the window: each buffer keeps its own, and
    // switching tabs brings that buffer's report back with it. One shared pane would show a stale error
    // from another shader beside code it has nothing to do with.
    void showCompileReport(bool ok, const QString& compilerLog, const QString& errorFile,
                           int errorLine, const QString& shaderName = QString());
    // Put the cursor on `line` (1-based) and make sure it is visible. No-op for a line number that is
    // not in the document, because a diagnostic referring to a line the editor does not have would
    // otherwise move the cursor somewhere arbitrary and look like a bug.
    //
    // A convenience only: the report names the file and the line, so nothing is lost when this does
    // nothing. It is also what had to learn about includes - a diagnostic inside an included library
    // is not a line in this document at all, so the caller compares files before asking
    // (docs/shader-includes-plan.md 4).
    void jumpToLine(int line);

    // ---- the buffers, as tabs ---------------------------------------------------------------
    //
    // One editor per buffer, kept for the life of the window: switching tabs must not throw away
    // unsaved text, which is the audio side's behaviour too (its ten buffers are ten editors, not one
    // reused editor).
    //
    // The LIST comes from the shader directory (GraphicsSettings::shaderNames()), so a buffer is a file
    // and nothing else has to be maintained. It is re-read on every rebuildTabs() - opening the window,
    // creating a buffer - rather than watched with a file watcher: a watcher is a thread and a set of
    // platform behaviours for a list that changes only when the user changes it.
    void rebuildTabs(const QString& selectName = QString());
    // The buffer currently being edited (the current tab's name). Empty only when there are no tabs at
    // all, which needs the shader directory to be unreadable.
    QString editingShaderName() const;
    // Make `name` the current tab. No-op when it is already current.
    void selectTab(const QString& name);
    // The editor for the current tab, or null.
    SonicPiScintilla* currentEditor() const;
    // Re-label the tabs: the buffer that is on screen gets the mark, and every tab's tooltip says what
    // pressing Compile would do. Called whenever the picture or the current tab changes.
    void updateTabLabels();
    // The window title names the buffer being edited, and says when that buffer is the picture. The window
    // is meant to sit OVER the output during a performance, so "which buffer is this" has to be answerable
    // without reading the tab bar under it.
    void updateWindowTitle();
    // Show the CURRENT tab's own report and status line. Called on every tab change and after a verdict,
    // because a report belongs to a buffer and must not be left beside another buffer's code.
    void showCurrentBuffer();
    // Create a new buffer: ask for a name, write a minimal shader to its file, and open it in a tab.
    void newBuffer();
    // Close a buffer's tab: the tab, its editor, its report, and its compiled program.
    //
    // THE FILE IS NOT TOUCHED. Closing a tab is an editor action, not a file operation - the shader stays
    // on disk and comes back the next time the window is built (the list IS the directory), which is also
    // why closing needs no "are you sure" about losing a shader: nothing is lost, only un-edited.
    void closeBuffer(const QString& shaderName);

    // Rename a buffer: the name IS the file name, so this renames the file too.
    //
    // Without it a mistyped name is permanent from inside the application, which is the wrong shape for an
    // editor whose whole model is "a buffer is a file". If the renamed buffer is the one on screen it is
    // recompiled under its new name, so the picture keeps following the file it came from.
    void renameBuffer(const QString& oldName);
    // A minimal valid shader for a new buffer. Valid on purpose: a new buffer that shows a blank output
    // with a compile error teaches the wrong thing about what just happened.
    static QString newBufferTemplate(const QString& name);

    // The file a buffer's text lives in, and where it is written. Empty when the name is unknown.
    static QString bufferFilePath(const QString& shaderName);

    SonicPiTheme* m_theme = nullptr;
    GraphicsRenderThread* m_renderThread = nullptr;
    // Not owned. The GUI's settings, for the file dialogs' remembered directory only.
    QSettings* m_settings = nullptr;

    QTabWidget* m_tabs = nullptr;
    // The editor of each tab, by buffer name. Owned by the tab widget.
    QHash<QString, SonicPiScintilla*> m_editors;
    // Each buffer's report and status line, so switching tabs does not mix two shaders' diagnostics.
    QHash<QString, QString> m_reports;
    QHash<QString, QString> m_statusByBuffer;
    // The name of the buffer the LAST compile request was made for, so a verdict arriving later can be
    // filed against the right buffer even if the user has switched tabs in the meantime.
    QString m_compilingShaderName;

    // Owned by the editors (set on them), and held here so applyTheme() can re-colour them.
    GlslLexer* m_lexer = nullptr;
    QPlainTextEdit* m_report = nullptr;
    QLabel* m_status = nullptr;
    QPushButton* m_compileButton = nullptr;
};

} // namespace SonicPi
