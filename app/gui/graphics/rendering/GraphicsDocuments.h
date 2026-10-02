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

// GraphicsDocuments.h — 磁盘上"一个 Shadertoy 文档"是什么（方案 A：目录级管理）。
//
// 约定（用户 2026-10-02 定，见 docs/graphics-desktop-multipass-plan.md §17.2）：
//
//   <shaders>/                       ← GraphicsSettings::shaderDirectoryPath()
//   ├── default.frag                 ← 顶层 .frag = **单 pass 文档**（既有行为，零迁移）
//   └── <doc>/                       ← 目录 = 一个文档，目录名 = tab 名
//       ├── common.glsl              ← Common：前置到本档每个 pass，**本身不是 pass**
//       ├── image.frag               ← Image：**存在它才算一个文档**
//       └── bufferA.frag … bufferD.frag
//
// 规则：缺某个 buffer 文件 → 该 pass 为空（不编译、不画，采样它 = 黑，与 web
// "空 pass 不花钱、指向它是黑而不是异常" 一致）；缺 common.glsl → 空（不是错误）；
// 缺 image.frag → 目录**不算文档**（免得随便一个目录被当成文档）；文件名**精确匹配**大小写。
//
// 这个头只回答"有哪些文档、每个文档的哪个 pass 在哪个文件"——不读文件内容、不碰 GL、不碰 QSettings，
// 所以它能被编译进任何地方，也能被 UI 与管线共同使用而不互相牵制。

#pragma once

#include <QDir>
#include <QFileInfo>
#include <QString>
#include <QStringList>

#include "GraphicsPasses.h"

namespace SonicPi
{

// Image is the pass whose presence makes a directory a document: a directory without it is not one.
inline QString graphicsDocumentImageFileName() { return QStringLiteral("image.frag"); }
inline QString graphicsDocumentCommonFileName() { return QStringLiteral("common.glsl"); }

// "image" -> "image.frag", "bufferA" -> "bufferA.frag": one rule, taken from the pass vocabulary, so the
// file names and graphicsPassName() cannot drift apart.
inline QString graphicsDocumentPassFileName(GraphicsPass pass)
{
    if (pass == GraphicsPass::Common)
        return graphicsDocumentCommonFileName();
    return graphicsPassName(pass) + QStringLiteral(".frag");
}

struct GraphicsDocument
{
    QString name;        // tab name: the directory's name, or the file's base name for a single pass
    QString directory;   // empty for a single-pass document (a top-level .frag file)
    bool singlePass = false;

    bool isValid() const { return !name.isEmpty(); }

    // Absolute path of one pass's text, or an empty string when that pass has no file (which is not an
    // error: an absent buffer is an empty pass).
    QString passPath(GraphicsPass pass) const
    {
        if (singlePass) {
            // A single-pass document is one file: everything but Image is absent, and Image IS the file.
            if (pass != GraphicsPass::Image)
                return QString();
            return directory.isEmpty() ? QString() : m_singlePassFile;
        }
        const QString file = QDir(directory).filePath(graphicsDocumentPassFileName(pass));
        return QFileInfo::exists(file) ? file : QString();
    }

    // Set only for single-pass documents, by the scanner below.
    QString m_singlePassFile;
};

// The four Shadertoy channels of a document, as the DRAW INDEX of the buffer each one reads, or -1 for
// None (a shader sampling it gets black).
//
// Stored as a small text file beside the document's passes, one line per channel:
//
//     iChannel0 = bufferA
//     iChannel1 = none
//
// Human-readable and hand-editable on purpose: this is exactly the kind of setting a person wants to see
// and change without a UI, and a diff of it should mean something. A missing file, a missing line or an
// unreadable name all mean "None for that channel" - the same rule as an absent buffer being an empty
// pass, so a hand-edited mistake degrades to black rather than to an exception.
inline QString graphicsDocumentChannelsFileName() { return QStringLiteral("channels.txt"); }

inline QString graphicsDocumentChannelsPath(const GraphicsDocument& document)
{
    if (document.directory.isEmpty())
        return QString();
    return QDir(document.directory).filePath(graphicsDocumentChannelsFileName());
}

// The channel whose line names `name`, or -1 when the line says none/anything unrecognised. `name` is
// compared against graphicsPassName() (bufferA..bufferD, image), so the file speaks the same vocabulary
// as everything else.
inline int graphicsChannelSourceFromName(const QString& name)
{
    const QString wanted = name.trimmed().toLower();
    if (wanted.isEmpty() || wanted == QLatin1String("none"))
        return -1;
    for (int i = 0; i < kDrawOrderCount; ++i) {
        if (graphicsPassName(kDrawOrder[i]).toLower() == wanted)
            return i;
    }
    return -1;
}

inline QList<int> graphicsDocumentChannels(const GraphicsDocument& document)
{
    QList<int> channels;
    channels << -1 << -1 << -1 << -1;   // None everywhere until the file says otherwise

    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return channels;

    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return channels;

    QTextStream in(&file);
    while (!in.atEnd()) {
        const QString line = in.readLine().trimmed();
        const int equals = line.indexOf(QLatin1Char('='));
        if (equals <= 0)
            continue;
        const QString key = line.left(equals).trimmed().toLower();
        if (!key.startsWith(QLatin1String("ichannel")))
            continue;
        bool ok = false;
        const int index = key.mid(8).toInt(&ok);      // "ichannel" is 8 characters
        if (!ok || index < 0 || index > 3)
            continue;
        channels[index] = graphicsChannelSourceFromName(line.mid(equals + 1));
    }
    return channels;
}

// Write the four lines. Returns false when there is nowhere to write (no directory) or the file cannot be
// opened, and the caller reports that rather than pretending the setting was saved.
inline bool writeGraphicsDocumentChannels(const GraphicsDocument& document, const QList<int>& channels)
{
    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty() || channels.size() != 4)
        return false;

    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
        return false;

    QTextStream out(&file);
    for (int i = 0; i < 4; ++i) {
        const int source = channels[i];
        const QString name = (source >= 0 && source < kDrawOrderCount)
                                 ? graphicsPassName(kDrawOrder[source])
                                 : QStringLiteral("none");
        out << QStringLiteral("iChannel%1 = %2\n").arg(i).arg(name);
    }
    return true;
}

// The passes this document actually HAS, in the frame order GraphicsPasses.h names: Image always (it is
// what makes a directory a document), and each Buffer only when its file exists. This is what a pass
// selector should offer, and what keeps an editor tab from offering a pass the renderer has no program
// for - the same rule as "an absent buffer is an empty pass" (plan 17.2), expressed once.
inline QList<GraphicsPass> graphicsDocumentPasses(const GraphicsDocument& document)
{
    QList<GraphicsPass> passes;
    if (!document.isValid())
        return passes;
    for (int i = 0; i < kDrawOrderCount; ++i) {
        if (!document.passPath(kDrawOrder[i]).isEmpty())
            passes.append(kDrawOrder[i]);
    }
    return passes;
}

// Every document under `shadersDir`: its subdirectories that hold image.frag, plus its top-level .frag
// files (each of which stays a single-pass document, exactly as before this feature).
inline QList<GraphicsDocument> scanGraphicsDocuments(const QString& shadersDir)
{
    QList<GraphicsDocument> documents;
    const QDir root(shadersDir);
    if (!root.exists())
        return documents;

    // Directories first, in name order: a document is a directory containing image.frag.
    const QStringList dirs = root.entryList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QString& dirName : dirs) {
        const QDir dir(root.filePath(dirName));
        if (!QFileInfo::exists(dir.filePath(graphicsDocumentImageFileName())))
            continue;   // not a document - just a directory somebody made
        GraphicsDocument document;
        document.name = dirName;
        document.directory = dir.absolutePath();
        document.singlePass = false;
        documents.append(document);
    }

    // Then the top-level .frag files: unchanged behaviour, one file is one single-pass document.
    const QStringList files = root.entryList(QStringList() << QStringLiteral("*.frag"), QDir::Files, QDir::Name);
    for (const QString& fileName : files) {
        GraphicsDocument document;
        document.name = QFileInfo(fileName).completeBaseName();
        document.directory = root.absolutePath();
        document.singlePass = true;
        document.m_singlePassFile = root.filePath(fileName);
        documents.append(document);
    }

    return documents;
}

} // namespace SonicPi
