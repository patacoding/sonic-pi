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
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QElapsedTimer>
#include <QHash>
#include <QSet>
#include <QSize>
#include <QString>

#include <memory>
#include <atomic>

#include "GraphicsFrame.h"
// For GraphicsOsc::Target, the mapping from a GL type to what OSC may drive it with. Widget-free
// and GL-free, and exercised on its own by tools/settings-probe/uniform-introspect.cpp.
#include "graphics/osc/GraphicsUniformMessage.h"
// For the buffer's name-to-file rule. Widget-free and GL-free: the same module the editor uses, so
// the renderer and the editor cannot disagree about which file a name means.
#include "GraphicsSettings.h"

class QOpenGLFramebufferObject;

namespace SonicPi
{

class GraphicsTarget;

// How often the "no matching uniform" set may be re-announced. An unmatched name is normal while
// either side of the pair is still being written, so this is a discoverability aid, not an alarm -
// and the interval is what keeps a five-times-a-second sender from filling the log.
constexpr int kUnmatchedReportIntervalMs = 10000;

// The outcome of one attempt to build the shader, with the compiler's own words.
//
// Returned rather than only logged, because a compile failure now has to reach the person who caused
// it: an editor that says nothing when the code is wrong is worse than no editor. The log remains for
// the record; this carries the same text to the user.
//
// A struct rather than an out-parameter so the outcome and its explanation cannot come apart -
// reporting "failed" without the log, or a log without its outcome, are both bugs waiting to happen.
struct GraphicsCompileResult
{
    std::unique_ptr<QOpenGLShaderProgram> program;   // null when the build failed, OR when installed
    QString log;                                     // the compiler's output; empty on success
    QString fragmentPath;                            // the file that was read, for the message

    // Set by buildAndInstall(): the program is now IN USE by the renderer, which is why `program` above
    // is null. Without this flag "installed" and "failed" are the same struct - both have a null
    // program - and reading ok() after install() therefore reports a success as a failure. That is not
    // hypothetical: it silently installed the built-in fallback over a shader that had compiled, and
    // told the editor that every successful compile had failed.
    bool installed = false;

    // Where the first diagnostic points, named in terms of FILES rather than the source string
    // numbers the driver was given, and empty/0 when no diagnostic named a position.
    //
    // Carried out of here rather than re-parsed by the editor, because the map from a source string
    // number to a file exists in this function, for this compile, and nowhere else. The editor needs
    // it for one decision: whether the line it is being told about is a line of ITS document, or of
    // an included library it cannot scroll to (docs/shader-includes-plan.md 4).
    QString errorFile;
    int errorLine = 0;

    bool ok() const { return program != nullptr || installed; }
};

// The shader program and the geometry that draws with it. No render target.
//
// What it owns is exactly what should exist once per shader: the linked program, the
// quad's vertex array and buffer, and the uniform locations that belong to that
// program. What it deliberately does NOT own is the framebuffer - see GraphicsTarget
// for why that separation is a correctness requirement rather than tidiness.
//
// The payoff is that double buffering costs two targets and still only one program,
// one set of uniform locations, and one compile per reload. Bundling the two would
// have meant two of each, which is the family of bug this feature has already been
// bitten by three times: state that should exist once, existing twice and drifting.
//
// Owned by, and only ever touched from, the thread holding the GL context it was
// created against. That is not a formality: a program belongs to the context it is
// used with, so compiling it anywhere else either fails or produces something this
// renderer cannot use.
//
// Shaders are loaded from files on disk rather than compiled in, so they can be
// edited and reloaded without a rebuild. Where they come from is reported in
// graphics.log.
class GraphicsRenderer
{
public:
    GraphicsRenderer() = default;
    // Defined in the .cpp: members here are only forward-declared, and
    // unique_ptr's deleter needs the complete types.
    ~GraphicsRenderer();

    GraphicsRenderer(const GraphicsRenderer&) = delete;
    GraphicsRenderer& operator=(const GraphicsRenderer&) = delete;

    // The quad's geometry, and nothing else. Requires a current context.
    //
    // Split out of initialize() so a buffer can be created WITHOUT compiling it: the caller that is
    // about to compile it wants the compile's own result in its hands - to report it, and to decide
    // whether the buffer may become the one on screen. Compiling inside the constructor is what makes
    // that impossible, and it is why this exists.
    bool prepare();

    // Compile this buffer's files and install the program. The compiler's own output comes back either
    // way (empty on success).
    //
    // One call rather than "compile, then adopt": the two halves must not come apart - a program that
    // is compiled but never installed, or installed from a compile nobody checked, are both states that
    // have already cost this feature a rewrite.
    GraphicsCompileResult buildAndInstall();

    // Builds the quad geometry and loads the shader files. Requires a current
    // context. Returns false and logs why on failure.
    //
    // `fallbackWhenNothingBuilds` is true for the FIRST renderer of a session: with no previous program
    // to keep, the choice is the built-in fallback or a blank output, and a blank output is worse. It is
    // FALSE for a buffer created later, where "keep the previous program" means the picture already on
    // screen - installing the fallback there would throw away a working shader to show a gradient.
    bool initialize(bool fallbackWhenNothingBuilds = true);

    // Whether this renderer has a program to draw with. A buffer that failed to compile has none, and
    // the caller uses this to decide whether a switch to it is allowed (see GraphicsRenderThread).
    bool hasProgram() const { return m_program != nullptr; }

    // Which buffer this renderer compiles.
    //
    // The name travels IN rather than being written into the compile, because which buffer this is
    // should not be the renderer's private knowledge: it decides the fragment file that is read
    // ("<name>.frag"), it is what the log lines name - so a picture showing the wrong buffer can be
    // told apart from one showing the right buffer twice - and it is exactly what a second buffer
    // would have to change.
    //
    // Set before initialize(). The default is the buffer a fresh session renders.
    void setShaderName(const QString& name);
    QString shaderName() const { return m_shaderName; }

    // Release the GL objects now, while the caller can still make the owning
    // context current. Calling this is optional - the destructor does the same -
    // but a caller tearing down a context should not rely on member destruction
    // order.
    void destroy();

    // Draws one frame into `target`. Requires a current context.
    //
    // `frame` carries the uniform values; see GraphicsFrame for why they are passed
    // in rather than read from a clock here.
    bool renderInto(GraphicsTarget& target, const GraphicsFrame& frame);

    // Reads the framebuffer back and compares anchor points against the quadrant
    // test pattern in anchors.frag. Returns false if the pixels differ.
    //
    // The check uses its own shader rather than whatever default.frag currently
    // draws. Coupling the two would mean a legitimate edit to the default shader
    // broke the pipeline's self-test, and the anchors would have to be kept in a
    // synthetic image that ships as the default.
    //
    // That reasoning was then applied one step further: the self-test's own shaders are
    // compiled into the binary rather than read from the shader directory, because they
    // are a FIXTURE whose only reader is this function. See kSelfTestFragmentShader in
    // the .cpp - loading them from the user's editable copy made a healthy build report
    // a shader failure on every start, which is worse than not checking at all.
    bool verifyShaderOutput(GraphicsTarget& target);

    // Reads the whole target back as RGBA8. Returns false on failure.
    //
    // Note: OpenGL's origin is bottom-left, so row 0 of the returned data is the
    // *bottom* row of the image. verifyShaderOutput depends on that, which is why it
    // reads deliberately rather than by habit.
    bool readPixels(GraphicsTarget& target, QSize* sizeOut,
                    std::unique_ptr<unsigned char[]>* pixelsOut);

    // GPU time of one frame's draw, in milliseconds, or -1 when it has not been measured.
    //
    // What this measures that nothing else does: the CPU-side frame time says how long the
    // thread took to ISSUE the work, which is a fraction of a millisecond for a shader that
    // could still be too slow to run at the target rate. The GPU time is what actually answers
    // "how expensive is this shader at this resolution", which is the question a user asking
    // about frame rate is really asking.
    //
    // Written by the render thread and read by anything; a plain atomic so a reader cannot stall
    // a frame. -1 rather than 0 for "not measured", because 0 would read as a free shader.
    double gpuFrameMs() const { return m_gpuFrameMs.load(std::memory_order_relaxed); }
    // The same value sampled for the whole previous reporting window's worst frame. Better than
    // the average for spotting a shader that is usually fast and occasionally not.
    double gpuFrameWorstMs() const { return m_gpuFrameWorstMs.load(std::memory_order_relaxed); }
    // Average over the last reporting window, which the render thread computes and passes in
    // because it owns the reporting cadence. Called once a second, not per frame.
    void setGpuFrameAverages(double avgMs, double worstMs)
    {
        m_gpuFrameAvgMs.store(avgMs, std::memory_order_relaxed);
        m_gpuFrameWorstMs.store(worstMs, std::memory_order_relaxed);
    }
    double gpuFrameAvgMs() const { return m_gpuFrameAvgMs.load(std::memory_order_relaxed); }

    // Re-read the shader files and recompile. On failure the previously working
    // program is kept and the compiler log is reported, so a bad edit does not take
    // the picture away - design document principle 6.
    //
    // Must be called on the thread that owns the context, with that context current.
    // A shader program belongs to the context it is used with, so compiling it
    // anywhere else either fails or produces a program this renderer cannot use. The
    // render thread calls this from its own loop; the GUI asks the render thread
    // instead of doing it itself.
    //
    // Blocks for as long as compilation takes - hundreds of milliseconds. A caller
    // that cannot afford to stall a frame should use the two-step form below.
    bool reloadShaders();

    // Compile the shader files and hand back the result WITHOUT installing it.
    //
    // The point is that compilation - the slow part - happens while no lock is held,
    // so the render loop is not stalled by it. The caller installs the result with
    // adoptProgram() at a moment of its choosing, which is a pointer swap and
    // effectively instantaneous.
    //
    // Returns a result whose program is null on failure, carrying the compiler's output either
    // way. The current program is left alone on failure, so a broken edit changes nothing - the
    // guarantee that makes a shader editor safe to use while the output is live.
    GraphicsCompileResult compileReplacement();

    // Install a program produced by compileReplacement(). Requires a current context.
    //
    // The caller must hold whatever lock protects the render loop: this is the one
    // operation the loop must not race, and keeping it to a pointer swap is what
    // makes holding that lock acceptable.
    void adoptProgram(std::unique_ptr<QOpenGLShaderProgram> program);

    // There is deliberately no static "reload every renderer" entry point.
    //
    // One used to exist so a GUI action could recompile every live renderer. It could
    // not work: a shader program belongs to a context, a context belongs to a thread,
    // and the GUI thread can only make its own context current - so it compiled
    // against the wrong one and raced the render loop. The GUI now only requests a
    // reload and the render thread applies it, on its own context.

    // Where the fragment shader was loaded from, so it can be reported to the user
    // (and so they know which copy to edit).
    QString fragmentShaderPath() const { return m_fragmentPath; }
    QString vertexShaderPath() const { return m_vertexPath; }

    // The colour a target is cleared to before drawing, and the colour used when
    // there is no usable shader. Kept as named constants so the clear and any check
    // against it cannot drift apart.
    static constexpr float kClearR = 0.25f;
    static constexpr float kClearG = 0.50f;
    static constexpr float kClearB = 0.75f;
    static constexpr float kClearA = 1.0f;

private:
    // The VAO and the quad's vertex buffer, both required before any draw.
    bool createQuadGeometry();

    // Compile a vertex/fragment pair from disk, carrying the compiler's output whether or not the
    // build succeeded: on failure that output IS the message the user needs, and on success an empty
    // string is itself information - nothing to report.
    GraphicsCompileResult buildProgram(const QString& vertexFile,
                                      const QString& fragmentFile);

    // Compile the self-test's own shader pair. Both halves are string literals in the
    // .cpp, so this cannot be broken by an edit to the shader directory, and cannot
    // disagree with the anchor table it is checked against.
    std::unique_ptr<QOpenGLShaderProgram> buildSelfTestProgram();

    // Load the default shader pair into m_program. Leaves m_program untouched on failure.
    bool loadShaders();

    // Build the built-in fallback shader and install it, for the one case where there is no previous
    // program to keep: a shader that will not compile at startup. Returns false if even the fallback
    // cannot be built, in which case the output is a flat clear colour and the log says so.
    bool installFallbackShader();

    // True while the built-in fallback is what is being drawn, so a later successful compile can
    // report the change and so the state is not invisible.
    bool m_usingFallbackShader = false;

    // The writable per-user shader directory, and the fallback in the source tree.
    // Returns an empty string if neither contains the file.
    QString resolveShaderPath(const QString& fileName) const;

    // Read a shader file and inline its `#include` directives, returning the source to compile.
    //
    // The driver has no include of its own (see graphics/ShaderInclude.h), so what is compiled is not
    // what is on disk. One file, one expansion, and one line in the log naming what came in - the
    // answer to "which library did that function come from" should not need a debugger.
    //
    // Returns false with `error` set, in the same shape as a compiler diagnostic
    // ("file:line: what"), so a failure here reaches the user through exactly the channel a
    // compile failure does. `fileBySourceString` receives the table the diagnostics will need to be
    // attributed: which source string number each inlined file was given.
    bool readExpandedShader(const QString& path, QString* text, QString* error,
                            QHash<int, QString>* fileBySourceString = nullptr) const;

    // Look up the uniform locations this renderer feeds.
    //
    // Called once per successful link rather than per frame: glGetUniformLocation is
    // a string lookup into the program and is not something to do 60+ times a second.
    // Locations belong to the program that was current when they were queried, so
    // they must be re-read whenever the program is replaced.
    void cacheUniformLocations();

    // Push the frame's values into the current program. Must be called with the
    // program bound.
    void applyUniforms(const GraphicsFrame& frame);

    // Draw the quad with `program`, which the caller has already bound and whose
    // uniforms it has set.
    //
    // Split out because two callers need it with DIFFERENT programs - the normal
    // frame path with m_program, and the verification with its own test program - and
    // sharing the body is what makes it impossible for the two to drift. It reads no
    // member that identifies a program, which is deliberately the property that keeps
    // a verification pass from corrupting the render path.
    bool drawQuadWithProgram(QOpenGLShaderProgram* program);

    bool channelClose(unsigned char actual, float expected) const;

    // Uniform locations for the current program, or -1 when it does not declare that
    // uniform. A shader is free to use only some of them - a static shader has no use
    // for iTime - so -1 is normal, not an error, and setting a uniform at location -1
    // is a defined no-op in OpenGL.
    struct Uniforms
    {
        int time = -1;
        int timeDelta = -1;
        int frame = -1;
        int resolution = -1;
    };

    // Uniform locations for an arbitrary program, or -1 for each it does not declare.
    // Static and taking the program explicitly so the verification can ask about its
    // own program WITHOUT disturbing the cached locations belonging to m_program.
    static Uniforms queryUniforms(QOpenGLShaderProgram* program);
    Uniforms m_uniforms;

    // Whether "this program declares no uniforms at all" has already been reported,
    // so the note appears once per program rather than once per frame.
    bool m_reportedNoUniforms = false;

    // ---- OSC-driven uniforms -------------------------------------------------------------
    //
    // What this program actually declares, read from the driver after each successful link. This is
    // the authority on whether a name exists: the linker removes uniforms that are declared but
    // never used, so a shader's source is not a reliable answer and the driver is (measured in
    // tools/settings-probe/uniform-introspect.cpp).
    //
    // Only the OSC-addressable ones are applied from here; the four built-ins above keep their own
    // explicit path, which is also what stops an OSC message from taking iTime away from the loop.
    struct DynamicUniform
    {
        int location = -1;
        unsigned int glType = 0;
        int size = 0;
        GraphicsOsc::Target target;
    };

    void buildDynamicUniforms();
    void applyDynamicUniforms(const GraphicsFrame& frame);
    void applyUniformValue(QOpenGLFunctions* f, const DynamicUniform& uniform,
                           const GraphicsUniformValue& value);
    void reportUnmatchedNames();

    QHash<QString, DynamicUniform> m_dynamicUniforms;

    // One line per name for a message that arrived but could not be used, and one line for a name
    // this program does not declare. Both are bounded by the number of names in play; neither is
    // per-message, because these arrive at music rate.
    QSet<QString> m_reportedMismatches;
    QSet<QString> m_reportedBuiltins;

    // Names that arrived with no matching uniform right now. Reported as a set, and at most once
    // per kUnmatchedReportIntervalMs: a name being absent is NORMAL while the user is still writing
    // either side of the pair, so this must not read as an error - but it must be discoverable,
    // because "declared but unused" looks identical from the sender's side (docs 3.2.3).
    QSet<QString> m_unmatchedNames;
    QElapsedTimer m_unmatchedTimer;

    std::unique_ptr<QOpenGLShaderProgram>     m_program;
    // Which buffer is compiled: the identity that decides the fragment file, and nothing else about
    // the pipeline. A second buffer is a second renderer, not a second copy of this.
    QString m_shaderName = GraphicsSettings::defaultShaderName();
    // Holds the quad's attribute bindings. A core-profile draw call needs one bound
    // even when the shader derives its own coordinates: without it glDrawArrays
    // raises GL_INVALID_OPERATION (0x502).
    //
    // Qt's wrapper rather than a raw GLuint: QOpenGLFunctions only exposes the
    // OpenGL ES 2.0 function set, which has no VAO entry points.
    std::unique_ptr<QOpenGLVertexArrayObject> m_vao;
    // The full-screen quad: position and uv, interleaved.
    std::unique_ptr<QOpenGLBuffer> m_vbo;
    QString m_vertexPath;
    QString m_fragmentPath;

    // ---- GPU timing (GL_ARB_timer_query) ------------------------------------------------
    //
    // A POOL of query objects read round-robin, which is the whole trick. Reading a query's
    // result forces the CPU to wait for the GPU, so a query written and read in the same frame
    // would serialise the two and destroy the parallelism the design depends on - it would
    // measure a pipeline made synchronous by the act of measuring it.
    //
    // Instead each frame starts a query into the next slot and reads the result of the slot used
    // kQueryPoolSize frames ago. That result has been ready for several frames, so reading it is
    // free, and the cost reported is a few frames old - exactly right for a number that changes
    // a few times a second.
    //
    // If a slot's previous result is not ready, that frame is not timed rather than waited for.
    // Under a stall the pool is exhausted and timing stops on its own, then resumes.
    static constexpr int kQueryPoolSize = 4;
    GLuint m_queries[kQueryPoolSize] = { 0, 0, 0, 0 };
    int    m_querySlot = 0;
    int    m_queryPoolUsed = 0;      // how many entries hold a result worth reading
    bool   m_queryActive = false;    // a glBeginQuery is open
    bool   m_gpuTimerReady = false;  // extension present and entry point resolved
    bool   m_gpuTimerUnavailableReported = false;

    // Resolved by hand: QOpenGLExtraFunctions exposes glGetQueryObjectuiv, whose result is 32
    // bits, but a GL_TIME_ELAPSED result is nanoseconds in a 64-bit value, and this Qt version
    // has no wrapper for that one.
    using GetQueryObjectui64vFn = void (*)(GLuint, GLenum, GLuint64*);
    GetQueryObjectui64vFn m_glGetQueryObjectui64v = nullptr;

    std::atomic<double> m_gpuFrameMs{-1.0};
    std::atomic<double> m_gpuFrameAvgMs{-1.0};
    std::atomic<double> m_gpuFrameWorstMs{-1.0};

    // Open a query if possible, returning whether one was opened.
    bool beginGpuTiming();
    // Close the query and harvest an older slot's result. Safe when beginGpuTiming returned
    // false.
    void endGpuTiming();

public:
    // Resolve the entry point and create the query pool. Requires a current context, and is safe
    // to call more than once; the render thread calls it once after this renderer exists.
    //
    // Public because the render thread owns the context and therefore owns when this can happen,
    // and because this is what produces gpuTimerDescription() - the render thread logs that line,
    // and a measurement nobody can ask about is one nobody knows to distrust.
    void setUpGpuTimer();

    // Drop the query objects, while the context is still current.
    void releaseGpuTimer();

    // What the timer reports about itself, for the one log line at startup: whether GPU timing is
    // available, and why not when it is not.
    QString gpuTimerDescription() const;
};

} // namespace SonicPi
