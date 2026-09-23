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

#include "graphics/osc/GraphicsOscReceiver.h"
#include "graphics/rendering/GraphicsLog.h"
#include "graphics/rendering/GraphicsRenderThread.h"
#include "graphics/rendering/GraphicsSettings.h"

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

    // Put every QOpenGLContext in one share group, so a texture written by one is
    // usable by another.
    //
    // This is what makes the graphics output work at all: the render thread draws
    // into its own framebuffer on its own context, and the output window displays
    // that texture from a different context. Without sharing, the window can only
    // draw its own copy of the shader - which is exactly the duplication this
    // removes - and it would have to be told the picture some other way.
    //
    // Must be set before QApplication is constructed and therefore before any
    // window or context exists; Qt reads it once when it sets up its global share
    // context. The splash window created further down would already be too late.
    //
    // Qt honours this on Windows and X11 but warns and ignores it on macOS, which
    // is why the graphics feature is Windows-first.
    QApplication::setAttribute(Qt::AA_ShareOpenGLContexts);

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
        // The handover point between the render thread and the output window.
        //
        // Created here, before the thread starts, and owned for the process's
        // lifetime rather than by either side: both need the SAME object, and
        // neither owns the other. It has to exist before start() because the loop
        // publishes from its very first frame, and any frame published into a slot
        // set later would simply be lost.
        //
        // Static rather than a stack local so it outlives both users regardless of
        // destruction order at shutdown - a consumer reading a destroyed slot would
        // be a use-after-free during exit, which is exactly when it is hardest to
        // diagnose.
        static SonicPi::GraphicsSharedFrameSlot gfxSharedFrame;

        auto* gfxThread = new SonicPi::GraphicsRenderThread(&app);
        // The frame rate ceiling, from Graphics' own settings file. 0 means no
        // explicit preference, so the renderer uses its default cap.
        //
        // Reported, because this value has already gone missing once and the failure is
        // invisible: a cap that does not arrive looks exactly like a cap that was never
        // set, and the renderer then quietly runs at its default. The log line is the only
        // place the two can be told apart.
        {
            const int cap = SonicPi::GraphicsSettings::frameCapHz();
            SonicPi::GraphicsLog::info(QStringLiteral("settings: frame cap = %1 Hz%2 (from %3)")
                                           .arg(cap)
                                           .arg(cap > 0 ? QString()
                                                        : QStringLiteral(" (unset; the renderer's default applies)"))
                                           .arg(SonicPi::GraphicsSettings::filePath()));
            gfxThread->setTargetFps(cap);
        }
        gfxThread->setSharedFrameSlot(&gfxSharedFrame);
        QObject::connect(gfxThread, &SonicPi::GraphicsRenderThread::contextReady,
                         &app, [](bool ok) {
                             if (!ok)
                                 std::cout << "[GUI] - graphics context could not be created"
                                           << std::endl;
                         });
        gfxThread->start();

        // OSC-driven shader uniforms.
        //
        // Created here, beside the render thread, and owned by the application: it needs nothing
        // from the main window, and keeping it out of MainWindow is deliberate - that translation
        // unit is the most expensive in the tree to recompile, and a graphics feature should not
        // have to pay it because it wanted a socket.
        //
        // Parented to the application so it lives as long as the event loop that serves it. The
        // values it stores are shared with the render thread, which snapshots them per frame; the
        // receiver itself never touches the renderer, so a message cannot reach a GL context.
        static SonicPi::GraphicsUniformValues gfxUniformValues;
        auto* gfxOsc = new SonicPi::GraphicsOscReceiver(&gfxUniformValues, &app);
        gfxThread->setUniformValues(&gfxUniformValues);
        Q_UNUSED(gfxOsc);

        // Hand the thread to MainWindow so the output window can tell it what size
        // to render at. The window is created lazily on first use, long after
        // this, so the handle has to be stored rather than passed at construction.
        mainWin.setGraphicsRenderThread(gfxThread);
        mainWin.setGraphicsSharedFrame(&gfxSharedFrame);

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