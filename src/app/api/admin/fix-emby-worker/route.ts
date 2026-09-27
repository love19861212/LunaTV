import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username || authInfo.username !== process.env.USERNAME) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const config = await db.getAdminConfig();
  const sources = (config as any)?.EmbyConfig?.Sources || [];
  let updated = false;
  for (const s of sources) {
    if (s.key === '69emby') {
      s.workerProxyPlay = true;
      updated = true;
    }
  }
  if (!updated) {
    return NextResponse.json({ error: '69emby not found' }, { status: 404 });
  }
  await db.saveAdminConfig(config as any);
  return NextResponse.json({ success: true, message: '69emby workerProxyPlay 已设为 true' });
}
