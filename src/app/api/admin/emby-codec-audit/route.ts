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

export async function GET(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo?.username || authInfo.username !== process.env.USERNAME) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const embyKey = searchParams.get('embyKey') || undefined;
    const includeEpisodes = searchParams.get('includeEpisodes') !== 'false';
    const limit = Math.min(parseInt(searchParams.get('limit') || '5000'), 20000);

    // 站长身份取 client
    const client = await embyManager.getClientForUser(process.env.USERNAME as string, embyKey);

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
        const streams: any[] = Array.isArray(ms.MediaStreams) ? ms.MediaStreams : [];
        const vStream = streams.find((s) => String(s.Type || '').toLowerCase() === 'video');
        const videoCodec = String(vStream?.Codec || 'unknown').toUpperCase();
        const videoProfile = String(vStream?.Profile || '').toUpperCase();
        const audioCodecs = [
          ...new Set(
            streams
              .filter((s) => String(s.Type || '').toLowerCase() === 'audio')
              .map((s) => String(s.Codec || 'unknown').toUpperCase())
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
      { status: 500 }
    );
  }
}
