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

#include "GraphicsTextureView.h"
#include "GraphicsLog.h"

#include <QOpenGLContext>
#include <QOpenGLExtraFunctions>

namespace SonicPi
{

namespace
{

// The display shader: show a texture, flipped vertically.
//
// The flip is not optional and not a preference. GL's texture origin is its bottom-left,
// so sampling with v increasing upward shows the renderer's framebuffer the same way up
// as it was drawn; the D3D interop path needs the opposite for the same reason. Which
// way round it goes is a property of the two coordinate systems, so it is pinned here
// once rather than left to each caller.
const char* kVertexShader = R"(
#version 330 core
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
    // a_pos is already in clip space (-1..1); derive uv from it rather than carrying a
    // second attribute, since the quad is exactly the whole viewport.
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
)";

const char* kFragmentShader = R"(
#version 330 core
uniform sampler2D u_texture;
in vec2 v_uv;
layout(location = 0) out vec4 FragColor;
void main() {
    FragColor = texture(u_texture, v_uv);
}
)";

// Two triangles covering clip space.
const float kQuad[] = {
    -1.0f, -1.0f,
     1.0f, -1.0f,
     1.0f,  1.0f,
    -1.0f, -1.0f,
     1.0f,  1.0f,
    -1.0f,  1.0f,
};

} // namespace

GraphicsTextureView::GraphicsTextureView(GraphicsConsumer::Id identity)
    : m_identity(identity)
{
}

GraphicsTextureView::~GraphicsTextureView()
{
    // Everything this owns is a Qt RAII object (program, VAO, VBO), and those need the
    // owning context current to tear down - which is why the windows make their context
    // current before the view is destroyed. Qt logs a warning and leaks rather than
    // crashing if it is not, which beats a crash on shutdown.
}

bool GraphicsTextureView::initialize()
{
    if (m_ready)
        return true;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    if (!ctx)
    {
        GraphicsLog::error(QStringLiteral("view %1: no current context at initialize")
                               .arg(int(m_identity)));
        return false;
    }

    auto program = std::make_unique<QOpenGLShaderProgram>();
    if (!program->addShaderFromSourceCode(QOpenGLShader::Vertex, kVertexShader)
        || !program->addShaderFromSourceCode(QOpenGLShader::Fragment, kFragmentShader)
        || !program->link())
    {
        GraphicsLog::error(QStringLiteral("view %1: the display shader failed\n%2")
                               .arg(int(m_identity)).arg(program->log()));
        return false;
    }

    m_vao = std::make_unique<QOpenGLVertexArrayObject>();
    if (!m_vao->create())
    {
        GraphicsLog::error(QStringLiteral("view %1: could not create a VAO").arg(int(m_identity)));
        m_vao.reset();
        return false;
    }
    m_vao->bind();

    m_vbo = std::make_unique<QOpenGLBuffer>(QOpenGLBuffer::VertexBuffer);
    if (!m_vbo->create() || !m_vbo->bind())
    {
        GraphicsLog::error(QStringLiteral("view %1: could not create a VBO").arg(int(m_identity)));
        m_vbo.reset();
        m_vao.reset();
        return false;
    }
    m_vbo->setUsagePattern(QOpenGLBuffer::StaticDraw);
    m_vbo->allocate(kQuad, int(sizeof(kQuad)));
    m_vao->release();
    m_vbo->release();

    m_program = std::move(program);
    m_ready = true;
    return true;
}

bool GraphicsTextureView::drawSharedFrame()
{
    if (!m_sharedFrame)
        return false;

    const GraphicsSharedFrame shared = m_sharedFrame->read();
    if (!shared.valid())
    {
        // The producer withdrew the slot: a rebuild or a shutdown destroys the target
        // textures, so a name remembered from before must not be sampled afterwards.
        m_lastGoodTexture = 0;
        return false;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLExtraFunctions* extra = ctx ? ctx->extraFunctions() : nullptr;
    if (!ctx || !initialize())
        return false;

    // Wait for the producer to finish this frame before sampling it.
    //
    // The producer waits on a fence of ours before overwriting a target; this is the
    // same idea in the other direction and both are needed, because they answer
    // different questions. Ours answers "may the producer write here"; this one answers
    // "is there a finished image here".
    //
    // A bounded wait, not zero. The zero-timeout version flickered: the producer draws in
    // well under a millisecond, so a consumer arriving a moment early found the fence
    // unsignalled nearly every frame and fell through to the background colour.
    if (shared.fence && extra)
    {
        constexpr GLuint64 kWaitNs = 8 * 1000 * 1000;   // 8ms, half a frame at 60Hz
        const GLenum r = extra->glClientWaitSync(shared.fence,
                                                 GL_SYNC_FLUSH_COMMANDS_BIT, kWaitNs);
        if (r == GL_TIMEOUT_EXPIRED || r == GL_WAIT_FAILED)
        {
            // Still not ready. Show the last one that WAS; sampling a texture that
            // completed a frame ago needs no wait and cannot be torn.
            m_staleFrames.fetch_add(1, std::memory_order_relaxed);
            if (m_lastGoodTexture != 0)
                return blitTexture(m_lastGoodTexture);
            return false;
        }
    }

    if (!blitTexture(shared.texture))
        return false;

    // Leave a fence recording that this target's read commands have been submitted.
    //
    // This is the whole of a consumer's side of the handoff, and it is deliberately not
    // a flag: a flag cleared here would say "this thread has stopped issuing commands",
    // which is not the same as "the GPU has stopped reading", and a producer that
    // trusted it would overwrite a texture still being read.
    //
    // Stored into THIS consumer's own slot, chosen by identity rather than by any
    // turn-taking. Several consumers reading one texture is fine because reading is
    // non-destructive; each one just records its own completion and they never interact.
    GLsync finished = extra ? extra->glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0) : nullptr;
    if (extra)
        extra->glFlush();   // submit it, or the fence never signals

    if (finished)
        m_sharedFrame->targetFence(shared.targetIndex)
            .consumerFence[m_identity]
            .store(finished, std::memory_order_release);

    m_lastGoodTexture = shared.texture;
    m_lastFrameSize = shared.size;
    m_lastFrameIndex = shared.frameIndex;
    m_lastTargetIndex = shared.targetIndex;

    // UNCONDITIONAL, and that is a fix rather than a style choice.
    //
    // This used to read `if (m_overlayTexture != 0) drawOverlay();`, which can never succeed
    // the first time: the texture is created INSIDE drawOverlay(), so gating the call on the
    // texture existing means the overlay is never built, never uploaded and never drawn. The
    // symptom was "the numbers never appear" while the log reported the overlay image being
    // constructed correctly - the code path ran and nothing reached the screen.
    //
    // The general lesson, which is why it is written here rather than only in a commit:
    // "the object was built" and "it was presented" are different assertions, and only the
    // second one is settled by looking. drawOverlay() decides for itself whether there is
    // anything to draw.
    drawOverlay();

    return true;
}

bool GraphicsTextureView::blitTexture(GLuint texture)
{
    if (texture == 0 || !m_program || !m_vao || !m_vbo)
        return false;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
        return false;

    // Filtering is set per texture rather than per frame: these are state on the texture
    // object, and re-setting them every frame would be noise.
    //
    // NEAREST for a 1:1 view - the output window shows an exact crop, and filtering there
    // would soften pixels meant to be shown exactly as rendered. LINEAR for a view that
    // scales, because minifying 1280x720 into a small window with NEAREST throws away
    // pixels and makes the picture crawl.
    const GLint filter = m_smoothScaling ? GL_LINEAR : GL_NEAREST;
    f->glActiveTexture(GL_TEXTURE0);
    f->glBindTexture(GL_TEXTURE_2D, texture);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    m_program->bind();
    m_program->setUniformValue("u_texture", 0);
    m_vao->bind();
    m_vbo->bind();
    m_program->enableAttributeArray(0);
    m_program->setAttributeBuffer(0, GL_FLOAT, 0, 2, 2 * sizeof(float));
    f->glDrawArrays(GL_TRIANGLES, 0, 6);
    m_program->disableAttributeArray(0);
    m_vbo->release();
    m_vao->release();
    m_program->release();
    return true;
}

void GraphicsTextureView::setOverlay(const QImage& image)
{
    if (image.isNull())
    {
        if (m_overlayTexture != 0)
        {
            QOpenGLContext* ctx = QOpenGLContext::currentContext();
            QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
            if (f)
            {
                f->glDeleteTextures(1, &m_overlayTexture);
                m_overlayTexture = 0;
            }
        }
        m_overlayImage = QImage();
        m_overlayDirty = false;
        return;
    }

    m_overlayImage = image;
    m_overlayDirty = true;
}

void GraphicsTextureView::drawOverlay()
{
    if (m_overlayImage.isNull())
        return;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f || !m_program || !m_vao || !m_vbo)
        return;

    if (m_overlayDirty || m_overlayTexture == 0)
    {
        if (m_overlayTexture == 0)
            f->glGenTextures(1, &m_overlayTexture);
        if (m_overlayTexture == 0)
            return;

        // ARGB32 on a little-endian machine is BGRA byte order, which is what GL_BGRA wants.
        QImage src = (m_overlayImage.format() == QImage::Format_ARGB32)
                         ? m_overlayImage
                         : m_overlayImage.convertToFormat(QImage::Format_ARGB32);

        // Flipped vertically, and this is not optional.
        //
        // A QImage's row 0 is its TOP row; a GL texture's row 0 is its BOTTOM row, because v=0
        // is the bottom in GL's convention. Uploading the image as-is therefore presents it
        // upside down, which for text reads as mirrored glyphs stacked in the wrong order -
        // reported exactly that way the first time this overlay was seen.
        //
        // Done here rather than with flipped texture coordinates in the shader so that one
        // convention (GL's) holds everywhere: the shader, whether it is sampling the frame or
        // this image, is the same shader doing the same thing, and the difference between a
        // QImage and a GL texture is resolved where the QImage is.
        src = src.mirrored(false, true);

        f->glBindTexture(GL_TEXTURE_2D, m_overlayTexture);
        if (src.bytesPerLine() == src.width() * 4)
        {
            f->glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, src.width(), src.height(), 0,
                            GL_BGRA, GL_UNSIGNED_BYTE, src.constBits());
        }
        else
        {
            // Allocate first, then fill row by row honouring the stride, so a padded QImage
            // cannot ship its padding as pixels.
            f->glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, src.width(), src.height(), 0,
                            GL_BGRA, GL_UNSIGNED_BYTE, nullptr);
            for (int y = 0; y < src.height(); ++y)
            {
                f->glTexSubImage2D(GL_TEXTURE_2D, 0, 0, y, src.width(), 1,
                                   GL_BGRA, GL_UNSIGNED_BYTE, src.constScanLine(y));
            }
        }
        // 1:1 with itself, so nearest keeps the glyph edges exact rather than blurring them.
        f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        m_overlayDirty = false;
    }

    // Positioned in the viewport's top-left corner, and clamped so it cannot be pushed
    // off-screen by a viewport shorter than the image - a top edge calculated as
    // vp[1] + vp[3] - imgH goes below the viewport's bottom when the image is taller than
    // it, and every pixel is then discarded, which looks exactly like "never drawn".
    GLint vp[4] = { 0, 0, 0, 0 };
    f->glGetIntegerv(GL_VIEWPORT, vp);

    const int imgW = m_overlayImage.width();
    const int imgH = m_overlayImage.height();
    constexpr int kInset = 8;
    const int x = qBound(vp[0], vp[0] + kInset, vp[0] + qMax(0, vp[2] - imgW));
    const int yTop = qBound(vp[1], vp[1] + vp[3] - kInset - imgH, vp[1] + vp[3]);

    f->glEnable(GL_BLEND);
    f->glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    f->glViewport(x, yTop, imgW, imgH);
    f->glActiveTexture(GL_TEXTURE0);
    f->glBindTexture(GL_TEXTURE_2D, m_overlayTexture);
    m_program->bind();
    m_program->setUniformValue("u_texture", 0);
    m_vao->bind();
    m_vbo->bind();
    m_program->enableAttributeArray(0);
    m_program->setAttributeBuffer(0, GL_FLOAT, 0, 2, 2 * sizeof(float));
    f->glDrawArrays(GL_TRIANGLES, 0, 6);
    m_program->disableAttributeArray(0);
    m_vbo->release();
    m_vao->release();
    m_program->release();

    f->glDisable(GL_BLEND);

    // Restore, so the caller is not left with the overlay's little rectangle as its drawing
    // area.
    f->glViewport(vp[0], vp[1], vp[2], vp[3]);
}

} // namespace SonicPi
