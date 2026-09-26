/* eslint-disable no-console */
import dns from 'dns';
import https from 'https';
import net from 'net';
import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { isFfmpegAvailable } from '@/lib/emby-transcode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/emby/transcode/{token}/diag?host=xxx
 * VPS 端网络诊断：DNS / TCP 443 / TLS / 代理环境变量 / ffmpeg 可用性。
 * 用于定位转码上游取流失败（如 Emby 前置机连不上）的根因。
 *
 * 权限验证：TVBox Token（路径参数） 或 用户登录（满足其一即可）
 */

function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, error: `ETIMEDOUT: ${timeoutMs}ms 内未连通` });
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve({ ok: true, rttMs: Date.now() - start });
      sock.end();
    });
    sock.once('error', (e: any) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `${e.code || 'ERROR'}: ${e.message}` });
    });
    sock.connect(port, host);
  });
}

function httpsProbe(host: string, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host,
        port: 443,
        path: '/',
        timeout: timeoutMs,
        // 诊断用途：只关心建连与握手，不校验证书
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `ETIMEDOUT: ${timeoutMs}ms 内无响应` });
    });
    req.on('error', (e: any) =>
      resolve({ ok: false, error: `${e.code || 'ERROR'}: ${e.message}` })
    );
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token: requestToken } = await params;
    const subscribeToken = process.env.TVBOX_SUBSCRIBE_TOKEN;
    const authInfo = getAuthInfoFromCookie(request);
    const hasValidToken = subscribeToken && requestToken === subscribeToken;
    const hasValidAuth = authInfo && authInfo.username;
    if (!hasValidToken && !hasValidAuth) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const host = (searchParams.get('host') || '').trim();
    if (!host || !/^[a-zA-Z0-9.-]+$/.test(host) || host.length > 253) {
      return NextResponse.json(
        { error: '缺少或非法的 host 参数' },
        { status: 400 }
      );
    }

    const out: any = {
      host,
      node: process.version,
      ffmpeg: isFfmpegAvailable(),
      // 只报告是否设置，不输出值（可能含敏感信息）
      proxyEnv: {
        http_proxy: !!(process.env.http_proxy || process.env.HTTP_PROXY),
        https_proxy: !!(process.env.https_proxy || process.env.HTTPS_PROXY),
        all_proxy: !!(process.env.all_proxy || process.env.ALL_PROXY),
        no_proxy: !!(process.env.no_proxy || process.env.NO_PROXY),
      },
    };

    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      out.dns = {
        ok: true,
        addresses: addrs.map((a) => `${a.address} (v${a.family})`),
      };
    } catch (e: any) {
      out.dns = { ok: false, error: `${e.code || 'ERROR'}: ${e.message}` };
    }

    if (out.dns?.ok) {
      out.tcp443 = await tcpProbe(host, 443);
    }
    if (out.tcp443?.ok) {
      out.https = await httpsProbe(host);
    }

    return NextResponse.json(out);
  } catch (error) {
    console.error('[EmbyTranscodeDiag] 错误:', error);
    return NextResponse.json(
      { error: '诊断失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
