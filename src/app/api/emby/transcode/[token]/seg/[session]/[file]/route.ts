/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  getSessionById,
  isValidSegmentFile,
  touchSessionById,
} from '@/lib/emby-transcode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/emby/transcode/{token}/seg/{session}/{file}
 *
 * 提供转码会话的 HLS 分片（seg00001.ts）。
 * 文件名严格校验，防止路径穿越。
 *
 * 权限验证：TVBox Token（路径参数） 或 用户登录（满足其一即可）
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; session: string; file: string }> }
) {
  try {
    const { token: requestToken, session: sessionId, file } = await params;

    const subscribeToken = process.env.TVBOX_SUBSCRIBE_TOKEN;
    const authInfo = getAuthInfoFromCookie(request);
    const hasValidToken = subscribeToken && requestToken === subscribeToken;
    const hasValidAuth = authInfo && authInfo.username;
    if (!hasValidToken && !hasValidAuth) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    if (!isValidSegmentFile(file)) {
      return NextResponse.json({ error: '非法的文件名' }, { status: 400 });
    }

    const session = getSessionById(sessionId);
    if (!session) {
      // 分片可能已被回收（会话超时）→ 404，播放器会按 HLS 逻辑重试/报错
      return NextResponse.json({ error: '转码会话不存在或已过期' }, { status: 404 });
    }
    touchSessionById(sessionId);

    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(session.dir, file);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // 分片还没生成（转码进度未到）→ 404，hls.js 会重试
      return NextResponse.json({ error: '分片尚未生成' }, { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', 'video/MP2T');
    headers.set('Content-Length', String(stat.size));
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Accept-Ranges', 'bytes');

    const stream = fs.createReadStream(filePath);
    return new NextResponse(stream as any, { status: 200, headers });
  } catch (error) {
    console.error('[EmbyTranscode] 分片服务错误:', error);
    return NextResponse.json(
      { error: '分片服务失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
