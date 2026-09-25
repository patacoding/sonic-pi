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

#include <QMutex>
#include <QString>
#include <QWaitCondition>

namespace SonicPi
{

// Sleeping for a fraction of a frame, as accurately as the platform allows.
//
// WHY THIS IS NOT QWaitCondition. The render loop paces to the rate the user asked for by sleeping until
// just before the next deadline and spinning out the rest, and how well it hits that deadline depends
// entirely on how finely it can sleep. Measured with tools/settings-probe/pacing-probe.cpp, at 144Hz
// (a 6.94ms interval):
//
//     QWaitCondition::wait(ms)           5.31 ms late on average   29/300 deadlines met
//     QThread::usleep                    5.39 ms late               26/300
//     high-resolution waitable timer     1.24 ms late              281/300
//     spin only (burns a core)           0.003 ms late             297/300
//
// The wait the loop used is only as good as the PROCESS's timer resolution, which is 10.8 ms by default
// on this machine (measured: Sleep(1) takes 10.8 ms). The application happens to have about 1 ms because
// the audio engine asks for it - so the render loop's pacing accuracy was being borrowed from the audio
// side, silently, and a plain process doing the same thing is five milliseconds a frame worse.
//
// A waitable timer created with CREATE_WAITABLE_TIMER_HIGH_RESOLUTION (Windows 10 1803+) does not care
// what the process's timer resolution is: it is accurate to a few hundred microseconds on its own. That
// is why it is what this class uses where it exists, with the previous wait kept as the fallback for
// every other platform and for a Windows that refuses to create one.
//
// It only ever sleeps. The last part of the interval is still spun by the loop, because a sleep is
// allowed to be late and a deadline is not; see GraphicsRenderThread::run().
class GraphicsPacer
{
public:
    GraphicsPacer();
    ~GraphicsPacer();

    // Sleep for about `ns`, and return. May sleep slightly longer; never spins.
    void wait(qint64 ns);

    // What is being used, for the startup line: which of the two waits this process got, and therefore
    // what "the user asked for 144Hz" is being measured against.
    QString description() const;

private:
    QMutex m_mutex;
    QWaitCondition m_condition;

    // A HANDLE on Windows, null when the timer could not be created or the platform is not Windows. Held
    // as void* rather than the type so that this header stays free of windows.h: it is included by the
    // render thread, and windows.h defines macros that collide with Qt's own.
    void* m_highResolutionTimer = nullptr;
};

} // namespace SonicPi
