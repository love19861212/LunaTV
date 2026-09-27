/* eslint-disable no-console */
/**
 * Emby 全库编码格式审计（仅站长）
 * 分页拉取所有 Movie/Episode 的 MediaSources，输出 (容器, 视频编码, 音频编码) 矩阵
 * 用途：一次性覆盖全库格式组合，定位转码决策逻辑的盲区
 * GET /api/admin/emby-codec-audit?embyKey=69emby&includeEpisodes=true&limit=5000
 */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { embyManager } from '@/lib/emby-manager';

export const runtime = 'nodejs';
export const maxDuration = 300; // 最长 5 分钟

interface CodecCombo {
  container: string;
  videoCodec: string;
  videoProfile: string;
  audioCodecs: string; // 去重排序后 join，如 "AAC+DTS"
  count: number;
  sampleIds: string[];
  sampleTitles: string[];
}

/**
 * 服务端复刻前端转码决策逻辑（src/app/play/page.tsx maybeBuildTranscodeUrl）
 * 用于审计：判断给定组合在 Chrome 下是否会触发 VPS 转码
 * 返回 'transcode' | 'direct'（direct = 不转码走直连）
 */
function simulateTranscodeDecision(
  container: string,
  audioCodecs: string,
): 'transcode' | 'direct' {
  // Chrome 支持的音频（与 audio-codec-compat.ts BROWSER_CODEC_SUPPORT.chrome 一致）
  const chromeSupported = new Set([
    'aac',
    'mp3',
    'opus',
    'vorbis',
    'flac',
    'pcm',
  ]);
  // 归一化（与 normalizeCodec 核心规则一致）
  const normalize = (codec: string): string => {
    const c = codec.toLowerCase().replace(/[\s_-]/g, '');
    if (c.includes('dtshd') || c.includes('dtshdma')) return 'dtshd';
    if (c === 'dca' || c === 'dts') return 'dts';
    if (c.includes('truehd') || c === 'mlp') return 'truehd';
    if (c === 'ac3') return 'ac-3';
    if (c === 'eac3' || c === 'ec3') return 'eac3';
    if (c.startsWith('mp4a') || c === 'aac') return 'aac';
    if (c === 'mp3' || c === 'mpeg') return 'mp3';
    if (c === 'opus') return 'opus';
    if (c === 'vorbis' || c === 'ogg') return 'vorbis';
    if (c === 'flac') return 'flac';
    if (c === 'pcm' || c === 'lpcm') return 'pcm';
    return c;
  };

  const tracksEmpty = !audioCodecs || audioCodecs === '(no-audio)';
  const cont = container.toLowerCase();
  const containerIncompatible =
    !!cont && !['mp4', 'm4v', 'webm', 'mov'].includes(cont);

  // STRM 是 Emby 外链流（无真实媒体），不适用转码决策，走直连
  if (cont === 'strm') return 'direct';

  // 当前前端逻辑：音轨与容器都缺失才保守转码（缺口：仅音轨缺失时不转码）
  if (tracksEmpty && !cont) return 'transcode';

  const codecs = tracksEmpty ? [] : audioCodecs.split('+');
  const hasPlayable = codecs.some((cd) => chromeSupported.has(normalize(cd)));

  if (hasPlayable && !containerIncompatible) return 'direct';
  return 'transcode';
}

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username || authInfo.username !== process.env.USERNAME) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const embyKey = searchParams.get('embyKey') || undefined;
    const includeEpisodes = searchParams.get('includeEpisodes') !== 'false';
    const limit = Math.min(
      parseInt(searchParams.get('limit') || '5000'),
      20000,
    );
    // analyze=true：只返回决策分析摘要（紧凑），不返回完整 matrix
    const analyzeOnly = searchParams.get('analyze') === 'true';

    // 站长身份取 client
    const client = await embyManager.getClientForUser(
      process.env.USERNAME as string,
      embyKey,
    );

    const combos = new Map<string, CodecCombo>();
    let totalItems = 0;
    let itemsWithMedia = 0;
    let itemsWithoutMedia = 0;

    const processItems = (items: any[]) => {
      for (const item of items) {
        totalItems++;
        const ms = item?.MediaSources?.[0];
        if (!ms) {
          itemsWithoutMedia++;
          continue;
        }
        itemsWithMedia++;

        const container = String(ms.Container || 'unknown').toUpperCase();
        const streams: any[] = Array.isArray(ms.MediaStreams)
          ? ms.MediaStreams
          : [];
        const vStream = streams.find(
          (s) => String(s.Type || '').toLowerCase() === 'video',
        );
        const videoCodec = String(vStream?.Codec || 'unknown').toUpperCase();
        const videoProfile = String(vStream?.Profile || '').toUpperCase();
        const audioCodecs = [
          ...new Set(
            streams
              .filter((s) => String(s.Type || '').toLowerCase() === 'audio')
              .map((s) => String(s.Codec || 'unknown').toUpperCase()),
          ),
        ]
          .sort()
          .join('+');

        const key = `${container}|${videoCodec}|${audioCodecs}`;
        let combo = combos.get(key);
        if (!combo) {
          combo = {
            container,
            videoCodec,
            videoProfile,
            audioCodecs: audioCodecs || '(no-audio)',
            count: 0,
            sampleIds: [],
            sampleTitles: [],
          };
          combos.set(key, combo);
        }
        combo.count++;
        if (combo.sampleIds.length < 5) {
          combo.sampleIds.push(String(item.Id));
          combo.sampleTitles.push(String(item.Name || ''));
        }
      }
    };

    // 1. 电影
    let startIndex = 0;
    const pageSize = 200;
    for (;;) {
      const result = await (client as any).getItems({
        IncludeItemTypes: 'Movie',
        Recursive: true,
        Fields: 'MediaSources',
        StartIndex: startIndex,
        Limit: pageSize,
      });
      const items = result?.Items || [];
      processItems(items);
      startIndex += items.length;
      if (items.length < pageSize || totalItems >= limit) break;
    }

    // 2. 剧集的每一集
    if (includeEpisodes && totalItems < limit) {
      startIndex = 0;
      for (;;) {
        const result = await (client as any).getItems({
          IncludeItemTypes: 'Episode',
          Recursive: true,
          Fields: 'MediaSources',
          StartIndex: startIndex,
          Limit: pageSize,
        });
        const items = result?.Items || [];
        processItems(items);
        startIndex += items.length;
        if (items.length < pageSize || totalItems >= limit) break;
      }
    }

    const matrix = [...combos.values()].sort((a, b) => b.count - a.count);

    // 分析模式：对每个组合模拟转码决策，输出紧凑摘要
    if (analyzeOnly) {
      const analysis = matrix.map((c) => ({
        container: c.container,
        videoCodec: c.videoCodec,
        audioCodecs: c.audioCodecs,
        count: c.count,
        decision: simulateTranscodeDecision(c.container, c.audioCodecs),
        sampleId: c.sampleIds[0] || null,
        sampleTitle: c.sampleTitles[0] || null,
      }));
      const directPlay = analysis.filter((a) => a.decision === 'direct');
      const transcode = analysis.filter((a) => a.decision === 'transcode');
      const directCount = directPlay.reduce((s, a) => s + a.count, 0);
      const transcodeCount = transcode.reduce((s, a) => s + a.count, 0);
      return NextResponse.json({
        success: true,
        embyKey: embyKey || '(default)',
        totalItems,
        comboCount: matrix.length,
        summary: {
          directPlayCombos: directPlay.length,
          directPlayItems: directCount,
          transcodeCombos: transcode.length,
          transcodeItems: transcodeCount,
        },
        // 只返回走直连的组合（潜在风险点），按数量排序
        directPlayCombos: directPlay,
        // 转码组合只给汇总，不逐个列出（数量大）
        transcodeComboCount: transcode.length,
      });
    }

    return NextResponse.json({
      success: true,
      embyKey: embyKey || '(default)',
      totalItems,
      itemsWithMedia,
      itemsWithoutMedia,
      comboCount: matrix.length,
      matrix,
    });
  } catch (error) {
    console.error('[emby-codec-audit] 失败:', error);
    return NextResponse.json(
      { error: '审计失败: ' + (error as Error).message },
      { status: 500 },
    );
  }
}
