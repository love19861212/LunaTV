/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { redeemIPlayToken } from '@/lib/iplay-token';

export const runtime = 'nodejs';

/**
 * iPlay 令牌兑换接口
 * GET /api/emby/iplay?t={token}
 * 令牌有效（5 分钟内）则 302 跳转到真实 Emby 播放地址（CF Worker 会跟随跳转）；
 * 无效/过期则 410。
 */
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('t') || '';
  if (!token) {
    return NextResponse.json({ error: '缺少令牌' }, { status: 400 });
  }
  const url = redeemIPlayToken(token);
  if (!url) {
    return NextResponse.json({ error: '令牌无效或已过期' }, { status: 410 });
  }
  return NextResponse.redirect(url, 302);
}
