#pragma once

// Decoding of the OSC messages that drive shader uniforms, and the rules deciding whether a
// decoded value may be handed to a GLSL uniform.
//
// Widget-free, GL-free and context-free on purpose. In the application these rules are reached
// only by a UDP datagram arriving at a port - no automated run can arrange that through the UI,
// and trying them inside Sonic Pi costs a multi-minute rebuild each time. So they live here and
// tools/settings-probe includes THIS file:
//
//   uniform-introspect.cpp   the GL half: what the driver reports for each uniform type
//   osc-decode-check.cpp     the wire half: what Ruby's encoder actually puts on the wire
//
// Testing a copy of a rule proves nothing about the rule, which is why there is no copy.
// See docs/dev-discipline.md section 4.1 and docs/graphics-osc-uniforms.md section 3.2.

#include <QString>
#include <QVector>

#include <cmath>
#include <cstdint>
#include <limits>

#include <api/osc/osc_pkt.hh>

namespace SonicPi
{
namespace GraphicsOsc
{

// The one address this feature owns. The /graphics/ namespace exists from the start on purpose:
// /graphics/buffer/<name>/uniform is added when there is more than one shader buffer, and code
// written against /graphics/uniform keeps working then (docs/graphics-osc-uniforms.md 5).
inline const char* uniformAddress()
{
    return "/graphics/uniform";
}

// v1 carries float, int, vec2/3/4 and ivec2/3/4 - four numbers is therefore the hard ceiling.
//
// Matrices are NOT supported, now or later (decided by the user, 2026-09-23): GLSL matrices are
// column-major, and a transposed one draws a picture that still looks plausible, which is the
// worst possible failure for a visual feature - the user cannot tell it from the intended result.
// Samplers need a texture binding rather than a number; arrays need an index syntax. All of them
// land on TargetKind::Unsupported below, so the boundary is explicit rather than accidental.
constexpr int kMaxValues = 4;

enum class TargetKind
{
    Unsupported,
    Float,
    Int,
};

struct Target
{
    TargetKind kind = TargetKind::Unsupported;
    int count = 0;

    bool supported() const { return kind != TargetKind::Unsupported; }
};

// GL's own type values, written out rather than included so this header stays free of GL.
//
// They are ASSERTED AGAINST THE DRIVER rather than trusted: uniform-introspect.cpp declares one
// uniform of every type, reads back what the driver reports, and requires it to map to the kind
// and arity it expects. A wrong constant here therefore fails a probe instead of silently making
// a uniform unreachable at runtime.
enum : unsigned int
{
    kGlInt = 0x1404,
    kGlFloat = 0x1406,
    kGlFloatVec2 = 0x8B50,
    kGlFloatVec3 = 0x8B51,
    kGlFloatVec4 = 0x8B52,
    kGlIntVec2 = 0x8B53,
    kGlIntVec3 = 0x8B54,
    kGlIntVec4 = 0x8B55,
    kGlBool = 0x8B56,
    kGlFloatMat2 = 0x8B5A,
    kGlFloatMat3 = 0x8B5B,
    kGlFloatMat4 = 0x8B5C,
    kGlSampler2D = 0x8B5E,
};

// An array element is reported with the bracket in its name ("uArray[0]"), and --- measured on this
// driver, see uniform-introspect.cpp --- `size` is NOT a reliable array signal: a shader that uses
// only uArray[0] gets size 1, which is indistinguishable from a scalar by size alone. GLSL
// identifiers cannot contain a bracket, so the name is the dependable test, and both are used.
inline bool isArrayElementName(const QString& name)
{
    return name.endsWith(QLatin1Char(']'));
}

// `size` and `name` are what glGetActiveUniform reported. size above 1 means several active
// elements; either signal makes the uniform unaddressable in v1, which does not do array indexing.
inline Target targetFromGlUniform(unsigned int glType, int size, const QString& name)
{
    if (size > 1 || isArrayElementName(name))
        return {};

    switch (glType)
    {
    case kGlFloat:     return { TargetKind::Float, 1 };
    case kGlFloatVec2: return { TargetKind::Float, 2 };
    case kGlFloatVec3: return { TargetKind::Float, 3 };
    case kGlFloatVec4: return { TargetKind::Float, 4 };

    case kGlInt:       return { TargetKind::Int, 1 };
    case kGlBool:      return { TargetKind::Int, 1 };
    case kGlIntVec2:   return { TargetKind::Int, 2 };
    case kGlIntVec3:   return { TargetKind::Int, 3 };
    case kGlIntVec4:   return { TargetKind::Int, 4 };

    default:           return {};   // matrices, samplers, and anything a future GL adds
    }
}

enum class DecodeError
{
    None,
    NotOsc,             // not an OSC message at all: garbage, or a truncated datagram
    MalformedArguments, // the argument bytes contradict the type tags, or stop short
    WrongAddress,       // a valid OSC message for something else
    NameMissing,        // no arguments, or an empty name
    NameNotString,      // the first argument is not a string
    ValuesMissing,      // a name with no value after it
    TooManyValues,      // more than kMaxValues - e.g. somebody sending a matrix anyway
    BadValueType,       // a value that is not a number: string, blob, or an int64 that does not fit
    NonFinite,          // NaN or infinity, which GL turns into black or garbage output
};

// Values are kept in the form they arrived. `integral` says every argument was an integer, which
// is what decides the widening rules below; ints and floats are parallel arrays of the same
// length so either view can be used once the target is known.
struct Decoded
{
    DecodeError error = DecodeError::None;
    QString name;
    bool integral = true;
    QVector<int> ints;
    QVector<float> floats;

    int count() const { return ints.size(); }
    bool ok() const { return error == DecodeError::None; }
};

namespace detail
{

inline bool fitsInFloat(double v)
{
    return v >= -double(std::numeric_limits<float>::max())
        && v <= double(std::numeric_limits<float>::max());
}

} // namespace detail

// Decode one datagram. Never throws and never asserts: on a UDP port that anything on the machine
// can send to, a malformed packet is an expected event, not an exceptional one.
inline Decoded decode(const char* bytes, int length)
{
    Decoded out;

    if (!bytes || length <= 0)
    {
        out.error = DecodeError::NotOsc;
        return out;
    }

    // oscpkt validates the address, the zero padding, the type tags and the argument lengths, so
    // a malformed packet is rejected here rather than producing a plausible-looking value.
    //
    // The distinction it draws is worth keeping: MALFORMED_ARGUMENTS means the bytes are a plausible
    // OSC message whose type tags do not describe them, which is what a hand-rolled sender gets
    // wrong - and "not an OSC message" would send that user looking in the wrong place. (Ruby's own
    // encoder cannot produce it: its tags always match the values.)
    oscpkt::Message message(bytes, static_cast<size_t>(length));
    if (!message.isOk())
    {
        out.error = message.getErr() == oscpkt::MALFORMED_ARGUMENTS
            ? DecodeError::MalformedArguments
            : DecodeError::NotOsc;
        return out;
    }

    // ArgReader is nested inside Message (oscpkt defines it that way).
    oscpkt::Message::ArgReader args = message.match(uniformAddress());
    if (!args.isOk())
    {
        out.error = DecodeError::WrongAddress;
        return out;
    }

    if (args.nbArgRemaining() == 0)
    {
        out.error = DecodeError::NameMissing;
        return out;
    }
    if (!args.isStr())
    {
        out.error = DecodeError::NameNotString;
        return out;
    }

    std::string rawName;
    args.popStr(rawName);
    out.name = QString::fromUtf8(rawName.c_str());
    if (out.name.isEmpty())
    {
        out.error = DecodeError::NameMissing;
        return out;
    }

    if (args.nbArgRemaining() == 0)
    {
        out.error = DecodeError::ValuesMissing;
        return out;
    }
    if (args.nbArgRemaining() > kMaxValues)
    {
        out.error = DecodeError::TooManyValues;
        return out;
    }

    bool integral = true;

    while (args.nbArgRemaining() > 0)
    {
        if (args.isInt32())
        {
            int32_t v = 0;
            args.popInt32(v);
            out.ints.append(v);
            out.floats.append(float(v));
        }
        else if (args.isInt64())
        {
            // Ruby sends Integer as 'i' and only marks int64 explicitly; accept it when it fits,
            // because silently truncating a large number would give a wrong but plausible value.
            int64_t v = 0;
            args.popInt64(v);
            if (v < std::numeric_limits<int32_t>::min() || v > std::numeric_limits<int32_t>::max())
            {
                out.error = DecodeError::BadValueType;
                return out;
            }
            out.ints.append(int32_t(v));
            out.floats.append(float(v));
        }
        else if (args.isFloat())
        {
            float v = 0.0f;
            args.popFloat(v);
            if (!std::isfinite(v))
            {
                out.error = DecodeError::NonFinite;
                return out;
            }
            integral = false;
            out.ints.append(int(v));   // only used if the target turns out to want an int
            out.floats.append(v);
        }
        else if (args.isDouble())
        {
            double v = 0.0;
            args.popDouble(v);
            if (!std::isfinite(v))
            {
                out.error = DecodeError::NonFinite;
                return out;
            }
            if (!detail::fitsInFloat(v))
            {
                out.error = DecodeError::BadValueType;
                return out;
            }
            integral = false;
            out.ints.append(int(v));
            out.floats.append(float(v));
        }
        else if (args.isBool())
        {
            // Ruby's true/false encode as OSC 'T'/'F', so a bool uniform can be driven with them.
            bool b = false;
            args.popBool(b);
            out.ints.append(b ? 1 : 0);
            out.floats.append(b ? 1.0f : 0.0f);
        }
        else
        {
            // A string, a blob, or a type tag oscpkt does not know.
            out.error = DecodeError::BadValueType;
            return out;
        }
    }

    if (!args.isOk())
    {
        out.error = DecodeError::BadValueType;
        return out;
    }

    out.integral = integral;
    return out;
}

enum class Verdict
{
    Accept,
    ArityMismatch,      // the wrong number of values: drop the whole message, never pad
    TypeMismatch,       // right count, but a non-integral value for an int uniform
    UnsupportedTarget,  // matrix, sampler, array
};

// Speculative convenience that must not exist: padding a short vec3 with zeros would give the user
// a half-applied value whose picture still moves, which reads as "it works" while being wrong.
inline bool allValuesIntegral(const QVector<float>& values)
{
    for (float v : values)
    {
        if (v != std::floor(v))
            return false;
    }
    return true;
}

inline bool allValuesIntegral(const Decoded& d)
{
    return allValuesIntegral(d.floats);
}

// Whether a value may be given to a uniform of this target. Two callers, and the difference between
// them is worth stating: a freshly decoded message knows whether each argument arrived as an
// integer, while a value read back from the store has been through a float view and only knows
// whether it is whole. Both are "an int where an int is wanted", so callers pass
// `integral || allValuesIntegral(floats)` and get the same answer either way - a value sent as 1.0
// drives an int uniform, a value sent as 1.5 does not.
inline Verdict verdictFor(bool integral, int count, const Target& target)
{
    if (!target.supported())
        return Verdict::UnsupportedTarget;
    if (count != target.count)
        return Verdict::ArityMismatch;

    // Widening is allowed (an int where a float is wanted, as in "uGain", 1); narrowing is allowed
    // only when no precision is lost (1.0 for an int uniform, not 1.5).
    if (target.kind == TargetKind::Int && !integral)
        return Verdict::TypeMismatch;

    return Verdict::Accept;
}

// The same question for a decoded message.
inline Verdict verdictFor(const Decoded& d, const Target& target)
{
    return verdictFor(d.integral || allValuesIntegral(d.floats), d.count(), target);
}

inline const char* describe(DecodeError error)
{
    switch (error)
    {
    case DecodeError::None:               return "ok";
    case DecodeError::NotOsc:             return "not an OSC message";
    case DecodeError::MalformedArguments: return "the arguments do not match the type tags";
    case DecodeError::WrongAddress:       return "wrong address";
    case DecodeError::NameMissing:        return "no uniform name";
    case DecodeError::NameNotString:      return "the name is not a string";
    case DecodeError::ValuesMissing:      return "no value after the name";
    case DecodeError::TooManyValues:      return "too many values";
    case DecodeError::BadValueType:       return "a value is not a usable number";
    case DecodeError::NonFinite:          return "a value is NaN or infinite";
    }
    return "unknown";
}

inline const char* describe(Verdict verdict)
{
    switch (verdict)
    {
    case Verdict::Accept:              return "accept";
    case Verdict::ArityMismatch:       return "the uniform takes a different number of values";
    case Verdict::TypeMismatch:        return "the uniform needs integers";
    case Verdict::UnsupportedTarget:   return "the uniform type is not addressable";
    }
    return "unknown";
}

inline const char* describe(TargetKind kind)
{
    switch (kind)
    {
    case TargetKind::Unsupported: return "unsupported";
    case TargetKind::Float:       return "float";
    case TargetKind::Int:         return "int";
    }
    return "unknown";
}

} // namespace GraphicsOsc
} // namespace SonicPi
