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

#include "ShaderBufferWindow.h"

#include "GraphicsLog.h"
#include "GraphicsSettings.h"
#include "GlslLexer.h"
#include "../ShaderText.h"
#include "dpi.h"
#include "sonicpiscintilla.h"
#include "sonicpitheme.h"
#include "utils/chrome_metrics.h"

#include <QCloseEvent>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QHash>
#include <QInputDialog>
#include <QLabel>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QRegularExpression>
#include <QSettings>
#include <QShortcut>
#include <QSplitter>
#include <QStringList>
#include <QTabBar>
#include <QTabWidget>
#include <QTextStream>
#include <QVBoxLayout>
#include <QVariant>
#include <QWheelEvent>

#include <Qsci/qscicommand.h>
#include <Qsci/qscicommandset.h>

namespace SonicPi
{

namespace
{
// The mark on the tab whose buffer is the picture on screen.
//
// ASCII, and a suffix rather than a colour: it has to survive every font and colour theme, and it has to
// be readable in a screenshot. The tooltip on each tab says what it means.
const QString kOnScreenMark = QStringLiteral(" *");

// Put the editing keys back on THIS editor's Scintilla commands.
//
// SonicPiScintilla's constructor calls standardCommands()->clearKeys() and re-adds only the
// navigation keys. That is not an oversight: in the main window the editing shortcuts are
// MainWindow ACTIONS (textUndoAct -> undoInCurrentWorkspace -> the current audio buffer's undo), so
// the widgets themselves never carry them.
//
// A different top-level window inherits none of that, which left this editor with no Ctrl+Z, no
// Ctrl+C/V/X and no Ctrl+A - a code editor without undo. The COMMANDS were never removed, only
// their keys, so restoring the six expected bindings is the whole repair. They are set on this
// editor's own command set, so nothing else in the application is affected.
//
// Deliberately only the six that mean the same thing in any text editor. Sonic Pi's other Code-menu
// actions (comment/uncomment, align, cut-to-end-of-line, the delete-word pair) carry Sonic Pi
// language semantics and must not be applied blind to GLSL - they stay out.
void restoreEditingKeys(SonicPiScintilla* editor)
{
    if (!editor)
        return;

    // QsciCommand takes raw key codes (modifiers OR'd with a key), not QKeySequence - the same form
    // the SonicPiScintilla constructor uses. The command modifier is spelled the way the
    // application's own shortcut table spells it: Ctrl on Windows and Linux, Command on macOS.
#if defined(Q_OS_MAC)
    const int cmd = Qt::META;
#else
    const int cmd = Qt::CTRL;
#endif

    struct Binding
    {
        QsciCommand::Command command;
        int primary;
        int alternate;
    };

    // Undo/redo take the bindings the application's shortcut table gives them, with the platform's
    // other common redo (Ctrl+Y) as an alternate so either habit works. The rest are the universal
    // Ctrl+X/C/V/A.
    //
    // The cut/copy commands are named SelectionCut/SelectionCopy in QScintilla; there is no plain
    // Cut/Copy.
    const Binding bindings[] = {
        { QsciCommand::Undo,          cmd | Qt::Key_Z,                 0 },
        { QsciCommand::Redo,          cmd | Qt::SHIFT | Qt::Key_Z,     cmd | Qt::Key_Y },
        { QsciCommand::SelectionCut,  cmd | Qt::Key_X,                 0 },
        { QsciCommand::SelectionCopy, cmd | Qt::Key_C,                 0 },
        { QsciCommand::Paste,         cmd | Qt::Key_V,                 0 },
        { QsciCommand::SelectAll,     cmd | Qt::Key_A,                 0 },
    };

    QsciCommandSet* commands = editor->standardCommands();

    for (const Binding& binding : bindings)
    {
        QsciCommand* command = commands->find(binding.command);
        if (!command)
            continue;

        command->setKey(binding.primary);
        if (binding.alternate != 0)
            command->setAlternateKey(binding.alternate);
    }
}

} // namespace


ShaderBufferWindow::ShaderBufferWindow(SonicPiTheme* theme, GraphicsRenderThread* renderThread,
                                       QSettings* settings, QWidget* parent)
    : QWidget(parent),
      m_theme(theme),
      m_renderThread(renderThread),
      m_settings(settings)
{
    setWindowTitle(tr("Sonic Pi - Shader Buffer"));
    setObjectName(QStringLiteral("ShaderBufferWindow"));

    // GLSL highlighting, and - just as importantly - the editor's text font, which in Sonic Pi is
    // supplied by the lexer rather than by the widget. See GlslLexer.h: the font rule is the same
    // one the code buffers use.
    m_lexer = new GlslLexer(m_theme, this);

    m_compileButton = new QPushButton(tr("Compile"), this);
    QPushButton* newButton = new QPushButton(tr("New Buffer..."), this);
    QPushButton* loadButton = new QPushButton(tr("Load into Buffer..."), this);
    QPushButton* saveButton = new QPushButton(tr("Save Buffer As..."), this);

    // Named in the tooltip as well as bound, because a shortcut nobody is told about is not a
    // feature. Alt+R is what Sonic Pi's own Run uses, so it needs no explaining.
    m_compileButton->setToolTip(tr("Write this buffer and put it on screen (Alt+R)"));
    newButton->setToolTip(tr("Create a new buffer: one more .frag file in the shader directory"));

    m_status = new QLabel(this);
    m_status->setWordWrap(true);

    // Read-only rather than hidden when empty: an editor whose error pane appears and disappears
    // makes the window jump on every compile, and a compile failure is exactly when the user is
    // looking at where the pane is.
    m_report = new QPlainTextEdit(this);
    m_report->setReadOnly(true);
    m_report->setLineWrapMode(QPlainTextEdit::NoWrap);
    m_report->setFont(GlslLexer::editorFont(m_theme));
    m_report->setPlaceholderText(tr("The compiler's output appears here, for the buffer being edited. "
                                    "Build problems are shown exactly as the driver reported them, "
                                    "including line numbers."));

    // ---- THE BUFFERS, AS TABS ---------------------------------------------------------------
    //
    // Built the way the audio side's buffers are (mainwindow.cpp, editorTabWidget): a QTabWidget along
    // the BOTTOM, tabs that cannot be closed or dragged, one editor per buffer. The similarity is the
    // point - this is the same gesture as switching audio buffers, and it is what makes the feature
    // usable while performing rather than only while setting up.
    //
    // A buffer IS a file in the shader directory, so the tab list is read from disk (rebuildTabs) and
    // there is no separate registry to keep in step with it.
    m_tabs = new QTabWidget(this);
    m_tabs->setTabsClosable(false);
    m_tabs->setMovable(false);
    m_tabs->setTabPosition(QTabWidget::South);
    m_tabs->tabBar()->setFixedHeight(ScaleHeightForDPI(SonicPi::kChromeControlDp));
    m_tabs->setToolTip(tr("One tab per buffer. The tab marked %1 is the picture on screen; Compile "
                          "(Alt+R) puts the buffer being edited on screen.").arg(kOnScreenMark));

    auto* buttons = new QWidget(this);
    auto* buttonsLayout = new QHBoxLayout(buttons);
    buttonsLayout->setContentsMargins(0, 0, 0, 0);
    buttonsLayout->addWidget(m_compileButton);
    buttonsLayout->addWidget(newButton);
    buttonsLayout->addWidget(loadButton);
    buttonsLayout->addWidget(saveButton);
    buttonsLayout->addWidget(m_status, 1);

    auto* split = new QSplitter(Qt::Vertical, this);
    split->addWidget(m_tabs);
    split->addWidget(m_report);
    split->setStretchFactor(0, 3);
    split->setStretchFactor(1, 1);

    auto* layout = new QVBoxLayout(this);
    layout->addWidget(buttons);
    layout->addWidget(split, 1);

    // Which trigger fired, in the log. Three ways in - button, Ctrl+Return, Alt+R - and "the key did
    // nothing" is otherwise indistinguishable from "the key never reached this window": the editor
    // widget sits between the two, and whether it swallows a chord is its business, not something to
    // assume. One line per press settles it.
    connect(m_compileButton, &QPushButton::clicked, this, [this]() {
        GraphicsLog::info(QStringLiteral("shader buffer: compile by button (%1)").arg(editingShaderName()));
        compile();
    });
    connect(newButton, &QPushButton::clicked, this, &ShaderBufferWindow::newBuffer);
    connect(loadButton, &QPushButton::clicked, this, &ShaderBufferWindow::loadFromFile);
    connect(saveButton, &QPushButton::clicked, this, &ShaderBufferWindow::saveToFile);

    // Switching tabs is a VIEW action and nothing else: it shows that buffer's text and its last
    // report, and does not touch what is on screen. Same as the audio side, where switching buffers
    // neither starts nor stops anything - the picture changes when the user compiles.
    connect(m_tabs, &QTabWidget::currentChanged, this, [this](int) { showCurrentBuffer(); });

    // The render thread's verdict arrives here, queued from another thread.
    connect(m_renderThread, &GraphicsRenderThread::shaderCompileFinished,
            this, &ShaderBufferWindow::compileFinished);
    // Compile keys. Ctrl+Return matches the audio editor's Run and the habit of every shader tool.
    //
    // Alt+R is Sonic Pi's own Run binding, and it is here because the semantics are the SAME as in an
    // audio buffer: take what is in the buffer and put it into effect. Someone who has just been
    // running code with Alt+R should not have to learn a second key for the shader beside it.
    //
    // "Meta" in Sonic Pi's shortcut table is the platform's command modifier, so the table's Meta+R
    // is Alt+R on Windows and Linux and Command+R on macOS - spelled here the same way.
    auto* compileShortcut = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Return), this);
    compileShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(compileShortcut, &QShortcut::activated, this, [this]() {
        GraphicsLog::info(QStringLiteral("shader buffer: compile by Ctrl+Return (%1)")
                              .arg(editingShaderName()));
        compile();
    });

#if defined(Q_OS_MAC)
    const int runKey = Qt::CTRL | Qt::Key_R;
#else
    const int runKey = Qt::ALT | Qt::Key_R;
#endif
    auto* runShortcut = new QShortcut(QKeySequence(runKey), this);
    runShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(runShortcut, &QShortcut::activated, this, [this]() {
        GraphicsLog::info(QStringLiteral("shader buffer: compile by Alt+R (%1)")
                              .arg(editingShaderName()));
        compile();
    });

    // Tab switching from the keyboard, as the code buffers have (Ctrl+Tab / Ctrl+Shift+Tab in the code
    // menu). This window is top-level, so it gets its own: MainWindow's actions cannot serve it.
    auto* nextTab = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Tab), this);
    nextTab->setContext(Qt::WidgetWithChildrenShortcut);
    connect(nextTab, &QShortcut::activated, this, [this]() {
        if (m_tabs && m_tabs->count() > 1)
            m_tabs->setCurrentIndex((m_tabs->currentIndex() + 1) % m_tabs->count());
    });

    auto* previousTab = new QShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_Tab), this);
    previousTab->setContext(Qt::WidgetWithChildrenShortcut);
    connect(previousTab, &QShortcut::activated, this, [this]() {
        if (m_tabs && m_tabs->count() > 1)
            m_tabs->setCurrentIndex((m_tabs->currentIndex() + m_tabs->count() - 1) % m_tabs->count());
    });

    // The text-size keys the rest of Sonic Pi uses (View -> Code Size Up/Down). MainWindow's own
    // actions cannot serve this window - their shortcuts belong to the main window, so they do not
    // fire while this one has focus, which is exactly when someone wants to resize this text.
    auto* zoomInShortcut = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Equal), this);
    zoomInShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(zoomInShortcut, &QShortcut::activated, this, &ShaderBufferWindow::zoomIn);

    auto* zoomOutShortcut =
        new QShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_Minus), this);
    zoomOutShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(zoomOutShortcut, &QShortcut::activated, this, &ShaderBufferWindow::zoomOut);

    // Start at the code buffers' default rather than Scintilla's 0, so the text is the size of the
    // buffer beside it from the moment the window opens. MainWindow may override this with the
    // current buffer's actual level (see showShaderBuffer).
    setEditorZoom(SonicPiScintilla::kDefaultZoom);

    applyTheme();

    // Open on the buffer that is on screen: the file being rendered is the one the user most likely
    // wants to see, and starting anywhere else would make the picture and the editor disagree for no
    // reason.
    const QString onScreen = m_renderThread ? m_renderThread->shaderName()
                                            : GraphicsSettings::defaultShaderName();
    rebuildTabs(onScreen);
}

ShaderBufferWindow::~ShaderBufferWindow() = default;

// The window's share of the application's look.
//
// Two separate mechanisms, and which one applies where is the whole point of this method:
//
//   * The STYLESHEET is the same string MainWindow applies to itself, so this window's buttons,
//     labels, splitter and status line look like the rest of Sonic Pi rather than like a bare Qt
//     window. MainWindow applies it to itself only (mainwindow.cpp, "appStyling"), which is why a
//     top-level window needs its own copy of this call.
//
//   * The EDITOR'S colours and font come from the theme through the lexer, because in Sonic Pi an
//     editor's text font is supplied by its lexer, not by the widget.
//
// WINDOW TRANSPARENCY IS NOT SET HERE, on purpose. This is a live coding tool: the editor is meant
// to sit OVER the graphics output, so its opacity must MATCH the main window's - and the way to
// guarantee "match" is to have one calculation and one writer. MainWindow computes the opacity from
// the GUI transparency preference and applies it to both windows; this window only has to be a
// QWidget for that to work. Setting it here as well would be a second copy of the rule, free to
// drift, which is the failure this codebase keeps paying for.
void ShaderBufferWindow::applyTheme()
{
    if (m_theme)
        setStyleSheet(m_theme->getAppStylesheet());

    if (m_lexer)
        m_lexer->applyTheme();

    // The report pane is compiler output, shown in the same face and size as the code it is about -
    // at the current zoom, or a theme change would quietly put it back to the base size.
    if (m_report)
        m_report->setFont(GlslLexer::editorFont(m_theme, editorZoom()));

    // Every tab's editor, not just the visible one: a theme change while a background buffer is being
    // edited must not leave that buffer in the old colours when the user switches back to it.
    for (SonicPiScintilla* editor : m_editors)
    {
        if (!editor)
            continue;
        // A lexer colour change only takes effect on the text already on screen when the styles are
        // re-applied to it; without this the editor keeps the old colours until it is reloaded.
        editor->recolor();
        editor->setMarginsFont(GlslLexer::editorFont(m_theme));
    }
}

void ShaderBufferWindow::setEditorZoom(int zoom)
{
    // Every buffer, so the text size is one property of the window rather than of whichever tab
    // happens to be open - the audio side behaves the same way (one Code Size for all buffers).
    for (SonicPiScintilla* editor : m_editors)
    {
        if (!editor)
            continue;
        editor->setProperty("zoom", QVariant(zoom));
        editor->zoomTo(zoom);
    }

    // The compiler report is shown in the same face and size as the code it is about, so it follows
    // the zoom. Scintilla adds the zoom to the style's point size; editorFont does the same.
    if (m_report)
        m_report->setFont(GlslLexer::editorFont(m_theme, zoom));
}

int ShaderBufferWindow::editorZoom() const
{
    // The remembered level, not "the current tab's editor": with no tabs yet (construction) or an
    // unreadable directory, there is still a zoom to report.
    if (SonicPiScintilla* editor = currentEditor())
        return editor->currentZoom();
    for (SonicPiScintilla* editor : m_editors)
    {
        if (editor)
            return editor->currentZoom();
    }
    return SonicPiScintilla::kDefaultZoom;
}

void ShaderBufferWindow::zoomIn()
{
    if (SonicPiScintilla* editor = currentEditor())
        editor->zoomFontIn();

    // zoomFontIn clamps and stores the level itself, so read it back rather than tracking a second
    // copy that could disagree with the editor.
    setEditorZoom(editorZoom());
}

void ShaderBufferWindow::zoomOut()
{
    if (SonicPiScintilla* editor = currentEditor())
        editor->zoomFontOut();

    setEditorZoom(editorZoom());
}

void ShaderBufferWindow::wheelEvent(QWheelEvent* event)
{
    // Ctrl+wheel, matching the code buffers on Windows. Handled here rather than letting the event
    // reach MainWindow, whose handler zooms the current AUDIO buffer whichever window is under the
    // pointer - so a wheel over this window would resize something the user is not looking at.
    if (event->modifiers() & Qt::ControlModifier)
    {
        if (event->angleDelta().y() > 0)
            zoomIn();
        else
            zoomOut();
        event->accept();
        return;
    }

    QWidget::wheelEvent(event);
}

QString ShaderBufferWindow::bufferFilePath(const QString& shaderName)
{
    // Through GraphicsSettings, so this is the same file the renderer reads. Resolving it here by a
    // second route is the mistake that would make editing appear to do nothing: one rule (name ->
    // file name -> path) lives in GraphicsSettings, and this window only supplies the name.
    return GraphicsSettings::writableShaderPath(GraphicsSettings::fragmentFileName(shaderName));
}

QString ShaderBufferWindow::editingShaderName() const
{
    if (!m_tabs || m_tabs->count() == 0)
        return QString();
    return m_tabs->tabText(m_tabs->currentIndex()).remove(kOnScreenMark).trimmed();
}

SonicPiScintilla* ShaderBufferWindow::currentEditor() const
{
    return m_editors.value(editingShaderName(), nullptr);
}

void ShaderBufferWindow::rebuildTabs(const QString& selectName)
{
    // The list IS the directory (GraphicsSettings::shaderNames()), so nothing has to be kept in step.
    //
    // Tabs are only ever ADDED here, never removed: a file that disappears from the directory while
    // the window is open may still have unsaved text in its tab, and silently dropping that would be
    // data loss dressed up as tidiness.
    const QStringList names = GraphicsSettings::shaderNames();
    for (const QString& name : names)
    {
        if (m_editors.contains(name))
            continue;

        auto* editor = new SonicPiScintilla(nullptr, m_theme,
                                            QStringLiteral("shader_%1").arg(name), false);
        editor->setLexer(m_lexer);
        restoreEditingKeys(editor);
        editor->zoomTo(editorZoom());

        // Read the buffer's file into its editor. Missing is a normal state - a buffer created by name
        // whose file was never written - and it is reported in that buffer's own status, not as a
        // window-wide failure.
        QFile file(bufferFilePath(name));
        if (file.open(QIODevice::ReadOnly | QIODevice::Text))
        {
            QTextStream in(&file);
            editor->setText(in.readAll());
            file.close();
        }
        else
        {
            m_statusByBuffer.insert(name, tr("No file yet at %1 - Compile will create it.")
                                              .arg(bufferFilePath(name)));
        }

        m_editors.insert(name, editor);
        m_tabs->addTab(editor, name);
        GraphicsLog::info(QStringLiteral("shader buffer: tab '%1' -> %2").arg(name,
                                                                             bufferFilePath(name)));
    }

    updateTabLabels();

    const QString wanted = selectName.isEmpty() ? editingShaderName() : selectName;
    selectTab(wanted.isEmpty() ? GraphicsSettings::defaultShaderName() : wanted);
}

void ShaderBufferWindow::selectTab(const QString& name)
{
    for (int i = 0; i < m_tabs->count(); ++i)
    {
        if (m_tabs->tabText(i).remove(kOnScreenMark).trimmed().compare(name, Qt::CaseInsensitive) == 0)
        {
            m_tabs->setCurrentIndex(i);
            return;
        }
    }
}

void ShaderBufferWindow::updateTabLabels()
{
    const QString onScreen = m_renderThread ? m_renderThread->shaderName()
                                            : GraphicsSettings::defaultShaderName();
    for (int i = 0; i < m_tabs->count(); ++i)
    {
        const QString name = m_tabs->tabText(i).remove(kOnScreenMark).trimmed();
        const bool isOnScreen = name.compare(onScreen, Qt::CaseInsensitive) == 0;
        // The mark is how a performer sees which buffer the picture belongs to without reading the log
        // or the status line. ASCII on purpose: it survives every font, and the tooltip explains it.
        m_tabs->setTabText(i, isOnScreen ? name + kOnScreenMark : name);
        m_tabs->setTabToolTip(i, isOnScreen
                                     ? tr("%1 - on screen now").arg(name)
                                     : tr("%1 - press Compile (Alt+R) to put it on screen").arg(name));
    }
}

void ShaderBufferWindow::showCurrentBuffer()
{
    const QString name = editingShaderName();
    if (name.isEmpty())
        return;

    updateTabLabels();

    // This buffer's own report and status, not the last one the window happened to show: two shaders'
    // diagnostics side by side is how a user fixes the wrong file.
    m_report->setPlainText(m_reports.value(name));
    m_status->setText(m_statusByBuffer.value(name));
}

void ShaderBufferWindow::showBuffer(const QString& shaderName)
{
    if (shaderName.isEmpty())
        return;
    rebuildTabs(shaderName);
    selectTab(shaderName);
}

QString ShaderBufferWindow::newBufferTemplate(const QString& name)
{
    return QStringLiteral("// Buffer: %1\n"
                          "//\n"
                          "// Alt+R (or Compile) writes this file and puts it on screen.\n"
                          "\n"
                          "#version 330 core\n"
                          "\n"
                          "in vec2 v_uv;\n"
                          "layout(location = 0) out vec4 FragColor;\n"
                          "\n"
                          "void main()\n"
                          "{\n"
                          "    FragColor = vec4(v_uv, 0.5, 1.0);\n"
                          "}\n").arg(name);
}

void ShaderBufferWindow::newBuffer()
{
    bool ok = false;
    const QString typed = QInputDialog::getText(this, tr("New Buffer"),
                                                tr("Name (the buffer is the file <name>.frag):"),
                                                QLineEdit::Normal, QString(), &ok);
    if (!ok)
        return;   // cancelled, which is not an error

    // A name becomes a file name, so it is validated as one. Silently accepting "my/shader" or a name
    // with a colon would write somewhere the tab list does not look, and the buffer would appear to
    // vanish.
    const QString name = typed.trimmed();
    if (name.isEmpty())
        return;
    if (name.contains(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]"))))
    {
        m_status->setText(tr("A buffer name cannot contain \\ / : * ? \" < > |"));
        return;
    }

    if (m_editors.contains(name))
    {
        selectTab(name);
        return;
    }

    const QString path = bufferFilePath(name);
    if (QFile::exists(path))
    {
        // The file is already there (made by hand, or by an earlier session): adopt it rather than
        // overwrite it. Overwriting is the one thing a "new buffer" must never do.
        GraphicsLog::info(QStringLiteral("shader buffer: buffer '%1' already has a file; opening it")
                              .arg(name));
        rebuildTabs(name);
        selectTab(name);
        return;
    }

    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Truncate))
    {
        m_status->setText(tr("Could not create %1").arg(path));
        GraphicsLog::error(QStringLiteral("shader buffer: could not create %1").arg(path));
        return;
    }
    {
        QTextStream out(&file);
        out << newBufferTemplate(name);
    }
    file.close();

    GraphicsLog::info(QStringLiteral("shader buffer: created buffer '%1' -> %2").arg(name, path));
    rebuildTabs(name);
    selectTab(name);
}

void ShaderBufferWindow::compile()
{
    const QString name = editingShaderName();
    SonicPiScintilla* editor = currentEditor();
    if (name.isEmpty() || !editor)
        return;

    const QString path = bufferFilePath(name);
    const QString text = editor->text();

    // Written first, because the render thread reads the file rather than receiving the text. That is
    // deliberate: there is one source of truth - the file - so a compile always describes what is on
    // disk, and a crash mid-compile cannot leave the renderer running code that exists nowhere.
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Truncate))
    {
        m_status->setText(tr("Could not write %1").arg(path));
        GraphicsLog::error(QStringLiteral("shader buffer: could not write %1").arg(path));
        return;
    }
    {
        QTextStream out(&file);
        out << text;
    }
    file.close();

    // Which buffer this verdict will be about. Kept because the user may switch tabs while the compile
    // is in flight, and a report filed against the wrong buffer is worse than no report.
    m_compilingShaderName = name;

    m_status->setText(tr("Compiling %1...").arg(name));
    GraphicsLog::info(QStringLiteral("shader buffer: wrote buffer '%1' -> %2 (%3 bytes); asking the render "
                                     "thread to compile and show it").arg(name, path).arg(text.size()));

    // The render thread compiles it AND puts it on screen - one operation, because for a picture there
    // is nothing useful in between. A buffer that will not build leaves the current picture alone.
    if (!m_renderThread->requestShaderCompile(name))
    {
        // No running loop means nothing will ever answer, so the window must say so rather than sit
        // on "Compiling..." forever. That state would be indistinguishable from a compile that takes
        // minutes.
        showCompileReport(false, tr("The render loop is not running, so nothing was compiled. "
                                    "The file has been saved."),
                          QString(), 0);
    }
}

void ShaderBufferWindow::compileFinished(bool ok, const QString& compilerLog,
                                         const QString& errorFile, int errorLine)
{
    // Filed against the buffer the request named, which is not necessarily the tab on screen now.
    const QString name = m_compilingShaderName.isEmpty()
                             ? (m_renderThread ? m_renderThread->shaderName()
                                               : GraphicsSettings::defaultShaderName())
                             : m_compilingShaderName;

    // The picture follows the buffer that compiled, so the mark on the tabs has to move with it.
    if (ok && m_renderThread)
        updateTabLabels();

    // Remembered so that "which buffer is on screen" survives the next session: written only when the
    // compile succeeded, because a buffer that did not build never reached the screen.
    if (ok && name == m_compilingShaderName)
        GraphicsSettings::setActiveShaderName(name);

    showCompileReport(ok, compilerLog, errorFile, errorLine, name);
}

// Import a fragment shader from an arbitrary file.
//
// Deliberately does NOT compile. Importing changes what is being edited, and whether that code goes
// into the renderer is a separate decision the user makes by pressing Compile. Compiling here would
// mean that opening the wrong file could change the live output - the thing this whole feature is
// arranged to prevent.
void ShaderBufferWindow::loadFromFile()
{
    const QString startDir = m_settings
                                 ? m_settings->value(QStringLiteral("lastShaderDir"),
                                                     QDir::homePath() + QStringLiteral("/Desktop")).toString()
                                 : QDir::homePath();

    QString selectedFilter = tr("Fragment shaders (*.frag)");
    const QString fileName = QFileDialog::getOpenFileName(
        this, tr("Load Shader into Buffer"), startDir,
        QStringLiteral("%1 (*.frag);;%2 (*.glsl *.fs *.txt);;%3 (*.*)")
            .arg(tr("Fragment shaders")).arg(tr("GLSL files")).arg(tr("All files")),
        &selectedFilter);
    if (fileName.isEmpty())
        return;   // cancelled, which is not an error

    if (m_settings)
        m_settings->setValue(QStringLiteral("lastShaderDir"), QDir(fileName).absolutePath());

    importFrom(fileName);
}

bool ShaderBufferWindow::importFrom(const QString& fileName)
{
    QFile file(fileName);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
    {
        m_status->setText(tr("Could not read %1").arg(fileName));
        GraphicsLog::warn(QStringLiteral("shader buffer: could not read %1").arg(fileName));
        return false;
    }
    QTextStream in(&file);
    const QString text = in.readAll();
    file.close();

    SonicPiScintilla* editor = currentEditor();
    if (editor)
        editor->setText(text);
    // The report is cleared because it describes the PREVIOUS contents. Leaving a stale compiler error
    // beside freshly imported code would point at a line that no longer means anything.
    showCompileReport(true, QString(), QString(), 0);
    m_status->setText(tr("Loaded %1 into this buffer. Press Compile to put it on screen.").arg(fileName));
    GraphicsLog::info(QStringLiteral("shader buffer: imported %1 (%2 bytes) into buffer '%3'")
                          .arg(fileName).arg(text.size()).arg(editingShaderName()));
    return true;
}

// Export the editor's text to an arbitrary file.
//
// Does not write the buffer's own file either: exporting a copy is not the same act as putting this
// text into the renderer, and conflating them would make "Save to File" silently change the output.
void ShaderBufferWindow::saveToFile()
{
    const QString startDir = m_settings
                                 ? m_settings->value(QStringLiteral("lastShaderDir"),
                                                     QDir::homePath() + QStringLiteral("/Desktop")).toString()
                                 : QDir::homePath();

    QString selectedFilter = tr("Fragment shaders (*.frag)");
    QString fileName = QFileDialog::getSaveFileName(
        this, tr("Save Shader Buffer As"), startDir,
        QStringLiteral("%1 (*.frag);;%2 (*.glsl);;%3 (*.*)")
            .arg(tr("Fragment shaders")).arg(tr("GLSL files")).arg(tr("All files")),
        &selectedFilter);
    if (fileName.isEmpty())
        return;

    if (m_settings)
        m_settings->setValue(QStringLiteral("lastShaderDir"), QDir(fileName).absolutePath());

    exportTo(fileName);
}

bool ShaderBufferWindow::exportTo(const QString& chosenName)
{
    const QString fileName = ShaderText::withFragmentExtension(chosenName);

    QFile file(fileName);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Truncate))
    {
        m_status->setText(tr("Could not write %1").arg(fileName));
        GraphicsLog::warn(QStringLiteral("shader buffer: could not write %1").arg(fileName));
        return false;
    }
    {
        QTextStream out(&file);
        SonicPiScintilla* editor = currentEditor();
        out << (editor ? editor->text() : QString());
    }
    file.close();

    m_status->setText(tr("Saved to %1").arg(fileName));
    GraphicsLog::info(QStringLiteral("shader buffer: exported to %1").arg(fileName));
    return true;
}

void ShaderBufferWindow::showCompileReport(bool ok, const QString& compilerLog,
                                           const QString& errorFile, int errorLine,
                                           const QString& shaderName)
{
    // Which buffer this report is about: the one named, or - for the window's own messages, like "the
    // render loop is not running" - whichever buffer is being edited.
    const QString name = shaderName.isEmpty() ? editingShaderName() : shaderName;

    if (ok && compilerLog.isEmpty())
    {
        m_reports.insert(name, QString());
        m_statusByBuffer.insert(name, tr("On screen. %1 is the picture now.").arg(name));
        if (name == editingShaderName())
            showCurrentBuffer();
        return;
    }

    // A failure with no compiler output at all is a contradiction, not a shader problem: the driver
    // always says something when a build fails. Saying so is better than an empty "FAILED" beside an
    // empty report pane, which is what a verdict/outcome mismatch looked like from the outside.
    if (!ok && compilerLog.trimmed().isEmpty() && errorLine == 0)
    {
        const QString text = tr("The renderer reported a failed build but gave no compiler output. "
                                "This is a bug in the graphics feature, not in this shader - see "
                                "graphics.log.");
        m_reports.insert(name, text);
        m_statusByBuffer.insert(name, text);
        if (name == editingShaderName())
            showCurrentBuffer();
        return;
    }

    // WHERE the problem is, in terms this window can name: the file, and the line inside it.
    //
    // The driver's own text says "1:11", where 1 is a source string number the renderer assigned to an
    // included file and 11 is the line inside that file. Turning that number back into a name needs
    // the table the expander produced, so it happens in the renderer and what arrives here is already
    // "lib/noise.frag:11" (ShaderText::attributeDiagnostics). Naming the file and the line is the whole
    // of what this report owes the user, which is why there is no "Go to Error" button.
    //
    // No position is a normal outcome, not a failure to parse: some diagnostics name none, and
    // inventing one would be worse than saying only the file.
    const QString ownFile = ShaderText::diagnosticName(bufferFilePath(name),
                                                       GraphicsSettings::shaderDirectoryPath());
    const QString file = errorFile.isEmpty() ? ownFile : errorFile;
    const QString where = errorLine > 0 ? QStringLiteral("%1:%2").arg(file).arg(errorLine) : file;

    // The one decision the line number alone cannot make: is that line in the document this window is
    // showing? A diagnostic inside an included library points at a line of a file this editor is not
    // displaying, so moving the cursor would put it on an unrelated line of THIS file - the failure
    // ShaderText has refused to guess its way into from the start (docs/shader-includes-plan.md 4).
    const bool inThisDocument = errorLine > 0 && file == ownFile;

    // The compiler's text is shown verbatim below the location. It is not reformatted, not summarised
    // and not translated: a driver's diagnostic is the single most useful thing in this window, and
    // paraphrasing it would lose the part that matters.
    m_reports.insert(name, errorLine > 0 ? QStringLiteral("%1\n\n%2").arg(where, compilerLog)
                                         : compilerLog);

    // The picture is NOT lost, and the status says so in those words: "still rendering X" is the
    // reassurance the user needs when their edit was refused, and it is the sentence that turns a wall
    // of compiler errors from "the feature broke" into "this buffer did not build".
    const QString onScreen = m_renderThread ? m_renderThread->shaderName()
                                            : GraphicsSettings::defaultShaderName();

    if (errorLine > 0 && !inThisDocument)
    {
        m_statusByBuffer.insert(name,
                                ok ? tr("Compiled with warnings. First at %1, which is not this buffer.")
                                         .arg(where)
                                   : tr("Compile FAILED at %1, which is not this buffer. Still "
                                        "rendering %2 - fix the error below and compile again.")
                                         .arg(where, onScreen));
    }
    else if (errorLine > 0)
    {
        m_statusByBuffer.insert(name,
                                ok ? tr("Compiled with warnings. First at %1.").arg(where)
                                   : tr("Compile FAILED at %1. Still rendering %2 - fix the error "
                                        "below and compile again.").arg(where, onScreen));
    }
    else
    {
        m_statusByBuffer.insert(name,
                                ok ? tr("Compiled with warnings.")
                                   : tr("Compile FAILED in %1. Still rendering %2 - fix the error below "
                                        "and compile again.").arg(file, onScreen));
    }

    if (name != editingShaderName())
    {
        // Another buffer's report. Kept for when that tab is opened, and mentioned now rather than
        // silently filed: a compile the user asked for that produces nothing visible reads as a compile
        // that never happened.
        showCurrentBuffer();
        m_status->setText(tr("Buffer %1: %2").arg(name, m_statusByBuffer.value(name)));
        return;
    }

    m_report->setPlainText(m_reports.value(name));
    m_status->setText(m_statusByBuffer.value(name));

    if (errorLine > 0 && inThisDocument)
    {
        // The cursor is also put on the line, because after asking for a compile the first thing
        // wanted is to see what it complained about. That is a convenience riding on top of the
        // report, not the mechanism: jumpToLine() checks the document and does nothing if the line
        // does not exist, and the report above says where to look either way.
        jumpToLine(errorLine);
    }
}


void ShaderBufferWindow::jumpToLine(int line)
{
    if (line <= 0)
        return;

    SonicPiScintilla* editor = currentEditor();
    if (!editor)
        return;

    // 1-based from the compiler, 0-based here. Checked against the document rather than trusted: a
    // diagnostic naming a line past the end would put the cursor at the end of the file, which reads
    // as the editor having jumped somewhere wrong.
    const int index = line - 1;
    if (index < 0 || index >= editor->lines())
        return;

    editor->setCursorPosition(index, 0);
    editor->ensureLineVisible(index);
    editor->setFocus();
}

void ShaderBufferWindow::closeEvent(QCloseEvent* e)
{
    GraphicsLog::info(QStringLiteral("shader buffer: window closed by user"));
    emit closedByUser();
    QWidget::closeEvent(e);
}

} // namespace SonicPi
