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

// GraphicsBufferTargets.h — 一个 buffer 的「一对常驻 ping-pong target」。
//
// 为 Shadertoy 风格的多 pass 而建（设计见 docs/graphics-desktop-multipass-plan.md §13/§14）：
// Buffer A–D 各自需要**两张**离屏 target —— front 保存上一帧的结果（供其他 pass 本帧采样），
// back 是本帧正在画的那张，一个 pass 画完就 swap。**这与输出交接用的那两张 target 无关**：
// 交接的两张每帧被 publish 给消费者，把 buffer 画进去会与"发布当前帧"冲突。
//
// 为什么是"两张常驻"而不是"一张 + takeTexture()"：Qt 文档明说 takeTexture() 会把纹理归属交给调用者，
// 并在**下一次 bind() 时重新分配纹理**（潜在昂贵，且会改掉当前绑定的纹理）。而 texture() 只读 id，
// 文档保证 "can be bound as a normal texture in your own OpenGL code" —— 那正是通道采样要的。见 §14.1。
//
// 单采样是硬要求：多采样 FBO **没有纹理**，texture() 返回无效值。GraphicsTarget 已是 samples=0 ✓。
//
// 创建与销毁都要求 current context（与 GraphicsTarget 的约定一致，见 GraphicsTarget.h:36-38/49-56）。
//
// 本文件只提供结构：谁创建、谁 swap、谁采样。把它接进每帧的 pass 顺序是下一步（P2b），
// 所以现在它"存在但不参与绘制"，行为与之前完全一致。

#pragma once

#include <array>
#include <memory>

#include <QSize>
#include <QString>

#include "GraphicsTarget.h"

namespace SonicPi
{

class GraphicsBufferTargets
{
public:
    // Two is the whole point: front is last frame's result, back is what this frame draws into.
    static constexpr int kCount = 2;

    GraphicsBufferTargets() = default;
    ~GraphicsBufferTargets() = default;

    // Not copyable: each target owns an FBO (GraphicsTarget holds a unique_ptr).
    GraphicsBufferTargets(const GraphicsBufferTargets&) = delete;
    GraphicsBufferTargets& operator=(const GraphicsBufferTargets&) = delete;

    // Creates both targets. Requires a current context. False (and a log line already written by
    // GraphicsTarget) if either fails to create or comes up invalid; a half-created pair is destroyed
    // rather than left behind, so the caller never sees one target and assumes two.
    bool create(const QSize& size);

    // Releases both, while the caller can still guarantee a current context.
    void destroy();

    bool isValid() const;

    // What this frame draws into. Never null once create() succeeded.
    GraphicsTarget* write();

    // What other passes sample from: the previous frame's result. Never null once create() succeeded.
    GraphicsTarget* read() const;

    // After a pass has finished drawing into write(). Only then does this frame's result become what
    // other passes read - which is exactly the ordering rule ("bound to an earlier buffer = this
    // frame's, bound to itself or a later one = last frame's").
    void swap();

    QSize size() const;

    // One line for the log: which is front, and the two texture ids. Deliberately not per-frame
    // (docs/graphics-phase01-spec.md 449-453).
    QString describe() const;

private:
    int readIndex() const { return m_front; }
    int writeIndex() const { return 1 - m_front; }

    std::array<std::unique_ptr<GraphicsTarget>, kCount> m_targets;
    // Which of the two holds the last completed frame. 0 at creation, so the first frame writes into
    // index 1 and reads index 0 - a target that has never been drawn into, i.e. black. That is the
    // "pointing at nothing is black, not an exception" rule, on the first frame.
    int m_front = 0;
};

} // namespace SonicPi

