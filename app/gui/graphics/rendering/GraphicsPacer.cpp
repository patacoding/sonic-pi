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

#include "GraphicsPacer.h"

#include <QElapsedTimer>

#ifdef Q_OS_WIN
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX   // this file includes Qt headers too, and windows.h's min/max macros break them
#  endif
#  include <windows.h>
#endif

namespace SonicPi
{

GraphicsPacer::GraphicsPacer()
{
#ifdef Q_OS_WIN
    // CREATE_WAITABLE_TIMER_HIGH_RESOLUTION is Windows 10 1803 and later. Asking for it on anything older
    // fails and the fallback below is used, which is the same behaviour as before this class existed -
    // a missing refinement must never be a broken pacer.
    m_highResolutionTimer = CreateWaitableTimerExW(nullptr, nullptr,
                                                   CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                                   TIMER_ALL_ACCESS);
#endif
}

GraphicsPacer::~GraphicsPacer()
{
#ifdef Q_OS_WIN
    if (m_highResolutionTimer)
        CloseHandle(static_cast<HANDLE>(m_highResolutionTimer));
#endif
}

void GraphicsPacer::wait(qint64 ns)
{
    if (ns <= 0)
        return;

#ifdef Q_OS_WIN
    if (HANDLE timer = static_cast<HANDLE>(m_highResolutionTimer))
    {
        // A relative due time, in 100ns units, negative. The timer is rearmed for every frame rather than
        // scheduled once: the deadline is absolute and what happens between frames varies, so the wait is
        // always "this much longer", never "at this absolute moment".
        LARGE_INTEGER due;
        due.QuadPart = -(ns / 100);
        if (SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE))
        {
            // The bound is a guard, not the pacing: it is there so that a timer that somehow never
            // signals cannot stop the render loop, which is the same reasoning the loop's own fence wait
            // uses. Milliseconds, rounded up so the bound is never the thing that expires first.
            WaitForSingleObject(timer, static_cast<DWORD>(ns / 1000000 + 2));
            return;
        }
    }
#endif

    QMutexLocker lock(&m_mutex);
    m_condition.wait(&m_mutex, static_cast<unsigned long>(ns / 1000000 + 1));
}

QString GraphicsPacer::description() const
{
#ifdef Q_OS_WIN
    if (m_highResolutionTimer)
        return QStringLiteral("high-resolution waitable timer");
#endif
    return QStringLiteral("QWaitCondition (the process's own timer resolution applies)");
}

} // namespace SonicPi
