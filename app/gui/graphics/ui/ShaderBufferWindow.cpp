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
#include "sonicpiscintilla.h"
#include "sonicpitheme.h"

#include <QCloseEvent>
#include <QFile>
#include <QFontDatabase>
#include <QHBoxLayout>
#include <QLabel>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QShortcut>
#include <QSplitter>
#include <QTextStream>
#include <QVBoxLayout>

namespace SonicPi
{

namespace
{
// The fragment shader is the one this feature renders, and it is the file the renderer reads. Named
// here as a constant so the window and the renderer cannot ask for different files.
const char* kFragmentShaderFile = "default.frag";
} // namespace

ShaderBufferWindow::ShaderBufferWindow(SonicPiTheme* theme, GraphicsRenderThread* renderThread,
                                       QWidget* parent)
    : QWidget(parent),
      m_theme(theme),
      m_renderThread(renderThread)
{
    setWindowTitle(tr("Sonic Pi - Shader Buffer"));
    setObjectName(QStringLiteral("ShaderBufferWindow"));

    // A null lexer, deliberately: see the class comment. SonicPiScintilla guards every use of lexer()
    // with a null check, so this yields the plain-text behaviour rather than a crash.
    m_editor = new SonicPiScintilla(nullptr, m_theme, QStringLiteral("shader_buffer"), false);

    m_compileButton = new QPushButton(tr("Compile"), this);
    QPushButton* revertButton = new QPushButton(tr("Revert"), this);

    m_status = new QLabel(this);
    m_status->setWordWrap(true);

    // Read-only rather than hidden when empty: an editor whose error pane appears and disappears
    // makes the window jump on every compile, and a compile failure is exactly when the user is
    // looking at where the pane is.
    m_report = new QPlainTextEdit(this);
    m_report->setReadOnly(true);
    m_report->setLineWrapMode(QPlainTextEdit::NoWrap);
    m_report->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
    m_report->setPlaceholderText(tr("The compiler's output appears here. Build problems are shown "
                                    "exactly as the driver reported them, including line numbers."));

    auto* buttons = new QWidget(this);
    auto* buttonsLayout = new QHBoxLayout(buttons);
    buttonsLayout->setContentsMargins(0, 0, 0, 0);
    buttonsLayout->addWidget(m_compileButton);
    buttonsLayout->addWidget(revertButton);
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

    // The render thread's verdict arrives here, queued from another thread.
    connect(m_renderThread, &GraphicsRenderThread::shaderCompileFinished,
            this, &ShaderBufferWindow::compileFinished);

    // Ctrl+Return compiles, matching the audio editor's Run and the habit of every shader tool. Also
    // available as a button, because a shortcut nobody knows about is not a feature.
    auto* compileShortcut = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Return), this);
    compileShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(compileShortcut, &QShortcut::activated, this, &ShaderBufferWindow::compile);

    reloadFromDisk();
}

ShaderBufferWindow::~ShaderBufferWindow() = default;

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

void ShaderBufferWindow::showCompileReport(bool ok, const QString& compilerLog)
{
    if (ok && compilerLog.isEmpty())
    {
        m_report->clear();
        m_status->setText(tr("Compiled. The output is showing this shader."));
        return;
    }

    // The compiler's text is shown verbatim. It is not reformatted, not summarised and not
    // translated: a driver's diagnostic with a line number is the single most useful thing in this
    // window, and paraphrasing it would lose the part that matters.
    m_report->setPlainText(compilerLog);
    m_status->setText(ok ? tr("Compiled with warnings.")
                         : tr("Compile FAILED. The previous shader is still rendering - fix the "
                              "error below and compile again."));
}

void ShaderBufferWindow::closeEvent(QCloseEvent* e)
{
    GraphicsLog::info(QStringLiteral("shader buffer: window closed by user"));
    emit closedByUser();
    QWidget::closeEvent(e);
}

} // namespace SonicPi
