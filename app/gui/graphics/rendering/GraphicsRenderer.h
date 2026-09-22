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

#include <QOpenGLFunctions>
// Included rather than forward-declared: these are members held by unique_ptr,
// and every translation unit that destroys a GraphicsRenderer needs the complete
// types to instantiate the deleter. Forward-declaring them only buys a compile
// error later.
#include <QOpenGLBuffer>
#include <QOpenGLFramebufferObject>
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QSize>
#include <QString>

#include <memory>

namespace SonicPi
{

// Draws into an offscreen framebuffer.
//
// Owned by, and only ever touched from, whichever thread holds the GL context it
// was created against.
//
// Phase 0 is narrow on purpose: prove a frame can be rendered and that its
// pixels come back exactly as expected. The readback checks exist because
// offscreen rendering has nothing to look at - "it ran without crashing" is not
// evidence that anything correct was drawn. The design document specified no
// such check.
//
// Shaders are loaded from files on disk rather than compiled in, so they can be
// edited and reloaded without a rebuild. Where they come from is reported in
// graphics.log at startup.
class GraphicsRenderer
{
public:
    GraphicsRenderer() = default;
    // Defined in the .cpp: members here are only forward-declared, and
    // unique_ptr's deleter needs the complete types.
    ~GraphicsRenderer();

    GraphicsRenderer(const GraphicsRenderer&) = delete;
    GraphicsRenderer& operator=(const GraphicsRenderer&) = delete;

    // Creates the framebuffer and loads the shaders. Requires a current context.
    // Returns false and logs why on failure.
    bool initialize(const QSize& size);

    // Loads the shaders with no framebuffer. Requires a current context.
    //
    // For a caller that draws the shader straight to a surface it owns - the
    // output window - rather than through an intermediate framebuffer. Use
    // initialize() when the frame has to land in a framebuffer first, such as when
    // it will be read back or shared with another context.
    bool initializeWithoutFramebuffer();

    // Draws one frame into the framebuffer with the current shader.
    bool render();

    // Draws one frame with the current shader into whichever framebuffer is
    // already bound, leaving the binding alone.
    //
    // Sets the viewport to `viewportSize` and clears to the documented background
    // colour first. Used by the output window to draw to its own surface.
    bool renderToBoundFramebuffer(const QSize& viewportSize);

    // Release the GL objects now, while the caller can still make the owning
    // context current. Calling this is optional - the destructor does the same -
    // but a window being torn down cannot rely on its context surviving into
    // member destruction, so it calls this first.
    void destroy();

    // Reads the framebuffer back and compares anchor points against the quadrant
    // test pattern in anchors.frag. Returns false if the pixels differ.
    //
    // The check uses its own shader rather than whatever default.frag currently
    // draws. Coupling the two would mean a legitimate edit to the default shader
    // broke the pipeline's self-test, and the anchors would have to be kept in a
    // synthetic image that ships as the default.
    bool verifyShaderOutput();

    // Re-read the shader files and recompile. On failure the previously working
    // program is kept and the compiler log is reported, so a bad edit does not
    // take the picture away - design document principle 6.
    //
    // The GL context must be current. Because a reload is triggered from the GUI
    // while the context lives on the render thread, callers that cannot make it
    // current should use reloadAll() instead.
    bool reloadShaders();

    // Recompile the shaders of every live renderer, making each context current
    // for the duration. Returns how many succeeded.
    //
    // This reaches only renderers created by initialize(), which are the offscreen
    // ones whose contexts belong to the render thread. A renderer created by
    // initializeWithoutFramebuffer() is driven from the thread that owns its
    // context and reloads itself, so it does not register here.
    //
    // A registry rather than a global shader object: shaders are per-context, so
    // there is nothing sensible to share, and keeping the reload explicit avoids
    // a singleton. Renderers register themselves on construction and deregister
    // on destruction.
    static int reloadAll();

    // Reads the whole framebuffer back as RGBA8. Returns false on failure.
    //
    // Note: OpenGL's origin is bottom-left, so row 0 of the returned data is the
    // *bottom* row of the image. verifyShaderOutput depends on that, which is
    // why it reads deliberately rather than by habit.
    bool readPixels(QSize* sizeOut, std::unique_ptr<unsigned char[]>* pixelsOut);

    QSize size() const { return m_size; }

    // Where the fragment shader was loaded from, so it can be reported to the
    // user (and so they know which copy to edit).
    QString fragmentShaderPath() const { return m_fragmentPath; }
    QString vertexShaderPath() const { return m_vertexPath; }

    // The colour the framebuffer is cleared to before drawing, and the colour
    // used when there is no usable shader. Kept as named constants so the clear
    // and any check against it cannot drift apart.
    static constexpr float kClearR = 0.25f;
    static constexpr float kClearG = 0.50f;
    static constexpr float kClearB = 0.75f;
    static constexpr float kClearA = 1.0f;

private:
    // The VAO and the quad's vertex buffer, both required before any draw.
    bool createQuadGeometry();

    // Compile a vertex/fragment pair from disk into a linked program. Returns
    // nullptr and logs the compiler output on any failure.
    std::unique_ptr<QOpenGLShaderProgram> buildProgram(const QString& vertexFile,
                                                       const QString& fragmentFile);

    // Load the default shader pair into m_program. Leaves m_program untouched on
    // failure.
    bool loadShaders();

    // The writable per-user shader directory, and the fallback in the source
    // tree. Returns an empty string if neither contains the file.
    QString resolveShaderPath(const QString& fileName) const;

    bool channelClose(unsigned char actual, float expected) const;

    std::unique_ptr<QOpenGLFramebufferObject> m_fbo;
    std::unique_ptr<QOpenGLShaderProgram>     m_program;
    // Holds the quad's attribute bindings. A core-profile draw call needs one
    // bound even when the shader derives its own coordinates: without it
    // glDrawArrays raises GL_INVALID_OPERATION (0x502).
    //
    // Qt's wrapper rather than a raw GLuint: QOpenGLFunctions only exposes the
    // OpenGL ES 2.0 function set, which has no VAO entry points.
    std::unique_ptr<QOpenGLVertexArrayObject> m_vao;
    // The full-screen quad: position and uv, interleaved.
    std::unique_ptr<QOpenGLBuffer> m_vbo;
    QSize   m_size;
    QString m_vertexPath;
    QString m_fragmentPath;
};

} // namespace SonicPi
