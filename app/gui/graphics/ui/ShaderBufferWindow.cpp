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
#include "sonicpiscintilla.h"
#include "sonicpitheme.h"

#include <QCloseEvent>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QHBoxLayout>
#include <QLabel>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QRegularExpression>
#include <QSettings>
#include <QShortcut>
#include <QSplitter>
#include <QStringList>
#include <QTextStream>
#include <QVBoxLayout>
#include <QVariant>
#include <QWheelEvent>

namespace SonicPi
{

namespace
{
// The fragment shader is the one this feature renders, and it is the file the renderer reads. Named
// here as a constant so the window and the renderer cannot ask for different files.
const char* kFragmentShaderFile = "default.frag";

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
    m_editor = new SonicPiScintilla(nullptr, m_theme, QStringLiteral("shader_buffer"), false);
    m_editor->setLexer(m_lexer);

    m_compileButton = new QPushButton(tr("Compile"), this);
    QPushButton* revertButton = new QPushButton(tr("Revert"), this);
    m_jumpButton = new QPushButton(tr("Go to Error"), this);
    m_jumpButton->setEnabled(false);
    QPushButton* loadButton = new QPushButton(tr("Load File..."), this);
    QPushButton* saveButton = new QPushButton(tr("Save File..."), this);

    m_status = new QLabel(this);
    m_status->setWordWrap(true);

    // Read-only rather than hidden when empty: an editor whose error pane appears and disappears
    // makes the window jump on every compile, and a compile failure is exactly when the user is
    // looking at where the pane is.
    m_report = new QPlainTextEdit(this);
    m_report->setReadOnly(true);
    m_report->setLineWrapMode(QPlainTextEdit::NoWrap);
    m_report->setFont(GlslLexer::editorFont(m_theme));
    m_report->setPlaceholderText(tr("The compiler's output appears here. Build problems are shown "
                                    "exactly as the driver reported them, including line numbers."));

    auto* buttons = new QWidget(this);
    auto* buttonsLayout = new QHBoxLayout(buttons);
    buttonsLayout->setContentsMargins(0, 0, 0, 0);
    buttonsLayout->addWidget(m_compileButton);
    buttonsLayout->addWidget(revertButton);
    buttonsLayout->addWidget(m_jumpButton);
    buttonsLayout->addWidget(loadButton);
    buttonsLayout->addWidget(saveButton);
    buttonsLayout->addWidget(m_status, 1);

    auto* split = new QSplitter(Qt::Vertical, this);
    split->addWidget(m_editor);
    split->addWidget(m_report);
    split->setStretchFactor(0, 3);
    split->setStretchFactor(1, 1);

    auto* layout = new QVBoxLayout(this);
    layout->addWidget(buttons);
    layout->addWidget(split, 1);

    connect(m_compileButton, &QPushButton::clicked, this, &ShaderBufferWindow::compile);
    connect(revertButton, &QPushButton::clicked, this, &ShaderBufferWindow::reloadFromDisk);
    connect(m_jumpButton, &QPushButton::clicked, this, [this]() { jumpToLine(m_errorLine); });
    connect(loadButton, &QPushButton::clicked, this, &ShaderBufferWindow::loadFromFile);
    connect(saveButton, &QPushButton::clicked, this, &ShaderBufferWindow::saveToFile);

    // The render thread's verdict arrives here, queued from another thread.
    connect(m_renderThread, &GraphicsRenderThread::shaderCompileFinished,
            this, &ShaderBufferWindow::compileFinished);
    // Ctrl+Return compiles, matching the audio editor's Run and the habit of every shader tool. Also
    // available as a button, because a shortcut nobody knows about is not a feature.
    auto* compileShortcut = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Return), this);
    compileShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(compileShortcut, &QShortcut::activated, this, &ShaderBufferWindow::compile);

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
    reloadFromDisk();
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
// WHAT IS DELIBERATELY NOT HERE: the GUI transparency setting. That is
// MainWindow::changeGUITransparency(), which calls setWindowOpacity() on the main window - it is a
// property of that window, not of the application or of its theme, so it neither reaches nor
// should reach this one. A see-through shader editor would make a shader harder to read, and this
// window exists for reading one. Nothing needs to be added to keep transparency out; adding it
// would take a deliberate setWindowOpacity() call, and there must not be one.
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

    if (m_editor)
    {
        // A lexer colour change only takes effect on the text already on screen when the styles are
        // re-applied to it; without this the editor keeps the old colours until it is reloaded.
        m_editor->recolor();
        m_editor->setMarginsFont(GlslLexer::editorFont(m_theme));
    }
}

void ShaderBufferWindow::setEditorZoom(int zoom)
{
    if (!m_editor)
        return;

    m_editor->setProperty("zoom", QVariant(zoom));
    m_editor->zoomTo(zoom);

    // The compiler report is shown in the same face and size as the code it is about, so it follows
    // the zoom. Scintilla adds the zoom to the style's point size; editorFont does the same.
    if (m_report)
        m_report->setFont(GlslLexer::editorFont(m_theme, zoom));
}

int ShaderBufferWindow::editorZoom() const
{
    return m_editor ? m_editor->currentZoom() : 0;
}

void ShaderBufferWindow::zoomIn()
{
    if (m_editor)
        m_editor->zoomFontIn();

    // zoomFontIn clamps and stores the level itself, so read it back rather than tracking a second
    // copy that could disagree with the editor.
    setEditorZoom(editorZoom());
}

void ShaderBufferWindow::zoomOut()
{
    if (m_editor)
        m_editor->zoomFontOut();

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

QString ShaderBufferWindow::shaderFilePath() const
{
    // Through GraphicsSettings, so this is the same file the renderer reads. Resolving it here by a
    // second route is the mistake that would make editing appear to do nothing.
    return GraphicsSettings::writableShaderPath(QString::fromLatin1(kFragmentShaderFile));
}

void ShaderBufferWindow::reloadFromDisk()
{
    const QString path = shaderFilePath();
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
    {
        m_status->setText(tr("Could not read %1").arg(path));
        GraphicsLog::error(QStringLiteral("shader buffer: could not read %1").arg(path));
        return;
    }

    QTextStream in(&file);
    const QString text = in.readAll();
    file.close();

    m_editor->setText(text);
    m_lastWrittenText = text;
    showCompileReport(true, QString());
    m_status->setText(tr("Loaded %1").arg(path));
    GraphicsLog::info(QStringLiteral("shader buffer: loaded %1 (%2 bytes)").arg(path).arg(text.size()));
}

void ShaderBufferWindow::compile()
{
    const QString path = shaderFilePath();
    const QString text = m_editor->text();

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
    m_lastWrittenText = text;

    m_status->setText(tr("Compiling..."));
    GraphicsLog::info(QStringLiteral("shader buffer: wrote %1 (%2 bytes), asking the render thread to compile")
                          .arg(path).arg(text.size()));

    if (!m_renderThread->requestShaderReload())
    {
        // No running loop means nothing will ever answer, so the window must say so rather than sit
        // on "Compiling..." forever. That state would be indistinguishable from a compile that takes
        // minutes.
        showCompileReport(false, tr("The render loop is not running, so nothing was compiled. "
                                    "The file has been saved."));
    }
}

void ShaderBufferWindow::compileFinished(bool ok, const QString& compilerLog)
{
    showCompileReport(ok, compilerLog);
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

    m_editor->setText(text);
    // The report is cleared because it describes the PREVIOUS contents. Leaving a stale compiler error
    // beside freshly imported code would point at a line that no longer means anything.
    showCompileReport(true, QString());
    m_status->setText(tr("Loaded %1 into the buffer. Press Compile to render it.").arg(fileName));
    GraphicsLog::info(QStringLiteral("shader buffer: imported %1 (%2 bytes)").arg(fileName).arg(text.size()));
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
        out << m_editor->text();
    }
    file.close();

    m_status->setText(tr("Saved to %1").arg(fileName));
    GraphicsLog::info(QStringLiteral("shader buffer: exported to %1").arg(fileName));
    return true;
}

void ShaderBufferWindow::showCompileReport(bool ok, const QString& compilerLog)
{
    if (ok && compilerLog.isEmpty())
    {
        m_report->clear();
        m_errorLine = 0;
        m_jumpButton->setEnabled(false);
        m_status->setText(tr("Compiled. The output is showing this shader."));
        return;
    }

    // The compiler's text is shown verbatim. It is not reformatted, not summarised and not
    // translated: a driver's diagnostic with a line number is the single most useful thing in this
    // window, and paraphrasing it would lose the part that matters.
    m_report->setPlainText(compilerLog);

    // A line number is offered when one can be recognised, and its absence is not an error: some
    // diagnostics name none, and inventing one would put the cursor somewhere arbitrary and look like
    // a bug in the editor rather than a limitation of the message.
    m_errorLine = ShaderText::firstErrorLine(compilerLog);
    m_jumpButton->setEnabled(m_errorLine > 0);

    if (m_errorLine > 0)
    {
        m_status->setText(ok ? tr("Compiled with warnings. First at line %1.").arg(m_errorLine)
                             : tr("Compile FAILED at line %1. The previous shader is still rendering - "
                                  "fix the error below and compile again.").arg(m_errorLine));
        // Jumped to immediately rather than only on request: the user asked for a compile, and the
        // first thing they want is to see the offending line. The button remains for going back after
        // scrolling away.
        jumpToLine(m_errorLine);
    }
    else
    {
        m_status->setText(ok ? tr("Compiled with warnings.")
                             : tr("Compile FAILED. The previous shader is still rendering - fix the "
                                  "error below and compile again."));
    }
}


void ShaderBufferWindow::jumpToLine(int line)
{
    if (line <= 0)
        return;

    // 1-based from the compiler, 0-based here. Checked against the document rather than trusted: a
    // diagnostic naming a line past the end would put the cursor at the end of the file, which reads
    // as the editor having jumped somewhere wrong.
    const int index = line - 1;
    if (index < 0 || index >= m_editor->lines())
        return;

    m_editor->setCursorPosition(index, 0);
    m_editor->ensureLineVisible(index);
    m_editor->setFocus();
}

void ShaderBufferWindow::closeEvent(QCloseEvent* e)
{
    GraphicsLog::info(QStringLiteral("shader buffer: window closed by user"));
    emit closedByUser();
    QWidget::closeEvent(e);
}

} // namespace SonicPi
