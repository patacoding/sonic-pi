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

// GraphicsPassPrograms.h — 一个 Shadertoy 文档的**五个 pass 各自的 program**。
//
// 这是 P2d-2 的契约（实现尚未写）。它存在的理由来自代码事实：今天 `m_renderers` 是"每个 .frag 文件一个
// program、彼此是候选关系、同时只有一个 active"（GraphicsRenderThread.h:369/:376）—— 那是多 buffer 的
// **文档切换**模型 ✓。而每帧 A→B→C→D→Image 的顺序管线需要**同一个文档的五个 pass 各有自己的 program** ✗，
// 否则没有东西可驱动 ✓。
//
// 与既有 `m_renderers` **并存**而不是改它：那套行为是 M1–M3 已落地并验证过的 ✓（含编译保护与上屏选择），
// 改动它会同时动到两件事 ✗。这里先把"五个 program 同时保活"证明出来，再决定两者如何合并 ✓
// （设计见 docs/graphics-desktop-multipass-plan.md §16/§17）。
//
// 逐 pass 独立保护：每个 pass 用**自己**的 GraphicsRenderer（`buildAndInstallFrom()` 的契约里最重要的一条
// ——失败保留原 program ✓），所以"第 3 个 pass 坏了"不会让整个画面消失 ✓（web 侧实测过的做法：
// graphics-web-canvas.md:827-829）。
//
// Common **不是** pass：它是文本，由 `setPrependedText()` 交给**每一个** pass 的 renderer ✓
// （GraphicsRenderer.h 里刚加的入口 ✓）。
//
// 创建与销毁都要求 current context（与 GraphicsTarget / GraphicsRenderer 的约定一致 ✓）。
// 本文件目前只有契约：编译得进任何 TU，但**无人调用**，所以行为与之前完全一致 ✓。

#pragma once

#include <array>
#include <memory>

#include <QString>

#include "GraphicsDocuments.h"
#include "GraphicsPasses.h"
#include "GraphicsRenderer.h"

namespace SonicPi
{

class GraphicsPassPrograms
{
public:
    GraphicsPassPrograms() = default;
    ~GraphicsPassPrograms();

    GraphicsPassPrograms(const GraphicsPassPrograms&) = delete;
    GraphicsPassPrograms& operator=(const GraphicsPassPrograms&) = delete;

    // Compile every pass this document has, into its own renderer. Requires a current context.
    //
    // A pass with no file is an EMPTY pass: no renderer, nothing drawn, and sampling it is black - not an
    // error (the rule the web renderer settled on). So `create()` succeeds for a document with just an
    // Image, and `pass()` answers nullptr for the buffers it does not have.
    //
    // `vertexFile` is passed in rather than resolved here, for the same reason GraphicsRenderer takes its
    // buffer name in: the caller knows which vertex half the pipeline uses, and one place should decide.
    bool create(const GraphicsDocument& document, const QString& vertexFile);

    // Releases every program, while the caller can still make the context current.
    void destroy();

    bool isValid() const;

    // The renderer for one pass, or nullptr when that pass has no file (an empty pass) or has not been
    // created yet. Common answers nullptr: it is text, not a pass.
    GraphicsRenderer* pass(GraphicsPass pass) const;

    // How many passes this document actually compiled, and a one-line summary for the log - the L1 evidence
    // that per-pass programs exist and which file each came from.
    int passCount() const;
    QString describe() const;

private:
    // Indexed by graphicsPassDrawIndex(), so the array order is the frame order and there is no second
    // mapping to keep in step with it.
    std::array<std::unique_ptr<GraphicsRenderer>, kDrawOrderCount> m_passes;

    QString m_commonText;
    QString m_commonFile;   // its path: what a diagnostic in Common is attributed TO, not the pass   // handed to every pass's renderer; empty when the document has no common.glsl
};

} // namespace SonicPi
