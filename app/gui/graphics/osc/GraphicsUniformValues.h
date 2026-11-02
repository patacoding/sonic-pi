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

#include <QHash>
#include <QMutex>
#include <QString>
#include <QVector>

#include <atomic>

namespace SonicPi
{

// One shader uniform's current value, as it arrived.
//
// `integral` records that every argument came as an integer, which is what the widening rules in
// GraphicsUniformMessage.h turn on. Both views are kept because which one is right is not known
// until the value meets a uniform: the shader may be recompiled with a different type for the same
// name, and it is the shader that decides.
struct GraphicsUniformValue
{
    QString name;
    bool integral = true;
    QVector<int> ints;
    QVector<float> floats;

    int count() const { return ints.size(); }
};

// An immutable set of values, taken at one instant. Immutable by convention: the render thread
// holds one and the renderer reads it, and nothing writes to it after it is handed over.
using GraphicsUniformSnapshot = QVector<GraphicsUniformValue>;

// The values arriving by OSC, and the one place both threads meet.
//
// A register, not a queue: a name holds its LATEST value. That is the whole point - user code sends
// at music rate, and a queue would either grow without bound or make the shader render stale values
// in order. It also means a name's value survives a shader reload: if the new program still declares
// it, the value is still there to be applied, so editing a shader does not reset the picture.
//
// Written by the GUI thread (the OSC receiver) and read by the render thread, which takes a snapshot
// only when the version changes - so the cost of a message is one hash write, not a per-frame copy.
// Same shape as the render thread's other runtime inputs (setTargetFps and friends): a short lock on
// one side, a pending marker on the other, no new concurrency model.
class GraphicsUniformValues
{
public:
    // Take a value. Replaces any previous value for the same name.
    void set(const GraphicsUniformValue& value);

    // Bumped on every change, so a reader can tell "nothing new" from "new values" with one load.
    quint64 version() const { return m_version.load(std::memory_order_acquire); }

    // A copy of every current value. Called by the render thread only when the version changed.
    GraphicsUniformSnapshot snapshot() const;

    // How many names are held. For diagnostics, not for control flow.
    int size() const;

private:
    mutable QMutex m_mutex;
    QHash<QString, GraphicsUniformValue> m_values;
    std::atomic<quint64> m_version{ 0 };
};

} // namespace SonicPi
