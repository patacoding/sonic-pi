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
#include <QSignalBlocker>
#include <QAction>
#include <QComboBox>
#include <QMenu>
#include <QFormLayout>
#include <QDialogButtonBox>
#include <QDialog>

#include "GraphicsDocuments.h"
#include <QHBoxLayout>
#include <QHash>
#include <QInputDialog>
#include <QLabel>
// The channel previews: decoded at thumbnail size rather than loaded and shrunk (see the loader).
#include <QImage>
#include <QImageReader>
#include <QPixmap>
#include <QLineEdit>
#include <QMessageBox>
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
// Ctrl+C/V/X and no Ctrl+A - a code editor without undo - and with no Tab either (see below). The
// COMMANDS were never removed, only their keys, so restoring the expected bindings is the whole
// repair. They are set on this editor's own command set, so nothing else in the application is
// affected.
//
// Deliberately only the keys that mean the same thing in any text editor. Sonic Pi's other Code-menu
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
    // Ctrl+X/C/V/A, and Tab.
    //
    // The cut/copy commands are named SelectionCut/SelectionCopy in QScintilla; there is no plain
    // Cut/Copy.
    //
    // TAB is a key of its own kind. The main window does have a Tab for its editors, but it is a
    // MainWindow QShortcut that runs Sonic Pi's complete-or-indent (mainwindow.cpp), and this window
    // has no snippet list to complete against - and must not borrow the audio side's semantics. So Tab
    // gets Scintilla's own Indent command, which with this editor's setTabIndents(true) indents the
    // caret or every selected line; Shift+Tab (Backtab) is bound by the constructor, so de-indenting
    // already worked. Without this binding Tab does NOTHING AT ALL rather than moving the focus:
    // QsciScintillaBase::focusNextPrevChild() returns false for an editable document precisely so that
    // Tab reaches the editor, and then nothing is bound to it - reported by the user as "Tab 无效".
    const Binding bindings[] = {
        { QsciCommand::Undo,          cmd | Qt::Key_Z,                 0 },
        { QsciCommand::Redo,          cmd | Qt::SHIFT | Qt::Key_Z,     cmd | Qt::Key_Y },
        { QsciCommand::SelectionCut,  cmd | Qt::Key_X,                 0 },
        { QsciCommand::SelectionCopy, cmd | Qt::Key_C,                 0 },
        { QsciCommand::Paste,         cmd | Qt::Key_V,                 0 },
        { QsciCommand::SelectAll,     cmd | Qt::Key_A,                 0 },
        { QsciCommand::Tab,           Qt::Key_Tab,                     0 },
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
    m_goToErrorButton = new QPushButton(tr("Go to Error"), this);
    m_goToErrorButton->setToolTip(tr("Jump to the line the last compile complained about"));
    m_goToErrorButton->setEnabled(false);
    connect(m_goToErrorButton, &QPushButton::clicked, this, [this]() {
        if (m_lastErrorLine > 0)
            jumpToLine(m_lastErrorLine);
    });
    QPushButton* newButton = new QPushButton(tr("New"), this);
    // The six passes always exist, so creating one is not a thing the user does (2026-10-02). The
    // control is hidden rather than deleted in this commit so the change stays one line wide.
    newButton->setVisible(false);
    QPushButton* loadButton = new QPushButton(tr("Load into Buffer..."), this);
    QPushButton* saveButton = new QPushButton(tr("Save Buffer As..."), this);

    // Named in the tooltip as well as bound, because a shortcut nobody is told about is not a feature.
    m_compileButton->setToolTip(tr("Write this buffer and put it on screen (Ctrl+Return)"));
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
    // Closable, UNLIKE the audio buffers, and deliberately so: a shader buffer is a file in a directory
    // the user controls, so a buffer can be got out of the way as well as made, and a list that can only
    // grow has no way back. The audio side's ten buffers are a fixed set of documents; these are whatever
    // the directory holds - which is the whole of the difference, and the reason this window no longer
    // copies that one blindly. Nothing is deleted from disk by closing a tab.
    m_tabs->setTabsClosable(true);
    m_tabs->setMovable(false);
    m_tabs->setTabPosition(QTabWidget::South);
    m_tabs->tabBar()->setVisible(false);
    m_tabs->tabBar()->setFixedHeight(ScaleHeightForDPI(SonicPi::kChromeControlDp));

    // MANY BUFFERS HAVE TO STAY NAVIGABLE. The tab bar is a strip that overflows, and there are three ways
    // out, all of them explicit rather than inherited from a default:
    //   * the scroll buttons (below), which are the visible affordance;
    //   * the wheel over the tab bar (eventFilter), which is the fast one;
    //   * Ctrl+Tab / Ctrl+Shift+Tab (shortcuts below), which needs no mouse at all.
    // Tabs are kept to their text width and elided rather than stretched, so more of them fit before any
    // of this is needed.
    m_tabs->tabBar()->setUsesScrollButtons(true);
    m_tabs->tabBar()->setExpanding(false);
    m_tabs->setElideMode(Qt::ElideRight);
    m_tabs->tabBar()->installEventFilter(this);
    m_tabs->setToolTip(tr("One tab per buffer. The tab marked %1 is the picture on screen; Compile "
                          "(Ctrl+Return) puts the buffer being edited on screen. The x closes the tab - "
                          "the shader file stays on disk.").arg(kOnScreenMark));

    // TWO ROWS, and which control belongs to which is the point (user, 2026-10-02: "put the compile
    // buttons on the row ABOVE the Image/Buffer tabs").
    //
    //   TOP    : what you do   - Compile, Go to Error, New, Load, Save, and the status line
    //   BOTTOM : what you edit - the pass tabs, Image first
    //
    // They were one row, which read as if the pass tabs were one more button. The tabs are a CHOICE OF
    // DOCUMENT POSITION and the buttons are ACTIONS ON IT, so the actions sit above the thing they act on -
    // the shape a person expects, and the shape Shadertoy uses.
    auto* buttons = new QWidget(this);
    auto* rows = new QVBoxLayout(buttons);
    rows->setContentsMargins(0, 0, 0, 0);
    rows->setSpacing(ScaleHeightForDPI(6));

    auto* actions = new QHBoxLayout();
    actions->setContentsMargins(0, 0, 0, 0);
    actions->addWidget(m_compileButton);
    actions->addWidget(m_goToErrorButton);
    actions->addWidget(newButton);
    actions->addWidget(loadButton);
    actions->addWidget(saveButton);
    actions->addWidget(m_status, 1);
    rows->addLayout(actions);

    // The PASS TABS: Image | Buffer A | ... | Common, the shape Shadertoy and the web editor both use
    // (graphics-web-canvas.md 4.7). Tabs rather than a dropdown, because a document's structure should be
    // visible at a glance - a dropdown hides which passes there are behind one click, and "which passes are
    // there" is the first thing this feature is about.
    auto* passRow = new QHBoxLayout();
    passRow->setContentsMargins(0, 0, 0, 0);
    m_passBar = new QTabBar(this);
    m_passBar->setExpanding(false);
    m_passBar->setDrawBase(false);
    m_passBar->setToolTip(tr("Which text of this document to edit (Ctrl+Return compiles it)"));
    connect(m_passBar, &QTabBar::currentChanged, this, [this](int index) {
        // Logged before anything else, so a click is visible even if the handler returns early. "The tab did
        // nothing" and "the tab was never clicked" have to be distinguishable, and they were not.
        GraphicsLog::info(QStringLiteral("pass tab: clicked index %1 (tabData=%2, label='%3')")
                              .arg(index)
                              .arg(m_passBar ? m_passBar->tabData(index).toInt() : -999)
                              .arg(m_passBar ? m_passBar->tabText(index) : QString()));
        if (!m_passBar || index < 0)
            return;
        setEditingPass(static_cast<GraphicsPass>(m_passBar->tabData(index).toInt()));
    });
    passRow->addWidget(m_passBar);

    // Shadertoy offers the passes you do not have yet from a "+" beside the tabs; this is that. The menu is
    // built when it opens, so it always reflects what the document has at that moment.
    auto* addPassButton = new QPushButton(tr("+"), this);
    addPassButton->setToolTip(tr("Add a pass: Common or a Buffer this document does not have yet"));
    connect(addPassButton, &QPushButton::clicked, this, [this, addPassButton]() {
        showAddPassMenu(addPassButton);
    });
    addPassButton->setVisible(false);
    passRow->addWidget(addPassButton);
    passRow->addStretch(1);
    rows->addLayout(passRow);

    // NO RIGHT-CLICK MENU ON THE PASS TABS. The six passes ARE the document (2026-10-02: "No delete
    // either: the six passes are the document, so there is nothing to remove"), so a Delete entry would
    // contradict the model - and the one that was wired here could never have appeared anyway:
    // `customContextMenuRequested` is emitted only under Qt::CustomContextMenu, while the policy was left
    // at Qt::DefaultContextMenu. Removing it rather than fixing the policy, because the menu should not
    // exist: the reachable-looking dead code was the actual defect.
    //
    // deletePass() is kept - it is how a pass that was made by mistake is undone from the Add menu, and its
    // refusal for Image is a rule worth keeping written down - but nothing offers it from the tab bar.

    auto* split = new QSplitter(Qt::Vertical, this);
    split->addWidget(m_tabs);
    split->addWidget(m_report);
    split->setStretchFactor(0, 3);
    split->setStretchFactor(1, 1);

    auto* layout = new QVBoxLayout(this);
    layout->addWidget(buttons);
    layout->addWidget(split, 1);

    // The channel row: four channels, UNDER the editor, laid out the way Shadertoy lays its own out - a
    // COLUMN each: the name, the combo that chooses, and the picture BELOW them, big enough to recognise
    // the image by. See the header for why it is not a dialog.
    //
    // It was one line of four (name, combo, small thumbnail each) and the user rejected it: the pictures
    // were too small to tell one screenshot from another, and a row that has to fit four of everything
    // sideways has no room to make them bigger. Four columns give each channel its own full width, so the
    // preview can be a real thumbnail rather than an icon.
    m_channelRow = new QWidget(this);
    auto* channelLayout = new QHBoxLayout(m_channelRow);
    channelLayout->setContentsMargins(0, 0, 0, 0);
    channelLayout->setSpacing(ScaleWidthForDPI(12));
    for (int i = 0; i < 4; ++i)
    {
        auto* column = new QVBoxLayout();
        column->setContentsMargins(0, 0, 0, 0);
        column->setSpacing(ScaleHeightForDPI(4));

        column->addWidget(new QLabel(QStringLiteral("iChannel%0").arg(i), m_channelRow));

        m_channelCombos[i] = new QComboBox(m_channelRow);
        m_channelCombos[i]->setToolTip(tr("What iChannel%1 samples (this pass's own channels)").arg(i));
        // A FIXED WIDTH, so choosing a file cannot move anything: Qt's default policy grows a combo to fit
        // its widest entry, and the entries stay short ("Image", "Buffer A") - the picture below carries the
        // rest. The column is what stretches, not the box, so the four columns stay aligned.
        m_channelCombos[i]->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
        m_channelCombos[i]->setMinimumContentsLength(12);
        m_channelCombos[i]->setSizePolicy(QSizePolicy::Fixed, QSizePolicy::Fixed);
        connect(m_channelCombos[i], QOverload<int>::of(&QComboBox::activated), this, [this](int) {
            writeChannelsFromRow();
        });
        column->addWidget(m_channelCombos[i]);

        // WHAT THE CHANNEL ACTUALLY READS, as a picture - BELOW the combo, and sized to be recognised
        // rather than merely present: a file path says nothing about whether the right image is loaded,
        // whether the path still exists, or whether a cubemap is the 4x3 cross the renderer expects, and a
        // 30-pixel icon answers none of those questions. Scaled by the same DPI helper as the rest of the
        // chrome, so it is the same physical size on a 200% display.
        m_channelPreviews[i] = new QLabel(m_channelRow);
        m_channelPreviews[i]->setFixedSize(ScaleWidthForDPI(kChannelPreviewWidth),
                                           ScaleHeightForDPI(kChannelPreviewHeight));
        m_channelPreviews[i]->setAlignment(Qt::AlignCenter);
        m_channelPreviews[i]->setScaledContents(false);
        m_channelPreviews[i]->setTextInteractionFlags(Qt::NoTextInteraction);
        column->addWidget(m_channelPreviews[i]);

        // The pass and the buffers are the same size, so the picture is never the thing that shifts a
        // column: below the previews there is room for a word, and nothing here writes one.
        auto* hint = new QLabel(m_channelRow);
        hint->setAlignment(Qt::AlignHCenter);
        m_channelHints[i] = hint;
        column->addWidget(hint);

        channelLayout->addLayout(column);
    }
    channelLayout->addStretch(1);
    layout->addWidget(m_channelRow);

    // What this window actually built, once, at construction. Not decoration: the controls are added in
    // several places and a mistake there is invisible from the outside - the window simply looks unchanged,
    // which is indistinguishable from "the change was never made".
    GraphicsLog::info(QStringLiteral("shader buffer: window built - tabs=%1 compile=%2 new=%3 passBar=%4 "
                                     "channelRow=%5 goToError=%6 previews=%7")
                          .arg(m_tabs ? QStringLiteral("yes") : QStringLiteral("NO"))
                          .arg(m_compileButton ? QStringLiteral("yes") : QStringLiteral("NO"))
                          .arg(newButton ? QStringLiteral("yes") : QStringLiteral("NO"))
                          .arg(m_passBar ? QStringLiteral("yes") : QStringLiteral("NO"))
                          .arg(m_channelRow ? QStringLiteral("yes") : QStringLiteral("NO"))
                          .arg(m_goToErrorButton ? QStringLiteral("yes") : QStringLiteral("NO"))
                          .arg(m_channelPreviews[0] ? QStringLiteral("yes") : QStringLiteral("NO")));

    // Which trigger fired, in the log. Two ways in - the button and Ctrl+Return - and "the key did
    // nothing" is otherwise indistinguishable from "the key never reached this window": the editor
    // widget sits between the two, and whether it swallows a chord is its business, not something to
    // assume. One line per press settles it.
    connect(m_compileButton, &QPushButton::clicked, this, [this]() {
        GraphicsLog::info(QStringLiteral("shader buffer: compile by button (%1)").arg(editingShaderName()));
        compile();
    });
    connect(newButton, &QPushButton::clicked, this, [this, newButton]() { showAddPassMenu(newButton); });
    connect(loadButton, &QPushButton::clicked, this, &ShaderBufferWindow::loadFromFile);
    connect(saveButton, &QPushButton::clicked, this, &ShaderBufferWindow::saveToFile);

    // Switching tabs is a VIEW action and nothing else: it shows that buffer's text and its last
    // report, and does not touch what is on screen. Same as the audio side, where switching buffers
    // neither starts nor stops anything - the picture changes when the user compiles.
    connect(m_tabs, &QTabWidget::currentChanged, this, [this](int) {
        showCurrentBuffer();

        // The OUTER layer decides which document RENDERS: a document is a directory of passes, and the loop
        // has to be told which one to compile - at a frame boundary, on its own context, like every other
        // switch. A single-pass .frag is the candidate/active model's business and is ignored there.
        if (m_renderThread && !editingShaderName().isEmpty())
            m_renderThread->requestPassDocument(editingShaderName());
    });

    // The x on a tab CLOSES THE TAB - it does not delete anything. The name is read from the tab rather
    // than from the index, because the index can shift while a confirmation dialog is open (a compile
    // finishing, another tab closing) and acting on the wrong buffer would be a mistake either way.
    connect(m_tabs, &QTabWidget::tabCloseRequested, this, [this](int index) {
        if (!m_tabs || index < 0 || index >= m_tabs->count())
            return;
        closeBuffer(m_tabs->tabText(index).remove(kOnScreenMark).trimmed());
    });

    // Double-click a tab to rename the buffer - which renames its FILE, because the name is the file name.
    // Double-click is where every tabbed editor puts rename, so it needs no button and no explaining.
    connect(m_tabs->tabBar(), &QTabBar::tabBarDoubleClicked, this, [this](int index) {
        if (!m_tabs || index < 0 || index >= m_tabs->count())
            return;
        renameBuffer(m_tabs->tabText(index).remove(kOnScreenMark).trimmed());
    });

    // The render thread's verdict arrives here, queued from another thread.
    connect(m_renderThread, &GraphicsRenderThread::shaderCompileFinished,
            this, &ShaderBufferWindow::compileFinished);

    // ---- THE COMPILE KEY: Ctrl+Return, and only that ---------------------------------------
    //
    // Ctrl+Return matches the audio editor's Run and the habit of every shader tool. This window claims
    // one chord and nothing else: it is a different place doing a different thing, and the main window's
    // own keys are none of its business.
    auto* compileShortcut = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Return), this);
    compileShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(compileShortcut, &QShortcut::activated, this, [this]() {
        GraphicsLog::info(QStringLiteral("shader buffer: compile by Ctrl+Return (%1)")
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

    // Ctrl+W closes the current buffer's tab, exactly as the x on it does - including the question about
    // uncompiled edits, because a keyboard route to a destructive action must not be the quiet one.
    auto* closeShortcut = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_W), this);
    closeShortcut->setContext(Qt::WidgetWithChildrenShortcut);
    connect(closeShortcut, &QShortcut::activated, this, [this]() {
        const QString name = editingShaderName();
        if (!name.isEmpty())
            closeBuffer(name);
    });

    // Ctrl+1 .. Ctrl+9: put the Nth buffer on screen, without touching the mouse.
    //
    // This is the live-coding gesture the whole feature is for: prepare several shaders, then cut between
    // them with one hand while the other is on the audio side. It compiles as well as selects, because
    // putting a buffer on screen IS compiling it (see GraphicsRenderThread::requestShaderCompile) - and a
    // cut that sometimes showed a stale program would be worse than no cut at all.
    for (int digit = 1; digit <= 9; ++digit)
    {
        auto* selectShortcut =
            new QShortcut(QKeySequence(Qt::CTRL | (Qt::Key_0 + digit)), this);
        selectShortcut->setContext(Qt::WidgetWithChildrenShortcut);
        connect(selectShortcut, &QShortcut::activated, this, [this, digit]() {
            if (!m_tabs || digit > m_tabs->count())
                return;
            selectTab(m_tabs->tabText(digit - 1).remove(kOnScreenMark).trimmed());
            compile();
        });
    }

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

bool ShaderBufferWindow::eventFilter(QObject* watched, QEvent* event)
{
    // Installed on the tab bar only, and it handles one thing: the wheel. Turning it into "previous /
    // next buffer" is deliberate rather than inherited, because a bar that overflows needs a fast way
    // along it that does not require hitting a small arrow, and because the behaviour should not depend on
    // whether the tabs happen to fit (which is what Qt's own handling keys off).
    if (m_tabs && watched == m_tabs->tabBar() && event->type() == QEvent::Wheel)
    {
        auto* wheel = static_cast<QWheelEvent*>(event);
        const int step = wheel->angleDelta().y() > 0 ? -1 : 1;
        if (m_tabs->count() > 1)
            m_tabs->setCurrentIndex((m_tabs->currentIndex() + step + m_tabs->count())
                                    % m_tabs->count());
        wheel->accept();
        return true;
    }

    return QWidget::eventFilter(watched, event);
}

// The document a tab name means, from the same scan the renderer uses - so the editor and the pipeline
// cannot disagree about which kind of thing a name is. That disagreement has already cost one round: the
// editor drew the pass tabs and the channel row for a name whose file is a single-pass .frag.
//
// Stateless and a free function because the callers are static-ish helpers as much as member functions,
// and because a cache here would be a second idea of "what is on disk" to keep in step with the scan.
static GraphicsDocument scannedDocument(const QString& name)
{
    GraphicsDocument found;
    if (name.isEmpty())
        return found;
    for (const GraphicsDocument& candidate : scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath()))
    {
        if (candidate.name.compare(name, Qt::CaseInsensitive) == 0)
            return candidate;
    }
    return found;
}

QString ShaderBufferWindow::bufferFilePath(const QString& shaderName, GraphicsPass pass)
{
    // The one rule, in GraphicsSettings/GraphicsDocuments where the renderer reads it too - so this window
    // cannot write a file the pipeline does not read. It answers for a file that does not exist yet, which
    // is the case Compile is in: the pass is written first, then compiled.
    //
    // History, because this function has been wrong in both directions: it used to fall through to
    // "<name>.frag" for a document pass whose file was missing (so Compile wrote the wrong file), and the
    // single-pass branch used to be `writableShaderPath(<name>.frag)`, which is the same file this rule
    // now names for Image - and the same one the pass chain reads.
    const GraphicsDocument document = scannedDocument(shaderName);
    const QString path = graphicsDocumentPassFilePath(document, pass);
    if (!path.isEmpty())
        return path;

    return GraphicsSettings::writableShaderPath(GraphicsSettings::fragmentFileName(shaderName));
}

QString ShaderBufferWindow::editingShaderName() const
{
    if (!m_tabs || m_tabs->count() == 0)
        return QString();
    return m_tabs->tabText(m_tabs->currentIndex()).remove(kOnScreenMark).trimmed();
}

GraphicsPass ShaderBufferWindow::editingPass() const
{
    return m_passByDocument.value(editingShaderName(), GraphicsPass::Image);
}

void ShaderBufferWindow::refreshPassSelector()
{
    if (!m_passBar)
        return;

    const QString document = editingShaderName();
    const GraphicsDocument found = scannedDocument(document);

    // SIX TABS, ALWAYS - for a single-pass .frag too, and this was got wrong once: the bar was hidden for a
    // plain .frag on the strength of a line in the plan that the user had already replaced. The rule is the
    // one written at plan 20: "a top-level .frag is still a document; inside its tab only Image has text,
    // and the remaining passes show as (empty)" - five tabs you can type into, where typing creates the
    // file. Hiding the bar made the structure invisible exactly where a person is learning it, and it made
    // the channel row (which belongs to the PASS) unreachable for those files.
    //
    // So there is no "applicable" here: a document has six passes, whether or not their files exist yet,
    // and an editor for a pass with no file is simply empty. The log line stays, because "the bar is there"
    // and "the bar was never built" look identical from outside.
    GraphicsLog::info(QStringLiteral("pass tabs: '%1' document=%2 tabs=%3 visible=%4")
                          .arg(document.isEmpty() ? QStringLiteral("(none)") : document,
                               found.isValid() ? (found.singlePass ? QStringLiteral("single-pass")
                                                                   : QStringLiteral("multi-pass"))
                                               : QStringLiteral("unknown"))
                          .arg(m_passBar->count())
                          .arg(m_passBar->isVisible() ? QStringLiteral("yes") : QStringLiteral("no")));

    // The tab ORDER is Shadertoy's, not the render order: Image first and selected by default, then
    // Common, then the buffers. The render order (A -> B -> C -> D -> Image) is a property of the
    // pipeline and does not belong in a strip a person clicks - presenting it there would say the wrong
    // thing about what happens first. Image first is also what the web editor settled on after a user
    // report: opening onto Common showed an empty editor while the code that was drawing sat in Image.
    const QList<GraphicsPass> display = { GraphicsPass::Image,  GraphicsPass::BufferA, GraphicsPass::BufferB,
                                          GraphicsPass::BufferC, GraphicsPass::BufferD, GraphicsPass::Common };

    // SIGNALS OFF FOR THE REBUILD, AND BACK ON WHEN IT IS DONE. That is not tidiness: this function runs
    // at construction and after every pass change, and it removes and re-adds every tab, so without the
    // block the bar would report a currentChanged per tab and the handler would fight the rebuild.
    //
    // The bug this replaces: the block was written as a bare `blockSignals(true)` with no matching
    // `blockSignals(false)` (and no early return to excuse it), so the FIRST refresh - at construction,
    // before the window was ever shown - left the pass bar muted for the life of the window. Every later
    // click changed the tab and emitted nothing, which is exactly "clicking a pass does nothing", and it
    // is why the handler's own log line never appeared in graphics.log. A scope guard cannot be
    // forgotten the way a second call can, which is the whole reason to use one here.
    {
        const QSignalBlocker blocker(m_passBar);

        while (m_passBar->count() > 0)
            m_passBar->removeTab(0);

        int current = -1;
        for (GraphicsPass pass : display)
        {
            const int index = m_passBar->addTab(graphicsPassLabel(pass));
            m_passBar->setTabData(index, int(pass));
            if (pass == editingPass())
                current = index;
        }

        // And the bar is put back on the pass actually being edited. A rebuilt bar starts at tab 0
        // (Image) whatever the document's pass is, so without this the tabs said "you are in Image" while
        // the editor below showed Buffer B - a disagreement that reads as data loss, and the reason
        // `current` was computed here and then never used.
        if (current >= 0)
            m_passBar->setCurrentIndex(current);
    }
}

SonicPiScintilla* ShaderBufferWindow::ensurePassEditor(const GraphicsDocument& document, GraphicsPass pass)
{
    const QString key = document.name + QLatin1Char('/') + graphicsPassName(pass);
    if (SonicPiScintilla* existing = m_editorsByPass.value(key, nullptr))
        return existing;

    QStackedWidget* stack = m_editorStacks.value(document.name, nullptr);
    if (!stack)
        return nullptr;

    auto* editor = new SonicPiScintilla(nullptr, m_theme, QStringLiteral("shader_%1").arg(key), false);
    editor->setLexer(m_lexer);
    restoreEditingKeys(editor);
    editor->zoomTo(editorZoom());
    editor->setAutoIndent(true);

    QFile file(bufferFilePath(document.name, pass));
    if (file.open(QIODevice::ReadOnly | QIODevice::Text))
    {
        QTextStream in(&file);
        editor->setText(in.readAll());
        file.close();
    }

    m_editorsByPass.insert(key, editor);
    stack->addWidget(editor);
    return editor;
}

void ShaderBufferWindow::addPass(GraphicsPass pass)
{
    GraphicsDocument document = scannedDocument(editingShaderName());

    if (!document.isValid() || document.singlePass)
        return;
    if (!document.passPath(pass).isEmpty())
        return;   // it is a file, and the file is there

    const QString path = QDir(document.directory).filePath(graphicsDocumentPassFileName(pass));
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
    {
        m_status->setText(tr("Could not create %1").arg(path));
        return;
    }
    {
        QTextStream out(&file);
        // A file that compiles and does nothing, which is what a new pass should be: an empty editor would
        // fail on the first compile and look like a fault rather than a blank page.
        out << QStringLiteral("#version 330 core\n\nvoid main()\n{\n}\n");
    }
    file.close();

    // Re-scan: passPath() reads the disk, so the document object has to be rebuilt to see the new file.
    GraphicsDocument updated;
    for (const GraphicsDocument& candidate : scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath()))
        if (candidate.name.compare(document.name, Qt::CaseInsensitive) == 0)
            updated = candidate;

    ensurePassEditor(updated, pass);
    m_passByDocument.insert(updated.name, pass);
    refreshPassSelector();
    refreshChannelRow();

    // The pass tab bar is rebuilt from the document, so the new pass appears there; select it so the user
    // lands in the file they just asked for.
    for (int i = 0; i < m_passBar->count(); ++i)
    {
        if (m_passBar->tabData(i).toInt() == int(pass))
        {
            m_passBar->setCurrentIndex(i);
            setEditingPass(pass);
            break;
        }
    }
    if (QStackedWidget* stack = m_editorStacks.value(updated.name, nullptr))
        if (SonicPiScintilla* editor = m_editorsByPass.value(updated.name + QLatin1Char('/') + graphicsPassName(pass), nullptr))
        {
            stack->setCurrentWidget(editor);
            m_editors.insert(updated.name, editor);
        }

    GraphicsLog::info(QStringLiteral("shader buffer: added %1 to %2 -> %3")
                          .arg(graphicsPassLabel(pass), updated.name, path));
    m_status->setText(tr("Added %1 (%2)").arg(graphicsPassLabel(pass), path));
}

void ShaderBufferWindow::showAddPassMenu(QWidget* anchor)
{
    GraphicsDocument document = scannedDocument(editingShaderName());

    if (!document.isValid())
    {
        m_status->setText(tr("No document to add a pass to"));
        return;
    }

    if (document.singlePass)
    {
        // A top-level .frag has no directory to put a pass in, and refusing here is what made New look
        // unimplemented in the document a fresh session shows. Shadertoy's model is that every shader has the
        // pass structure, so adding a pass PROMOTES the file: <name>.frag becomes <name>/image.frag and the
        // directory takes its place. Nothing is lost - the text moves, it is not rewritten.
        const QString directory = QDir(GraphicsSettings::shaderDirectoryPath()).filePath(document.name);
        if (!QDir().mkpath(directory))
        {
            m_status->setText(tr("Could not create %1").arg(directory));
            return;
        }
        const QString from = document.passPath(GraphicsPass::Image);   // the single-pass file itself
        const QString to = QDir(directory).filePath(graphicsDocumentImageFileName());
        if (from.isEmpty() || !QFile::rename(from, to))
        {
            m_status->setText(tr("Could not move %1 into %2").arg(from, to));
            return;
        }
        GraphicsLog::info(QStringLiteral("shader buffer: promoted '%1' to a document (%2 -> %3)")
                              .arg(document.name, from, to));

        // Re-scanned rather than patched: what the tabs and this menu show must come from the disk, and the
        // document is a different shape now.
        for (const GraphicsDocument& candidate : scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath()))
            if (candidate.name.compare(document.name, Qt::CaseInsensitive) == 0)
                document = candidate;

        // The single-shader path lost its file in the move, so the document path takes over for this name.
        // The OLD tab has to go first: rebuildTabs() skips a name it already knows, so leaving it would keep
        // the single-pass editor and the new pass would silently have none - which is the same "New does
        // nothing" symptom this whole path exists to remove.
        if (m_editors.contains(document.name))
        {
            SonicPiScintilla* old = m_editors.take(document.name);
            for (int i = 0; i < m_tabs->count(); ++i)
            {
                if (m_tabs->widget(i) == old)
                {
                    m_tabs->removeTab(i);
                    break;
                }
            }
            old->deleteLater();
        }
        if (m_passByDocument.contains(document.name))
            m_passByDocument.remove(document.name);
        if (m_renderThread)
            m_renderThread->requestPassDocument(document.name);
        rebuildTabs(document.name);
        refreshPassSelector();
        refreshChannelRow();
    }

    // Only the passes that do not exist yet, and only the ones Shadertoy names: a pass is one of Common or
    // Buffer A-D, so there is nothing to type and no way to invent a name the pipeline would not know.
    QMenu menu(this);
    for (GraphicsPass pass : { GraphicsPass::Common, GraphicsPass::BufferA, GraphicsPass::BufferB,
                               GraphicsPass::BufferC, GraphicsPass::BufferD })
    {
        if (!document.passPath(pass).isEmpty())
            continue;
        QAction* action = menu.addAction(tr("Add %1").arg(graphicsPassLabel(pass)));
        connect(action, &QAction::triggered, this, [this, pass]() { addPass(pass); });
    }
    if (menu.isEmpty())
        menu.addAction(tr("Every pass already exists"))->setEnabled(false);
    menu.exec(anchor->mapToGlobal(QPoint(0, anchor->height())));
}

void ShaderBufferWindow::deletePass(GraphicsPass pass)
{
    // Image is what makes a directory a document, so removing it would delete the document rather than a
    // pass. Refused with a reason, not silently.
    if (pass == GraphicsPass::Image)
    {
        m_status->setText(tr("Image cannot be deleted: it is what makes a document a document"));
        return;
    }

    GraphicsDocument document = scannedDocument(editingShaderName());

    if (!document.isValid() || document.singlePass)
        return;

    const QString path = document.passPath(pass);
    if (path.isEmpty())
        return;

    // Asked twice, because this removes a file the user wrote. The default is No, so a stray Return does
    // nothing.
    const auto answer = QMessageBox::question(
        this, tr("Delete pass"),
        tr("Delete %1?\n\n%2\n\nThe file is removed from the document. Channels that named it will read "
           "black until they are pointed somewhere else.")
            .arg(graphicsPassLabel(pass), path),
        QMessageBox::Yes | QMessageBox::No, QMessageBox::No);
    if (answer != QMessageBox::Yes)
        return;

    if (!QFile::remove(path))
    {
        m_status->setText(tr("Could not delete %1").arg(path));
        return;
    }

    // The editor goes with it: the stack owns it, and a pass that no longer exists must not be reachable.
    const QString key = document.name + QLatin1Char('/') + graphicsPassName(pass);
    if (SonicPiScintilla* editor = m_editorsByPass.take(key))
    {
        if (QStackedWidget* stack = m_editorStacks.value(document.name, nullptr))
        {
            stack->removeWidget(editor);
            editor->deleteLater();
        }
    }

    // The document is re-scanned rather than edited in place, so what the tabs show comes from the disk.
    GraphicsDocument updated;
    for (const GraphicsDocument& candidate : scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath()))
        if (candidate.name.compare(document.name, Qt::CaseInsensitive) == 0)
            updated = candidate;

    m_passByDocument.insert(updated.name, GraphicsPass::Image);
    refreshPassSelector();
    refreshChannelRow();

    if (QStackedWidget* stack = m_editorStacks.value(updated.name, nullptr))
    {
        if (SonicPiScintilla* image = m_editorsByPass.value(updated.name + QLatin1Char('/') + graphicsPassName(GraphicsPass::Image), nullptr))
        {
            stack->setCurrentWidget(image);
            m_editors.insert(updated.name, image);
        }
    }

    GraphicsLog::info(QStringLiteral("shader buffer: deleted %1 from %2 -> %3")
                          .arg(graphicsPassLabel(pass), updated.name, path));
    m_status->setText(tr("Deleted %1 (%2)").arg(graphicsPassLabel(pass), path));
}

// The thumbnail under a channel: the picture that channel will sample, or an honest statement that there is
// not one.
//
// Three rules, each from a way this kind of widget goes wrong:
//
//   * A FILE THAT IS NOT THERE IS SAID, not drawn as a blank square. The path can be edited by hand in
//     channels.txt, and a deleted screenshot then reads as "my shader samples black" - which is exactly the
//     failure a preview exists to make visible. The name is shown in the cell, and the tooltip carries the
//     reason.
//   * NOTHING IS DRAWN FOR A BUFFER. Its picture is the pass two lines up in this very window; reading it
//     back would cost a GPU sync per refresh to show somebody what they can already see.
//   * THE IMAGE IS DECODED AT THUMBNAIL SIZE (QImageReader::setScaledSize), not loaded and then shrunk. A
//     phone photo is 12 megapixels, and decoding one per channel per refresh is a visible stall in a window
//     that refreshes on every pass switch.
void ShaderBufferWindow::refreshChannelPreviews(const QList<GraphicsChannelSource>& sources)
{
    // The box, once: an image that is not square sits inside it rather than stretching it, so the four
    // columns keep their line.
    const int boxW = ScaleWidthForDPI(kChannelPreviewWidth);
    const int boxH = ScaleHeightForDPI(kChannelPreviewHeight);

    for (int i = 0; i < 4; ++i)
    {
        QLabel* preview = m_channelPreviews[i];
        QLabel* hint = m_channelHints[i];
        if (!preview)
            continue;

        const GraphicsChannelSource source = sources.value(i);
        preview->setPixmap(QPixmap());
        preview->setText(QString());
        preview->setToolTip(QString());
        if (hint)
            hint->setText(QString());

        const QString shortName = [&source]() {
            QString name = QFileInfo(source.path).fileName();
            if (name.size() > 16)
                name = name.left(13) + QStringLiteral("...");
            return name;
        }();

        if (!source.isTexture() && !source.isCubemap())
        {
            // None, or a buffer. Nothing is drawn - a buffer's picture is the pass editor above, and the
            // combo already names it - but the box keeps its size so the row does not jump when a channel
            // changes between a file and a buffer.
            if (hint)
                hint->setText(source.isBuffer() ? graphicsPassLabel(kDrawOrder[qBound(0, source.bufferIndex,
                                                                                     kDrawOrderCount - 1)])
                                                : tr("none"));
            continue;
        }

        const bool cube = source.isCubemap();
        const QString kind = cube ? tr("Cubemap") : tr("Image");

        QImageReader reader(source.path);
        reader.setAutoTransform(true);   // a photo's EXIF rotation is part of the picture, not a detail
        const QSize size = reader.size();
        if (size.isValid() && !size.isEmpty())
        {
            // Keep the aspect ratio while fitting INSIDE the box, so a portrait photo and a panorama both
            // come out as themselves rather than as a letterbox or a stripe.
            const qreal scale = qMin(qreal(boxW) / size.width(), qreal(boxH) / size.height());
            const QSize wanted(qMax(1, int(size.width() * scale)), qMax(1, int(size.height() * scale)));
            reader.setScaledSize(wanted);
        }
        const QImage image = reader.read();

        if (image.isNull())
        {
            // Said, in the same fixed box, so a broken path is visible AND does not move anything.
            preview->setText(tr("%1\ncannot be read\n%2").arg(kind, shortName));
            preview->setToolTip(tr("%1 could not be read as an image.\n%2\n%3")
                                    .arg(kind, source.path, reader.errorString()));
            if (hint)
                hint->setText(shortName);
            GraphicsLog::warn(QStringLiteral("shader buffer: channel %1 preview could not read %2 (%3)")
                                  .arg(i).arg(source.path, reader.errorString()));
            continue;
        }

        preview->setPixmap(QPixmap::fromImage(image));
        // The name and the size BELOW the picture, not inside it: the picture is for recognising the image,
        // the words are for when recognising is not enough - and neither one moves the other.
        if (hint)
            hint->setText(QStringLiteral("%1 %2x%3").arg(shortName).arg(size.width()).arg(size.height()));
        preview->setToolTip(cube
                                ? tr("%1: %2\n%3x%4 - read as a 4x3 cross of six faces.\n"
                                     "A file that is not 4:3 cannot be laid out this way, and the channel "
                                     "would read black.")
                                      .arg(kind, source.path).arg(size.width()).arg(size.height())
                                : tr("%1: %2\n%3x%4 (shown fitted; the renderer loads it at full size)")
                                      .arg(kind, source.path).arg(size.width()).arg(size.height()));
    }
}

void ShaderBufferWindow::refreshChannelRow()
{
    if (!m_channelRow)
        return;

    const GraphicsDocument document = scannedDocument(editingShaderName());

    // The row belongs to the PASS and follows it, for EVERY document - a single-pass .frag included, whose
    // Image pass is its one file and whose buffers are the four top-level files a compile would create.
    // Common is the only thing without channels: it is text prepended to the others, not a pass that draws.
    const bool applicable = document.isValid() && editingPass() != GraphicsPass::Common;

    // Logged on every refresh - which happens on a pass change and not per frame: which pass this row shows
    // and what it read for it. Without it, "the row did not change" and "the row changed to identical values"
    // are indistinguishable from outside, and telling those apart has already cost two rounds.
    const QList<GraphicsChannelSource> shown =
        graphicsDocumentChannelSourcesFromFile(document, editingPass());
    {
        GraphicsLog::info(QStringLiteral("channel row: %1 of '%2' reads [%3|%4|%5|%6] applicable=%7")
                              .arg(graphicsPassLabel(editingPass()), document.name,
                                   graphicsChannelSourceToText(shown.value(0)),
                                   graphicsChannelSourceToText(shown.value(1)),
                                   graphicsChannelSourceToText(shown.value(2)),
                                   graphicsChannelSourceToText(shown.value(3)),
                                   applicable ? QStringLiteral("yes") : QStringLiteral("no")));
    }
    m_channelRow->setVisible(applicable);
    if (!applicable)
        return;

    // The pictures come from the same read as the combos, so what is shown and what is selected cannot be
    // two different answers to "what does this channel read".
    refreshChannelPreviews(shown);

    for (int i = 0; i < 4; ++i)
    {
        QComboBox* combo = m_channelCombos[i];
        const GraphicsChannelSource currentSource = shown.value(i);
        const QString currentText = graphicsChannelSourceToText(currentSource);
        const bool currentIsFile = currentSource.isTexture() || currentSource.isCubemap();

        // EVERY ITEM CARRIES ITS OWN SOURCE, as the text the FILE stores - and a file entry carries its path
        // in the item too, so nothing has to be looked up a second time.
        //
        // What this replaces: item data was an int that meant three different things by range (a pass index,
        // a "kind" code, and a kind code plus an offset), and the file path was then read back out of the
        // file for the item that represented it. That is two sources of truth for one click, and it is how
        // choosing an image came to write nothing: the item the user picked reported a kind while its path
        // was fetched from a file that did not have one yet, so the write carried the OLD value and the row
        // came back unchanged. `activated` hands the handler an index, the handler reads that index's data,
        // and that data is now the whole answer.
        const QSignalBlocker blocker(combo);
        combo->clear();
        combo->addItem(tr("None"), QStringLiteral("none"));

        // The four buffers SHADERTOY HAS, always listed - Shadertoy's own channel menu lists Buffer A-D
        // whether or not the buffer has been written yet, and "an absent buffer is black" is already the
        // renderer's rule. Listing only the buffers that happen to have files is what made the menu change
        // shape as a document grew, and hid the choice a person was about to make.
        for (int b = 0; b < kBufferCount; ++b)
            combo->addItem(graphicsPassLabel(kDrawOrder[b]), graphicsPassName(kDrawOrder[b]));

        // The chosen file, selected, and named only as "Image" / "Cubemap": the PICTURE beside this combo
        // says which file it is, and a file name in a combo box makes the box as wide as the longest name
        // anybody ever chose - which pushed the other three channels off the row. The name is in the
        // tooltip and on the thumbnail for anyone who needs to read it.
        if (currentIsFile)
        {
            combo->addItem(currentSource.isCubemap() ? tr("Cubemap") : tr("Image"), currentText);
            combo->setItemData(combo->count() - 1, QFileInfo(currentSource.path).fileName(),
                               Qt::ToolTipRole);
            combo->setCurrentIndex(combo->count() - 1);
        }

        // ONE image entry and one cubemap entry, not "Texture" plus "image": a channel that reads a file
        // reads an image, and what the renderer does with it is its own business. These two are REQUESTS -
        // "ask me for a file" - which is why they are marked as such rather than looking like a source.
        combo->addItem(tr("Image..."), kChannelSourceChooseImage);
        combo->addItem(tr("Cubemap..."), kChannelSourceChooseCubemap);

        if (!currentIsFile)
        {
            const int index = combo->findData(currentText);
            combo->setCurrentIndex(index >= 0 ? index : 0);   // None when the file said something odd
        }
    }
}

void ShaderBufferWindow::writeChannelsFromRow()
{
    const GraphicsDocument document = scannedDocument(editingShaderName());
    if (!document.isValid())
        return;

    // The sender is one of the four combos; `sender()` is how the connection knows which, so one slot can
    // serve all four rather than four near-identical lambdas.
    const QComboBox* combo = qobject_cast<QComboBox*>(sender());
    int changed = -1;
    for (int i = 0; i < 4; ++i)
    {
        if (m_channelCombos[i] == combo)
        {
            changed = i;
            break;
        }
    }
    if (changed < 0)
        return;

    // WHAT THE USER PICKED, read from the item itself - "bufferA", "none", "texture:<path>", or one of the
    // two requests. This is the one place a click is turned into a value, and it is the same text the file
    // holds, so a choice cannot mean one thing here and another there.
    const QString picked = combo->currentData().toString();

    // The other three channels come from the FILE, not from their widgets: the row is rebuilt per pass, and
    // a widget that has not finished reflecting the file yet must not be able to write over it.
    QList<GraphicsChannelSource> chosen =
        graphicsDocumentChannelSourcesFromFile(document, editingPass());
    while (chosen.size() < 4)
        chosen << GraphicsChannelSource{};

    if (picked == QLatin1String(kChannelSourceChooseImage)
        || picked == QLatin1String(kChannelSourceChooseCubemap))
    {
        const bool cube = (picked == QLatin1String(kChannelSourceChooseCubemap));
        const GraphicsChannelSource previous = chosen.value(changed);
        const QString start = previous.path.isEmpty() ? QDir::homePath() : previous.path;
        const QString file = QFileDialog::getOpenFileName(
            this, cube ? tr("Choose a cubemap image (a 4x3 cross)") : tr("Choose an image"), start,
            cube ? tr("Images (*.png *.jpg *.jpeg *.hdr *.exr);;All files (*)")
                 : tr("Images (*.png *.jpg *.jpeg *.bmp);;All files (*)"));
        if (file.isEmpty())
        {
            // Cancelled: put the row back to what the file says rather than leaving the request entry
            // selected, so the row never shows a choice that was not made.
            refreshChannelRow();
            return;
        }
        chosen[changed].kind = cube ? GraphicsChannelSource::Cubemap : GraphicsChannelSource::Texture;
        chosen[changed].path = file;
    }
    else
    {
        // Everything else IS a source already, in the file's own words: "none", "bufferA".."bufferD", or a
        // "texture:"/"cubemap:" line that was re-selected from the row.
        chosen[changed] = graphicsChannelSourceFromText(picked);
    }

    if (!writeGraphicsDocumentChannelSources(document, editingPass(), chosen))
    {
        m_status->setText(tr("Could not write %1").arg(graphicsDocumentChannelsPath(document)));
        GraphicsLog::error(QStringLiteral("shader buffer: could not write %1")
                               .arg(graphicsDocumentChannelsPath(document)));
        return;
    }

    GraphicsLog::info(QStringLiteral("shader buffer: channel %1 of %2 -> [%3|%4|%5|%6] in %7")
                          .arg(changed)
                          .arg(editingShaderName())
                          .arg(graphicsChannelSourceToText(chosen.value(0)),
                               graphicsChannelSourceToText(chosen.value(1)),
                               graphicsChannelSourceToText(chosen.value(2)),
                               graphicsChannelSourceToText(chosen.value(3)),
                               graphicsDocumentChannelsPath(document)));

    // The row is rebuilt from what was just written, so the displayed state is the file's state. Without
    // this the row and the file can disagree - which is exactly how a "saved" choice appeared to be lost.
    refreshChannelRow();

    // AND IT TAKES EFFECT NOW. The channels are what a pass SAMPLES, so a change to them is a change to what
    // is being drawn - and until this call the new assignment sat in the file while the picture kept using
    // the old one, which is indistinguishable from "choosing an image does nothing". `rebuild` is the same
    // request Compile makes: same document, files changed, build the passes again. It cannot drop the
    // picture: a pass that fails to build keeps the program it had.
    if (m_renderThread)
    {
        if (!m_renderThread->requestPassDocument(document.name, true))
            GraphicsLog::warn(QStringLiteral("shader buffer: channel change could not be applied "
                                             "(the render loop is not running)"));
    }

    m_status->setText(tr("iChannel%1 = %2 (live)")
                          .arg(changed)
                          .arg(graphicsChannelSourceToText(chosen.value(changed))));
}

void ShaderBufferWindow::setEditingPass(GraphicsPass pass)
{
    const QString document = editingShaderName();
    if (document.isEmpty() || m_passByDocument.value(document, GraphicsPass::Image) == pass)
        return;

    m_passByDocument.insert(document, pass);

    // A change of VIEW, exactly as on Shadertoy: every pass has its own editor, so this shows a different
    // one and does nothing else. No file is written - the previous version wrote the file being left behind
    // on every click, which is a save the user did not ask for - and nothing is re-read, so undo, selection
    // and scroll stay with the pass they belong to.
    if (QStackedWidget* stack = m_editorStacks.value(document, nullptr))
    {
        const QString key = document + QLatin1Char('/') + graphicsPassName(pass);
        SonicPiScintilla* editor = m_editorsByPass.value(key, nullptr);
        if (!editor)
        {
            // The six tabs are always there, so a pass with no file yet has no editor until it is opened.
            const GraphicsDocument found = scannedDocument(document);
            if (found.isValid())
                editor = ensurePassEditor(found, pass);
        }
        if (editor)
        {
            stack->setCurrentWidget(editor);
            m_editors.insert(document, editor);
        }
    }

    // The channel row belongs to the PASS: without these two calls the row keeps the previous pass's four
    // values, which is indistinguishable from "both passes share one set of channels" - and an edit then
    // writes pass A's values into pass B's section. They belong HERE, in setEditingPass; an earlier attempt
    // anchored on a string that occurs in several functions and landed in the wrong one, which is why the
    // symptom survived a green build.
    refreshPassSelector();
    refreshChannelRow();

    // The window title and the tab tooltips name the buffer being edited, and a pass change moves neither
    // by itself: switching from Image to Common left the title saying the same thing for both.
    updateTabLabels();
    updateWindowTitle();

    GraphicsLog::info(QStringLiteral("shader buffer: %1 now edits %2 (%3)")
                          .arg(document, graphicsPassLabel(pass), bufferFilePath(document, pass)));
    m_status->setText(tr("Editing %1 of %2").arg(graphicsPassLabel(pass), document));
}

SonicPiScintilla* ShaderBufferWindow::currentEditor() const
{
    const QString name = editingShaderName();
    if (QStackedWidget* stack = m_editorStacks.value(name, nullptr))
        return qobject_cast<SonicPiScintilla*>(stack->currentWidget());
    return m_editors.value(name, nullptr);
}

void ShaderBufferWindow::rebuildTabs(const QString& selectName)
{
    // OUTER layer: one tab per DOCUMENT - a directory holding image.frag, or a top-level .frag as before.
    // INNER layer: that document's own Shadertoy panel, whose pass tabs are drawn by refreshPassSelector().
    //
    // Tabs are only ever ADDED here, never removed: a file that disappears from the directory while
    // the window is open may still have unsaved text in its tab, and silently dropping that would be
    // data loss dressed up as tidiness.
    const QStringList names = GraphicsSettings::documentNames();
    const QList<GraphicsDocument> scanned = scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath());

    // Every pass gets its OWN editor, as on Shadertoy. Switching pass tabs is then a change of view, so
    // undo, selection and scroll stay with the pass; one editor handed different text - which is what this
    // did before - shares all three without saying so.
    const auto makeEditor = [this](const QString& key) {
        auto* editor = new SonicPiScintilla(nullptr, m_theme, QStringLiteral("shader_%1").arg(key), false);
        editor->setLexer(m_lexer);
        restoreEditingKeys(editor);
        editor->zoomTo(editorZoom());

        // Scintilla's OWN auto-indentation, not SonicPiScintilla's `autoIndent` flag - that one does not
        // indent anything itself, it emits bufferNewlineAndIndent for Sonic Pi's Ruby side to answer (the
        // main window connects that to the API). Nothing answers it here, so turning it on would make the
        // Return key do nothing at all. This call keeps the work local, which is what a GLSL editor needs.
        editor->setAutoIndent(true);
        return editor;
    };

    for (const QString& name : names)
    {
        if (m_editorStacks.contains(name) || m_editors.contains(name))
            continue;

        GraphicsDocument document;
        for (const GraphicsDocument& candidate : scanned)
        {
            if (candidate.name.compare(name, Qt::CaseInsensitive) == 0)
            {
                document = candidate;
                break;
            }
        }

        // Shadertoy's tab order: Image first and selected, then the buffers, then Common. The RENDER order
        // (A -> B -> C -> D -> Image) belongs to the pipeline and stays out of a strip a person clicks -
        // putting it there would say the wrong thing about what happens first.
        // EVERY document gets all six passes. A pass whose file does not exist is not skipped - its editor
        // is simply empty, and typing in it plus Compile is what creates the file. Building only the passes
        // that happen to be on disk is what made the bar and the editor disagree about which passes a
        // document has.
        const QList<GraphicsPass> order = { GraphicsPass::Image,  GraphicsPass::BufferA, GraphicsPass::BufferB,
                                            GraphicsPass::BufferC, GraphicsPass::BufferD, GraphicsPass::Common };

        auto* stack = new QStackedWidget(m_tabs);
        SonicPiScintilla* shown = nullptr;
        for (GraphicsPass pass : order)
        {
            const QString key = name + QLatin1Char('/') + graphicsPassName(pass);
            SonicPiScintilla* editor = makeEditor(key);

            // Read the pass's file into ITS editor. Missing is a normal state - a pass whose file was never
            // written - and it is reported in that document's own status, not as a window-wide failure.
            QFile file(bufferFilePath(name, pass));
            if (file.open(QIODevice::ReadOnly | QIODevice::Text))
            {
                QTextStream in(&file);
                editor->setText(in.readAll());
                file.close();
            }
            else if (pass == GraphicsPass::Image)
            {
                m_statusByBuffer.insert(name, tr("No file yet at %1 - Compile will create it.")
                                                  .arg(bufferFilePath(name, pass)));
            }

            m_editorsByPass.insert(key, editor);
            stack->addWidget(editor);
            if (pass == m_passByDocument.value(name, GraphicsPass::Image) || !shown)
                shown = editor;
        }
        stack->setCurrentWidget(shown);

        m_editorStacks.insert(name, stack);
        m_editors.insert(name, shown);
        m_tabs->addTab(stack, name);

        GraphicsLog::info(QStringLiteral("shader buffer: tab '%1' holds %2 pass editor(s), showing %3")
                              .arg(name)
                              .arg(order.size())
                              .arg(graphicsPassLabel(m_passByDocument.value(name, GraphicsPass::Image))));
    }

    refreshPassSelector();
    refreshChannelRow();
    updateTabLabels();

        // ONE document at a time: start on a directory document when there is one. Not because a single-pass
        // .frag lacks the structure - every document has six passes now - but because a directory document
        // is the one whose buffers are separate files, so it is the one where a fresh session has something
        // to show. When there is no directory document, the requested name (or `default`) is used as before.
        QString wanted = selectName.isEmpty() ? editingShaderName() : selectName;
    if (wanted.isEmpty())
    {
        for (const GraphicsDocument& candidate : scanned)
        {
            if (!candidate.singlePass)
            {
                wanted = candidate.name;
                break;
            }
        }
    }
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
                                     : tr("%1 - press Compile (Ctrl+Return) to put it on screen").arg(name));
    }
}

void ShaderBufferWindow::updateWindowTitle()
{
    const QString name = editingShaderName();
    if (name.isEmpty())
    {
        setWindowTitle(tr("Sonic Pi - Shader Buffer"));
        return;
    }

    const QString onScreen = m_renderThread ? m_renderThread->shaderName()
                                            : GraphicsSettings::defaultShaderName();
    setWindowTitle(name.compare(onScreen, Qt::CaseInsensitive) == 0
                       ? tr("Sonic Pi - Shader Buffer - %1 (on screen)").arg(name)
                       : tr("Sonic Pi - Shader Buffer - %1").arg(name));
}

void ShaderBufferWindow::showCurrentBuffer()
{
    const QString name = editingShaderName();
    if (name.isEmpty())
        return;

    refreshPassSelector();
    refreshChannelRow();
    updateTabLabels();
    updateWindowTitle();

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
                          "// Ctrl+Return (or Compile) writes this file and puts it on screen.\n"
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

void ShaderBufferWindow::closeBuffer(const QString& shaderName)
{
    if (shaderName.isEmpty())
        return;

    const QString path = bufferFilePath(shaderName);
    SonicPiScintilla* editor = m_editors.value(shaderName, nullptr);
    const QString onScreen = m_renderThread ? m_renderThread->shaderName()
                                            : GraphicsSettings::defaultShaderName();

    // The one thing that CAN be lost by closing: text edited in this tab and never compiled - because the
    // file is the compiled state, and anything typed since is only in the editor. The file is read back
    // and compared rather than a dirty flag being tracked, so the question is about the bytes on disk
    // instead of about a flag that could have drifted.
    if (editor)
    {
        QFile file(path);
        QString onDisk;
        if (file.open(QIODevice::ReadOnly | QIODevice::Text))
        {
            QTextStream in(&file);
            onDisk = in.readAll();
            file.close();
        }

        if (editor->text() != onDisk)
        {
            QMessageBox confirm(this);
            confirm.setIcon(QMessageBox::Warning);
            confirm.setWindowTitle(tr("Close Buffer"));
            confirm.setText(tr("Buffer \"%1\" has edits that have not been compiled.").arg(shaderName));
            confirm.setInformativeText(tr("Closing the tab discards them. The file is not touched:\n%1")
                                           .arg(path));
            QPushButton* closeButton = confirm.addButton(tr("Close and discard"), QMessageBox::DestructiveRole);
            confirm.addButton(QMessageBox::Cancel);
            confirm.setDefaultButton(QMessageBox::Cancel);
            confirm.exec();
            if (confirm.clickedButton() != closeButton)
                return;   // cancelled, which is not an error
        }
    }

    GraphicsLog::info(QStringLiteral("shader buffer: closed buffer '%1' (file left alone: %2)")
                          .arg(shaderName, path));

    // The compiled program belongs to the render thread, so the release is a request like every other
    // change that touches GL. The file stays, so the program can be rebuilt from it at any time.
    if (m_renderThread)
        m_renderThread->requestShaderForget(shaderName);

    // The tab, its editor, and everything remembered about it.
    if (editor)
    {
        const int index = m_tabs->indexOf(editor);
        if (index >= 0)
            m_tabs->removeTab(index);
        m_editors.remove(shaderName);
        editor->deleteLater();
    }
    m_reports.remove(shaderName);
    m_statusByBuffer.remove(shaderName);

    // A closed tab must not leave the picture unrepresented: the tab bar shows which buffer is on screen,
    // and if that buffer has no tab the mark has nowhere to live. So closing the buffer that IS the
    // picture puts `default` on screen - and the status says so, because a picture that changes while the
    // user was doing something else to the editor would otherwise be a mystery.
    if (shaderName.compare(onScreen, Qt::CaseInsensitive) == 0)
    {
        const QString fallback = GraphicsSettings::defaultShaderName();
        if (m_renderThread && m_renderThread->requestShaderCompile(fallback))
        {
            m_status->setText(tr("Closed %1 - it was the picture, so %2 is on screen now. "
                                 "%3 is still on disk.").arg(shaderName, fallback, path));
            GraphicsLog::info(QStringLiteral("shader buffer: '%1' was the picture; asked for '%2'")
                                  .arg(shaderName, fallback));
        }
    }

    refreshPassSelector();
    refreshChannelRow();
    updateTabLabels();
    if (m_tabs->count() > 0)
        selectTab(editingShaderName());
    else
        showCurrentBuffer();
}

void ShaderBufferWindow::renameBuffer(const QString& oldName)
{
    if (oldName.isEmpty())
        return;

    bool ok = false;
    const QString typed = QInputDialog::getText(this, tr("Rename Buffer"),
                                                tr("New name (the buffer is the file <name>.frag):"),
                                                QLineEdit::Normal, oldName, &ok);
    if (!ok)
        return;   // cancelled, which is not an error

    const QString name = typed.trimmed();
    if (name.isEmpty() || name == oldName)
        return;
    if (name.contains(QRegularExpression(QStringLiteral("[\\\\/:*?\"<>|]"))))
    {
        m_status->setText(tr("A buffer name cannot contain \\ / : * ? \" < > |"));
        return;
    }
    if (m_editors.contains(name))
    {
        m_status->setText(tr("There is already a buffer called %1").arg(name));
        return;
    }

    const QString oldPath = bufferFilePath(oldName);
    const QString newPath = bufferFilePath(name);
    if (QFile::exists(newPath))
    {
        // Refused rather than merged: the whole model is "one name, one file", and quietly taking over a
        // file somebody else's buffer is about would be the worst possible reading of "rename".
        m_status->setText(tr("%1 already exists").arg(newPath));
        GraphicsLog::warn(QStringLiteral("shader buffer: cannot rename '%1' to '%2': the file exists")
                              .arg(oldName, newPath));
        return;
    }

    // The FILE first: the name means the file, and a tab renamed without its file would be a buffer whose
    // text comes from somewhere else on the next window rebuild.
    if (QFile::exists(oldPath) && !QFile::rename(oldPath, newPath))
    {
        m_status->setText(tr("Could not rename %1").arg(oldPath));
        GraphicsLog::error(QStringLiteral("shader buffer: could not rename %1 to %2")
                               .arg(oldPath, newPath));
        return;
    }
    GraphicsLog::info(QStringLiteral("shader buffer: renamed '%1' to '%2' (%3 -> %4)")
                          .arg(oldName, name, oldPath, newPath));

    // Everything remembered about the buffer moves with it: the editor, its report, its status. The editor
    // widget itself is kept, because it holds the text the user is looking at.
    SonicPiScintilla* editor = m_editors.take(oldName);
    if (editor)
    {
        m_editors.insert(name, editor);
        const int index = m_tabs->indexOf(editor);
        if (index >= 0)
            m_tabs->setTabText(index, name);
    }
    if (m_reports.contains(oldName))
        m_reports.insert(name, m_reports.take(oldName));
    if (m_statusByBuffer.contains(oldName))
        m_statusByBuffer.insert(name, m_statusByBuffer.take(oldName));

    // The render thread knows buffers by name. If this was the picture, ask for it under the new name: the
    // program is rebuilt from the renamed file, so the picture keeps following the file it came from. If it
    // was not, the old entry is dropped (it is not the active one, so the request is honoured).
    if (m_renderThread)
    {
        const bool wasOnScreen =
            m_renderThread->shaderName().compare(oldName, Qt::CaseInsensitive) == 0;
        if (wasOnScreen)
        {
            m_compilingShaderName = name;
            GraphicsSettings::setActiveShaderName(name);
            if (!m_renderThread->requestShaderCompile(name))
                GraphicsLog::warn(QStringLiteral("shader buffer: rename could not ask for '%1' to be "
                                                 "recompiled (no running loop)").arg(name));
        }
        m_renderThread->requestShaderForget(oldName);
    }

    refreshPassSelector();
    refreshChannelRow();
    updateTabLabels();
    selectTab(name);
    m_status->setText(tr("Renamed to %1 (%2)").arg(name, newPath));
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

    // THE PASS BEING EDITED, not the default. This call used the default argument (Image) while the text
    // above came from whichever pass tab was selected, so in a document every pass wrote its text to
    // image.frag: editing Buffer B and compiling replaced the Image pass with Buffer B's code, and Buffer
    // B's own file was never written at all. Two facts about the same click have to name the same pass.
    const GraphicsPass pass = editingPass();
    const QString path = bufferFilePath(name, pass);
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
    GraphicsLog::info(QStringLiteral("shader buffer: wrote %1 of '%2' -> %3 (%4 bytes); asking the render "
                                     "thread to compile and show it")
                          .arg(graphicsPassLabel(pass), name, path)
                          .arg(text.size()));

    // The render thread compiles it AND puts it on screen - one operation, because for a picture there
    // is nothing useful in between. A buffer that will not build leaves the current picture alone.
    //
    // A DOCUMENT's name is not a buffer name: there is no "<document>.frag", and its passes are compiled as
    // a set (GraphicsPassPrograms). Asking the render thread to switch to the document - which is what
    // requestPassDocument means - is what compiles the file that was just written, and it answers through
    // the same shaderCompileFinished. The render thread also redirects to this path when a plain compile
    // request names a document, so either spelling works and neither can end in "no such file".
    bool asked = false;
    if (documentIsMultiPass(name))
        asked = m_renderThread->requestPassDocument(name);
    else
        asked = m_renderThread->requestShaderCompile(name);

    if (!asked)
    {
        // No running loop means nothing will ever answer, so the window must say so rather than sit
        // on "Compiling..." forever. That state would be indistinguishable from a compile that takes
        // minutes.
        showCompileReport(false, tr("The render loop is not running, so nothing was compiled. "
                                    "The file has been saved."),
                          QString(), 0);
    }
}

// Whether this tab is a multi-pass DOCUMENT (a directory holding image.frag) rather than a single-pass .frag.
// Asked of the same scan the renderer uses, so the editor and the pipeline cannot disagree about which kind
// of thing a name is - the disagreement that made Compile write to one file and read another.
bool ShaderBufferWindow::documentIsMultiPass(const QString& name) const
{
    for (const GraphicsDocument& document : scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath()))
    {
        if (document.name.compare(name, Qt::CaseInsensitive) == 0)
            return !document.singlePass;
    }
    return false;
}

void ShaderBufferWindow::compileFinished(bool ok, const QString& compilerLog,
                                         const QString& errorFile, int errorLine,
                                         const QStringList& includedShaders)
{
    // Filed against the buffer the request named, which is not necessarily the tab on screen now.
    const QString name = m_compilingShaderName.isEmpty()
                             ? (m_renderThread ? m_renderThread->shaderName()
                                               : GraphicsSettings::defaultShaderName())
                             : m_compilingShaderName;

    // The picture follows the buffer that compiled, so the mark on the tabs has to move with it.
    if (ok && m_renderThread)
        refreshPassSelector();
    refreshChannelRow();
    updateTabLabels();

    // Remembered so that "which buffer is on screen" survives the next session: written only when the
    // compile succeeded, because a buffer that did not build never reached the screen.
    if (ok && name == m_compilingShaderName)
        GraphicsSettings::setActiveShaderName(name);

    showCompileReport(ok, compilerLog, errorFile, errorLine, name, includedShaders);
}

// Load a document from one of these saved directories: the record is what is chosen, and the six texts, the
// images and the channels come with it.
//
// THE RECORD IS CHOSEN, not the folder: a folder says nothing about whether it IS a document, and picking a
// folder would leave "why did nothing load" as the only feedback. Picking the json says exactly what the
// user means, and the file dialog's filter teaches the name at the same time.
void ShaderBufferWindow::loadFromFile()
{
    const QString startDir = m_settings
                                 ? m_settings->value(QStringLiteral("lastDocumentDir"),
                                                     QDir::homePath() + QStringLiteral("/Desktop")).toString()
                                 : QDir::homePath();

    const QString chosen = QFileDialog::getOpenFileName(
        this, tr("Open a saved document"), startDir,
        tr("ShaderToy documents (%1);;All files (*)").arg(graphicsDocumentRecordFileName()));
    if (chosen.isEmpty())
        return;   // cancelled, which is not an error

    if (m_settings)
        m_settings->setValue(QStringLiteral("lastDocumentDir"), QFileInfo(chosen).absolutePath());

    importDocumentFrom(chosen);
}

// Put a loaded document into the shaders directory, where the renderer reads documents from, and show it.
//
// It goes THERE and not "wherever it was saved": the renderer compiles from the shaders directory, so a
// document loaded anywhere else would be visible in the editor and invisible to the picture. A file that is
// already there is overwritten only after the record has been read successfully, so a failed load cannot
// destroy the document that is open.
bool ShaderBufferWindow::importDocumentFrom(const QString& recordPath)
{
    GraphicsDocumentFile file;
    const GraphicsDocumentIoResult loaded = loadGraphicsDocument(recordPath, &file);
    if (!loaded.ok)
    {
        m_status->setText(tr("Load failed: %1").arg(loaded.message));
        GraphicsLog::error(QStringLiteral("shader buffer: load of %1 failed: %2")
                               .arg(recordPath, loaded.message));
        return false;
    }

    const QString directory = QDir(GraphicsSettings::shaderDirectoryPath()).filePath(file.name);
    const GraphicsDocumentIoResult saved = saveGraphicsDocument(file, directory);
    if (!saved.ok)
    {
        m_status->setText(tr("Load failed: %1").arg(saved.message));
        GraphicsLog::error(QStringLiteral("shader buffer: could not write the loaded document into %1: %2")
                               .arg(directory, saved.message));
        return false;
    }

    // Everything that went wrong on the way is passed on rather than swallowed: a record whose bufferB.frag
    // is missing loads a document with five passes, and the difference between that and a complete one is
    // invisible in the picture.
    for (const QString& warning : loaded.warnings)
        GraphicsLog::warn(QStringLiteral("shader buffer: load of %1: %2").arg(file.name, warning));
    for (const QString& warning : saved.warnings)
        GraphicsLog::warn(QStringLiteral("shader buffer: load of %1: %2").arg(file.name, warning));

    // THIS SESSION'S COPIES ARE NOW WRONG. Tabs are only ever added to, never rebuilt, and their editors hold
    // the text they were built with - so without this the tab would show the PREVIOUS document's code while
    // the file on disk held the new one, which is the one failure this whole feature exists to avoid.
    for (int i = 0; i < kDrawOrderCount; ++i)
    {
        const GraphicsPass pass = kDrawOrder[i];
        const QString key = file.name + QLatin1Char('/') + graphicsPassName(pass);
        if (SonicPiScintilla* editor = m_editorsByPass.value(key, nullptr))
            editor->setText(file.textFor(pass));
    }

    // The channels, into the document's own file - so what the row shows and what the renderer reads come
    // from the same place, and re-saving this document writes the same assignments back.
    {
        const GraphicsDocument scanned = scannedDocument(file.name);
        if (scanned.isValid())
        {
            for (int i = 0; i < kDrawOrderCount; ++i)
            {
                const GraphicsPass pass = kDrawOrder[i];
                if (!writeGraphicsDocumentChannelSources(scanned, pass, file.channels[int(pass)]))
                {
                    GraphicsLog::warn(QStringLiteral("shader buffer: could not write the channels of %1")
                                          .arg(graphicsPassLabel(pass)));
                }
            }
        }
    }

    // And the picture: the renderer is told to build this document's passes, exactly as Compile does.
    m_compilingShaderName = file.name;
    if (m_renderThread)
        m_renderThread->requestPassDocument(file.name, true);

    // The tab exists only if this document was on disk when the window was built; a load can bring in a name
    // nobody has seen before.
    rebuildTabs(file.name);
    selectTab(file.name);
    m_passByDocument.insert(file.name, GraphicsPass::Image);
    refreshPassSelector();
    refreshChannelRow();
    updateTabLabels();
    updateWindowTitle();

    GraphicsLog::info(QStringLiteral("shader buffer: loaded document '%1' from %2 into %3 "
                                     "(%4 warning(s)); press Compile to put it on screen")
                          .arg(file.name, recordPath, directory)
                          .arg(loaded.warnings.size() + saved.warnings.size()));
    m_status->setText(loaded.warnings.isEmpty() && saved.warnings.isEmpty()
                          ? tr("Loaded %1. Compile (Ctrl+Return) puts it on screen.").arg(file.name)
                          : tr("Loaded %1, with %2 warning(s) - see graphics.log")
                                .arg(file.name)
                                .arg(loaded.warnings.size() + saved.warnings.size()));
    return true;
}

// Save the WHOLE DOCUMENT, not the pass being edited: six texts, the images their channels read, and a
// record that can rebuild all of it.
//
// Why one act rather than "export this pass": a Shadertoy document is a set of passes that only mean
// anything together - an Image that samples a Buffer that is fed by a Common function - so saving one text
// saves something that cannot be run. The old single-file export is gone with this: it wrote the current
// editor's text to a path the user chose, which is now what "Save" does for six texts at once.
void ShaderBufferWindow::saveToFile()
{
    const QString name = editingShaderName();
    if (name.isEmpty())
        return;

    const QString startDir = m_settings
                                 ? m_settings->value(QStringLiteral("lastDocumentDir"),
                                                     QDir::homePath() + QStringLiteral("/Desktop")).toString()
                                 : QDir::homePath();

    // A DIRECTORY, because a document is a directory: six files, an img/ folder and a record. Asking for a
    // file name here would be asking the user to name one sixth of what is being saved.
    const QString target = QFileDialog::getExistingDirectory(
        this, tr("Save document '%1' into a folder").arg(name), startDir,
        QFileDialog::ShowDirsOnly | QFileDialog::DontResolveSymlinks);
    if (target.isEmpty())
        return;   // cancelled, which is not an error

    if (m_settings)
        m_settings->setValue(QStringLiteral("lastDocumentDir"), target);

    saveDocumentTo(target);
}

// Gather the document as the EDITOR has it, which is not what is on disk: the user may have typed without
// compiling, and those keystrokes are exactly what a save is for.
GraphicsDocumentFile ShaderBufferWindow::currentDocumentFile() const
{
    GraphicsDocumentFile file;
    file.name = editingShaderName();

    const GraphicsDocument scanned = scannedDocument(file.name);
    for (GraphicsPass pass : { GraphicsPass::Common, GraphicsPass::Image, GraphicsPass::BufferA,
                               GraphicsPass::BufferB, GraphicsPass::BufferC, GraphicsPass::BufferD })
    {
        // The editor's text when that pass has one; the file's when it does not (a pass never opened in
        // this session, whose text is still perfectly good).
        const QString key = file.name + QLatin1Char('/') + graphicsPassName(pass);
        if (SonicPiScintilla* editor = m_editorsByPass.value(key, nullptr))
            file.setTextFor(pass, editor->text());
        else if (!scanned.passPath(pass).isEmpty())
        {
            QFile passFile(scanned.passPath(pass));
            if (passFile.open(QIODevice::ReadOnly | QIODevice::Text))
                file.setTextFor(pass, QString::fromUtf8(passFile.readAll()));
        }
    }

    for (int i = 0; i < kDrawOrderCount; ++i)
        file.channels[int(kDrawOrder[i])] = graphicsDocumentChannelSourcesFromFile(scanned, kDrawOrder[i]);

    return file;
}

bool ShaderBufferWindow::saveDocumentTo(const QString& targetDirectory)
{
    const GraphicsDocumentFile file = currentDocumentFile();
    const GraphicsDocumentIoResult saved = saveGraphicsDocument(file, targetDirectory);

    if (!saved.ok)
    {
        m_status->setText(tr("Save failed: %1").arg(saved.message));
        GraphicsLog::error(QStringLiteral("shader buffer: save of '%1' failed: %2")
                               .arg(file.name, saved.message));
        return false;
    }

    for (const QString& warning : saved.warnings)
        GraphicsLog::warn(QStringLiteral("shader buffer: save of '%1': %2").arg(file.name, warning));

    GraphicsLog::info(QStringLiteral("shader buffer: saved document '%1' -> %2 (%3 warning(s))")
                          .arg(file.name, saved.message).arg(saved.warnings.size()));
    m_status->setText(saved.warnings.isEmpty()
                          ? tr("Saved %1 (six passes, images, %2)")
                                .arg(file.name, graphicsDocumentRecordFileName())
                          : tr("Saved %1, with %2 warning(s) - see graphics.log")
                                .arg(file.name).arg(saved.warnings.size()));
    return true;
}

void ShaderBufferWindow::showCompileReport(bool ok, const QString& compilerLog,
                                           const QString& errorFile, int errorLine,
                                           const QString& shaderName,
                                           const QStringList& includedShaders)
{
    // Which buffer this report is about: the one named, or - for the window's own messages, like "the
    // render loop is not running" - whichever buffer is being edited.
    const QString name = shaderName.isEmpty() ? editingShaderName() : shaderName;

    if (ok && compilerLog.isEmpty())
    {
        // WHAT THE COMPILE READ, on success. Not decoration: a successful build says nothing about where
        // the code came from, and since a library file is never checked on its own, this list is the only
        // place a library's presence - or its absence - can be seen. "I edited lib/noise.frag and the
        // picture changed" and "I edited a library this buffer does not include" look identical without
        // it.
        const QString what = includedShaders.isEmpty()
                                 ? tr("%1\n  no #include in this buffer: nothing else was compiled.")
                                       .arg(GraphicsSettings::fragmentFileName(name))
                                 : tr("%1\n  includes: %2")
                                       .arg(GraphicsSettings::fragmentFileName(name),
                                            includedShaders.join(QStringLiteral(", ")));
        m_reports.insert(name, what);
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
    // Remembered so "Go to Error" has something to jump to. Whether that line is inside the document this
    // window is showing is decided below, once the file has been resolved to a name.
    m_lastErrorLine = errorLine;
    m_lastErrorFile = errorFile;

    const QString ownFile = ShaderText::diagnosticName(bufferFilePath(name),
                                                       GraphicsSettings::shaderDirectoryPath());
    const QString file = errorFile.isEmpty() ? ownFile : errorFile;
    const QString where = errorLine > 0 ? QStringLiteral("%1:%2").arg(file).arg(errorLine) : file;

    // Shadertoy jumps to the failing line; this is the same offer, enabled only when the line is in the
    // text this window shows - a diagnostic in a library file is named but cannot be jumped to.
    if (m_goToErrorButton)
        m_goToErrorButton->setEnabled(errorLine > 0 && file == ownFile);

    // The one decision the line number alone cannot make: is that line in the document this window is
    // showing? A diagnostic inside an included library points at a line of a file this editor is not
    // displaying, so moving the cursor would put it on an unrelated line of THIS file - the failure
    // ShaderText has refused to guess its way into from the start (docs/shader-includes-plan.md 4).
    const bool inThisDocument = errorLine > 0 && file == ownFile;

    // The compiler's text is shown verbatim below the location. It is not reformatted, not summarised
    // and not translated: a driver's diagnostic is the single most useful thing in this window, and
    // paraphrasing it would lose the part that matters.
    //
    // What the compile READ is appended when there was anything to read: on a failure it says which
    // libraries were inlined before it went wrong, which is how a diagnostic attributed to one library is
    // told apart from a mistake in the buffer itself.
    QString text = errorLine > 0 ? QStringLiteral("%1\n\n%2").arg(where, compilerLog) : compilerLog;
    if (!includedShaders.isEmpty())
        text += QStringLiteral("\n\nincludes: %1").arg(includedShaders.join(QStringLiteral(", ")));
    m_reports.insert(name, text);

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
