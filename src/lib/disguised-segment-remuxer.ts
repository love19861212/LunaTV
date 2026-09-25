/**
 * 伪装分片修复器（v3）
 *
 * 部分视频源（如 #1 爱奇艺、#27 百度云zy、#56 黑料资源）的 HLS 分片
 * 被伪装成 JPEG 图片，实际结构为：
 *   [假 JPEG 头 + 填充 ~263 字节] + [标准 MPEG-TS]
 *
 * 浏览器测速只测下载速度所以显示正常，但 hls.js 的 TS 解析器从第 0 字节
 * 开始找 0x47 同步头，被开头的伪装数据干扰，导致 FRAG_PARSING_ERROR、黑屏。
 *
 * 修复：在 hls.js 自定义 Loader 中拦截分片下载，检测 JPEG 伪装，
 * 定位真正的 TS 同步位置，切掉伪装头，把干净的 TS 交回 hls.js。
 *
 * v3 变更：
 * - 同步定位放宽为两阶段：先用 PAT 严格校验，失败再退回纯同步校验
 *   （部分分片开头 PAT 位置靠后，严格模式会漏检）
 * - 扫描窗口扩大到 64KB，扫描起点提前到 64 字节，兼容更短/更长的伪装头
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

/** 取指定包的 PID */
function getPid(data: Uint8Array, packetOffset: number): number {
  return (
    ((data[packetOffset + 1] & 0x1f) << 8) | data[packetOffset + 2]
  );
}

/**
 * 在数据中定位真正的 TS 包起始位置。
 *
 * 两阶段策略：
 *  阶段一（严格）：连续 N 包 188 对齐同步 + 前 32 包内出现 PAT(PID=0)；
 *  阶段二（宽松）：仅连续 N 包 188 对齐同步。
 *
 * 10 个连续 188 对齐的 0x47 在随机数据中出现的概率可忽略不计，
 * 因此宽松阶段也不会误判伪装区；PAT 校验只是额外保险。
 */
function findTsSync(data: Uint8Array): number {
  const CONFIRM_PACKETS = 10;
  // 从 0 开始扫描：伪装头长度不固定，10 包连续同步 + PAT 校验已足够排除误报；
  // 扫描上限 64KB，覆盖更长的伪装头
  const SCAN_START = 0;
  const SCAN_LIMIT = 64 * 1024;
  const maxOffset = Math.min(
    data.length - TS_PACKET * CONFIRM_PACKETS,
    SCAN_START + SCAN_LIMIT
  );

  // 收集所有通过连续同步校验的候选位置
  const candidates: number[] = [];
  for (let offset = SCAN_START; offset < maxOffset; offset++) {
    if (data[offset] !== TS_SYNC) continue;
    let ok = true;
    for (let k = 1; k < CONFIRM_PACKETS; k++) {
      if (data[offset + k * TS_PACKET] !== TS_SYNC) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push(offset);
  }

  if (candidates.length === 0) return -1;

  // 阶段一：优先返回带 PAT 校验的候选（PAT 出现在前 32 个包内）
  for (const offset of candidates) {
    const checkPackets = Math.min(
      32,
      Math.floor((data.length - offset) / TS_PACKET)
    );
    for (let k = 0; k < checkPackets; k++) {
      if (getPid(data, offset + k * TS_PACKET) === 0x0000) {
        return offset;
      }
    }
  }

  // 阶段二：无 PAT 候选时，取第一个纯同步候选
  return candidates[0];
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
