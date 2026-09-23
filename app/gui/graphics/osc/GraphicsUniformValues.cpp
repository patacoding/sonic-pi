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

#include "GraphicsUniformValues.h"

#include <QMutexLocker>

namespace SonicPi
{

void GraphicsUniformValues::set(const GraphicsUniformValue& value)
{
    {
        QMutexLocker lock(&m_mutex);
        m_values.insert(value.name, value);
    }

    // Released after the lock: a reader that sees the new version is then guaranteed to see the
    // value that came with it.
    m_version.fetch_add(1, std::memory_order_release);
}

GraphicsUniformSnapshot GraphicsUniformValues::snapshot() const
{
    QMutexLocker lock(&m_mutex);

    GraphicsUniformSnapshot out;
    out.reserve(m_values.size());
    for (auto it = m_values.constBegin(); it != m_values.constEnd(); ++it)
        out.append(it.value());
    return out;
}

int GraphicsUniformValues::size() const
{
    QMutexLocker lock(&m_mutex);
    return m_values.size();
}

} // namespace SonicPi
