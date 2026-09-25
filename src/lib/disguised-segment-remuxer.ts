/**
 * 伪装分片修复器（v2 - 简化版）
 *
 * 部分视频源（如 #1 爱奇艺、#27 百度云zy、#56 黑料资源）的 HLS 分片
 * 被伪装成 JPEG 图片，实际结构为：
 *   [假 JPEG 头 + 填充 ~451 字节] + [标准 MPEG-TS]
 *
 * 浏览器测速只测下载速度所以显示正常，但 hls.js 的 TS 解析器从第 0 字节
 * 开始找 0x47 同步头，被开头的伪装数据干扰，导致 FRAG_PARSING_ERROR、黑屏。
 *
 * 修复：在 hls.js 自定义 Loader 中拦截分片下载，检测 JPEG 伪装，
 * 定位真正的 TS 同步位置，切掉伪装头，把干净的 TS 交回 hls.js。
 */

const TS_PACKET = 188;
const TS_SYNC = 0x47;

/** 是否为伪装分片：以 JPEG SOI (FF D8 FF) 开头 */
export function isDisguisedSegment(data: Uint8Array): boolean {
  return (
    data.length > TS_PACKET * 2 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  );
}

/**
 * 在数据中定位真正的 TS 包起始位置。
 * 要求：连续 N 个 188 字节间隔的位置都是 0x47。
 * 从较靠后的位置开始扫描，避免 JPEG 区偶然的 0x47 误命中。
 */
function findTsSync(data: Uint8Array): number {
  // 需要连续 10 个包同步才确认，避免伪装区偶然的 0x47 误命中
  const CONFIRM_PACKETS = 10;
  // 伪装头通常 < 2KB，从 256 字节后开始找，步进 1 字节扫描
  const SCAN_START = 256;
  const maxOffset = Math.min(data.length - TS_PACKET * CONFIRM_PACKETS, 8192);

  for (let offset = SCAN_START; offset < maxOffset; offset++) {
    if (data[offset] !== TS_SYNC) continue;
    let ok = true;
    for (let k = 1; k < CONFIRM_PACKETS; k++) {
      if (data[offset + k * TS_PACKET] !== TS_SYNC) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // 二次验证：检查 PID 分布是否合理（PAT=0 必须在前几个包中出现）
    let hasPat = false;
    for (let k = 0; k < CONFIRM_PACKETS; k++) {
      const pid = ((data[offset + k * TS_PACKET + 1] & 0x1f) << 8) |
        data[offset + k * TS_PACKET + 2];
      if (pid === 0x0000) { hasPat = true; break; }
    }
    if (hasPat) return offset;
  }
  return -1;
}

/**
 * 主入口：剥掉伪装头，返回干净的 MPEG-TS。
 * @param rawData 分片原始字节
 * @returns 干净 TS 字节；若不是伪装分片返回 null（走原流程）；
 *          若是伪装但找不到 TS 同步则抛出错误（由调用方捕获并降级）
 */
export function remuxDisguisedSegment(rawData: Uint8Array): Uint8Array | null {
  if (!isDisguisedSegment(rawData)) return null;

  const tsStart = findTsSync(rawData);
  if (tsStart < 0) {
    throw new Error('disguised segment: TS sync not found');
  }

  // 截断到 188 字节对齐
  const cleanLen = rawData.length - tsStart;
  const alignedLen = cleanLen - (cleanLen % TS_PACKET);
  if (alignedLen < TS_PACKET * 2) {
    throw new Error('disguised segment: too short after stripping');
  }

  return rawData.slice(tsStart, tsStart + alignedLen);
}
