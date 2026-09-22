//--
// This file is part of Sonic Pi: http://sonic-pi.net
// Full project source: https://github.com/samaaron/sonic-pi
// License: https://github.com/samaaron/sonic-pi/blob/main/LICENSE.md
//
// Copyright 2013, 2014, 2015, 2016 by Sam Aaron (http://sam.aaron.name).
// All rights reserved.
//
// Permission is granted for use, copying, modification, and
// distribution of modified versions of this work as long as this
// notice is included.
//++

#include <iostream>

#include <QApplication>
#include <QBitmap>
#include <QDateTime>
#include <QFontDatabase>
#include <QLabel>
#include <QLibraryInfo>
#include <QPixmap>
#include <QStyleFactory>
#include <QSurfaceFormat>
#include <QThread>

#include "utils/dividerproxystyle.h"
#include "utils/fontroles.h"

#include "graphics/rendering/GraphicsLog.h"
#include "graphics/rendering/GraphicsRenderThread.h"

#include "mainwindow.h"

#include "widgets/sonicpilog.h"
#include "widgets/splashwidget.h"

#include "dpi.h"

#ifdef Q_OS_DARWIN
#include "platform/macos.h"
#endif
#ifdef Q_OS_WIN
#include "platform/windows_a11y.h"
#endif

int main(int argc, char* argv[])
{
    if (qgetenv("SONIC_PI_RESTART") != "")
    {
        std::cout << "Restarting Sonic Pi..." << std::endl;
        // Pause for a couple of seconds to enable the previous instance
        // of Sonic Pi to complete before starting this new replacement
        // instance. This is to ensure that the two processes don't
        // conflict with the single-instance constraint.
        QThread::msleep(2000);
    }
    else
    {
        std::cout << "Starting Sonic Pi..." << std::endl;
    }

#ifndef Q_OS_DARWIN
    Q_INIT_RESOURCE(SonicPi);
#endif

    QApplication::setAttribute(Qt::AA_DontShowIconsInMenus, true);

    // Sync GL surfaces to the display refresh (vsync). The scope is the only
    // QOpenGLWidget; this caps its swaps to the refresh rate and lets Qt's
    // repaint coalescing keep the GUI to one frame per refresh instead of
    // tearing/over-painting. Must be set before the first window is created.
    {
        QSurfaceFormat fmt = QSurfaceFormat::defaultFormat();
        fmt.setSwapInterval(1);
        QSurfaceFormat::setDefaultFormat(fmt);
    }

#if defined(Q_OS_LINUX)
    // linux code goes here
#elif defined(Q_OS_WIN)
    // windows code goes here
    // High-DPI scaling and pixmaps are always on in Qt6; only the GL
    // backend hint still does anything.
    QApplication::setAttribute(Qt::AA_UseDesktopOpenGL);

#elif defined(Q_OS_DARWIN)
    // macOS code goes here
    SonicPi::removeMacosSpecificMenuItems();
#endif

    QApplication app(argc, argv);

#if defined(Q_OS_DARWIN)
    // After QApplication: the cocoa plugin's accessibility classes only
    // exist once the platform plugin has loaded.
    SonicPi::installAccessibilityNavigationOrderShim();
#endif

#if defined(Q_OS_DARWIN) || defined(Q_OS_WIN)
    // Local accessibility self-test: drive the real platform accessibility
    // bridge (NSAccessibility on macOS, UI Automation on Windows) and exit
    // with a pass/fail code, without launching the full app.
    if (app.arguments().contains(QStringLiteral("--selftest-accessibility")))
        return SonicPi::runAccessibilitySelfTest();
#endif

    // The GUI's base type size. app.qss used to set `font-size: medium` on a
    // dozen widget types to say exactly this; carrying it on the application
    // font instead means those widgets inherit it, and — crucially — that a
    // pane's A-/A+ can override it with setFont() (a stylesheet font-size
    // cannot be overridden that way). See utils/fontroles.h.
    app.setFont(RoleFont(FontRole::Base));

    // Registered before the splash is built so its strapline gets Hack.
    QFontDatabase::addApplicationFont(":/fonts/Hack-Regular.ttf");
    QFontDatabase::addApplicationFont(":/fonts/Hack-Italic.ttf");
    QFontDatabase::addApplicationFont(":/fonts/Hack-Bold.ttf");
    QFontDatabase::addApplicationFont(":/fonts/Hack-BoldItalic.ttf");

    // Splash up before any other init. shownAtMs is read by
    // MainWindow::splashClose to enforce a minimum visible duration.
    SplashWidget* splash = new SplashWidget();
    splash->setProperty("shownAtMs", QDateTime::currentMSecsSinceEpoch());
    splash->show();
    app.processEvents();

#if defined(Q_OS_DARWIN)
    // Request mic access from the foreground GUI process — requesting from
    // a background helper (like supersonic) gets auto-denied by macOS.
    // Permission granted here applies to all child processes.
    SonicPi::requestMicrophoneAccess();
#endif

    qRegisterMetaType<SonicPiLog::MultiMessage>("SonicPiLog::MultiMessage");

    app.setApplicationName(QObject::tr("Sonic Pi"));

    // Wrap Fusion in a proxy so QMainWindow dock separators get the same
    // thin-line/hover-reveal as the custom QSplitter handles (ThinSplitter).
    {
        auto* dividerStyle = new DividerProxyStyle;
        dividerStyle->setBaseStyle(QStyleFactory::create("fusion"));
        app.setStyle(dividerStyle);
    }

    MainWindow mainWin(app, splash);

    // ---- Graphics feature, Phase 0 scaffolding --------------------------
    // Step 0.1 only: create the render thread's offscreen GL context and report
    // what the driver gave us.
    //
    // Positioned *after* MainWindow on purpose. Two things happen inside its
    // construction that this must not race: SonicPiAPI::CycleLogs() rotates the
    // previous session's logs into log/history and truncates the live ones, and
    // then stdout is redirected into gui.log. Starting the thread earlier - as
    // an earlier revision did - meant graphics.log was written and then
    // immediately rotated away, leaving the live file permanently empty.
    //
    // The thread is NOT waited on. Creating a GL context pulls in the GPU driver
    // and measured about four seconds here; blocking on it delayed audio device
    // setup far enough that Spider's five-second promise expired in
    // load_synthdefs and Sonic Pi failed to boot with "Could not connect to
    // Sonic Pi Server". contextReady() is queued back to this thread instead.
    //
    // TEMPORARY: the render loop replaces the run-to-completion inside the
    // thread, and GraphicsRuntime will own it rather than main().
    {
        auto* gfxThread = new SonicPi::GraphicsRenderThread(&app);
        QObject::connect(gfxThread, &SonicPi::GraphicsRenderThread::contextReady,
                         &app, [](bool ok) {
                             if (!ok)
                                 std::cout << "[GUI] - graphics context could not be created"
                                           << std::endl;
                         });
        gfxThread->start();

        // Self-check for the logging itself. The warning and error paths only
        // fire when something has already gone wrong, which means they would
        // otherwise never be exercised - and a broken format discovered during a
        // real failure is the worst time to find it. Set the variable and every
        // level is written once, along with the resolved path.
        //
        //   set SONIC_PI_GRAPHICS_LOG_SELFTEST=1
        if (qEnvironmentVariableIsSet("SONIC_PI_GRAPHICS_LOG_SELFTEST"))
        {
            SonicPi::GraphicsLog::info(QStringLiteral("log self-check"));
            SonicPi::GraphicsLog::warn(QStringLiteral("log self-check: warning level"));
            SonicPi::GraphicsLog::error(QStringLiteral("log self-check: error level"));
            SonicPi::GraphicsLog::info(QStringLiteral("multiline message:\n")
                                       + QStringLiteral("second line should be indented"));
            std::cout << "[GUI] - graphics log at: "
                      << SonicPi::GraphicsLog::filePath().toStdString() << std::endl;
        }
    }
    // ---------------------------------------------------------------------

    return app.exec();
}