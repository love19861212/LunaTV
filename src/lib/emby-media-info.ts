/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 从 Emby MediaSources 提取紧凑的媒体信息标签，如 "MKV · HEVC · EAC3 · 19.8M"
 * 返回 null 表示无可用信息
 */
export function buildEmbyMediaInfo(item: any): string | null {
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
