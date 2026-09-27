/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getCachedEmbyList, setCachedEmbyList } from '@/lib/emby-cache';
import { embyManager } from '@/lib/emby-manager';
import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

// 从 Emby MediaSources 提取紧凑的媒体信息标签，如 "MKV · HEVC · EAC3 · 19.8M"
// 返回 null 表示无可用信息（剧集等）
function buildMediaInfo(item: any): string | null {
  try {
    const ms = item?.MediaSources?.[0];
    if (!ms) return null;
    const parts: string[] = [];
    const container = String(ms.Container || '').toUpperCase();
    if (container) parts.push(container);
    const streams: any[] = ms.MediaStreams || [];
    const video = streams.find((s: any) => s.Type === 'Video');
    if (video?.Codec) {
      let vc = String(video.Codec).toUpperCase();
      // HEVC 10-bit 特别标出
      if (/HEVC|H265/i.test(vc) && /10/i.test(String(video.Profile || ''))) vc = 'HEVC 10bit';
      parts.push(vc);
    }
    const audio = streams.find((s: any) => s.Type === 'Audio' && (s.IsDefault || s.IsDefault === undefined))
      || streams.find((s: any) => s.Type === 'Audio');
    if (audio?.Codec) parts.push(String(audio.Codec).toUpperCase());
    const br = Number(ms.Bitrate);
    if (br > 0) parts.push((Math.round(br / 100000) / 10) + 'M');
    return parts.length > 0 ? parts.join(' · ') : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = parseInt(searchParams.get('pageSize') || '20');
  const parentId = searchParams.get('parentId') || undefined;
  const embyKey = searchParams.get('embyKey') || undefined;
  const sortBy = searchParams.get('sortBy') || 'SortName';
  const sortOrder = searchParams.get('sortOrder') || 'Ascending';

  try {
    // 从 cookie 获取用户信息
    const authCookie = getAuthInfoFromCookie(request);

    if (!authCookie?.username) {
      return NextResponse.json(
        { error: '未登录' },
        { status: 401 }
      );
    }

    const username = authCookie.username;

    // 判断是否是默认排序（只有默认排序才使用缓存）
    const isDefaultSort = sortBy === 'SortName' && sortOrder === 'Ascending';

    // 只有默认排序才检查缓存
    if (isDefaultSort) {
      const cached = getCachedEmbyList(page, pageSize, parentId, embyKey);
      if (cached) {
        return NextResponse.json(cached);
      }
    }

    // 获取用户的Emby客户端
    const client = await embyManager.getClientForUser(username, embyKey);

    // 获取媒体列表
    const result = await client.getItems({
      ParentId: parentId,
      IncludeItemTypes: 'Movie,Series',
      Recursive: true,
      Fields: 'Overview,ProductionYear,MediaSources',
      SortBy: sortBy,
      SortOrder: sortOrder,
      StartIndex: (page - 1) * pageSize,
      Limit: pageSize,
    });

    const list = result.Items.map((item) => ({
      id: item.Id,
      title: item.Name,
      poster: client.getImageUrl(item.Id, 'Primary'),
      year: item.ProductionYear?.toString() || '',
      rating: item.CommunityRating || 0,
      mediaType: item.Type === 'Movie' ? 'movie' : 'tv',
      mediaInfo: buildMediaInfo(item),
    }));

    const totalPages = Math.ceil(result.TotalRecordCount / pageSize);

    const response = {
      success: true,
      list,
      totalPages,
      currentPage: page,
      total: result.TotalRecordCount,
    };

    // 只有默认排序才缓存结果
    if (isDefaultSort) {
      setCachedEmbyList(page, pageSize, response, parentId, embyKey);
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('获取 Emby 列表失败:', error);
    return NextResponse.json({
      error: '获取 Emby 列表失败: ' + (error as Error).message,
      list: [],
      totalPages: 0,
      currentPage: page,
      total: 0,
    });
  }
}
