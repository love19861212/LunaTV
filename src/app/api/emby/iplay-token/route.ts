/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { createEncryptedIPlayToken } from '@/lib/iplay-token';

export const runtime = 'nodejs';

/**
 * iPlay 加密令牌签发接口
 * POST /api/emby/iplay-token  { url: string }
 * 返回 { playUrl }：可直接 base64 后拼入 iplay:// 深链的播放地址。
 * playUrl 形如  {Worker}/?iplay={加密令牌}，Worker 用共享密钥直接解密，
 * 无需回跳本站兑换，深链里不含 Emby 真实地址。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    let url = (body?.url || '').trim();
    if (!url) {
      return NextResponse.json({ error: '缺少 url 参数' }, { status: 400 });
    }
    if (!/^https?:\/\//i.test(url)) {
      // 相对路径补成站内地址
      if (url.startsWith('/')) {
        const host =
          request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
        const proto =
          request.headers.get('x-forwarded-proto') ||
          (host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https');
        url = `${proto}://${host}${url}`;
      } else {
        return NextResponse.json({ error: 'url 格式不正确' }, { status: 400 });
      }
    }

    const config = await getConfig();

    // 如果是 Worker 包裹地址，先解出里面的直链（令牌兑换后 Worker 会再包一层）
    let directUrl = url;
    try {
      const workerProxyUrl: string = config.VideoProxyConfig?.proxyUrl || '';
      const workerHost = workerProxyUrl ? new URL(workerProxyUrl).hostname : '';
      const u = new URL(url);
      const inner = u.searchParams.get('url');
      if (inner && workerHost && u.hostname === workerHost) {
        directUrl = inner;
      }
    } catch {
      // 解析失败就用原地址
    }

    const token = createEncryptedIPlayToken(directUrl);

    // 用 CF Worker 包裹加密令牌（Worker 直接解密拿到真实 Emby 地址，无需回跳本站）
    let playUrl = '';
    const workerEnabled = config.VideoProxyConfig?.enabled;
    const workerProxyUrl = (config.VideoProxyConfig?.proxyUrl || '').replace(/\/+$/, '');
    if (workerEnabled && workerProxyUrl) {
      playUrl = `${workerProxyUrl}/?iplay=${token}`;
    } else {
      // Worker 未启用时回退到旧的本站兑换地址（兼容）
      const host =
        request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
      const proto =
        request.headers.get('x-forwarded-proto') ||
        (host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https');
      const baseUrl = process.env.SITE_BASE || `${proto}://${host}`;
      // 旧版令牌（内存存储）已废弃，此处仅作兜底，正常不会走到
      playUrl = `${baseUrl}/api/emby/iplay?t=${token}`;
    }

    return NextResponse.json({ playUrl });
  } catch (e) {
    console.error('[iPlay token] 签发失败:', e);
    return NextResponse.json({ error: '令牌签发失败' }, { status: 500 });
  }
}
