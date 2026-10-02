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

// The four Shadertoy channels of ONE PASS of a document, as the DRAW INDEX of the buffer each one reads, or
// -1 for None (a shader sampling it gets black).
//
// PER PASS, which is what Shadertoy does: its API hangs the bindings under each render pass, and its editor
// shows the channel row of whichever pass is selected. A single shared set - what this did first, a
// deliberate deviation recorded in the plan - cannot express a shader whose Buffer A reads Buffer B while
// its Image reads Buffer A, so porting such a shader would mean renumbering its channels.
//
// Stored beside the document's passes, one section per pass:
//
//     [Image]
//     iChannel0 = bufferA
//     iChannel1 = none
//     [Buffer A]
//     iChannel0 = none
//
// Human-readable and hand-editable on purpose. A file with NO section header is a document-level
// assignment applying to every pass - the format this had before channels were per-pass - so old files keep
// meaning what they meant. A missing file means the default assignment (channel i reads Buffer i).
inline QString graphicsDocumentChannelsFileName() { return QStringLiteral("channels.txt"); }

inline QString graphicsDocumentChannelsPath(const GraphicsDocument& document)
{
    if (document.directory.isEmpty())
        return QString();
    return QDir(document.directory).filePath(graphicsDocumentChannelsFileName());
}

// The channel whose line names `name`, or -1 when the line says none or anything unrecognised.
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

// A section header as a key: lower case, spaces removed, so "[Buffer A]" and "[bufferA]" are the same pass.
inline QString graphicsChannelSectionKey(const QString& raw)
{
    QString key = raw.trimmed().toLower();
    key.remove(QLatin1Char(' '));
    return key;
}

// Every section of the file, keyed by pass name (graphicsPassName), plus the key "*" when the file has no
// sections at all - the legacy document-level form.
inline QHash<QString, QList<int>> graphicsDocumentChannelTable(const GraphicsDocument& document)
{
    QHash<QString, QList<int>> table;
    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return table;

    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return table;

    QTextStream in(&file);
    QString section;
    QList<int> legacy;
    while (!in.atEnd())
    {
        const QString line = in.readLine().trimmed();
        if (line.isEmpty() || line.startsWith(QLatin1Char('#')))
            continue;

        if (line.startsWith(QLatin1Char('[')) && line.endsWith(QLatin1Char(']')))
        {
            section = graphicsChannelSectionKey(line.mid(1, line.size() - 2));
            if (!table.contains(section))
                table.insert(section, QList<int>() << -1 << -1 << -1 << -1);
            continue;
        }

        const int equals = line.indexOf(QLatin1Char('='));
        if (equals <= 0)
            continue;
        const QString key = line.left(equals).trimmed().toLower();
        if (!key.startsWith(QLatin1String("ichannel")))
            continue;
        bool ok = false;
        const int index = key.mid(8).toInt(&ok);   // "ichannel" is 8 characters
        if (!ok || index < 0 || index > 3)
            continue;

        const int source = graphicsChannelSourceFromName(line.mid(equals + 1));
        if (section.isEmpty())
        {
            while (legacy.size() < 4)
                legacy << -1;
            legacy[index] = source;
        }
        else
        {
            QList<int> entry = table.value(section);
            while (entry.size() < 4)
                entry << -1;
            entry[index] = source;
            table.insert(section, entry);
        }
    }

    if (!legacy.isEmpty())
        table.insert(QStringLiteral("*"), legacy);
    return table;
}

// The sources for one pass, or an empty list when the document says nothing about it - in which case the
// caller applies the default (channel i reads Buffer i).
inline QList<int> graphicsDocumentChannels(const GraphicsDocument& document, GraphicsPass pass)
{
    const QHash<QString, QList<int>> table = graphicsDocumentChannelTable(document);
    const QString key = graphicsChannelSectionKey(graphicsPassName(pass));
    if (table.contains(key))
        return table.value(key);
    if (table.contains(QStringLiteral("*")))
        return table.value(QStringLiteral("*"));
    return QList<int>();
}

// Write one pass's four lines, keeping every other section. Existing sections are re-emitted in name order,
// so a diff of this file shows only what the user changed.
inline bool writeGraphicsDocumentChannels(const GraphicsDocument& document, GraphicsPass pass,
                                          const QList<int>& channels)
{
    if (channels.size() != 4)
        return false;

    QHash<QString, QList<int>> table = graphicsDocumentChannelTable(document);
    const QString key = graphicsChannelSectionKey(graphicsPassName(pass));
    table.insert(key, channels);
    table.remove(QStringLiteral("*"));   // a legacy file becomes sections on its first write

    const QString path = graphicsDocumentChannelsPath(document);
    if (path.isEmpty())
        return false;

    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text))
        return false;

    QTextStream out(&file);
    QStringList order = table.keys();
    order.sort();
    for (const QString& sectionName : order)
    {
        out << QStringLiteral("[%1]\n").arg(sectionName);
        const QList<int> entry = table.value(sectionName);
        for (int i = 0; i < 4; ++i)
        {
            const int source = entry.value(i, -1);
            const QString name = (source >= 0 && source < kDrawOrderCount)
                                     ? graphicsPassName(kDrawOrder[source])
                                     : QStringLiteral("none");
            out << QStringLiteral("iChannel%1 = %2\n").arg(i).arg(name);
        }
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
