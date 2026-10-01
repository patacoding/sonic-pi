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

// GraphicsPasses.h — Shadertoy 多 pass 的**词汇表**：pass 有哪些、每帧按什么顺序画。
//
// 这里刻意**不含磁盘布局**：一个文档的六个文本（Common + Image + Buffer A–D）怎么存，
// 是调用方的事（见 docs/graphics-desktop-multipass-plan.md §17.1 的三个方案，待定）。
// 这样这一层可以先生效、且不会因为布局选定而作废。
//
// 语义（来自 web 侧已实测的规格，见同文档 §0）：
//   * Common **不是 pass** —— 它是前置到该文档每个 pass 的文本；
//   * 每帧顺序 Buffer A → B → C → D → Image；
//   * 通道源只能是同一文档的 Buffer A–D，或 None（跨文档不共享，2026-10-02 决定）。

#pragma once

#include <QString>

namespace SonicPi
{

enum class GraphicsPass
{
    Common = 0,   // not a pass: text prepended to every other one
    Image,
    BufferA,
    BufferB,
    BufferC,
    BufferD
};

// Four buffers, fixed, matching Shadertoy (decision of 2026-10-02). The passes that are DRAWN are
// these four plus Image; Common never is.
inline constexpr int kBufferCount = 4;

// The order a frame runs them in. One list, in one place, because several callers need to agree about
// it: the pipeline that draws them, the channel rules that decide what "earlier" and "later" mean for
// sampling, and the editor that will show the order to a person.
inline constexpr GraphicsPass kDrawOrder[] = {
    GraphicsPass::BufferA,
    GraphicsPass::BufferB,
    GraphicsPass::BufferC,
    GraphicsPass::BufferD,
    GraphicsPass::Image
};
inline constexpr int kDrawOrderCount = int(sizeof(kDrawOrder) / sizeof(kDrawOrder[0]));

// A stable, lower-case key for a pass - the spelling used in file names and in the channel UI.
inline QString graphicsPassName(GraphicsPass pass)
{
    switch (pass) {
    case GraphicsPass::Common:  return QStringLiteral("common");
    case GraphicsPass::Image:   return QStringLiteral("image");
    case GraphicsPass::BufferA: return QStringLiteral("bufferA");
    case GraphicsPass::BufferB: return QStringLiteral("bufferB");
    case GraphicsPass::BufferC: return QStringLiteral("bufferC");
    case GraphicsPass::BufferD: return QStringLiteral("bufferD");
    }
    return QStringLiteral("?");
}

// What a person sees, matching Shadertoy's own wording.
inline QString graphicsPassLabel(GraphicsPass pass)
{
    switch (pass) {
    case GraphicsPass::Common:  return QStringLiteral("Common");
    case GraphicsPass::Image:   return QStringLiteral("Image");
    case GraphicsPass::BufferA: return QStringLiteral("Buffer A");
    case GraphicsPass::BufferB: return QStringLiteral("Buffer B");
    case GraphicsPass::BufferC: return QStringLiteral("Buffer C");
    case GraphicsPass::BufferD: return QStringLiteral("Buffer D");
    }
    return QStringLiteral("?");
}

// Index of a drawable pass within kDrawOrder (Common returns -1: it is not drawn).
inline int graphicsPassDrawIndex(GraphicsPass pass)
{
    for (int i = 0; i < kDrawOrderCount; ++i) {
        if (kDrawOrder[i] == pass)
            return i;
    }
    return -1;
}

} // namespace SonicPi
