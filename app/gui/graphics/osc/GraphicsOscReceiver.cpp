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

#include "GraphicsOscReceiver.h"

#include "GraphicsUniformMessage.h"

#include "../rendering/GraphicsLog.h"

#include <QByteArray>
#include <QHostAddress>
#include <QString>
#include <QStringList>
#include <QUdpSocket>

namespace SonicPi
{

namespace
{

// Enough of a rejected packet to recognise it by eye, without letting one sender fill the log.
constexpr int kHexBytesInFirstRejection = 32;

QString hexPreview(const char* data, int size)
{
    const int shown = qMin(size, kHexBytesInFirstRejection);
    QString out = QString::fromLatin1(QByteArray(data, shown).toHex(' '));
    if (size > shown)
        out += QStringLiteral(" ... (%1 bytes)").arg(size);
    return out;
}

// The numbers as the shader will receive them, so an unexpected value is visible here rather than
// only on screen.
QString valueList(const GraphicsOsc::Decoded& decoded)
{
    QStringList values;
    for (int i = 0; i < decoded.count(); ++i)
    {
        values << (decoded.integral ? QString::number(decoded.ints.value(i))
                                    : QString::number(double(decoded.floats.value(i)), 'g', 6));
    }
    return values.join(QStringLiteral(", "));
}

} // namespace

GraphicsOscReceiver::GraphicsOscReceiver(QObject* parent)
    : QObject(parent)
{
    m_socket = new QUdpSocket(this);

    // Loopback only. OSC from another machine is a separate feature with its own switch (the
    // engine's cue server); this port exists to be driven by code running in this application.
    //
    // DontShareAddress because one listener is the intent: a second instance then fails to bind and
    // says so, rather than both receiving an arbitrary half of the datagrams.
    const bool bound = m_socket->bind(QHostAddress(QHostAddress::LocalHost),
                                      GraphicsOscReceiver::port(),
                                      QUdpSocket::DontShareAddress);

    if (!bound)
    {
        GraphicsLog::error(QStringLiteral("graphics osc: could not bind 127.0.0.1:%1 - %2. "
                                          "OSC-driven uniforms are off; everything else is unaffected.")
                               .arg(GraphicsOscReceiver::port())
                               .arg(m_socket->errorString()));
        return;
    }

    m_listening = true;
    GraphicsLog::info(QStringLiteral("graphics osc: listening on 127.0.0.1:%1 "
                                     "for osc \"/graphics/uniform\", \"name\", value")
                          .arg(GraphicsOscReceiver::port()));

    connect(m_socket, &QUdpSocket::readyRead, this, &GraphicsOscReceiver::readPendingDatagrams);
}

GraphicsOscReceiver::~GraphicsOscReceiver() = default;

quint16 GraphicsOscReceiver::port()
{
    return 4561;
}

void GraphicsOscReceiver::readPendingDatagrams()
{
    while (m_socket->hasPendingDatagrams())
    {
        const qint64 pending = m_socket->pendingDatagramSize();
        if (pending <= 0)
            break;

        // One buffer, grown once. A burst of datagrams must not turn into a burst of allocations.
        if (m_buffer.size() < pending)
            m_buffer.resize(int(pending));

        const qint64 read = m_socket->readDatagram(m_buffer.data(), m_buffer.size());
        if (read < 0)
            break;

        const int size = int(read);
        const GraphicsOsc::Decoded decoded = GraphicsOsc::decode(m_buffer.constData(), size);

        if (!decoded.ok())
        {
            ++m_rejected;
            reportDecodeError(int(decoded.error), size, m_buffer.constData());
            continue;
        }

        ++m_received;

        // One line per name, the first time it arrives: it proves the link end to end and lists what
        // the code is driving. Every later value for the same name is silent on purpose - these
        // arrive at music rate, and a line per message would bury everything else in the log.
        if (m_reportedNames.contains(decoded.name))
            continue;

        m_reportedNames.insert(decoded.name);

        const GraphicsOsc::TargetKind kind =
            decoded.integral ? GraphicsOsc::TargetKind::Int : GraphicsOsc::TargetKind::Float;

        const QString shape = decoded.count() == 1
            ? QStringLiteral("%1 value").arg(QLatin1String(GraphicsOsc::describe(kind)))
            : QStringLiteral("%1 vector x%2").arg(QLatin1String(GraphicsOsc::describe(kind)))
                  .arg(decoded.count());

        GraphicsLog::info(QStringLiteral("graphics osc: %1 = %2  (%3)")
                              .arg(decoded.name, valueList(decoded), shape));
    }
}

void GraphicsOscReceiver::reportDecodeError(int errorCode, int datagramSize, const char* datagram)
{
    // One line per failure shape, with everything after it counted but silent. A malformed packet is
    // an expected event on a port anything on the machine can send to, so it must not be able to
    // flood the log - and the shapes are what the probe already enumerates.
    if (m_reportedErrors.contains(errorCode))
        return;

    m_reportedErrors.insert(errorCode);

    const auto error = static_cast<GraphicsOsc::DecodeError>(errorCode);

    QString line = QStringLiteral("graphics osc: refused a %1-byte datagram - %2")
                       .arg(datagramSize)
                       .arg(QLatin1String(GraphicsOsc::describe(error)));

    // A wrong address is almost always a typo in the user's own code and needs no packet dump; the
    // shapes that mean "these bytes are not what you think they are" get one.
    if (error != GraphicsOsc::DecodeError::WrongAddress)
    {
        line += QStringLiteral("\n           first %1 byte(s): %2")
                    .arg(kHexBytesInFirstRejection)
                    .arg(hexPreview(datagram, datagramSize));
    }

    GraphicsLog::warn(line);
}

} // namespace SonicPi
