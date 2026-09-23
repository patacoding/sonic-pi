#pragma once

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

#include <QByteArray>
#include <QObject>
#include <QSet>
#include <QString>

class QUdpSocket;

namespace SonicPi
{

class GraphicsUniformValues;

// Receives the OSC messages that drive shader uniforms, and nothing else.
//
// The other end is user code running in Sonic Pi:
//
//     use_osc "127.0.0.1", 4561
//     osc "/graphics/uniform", "uGain", 0.5
//
// That message is neither sent by Ruby nor by this process: `osc_send` schedules it inside the
// audio engine, which puts a UDP datagram on the wire when the audio clock reaches the time the
// code asked for. Measured end to end, including the sender's identity, in
// docs/graphics-osc-uniforms.md 2.1.1.
//
// Why this feature owns a socket and a port rather than sharing the GUI's OSC transport: that
// transport carries logs, errors, cues and MIDI to the GUI, and a graphics feature has no business
// adding branches to it - nor any need to, since the engine will send anywhere. The port is this
// class's own property for the same reason: it is not a general application setting, so it does not
// live in GraphicsSettings.h. If it ever becomes user-configurable it belongs there, and the move
// should be made deliberately - see docs/dev-discipline.md 4.2.1 for why that file is not edited
// casually during development (mainwindow.cpp includes it, and that one translation unit costs
// about 96 seconds to compile).
//
// The values are not consumed here. This class decodes a datagram and hands the value to
// GraphicsUniformValues; what that value means for a shader is decided where the shader is - by the
// renderer, which holds the registry of what the program actually declares. So the receiver never
// needs a GL context, and it cannot report "the name matched" even if it wanted to: it does not
// know, and guessing from the shader's source would be wrong (a declared-but-unused uniform is
// removed by the linker).
class GraphicsOscReceiver : public QObject
{
    Q_OBJECT

public:
    // `values` is not owned and must outlive this object. The caller keeps it because the render
    // thread needs the same object.
    explicit GraphicsOscReceiver(GraphicsUniformValues* values, QObject* parent = nullptr);
    ~GraphicsOscReceiver() override;

    // The port user code must address. Fixed rather than discovered: a dynamic port would need a
    // channel back to the code that sends, and this feature is deliberately one-way.
    static quint16 port();

    // False when the port could not be bound - normally because something else holds it. The rest
    // of the graphics feature is unaffected; only OSC-driven values are unavailable.
    bool isListening() const { return m_listening; }

    // Counters, so a run can be summarised without logging every message.
    quint64 received() const { return m_received; }
    quint64 rejected() const { return m_rejected; }

private slots:
    void readPendingDatagrams();

private:
    void reportDecodeError(int errorCode, int datagramSize, const char* datagram);

    GraphicsUniformValues* m_values = nullptr;
    QUdpSocket* m_socket = nullptr;
    bool m_listening = false;

    // Grown once and reused: a burst of datagrams must not become a burst of allocations.
    QByteArray m_buffer;

    quint64 m_received = 0;
    quint64 m_rejected = 0;

    // Per-name, not per-message: the first value seen for a name is reported once, and a name
    // repeats silently afterwards. Bounded by how many names the user's code drives.
    QSet<QString> m_reportedNames;

    // One line per failure shape, with a count afterwards. A malformed packet is an expected event
    // on a port anything on the machine can send to, so it must not be able to flood the log.
    QSet<int> m_reportedErrors;
};

} // namespace SonicPi
