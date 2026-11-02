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

#include "GraphicsSpoutPublisher.h"

#include "../rendering/GraphicsLog.h"

#include "SpoutDX.h"

#include <QElapsedTimer>
#include <QThread>

#include <cstring>

namespace SonicPi
{

namespace
{

// The sender format, chosen to match what a GL read-back produces byte for byte.
//
// R8G8B8A8_UNORM, not the B8G8R8A8 that D3D is usually happier with: spoutDX::SendImage hands the buffer
// straight to UpdateSubresource, so the bytes in memory ARE the texture, and a GL read-back of an RGBA8
// target is already R,G,B,A. Choosing the D3D-native order would mean swizzling four bytes per pixel on
// every frame to arrive back where we started.
constexpr DXGI_FORMAT kSenderFormat = DXGI_FORMAT_R8G8B8A8_UNORM;

// How long start() waits for the sender thread to report whether it managed to create a sender. Bounded
// because the caller may be the render thread: a Spout runtime that never gets anywhere must not become a
// frozen picture.
constexpr int kStartupWaitMs = 5000;

// The upload measurement: which sends to throw away, and how many to average.
//
// The first sends of a session create the shared texture on the receiving side and cost several times the
// steady figure - measuring those and calling it "the cost" would report the receiver connecting rather
// than the cost of sending. Same reasoning as the render thread's read-back measurement.
constexpr int kUploadWarmupSends = 30;
constexpr int kUploadMeasuredSends = 120;

const char* formatName(DXGI_FORMAT format)
{
    switch (format)
    {
    case DXGI_FORMAT_R8G8B8A8_UNORM: return "R8G8B8A8_UNORM";
    case DXGI_FORMAT_B8G8R8A8_UNORM: return "B8G8R8A8_UNORM";
    default: return "other";
    }
}

} // namespace

GraphicsSpoutPublisher::GraphicsSpoutPublisher() = default;

GraphicsSpoutPublisher::~GraphicsSpoutPublisher()
{
    stop();
}

bool GraphicsSpoutPublisher::start(const QString& senderName, int width, int height, QString* error)
{
    if (isPublishing())
        return true;
    if (width <= 0 || height <= 0)
    {
        if (error)
            *error = QStringLiteral("the output size is %1x%2").arg(width).arg(height);
        return false;
    }

    m_senderName = senderName;
    m_width = width;
    m_height = height;
    m_formatName = QString::fromLatin1(formatName(kSenderFormat));
    m_startupError.clear();

    {
        QMutexLocker lock(&m_mutex);
        for (Slot& slot : m_slots)
        {
            // Allocated up front, once per size: a sender that reallocated per frame would be an
            // allocation storm at frame rate for no reason.
            slot.pixels.assign(size_t(width) * size_t(height) * 4, 0);
            slot.filled = false;
            slot.sending = false;
            slot.sequence = 0;
        }
        m_sequence = 0;
        m_stopping = false;
        m_startupFinished = false;
        // A fresh session: the previous one's upload measurement does not describe this one, and the first
        // sends of a new sender are warm-up again.
        m_sendMsSum = 0.0;
        m_sendCount = 0;
        m_sendCostLogged = false;
    }

    QThread::start();   // the sender thread: it owns the spoutDX object and the DX upload loop

    {
        QMutexLocker lock(&m_mutex);
        while (!m_startupFinished && !m_stopping)
        {
            if (!m_wake.wait(&m_mutex, kStartupWaitMs))
            {
                m_startupError = QStringLiteral("the Spout sender did not report back within %1ms")
                                     .arg(kStartupWaitMs);
                break;
            }
        }
        if (m_startupError.isEmpty() && !m_publishing.load(std::memory_order_relaxed))
            m_startupError = QStringLiteral("no Spout sender could be created");
    }

    if (!m_publishing.load(std::memory_order_relaxed))
    {
        stop();
        if (error)
            *error = m_startupError;
        return false;
    }

    GraphicsLog::info(QStringLiteral("spout: publishing the graphics output as '%1' %2x%3 (%4)")
                          .arg(m_senderName)
                          .arg(m_width)
                          .arg(m_height)
                          .arg(m_formatName));
    return true;
}

void GraphicsSpoutPublisher::stop()
{
    {
        QMutexLocker lock(&m_mutex);
        m_stopping = true;
        m_wake.wakeAll();
    }

    if (isRunning() && !wait(4000))
    {
        // Bounded, like every other shutdown in this feature: a sender thread that will not stop is
        // reported and left behind rather than taking the application's exit with it.
        GraphicsLog::warn(QStringLiteral("spout: sender thread did not stop within 4s"));
        return;
    }

    m_publishing.store(false, std::memory_order_relaxed);
}

QString GraphicsSpoutPublisher::description() const
{
    QMutexLocker lock(&m_mutex);
    if (!m_publishing.load(std::memory_order_relaxed))
        return QStringLiteral("not publishing");
    return QStringLiteral("%1 %2x%3 (%4) on %5")
        .arg(m_senderName)
        .arg(m_width)
        .arg(m_height)
        .arg(m_formatName)
        .arg(m_adapterName);
}

QString GraphicsSpoutPublisher::adapterName() const
{
    QMutexLocker lock(&m_mutex);
    return m_adapterName;
}

void GraphicsSpoutPublisher::publishFrame(const unsigned char* pixels, bool bottomUp)
{
    if (!isPublishing() || !pixels || m_width <= 0 || m_height <= 0)
        return;

    const size_t rowBytes = size_t(m_width) * 4;

    QMutexLocker lock(&m_mutex);
    const int index = freeSlotLocked();
    if (index < 0)
    {
        // Every buffer is in flight: the receiver side is behind. Dropped and counted - see the header for
        // why waiting is not an option here.
        m_dropped.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    Slot& slot = m_slots[index];
    if (bottomUp)
    {
        // Row by row, bottom of the picture last: the flip costs one memcpy per row and no extra traffic.
        for (int y = 0; y < m_height; ++y)
        {
            const unsigned char* source = pixels + size_t(m_height - 1 - y) * rowBytes;
            std::memcpy(slot.pixels.data() + size_t(y) * rowBytes, source, rowBytes);
        }
    }
    else
    {
        std::memcpy(slot.pixels.data(), pixels, rowBytes * size_t(m_height));
    }

    slot.sequence = ++m_sequence;
    slot.filled = true;
    m_wake.wakeOne();
}

quint64 GraphicsSpoutPublisher::takeSentCount()
{
    return m_sent.exchange(0, std::memory_order_relaxed);
}

quint64 GraphicsSpoutPublisher::takeDroppedCount()
{
    return m_dropped.exchange(0, std::memory_order_relaxed);
}

int GraphicsSpoutPublisher::freeSlotLocked() const
{
    // The stalest slot that is neither filled (waiting to be sent) nor sending (being read).
    int best = -1;
    quint64 bestSequence = 0;
    for (int i = 0; i < kSlotCount; ++i)
    {
        if (m_slots[i].filled || m_slots[i].sending)
            continue;
        if (best < 0 || m_slots[i].sequence < bestSequence)
        {
            best = i;
            bestSequence = m_slots[i].sequence;
        }
    }
    return best;
}

void GraphicsSpoutPublisher::run()
{
    setObjectName(QStringLiteral("spout-sender"));

    auto sender = std::make_unique<spoutDX>();

    // OpenDirectX11 with no device: Spout creates its own, on the DEFAULT adapter - the system's choice
    // for this process, not ours. This single call with no adapter argument is the whole of the "do not
    // choose a GPU" requirement.
    if (!sender->OpenDirectX11())
    {
        failStartup(QStringLiteral("OpenDirectX11 failed: no D3D11 device could be created on the "
                                   "default adapter"));
        return;
    }

    sender->SetSenderFormat(kSenderFormat);
    if (!sender->SetSenderName(m_senderName.toUtf8().constData()))
    {
        sender->CloseDirectX11();
        failStartup(QStringLiteral("could not register the sender name '%1'").arg(m_senderName));
        return;
    }

    // Which adapter the D3D11 side landed on: the one fact that decides whether the zero-copy route could
    // ever work, and one the user cannot see for themselves. Reported, not acted on - nothing here
    // switches adapters.
    QString adapterName = QStringLiteral("adapter %1").arg(sender->GetAdapter());
    {
        char name[256] = { 0 };
        if (sender->GetAdapterName(sender->GetAdapter(), name, int(sizeof(name))))
            adapterName = QString::fromLatin1(name);
    }

    m_sender = std::move(sender);
    {
        QMutexLocker lock(&m_mutex);
        m_adapterName = adapterName;
        m_startupFinished = true;
        m_publishing.store(true, std::memory_order_relaxed);
        m_wake.wakeAll();
    }

    GraphicsLog::info(QStringLiteral("spout: sender thread running; Spout's D3D11 device is on %1")
                          .arg(adapterName));

    // The send loop. Sends the NEWEST filled slot and lets the older ones go: a receiver wants the latest
    // picture, and sending a queue of stale frames would add latency for nothing.
    while (true)
    {
        int index = -1;
        {
            QMutexLocker lock(&m_mutex);
            while (!m_stopping)
            {
                quint64 newest = 0;
                int newestIndex = -1;
                int superseded = 0;
                for (int i = 0; i < kSlotCount; ++i)
                {
                    if (!m_slots[i].filled)
                        continue;
                    if (m_slots[i].sequence > newest)
                    {
                        if (newestIndex >= 0)
                            ++superseded;   // the previously chosen one is now known to be older
                        newest = m_slots[i].sequence;
                        newestIndex = i;
                    }
                    else
                    {
                        ++superseded;
                    }
                }

                if (newestIndex >= 0)
                {
                    // Everything older than the one being sent is dropped here, under the lock, so the
                    // render thread can immediately reuse those buffers.
                    for (int i = 0; i < kSlotCount; ++i)
                    {
                        if (i != newestIndex && m_slots[i].filled)
                            m_slots[i].filled = false;
                    }
                    m_slots[newestIndex].sending = true;
                    index = newestIndex;
                    if (superseded > 0)
                        m_dropped.fetch_add(quint64(superseded), std::memory_order_relaxed);
                    break;
                }

                m_wake.wait(&m_mutex, 500);
            }

            if (m_stopping)
                break;
        }

        if (index < 0)
            continue;

        // Outside the lock: the upload is the slow part, and the render thread must never wait for it. The
        // slot stays marked `sending` for the whole call, so it cannot be written while being read.
        bool sent = false;
        if (m_sender)
        {
            QElapsedTimer upload;
            upload.start();
            sent = m_sender->SendImage(m_slots[index].pixels.data(), unsigned(m_width), unsigned(m_height));
            recordSendCost(double(upload.nsecsElapsed()) / 1.0e6);
        }

        {
            QMutexLocker lock(&m_mutex);
            m_slots[index].sending = false;
            m_slots[index].filled = false;
        }

        if (sent)
            m_sent.fetch_add(1, std::memory_order_relaxed);
        else
            m_dropped.fetch_add(1, std::memory_order_relaxed);
    }

    if (m_sender)
    {
        m_sender->ReleaseSender();
        m_sender->CloseDirectX11();
        m_sender.reset();
    }
    m_publishing.store(false, std::memory_order_relaxed);

    {
        QMutexLocker lock(&m_mutex);
        m_wake.wakeAll();
    }
}

void GraphicsSpoutPublisher::recordSendCost(double ms)
{
    // Called from the sender thread and nowhere else, so these three members need no lock. The counters the
    // render thread reads are the atomics; this is bookkeeping local to this thread.
    if (m_sendCostLogged)
        return;

    ++m_sendCount;
    if (m_sendCount <= kUploadWarmupSends)
        return;

    m_sendMsSum += ms;
    if (m_sendCount - kUploadWarmupSends < kUploadMeasuredSends)
        return;

    // Once, and then never again: this file's rule is that the log carries what changed, not a per-second
    // stream of numbers. If the cost later grows because a receiver appeared or went away, that shows up as
    // dropped frames, which IS reported.
    m_sendCostLogged = true;
    GraphicsLog::info(QStringLiteral("spout: handing one frame to the sender costs %1 ms (DX upload, "
                                     "averaged over %2 frames)")
                          .arg(m_sendMsSum / double(kUploadMeasuredSends), 0, 'f', 2)
                          .arg(kUploadMeasuredSends));
}

void GraphicsSpoutPublisher::failStartup(const QString& reason)
{
    GraphicsLog::error(QStringLiteral("spout: %1 - Spout output is unavailable").arg(reason));
    QMutexLocker lock(&m_mutex);
    m_startupError = reason;
    m_startupFinished = true;
    m_wake.wakeAll();
}

} // namespace SonicPi
