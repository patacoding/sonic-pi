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

#include "GraphicsBufferTargets.h"

#include "GraphicsLog.h"

namespace SonicPi
{

bool GraphicsBufferTargets::create(const QSize& size)
{
    destroy();

    for (int i = 0; i < kCount; ++i) {
        auto target = std::make_unique<GraphicsTarget>();
        // GraphicsTarget::create logs its own reason, so a failure here is already explained by the
        // time it returns; this only makes sure a half-created pair is never left behind, because a
        // caller that saw one valid target could easily assume the other one is there too.
        if (!target->create(size) || !target->isValid()) {
            GraphicsLog::error(QStringLiteral("buffer targets: %1x%2 ping-pong pair failed at %3 of %4; "
                                              "nothing is left behind")
                                   .arg(size.width())
                                   .arg(size.height())
                                   .arg(i + 1)
                                   .arg(kCount));
            destroy();
            return false;
        }
        m_targets[i] = std::move(target);
    }

    // A fresh pair has no completed frame: index 0 is "front" and is black, the first frame writes
    // into index 1. See the header for why that is the wanted first-frame behaviour.
    m_front = 0;
    return true;
}

void GraphicsBufferTargets::destroy()
{
    for (auto& target : m_targets)
        target.reset();
    m_front = 0;
}

bool GraphicsBufferTargets::isValid() const
{
    for (const auto& target : m_targets) {
        if (!target || !target->isValid())
            return false;
    }
    return true;
}

GraphicsTarget* GraphicsBufferTargets::write()
{
    return m_targets[writeIndex()].get();
}

GraphicsTarget* GraphicsBufferTargets::read() const
{
    return m_targets[readIndex()].get();
}

void GraphicsBufferTargets::swap()
{
    m_front = writeIndex();
}

QSize GraphicsBufferTargets::size() const
{
    if (const auto& target = m_targets[readIndex()])
        return target->size();
    if (const auto& target = m_targets[writeIndex()])
        return target->size();
    return QSize();
}

QString GraphicsBufferTargets::describe() const
{
    // Indexed directly rather than through write(): that accessor is non-const, and this is a
    // const query about what the pair looks like right now.
    const GraphicsTarget* front = m_targets[readIndex()].get();
    const GraphicsTarget* back = m_targets[writeIndex()].get();
    return QStringLiteral("buffer targets: %1x%2 ping-pong, front texture %3, back texture %4")
        .arg(size().width())
        .arg(size().height())
        .arg(front ? front->texture() : 0)
        .arg(back ? back->texture() : 0);
}

} // namespace SonicPi
