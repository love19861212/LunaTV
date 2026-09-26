/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  getOrStartSession,
  rewritePlaylistUrls,
  toFfmpegAudioPos,
  TranscodeError,
} from '@/lib/emby-transcode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getEmbyClient(embyKey?: string, username?: string) {
  const { embyManager } = await import('@/lib/emby-manager');
  if (username) {
    return await embyManager.getClientForUser(username, embyKey);
  }
  return await embyManager.getClient(embyKey);
}

/** 查找源配置（用于读取 vpsAudioTranscode 开关） */
async function getSourceConfig(embyKey?: string, username?: string) {
  const { embyManager } = await import('@/lib/emby-manager');
  const sources = username
    ? await embyManager.getEnabledSourcesForUser(username)
    : await embyManager.getEnabledSources();
  if (embyKey) return sources.find((s: any) => s.key === embyKey);
  return sources.find((s: any) => s.isDefault) || sources[0];
}

function checkAuth(request: NextRequest, requestToken: string) {
  const subscribeToken = process.env.TVBOX_SUBSCRIBE_TOKEN;
  const authInfo = getAuthInfoFromCookie(request);
  const hasValidToken = subscribeToken && requestToken === subscribeToken;
  const hasValidAuth = authInfo && authInfo.username;
  return { ok: !!(hasValidToken || hasValidAuth), authInfo };
}

function errorStatus(code: TranscodeError['code']): number {
  switch (code) {
    case 'NO_FFMPEG':
      return 503;
    case 'TOO_MANY':
      return 429;
    case 'NO_DISK':
      return 507;
    case 'UPSTREAM':
      return 502;
    default:
      return 500;
  }
}

/**
 * GET /api/emby/transcode/{token}/playlist.m3u8?itemId=xxx&audioStreamIndex=n&embyKey=yyy
 *
 * 启动（或复用）VPS 端 ffmpeg 音频转码会话，返回 HLS 播放列表。
 * - 视频流复制不转码，音频转 AAC
 * - playlist 随转码进度增长，可 seek
 *
 * 权限验证：TVBox Token（路径参数） 或 用户登录（满足其一即可）
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token: requestToken } = await params;
    const { ok, authInfo } = checkAuth(request, requestToken);
    if (!ok) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const itemId = searchParams.get('itemId');
    const embyKey = searchParams.get('embyKey') || undefined;
    const audioStreamIndexRaw = searchParams.get('audioStreamIndex');
    const audioStreamIndex =
      audioStreamIndexRaw !== null && audioStreamIndexRaw !== ''
        ? Number(audioStreamIndexRaw)
        : undefined;

    if (!itemId) {
      return NextResponse.json({ error: '缺少 itemId 参数' }, { status: 400 });
    }

    // 检查源是否启用了 VPS 音频转码（默认启用，显式关闭才禁用）
    const sourceConfig = await getSourceConfig(embyKey, authInfo?.username);
    if (sourceConfig && sourceConfig.vpsAudioTranscode === false) {
      return NextResponse.json(
        { error: '该 Emby 源未启用 VPS 音频转码' },
        { status: 403 }
      );
    }

    const client = await getEmbyClient(embyKey, authInfo?.username);

    // Emby 直链（ffmpeg 在 VPS 端直接拉流）
    let embyStreamUrl = await client.getStreamUrl(
      itemId,
      true,
      true,
      typeof audioStreamIndex === 'number' && Number.isFinite(audioStreamIndex)
        ? audioStreamIndex
        : undefined
    );

    // 换算 ffmpeg 的音频流序号（0:a:N）
    let audioPos = 0;
    try {
      const tracks = await client.getAudioStreams(itemId);
      audioPos = toFfmpegAudioPos(tracks, audioStreamIndex);
    } catch (e) {
      console.warn('[EmbyTranscode] 获取音轨失败，使用默认音轨:', (e as Error).message);
    }

    const session = await getOrStartSession({
      embyKey,
      itemId,
      audioPos,
      inputUrl: embyStreamUrl,
    });

    // 读取当前 playlist 并重写分片 URL
    const fs = await import('fs');
    const path = await import('path');
    const playlistPath = path.join(session.dir, 'playlist.m3u8');
    let playlistText: string;
    try {
      playlistText = fs.readFileSync(playlistPath, 'utf8');
    } catch {
      return NextResponse.json(
        { error: '转码会话异常，播放列表不可用' },
        { status: 502 }
      );
    }

    const segPrefix = `/api/emby/transcode/${encodeURIComponent(requestToken)}/seg/${session.id}`;
    const rewritten = rewritePlaylistUrls(playlistText, segPrefix);

    return new NextResponse(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'X-Transcode-Session': session.id,
      },
    });
  } catch (error) {
    console.error('[EmbyTranscode] playlist 错误:', error);
    if (error instanceof TranscodeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: errorStatus(error.code) }
      );
    }
    return NextResponse.json(
      { error: '启动转码失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
