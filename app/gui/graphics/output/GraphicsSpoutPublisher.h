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
#include <QThread>
#include <QWaitCondition>

#include <atomic>
#include <memory>
#include <vector>

class spoutDX;

namespace SonicPi
{

// Sends the graphics output to any Spout receiver on this machine.
//
// NOT the window publisher in platform/spout_publisher.cpp. That one captures the GUI window with
// Windows.Graphics.Capture, so what it sends is the application as displayed - cropped to the window,
// carrying the window's chrome, and changing when the window moves. This one sends the PICTURE: the
// render target at the configured output size. That distinction is the whole of
// docs/graphics-output-design.md 1-2, and it is why this class takes pixels rather than a window handle.
//
// HARDWARE-AGNOSTIC BY CONSTRUCTION. The D3D11 device belongs to Spout, which creates it on the DEFAULT
// adapter - whatever the system's graphics settings give this process. Nothing here chooses a GPU, and
// the path this class uses needs no GPU feature at all: it takes an ordinary CPU pixel buffer and hands it
// to spoutDX::SendImage. That is what makes Spout output available on a machine whose GL context sits on
// an adapter that cannot share textures with D3D11 (measured: docs/graphics-output-design.md 8.2), and the
// zero-copy route is a separate question asked at run time, never assumed from an adapter's name.
//
// ITS OWN THREAD, because the DX upload is the receiver's problem and not the render loop's. A receiver
// that is slow, or absent, must cost the picture nothing: publishFrame() copies and returns.
class GraphicsSpoutPublisher : public QThread
{
public:
    GraphicsSpoutPublisher();
    ~GraphicsSpoutPublisher() override;

    // Begin sending at this size. Returns false and sets `error` when no sender could be created - the
    // caller reports that to the user, because a menu item that silently does nothing is worse than one
    // that says why it cannot.
    bool start(const QString& senderName, int width, int height, QString* error);
    void stop();

    bool isPublishing() const { return m_publishing.load(std::memory_order_relaxed); }

    // What is being sent, for the log: the name, the size, the DXGI format, and which adapter Spout's
    // D3D11 device landed on. That last part is the one fact only this process can report, and it is what
    // makes "the system put GL and D3D on different adapters" visible instead of mysterious.
    QString description() const;

    // The adapter Spout's D3D11 device is on, as DXGI names it. Empty before start() has reported back.
    //
    // Reported rather than acted on: nothing here switches adapters, but "GL is on A and D3D is on B" is
    // the state that makes a zero-copy route impossible, and it is invisible from outside the process.
    QString adapterName() const;

    // One frame: RGBA8, TOP-DOWN (row 0 is the top of the picture).
    //
    // TOP-DOWN because spoutDX::SendImage copies the buffer straight into a D3D11 texture with
    // UpdateSubresource, and a D3D texture's row 0 is its top. A GL read-back is bottom-up, so whoever
    // reads the pixels is the one who has to flip them - doing it here would mean the caller's mistake
    // (an upside-down picture in every receiver) is invisible until someone looks at a receiver.
    //
    // NEVER BLOCKS. The pixels are copied into a spare buffer and the sender thread is woken. If every
    // buffer is still in flight the frame is dropped and counted: a backlog here means a receiver that is
    // behind, and waiting for it would stall the render loop - the one thing this must never do.
    void publishFrame(const unsigned char* rgbaTopDown);

    // Frame counters since the last call, then reset. For the once-a-second log line.
    quint64 takeSentCount();
    quint64 takeDroppedCount();

protected:
    void run() override;

private:
    // How many frames can be in flight. Three rather than two: the sender may be uploading one while the
    // render thread fills another, and a third means a single slow upload does not immediately start
    // dropping. More than three buys nothing - the newest frame is the only one worth sending.
    static constexpr int kSlotCount = 3;

    struct Slot
    {
        std::vector<unsigned char> pixels;
        // Waiting to be sent.
        bool filled = false;
        // Being read by SendImage right now. A separate flag from `filled` because the buffer is still in
        // use during the upload, and reusing it then would send a half-overwritten frame.
        bool sending = false;
        quint64 sequence = 0;
    };

    // The slot to write into, or -1 when every slot is still in flight. Caller holds m_mutex.
    int freeSlotLocked() const;

    // Report a startup failure and wake whoever is waiting in start().
    void failStartup(const QString& reason);

    mutable QMutex m_mutex;
    QWaitCondition m_wake;
    bool m_stopping = false;
    bool m_startupFinished = false;
    QString m_startupError;

    Slot m_slots[kSlotCount];
    quint64 m_sequence = 0;
    int m_width = 0;
    int m_height = 0;
    QString m_senderName;
    QString m_adapterName;
    QString m_formatName;

    std::unique_ptr<spoutDX> m_sender;

    std::atomic<bool> m_publishing{false};
    std::atomic<quint64> m_sent{0};
    std::atomic<quint64> m_dropped{0};
};

} // namespace SonicPi
