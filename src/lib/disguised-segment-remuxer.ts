/**
 * 伪装分片修复器（v4）
 *
 * 部分视频源（如 #1 爱奇艺、#27 百度云zy、#56 黑料资源）的 HLS 分片
 * 被伪装成图片，实际结构为：
 *   [假图片头 + 填充] + [标准 MPEG-TS]
 * 伪装头格式会变：v3 时期是 JPEG（FF D8），2026-09-26 起 #1 切到 PNG
 * （89 50 4E 47…IEND，共 181 字节），m3u8 里分片后缀也是 .png。
 *
 * 浏览器测速只测下载速度所以显示正常，但 hls.js 的 TS 解析器从第 0 字节
 * 开始找 0x47 同步头，被开头的伪装数据干扰，导致 FRAG_PARSING_ERROR、黑屏。
 *
 * 修复：在 hls.js 自定义 Loader 中拦截分片下载，检测伪装，
 * 定位真正的 TS 同步位置，切掉伪装头，把干净的 TS 交回 hls.js。
 *
 * v4 变更（相对 v3）：
 * - 不再只认 JPEG 头：只要分片不是标准 TS（首字节 0x47）也不是 fMP4，
 *   就视为"疑似伪装"并扫描 TS 同步。JPEG / PNG / GIF / 未来新伪装通用。
 * - fMP4（box 类型 ftyp/moov/moof/styp/sidx）明确排除，避免误伤。
 * - 真正的安全网是 findTsSync：10 个连续 188 对齐的 0x47 + PAT 校验，
 *   在随机数据中误报概率可忽略；找不到则抛错，调用方 catch 后走原流程。
 */

const TS_PACKET = 188;
const TS_SYNC = 0x47;

/** fMP4 box 类型：分片若是 fMP4 绝不能动 */
function isFmp4(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const box = String.fromCharCode(data[4], data[5], data[6], data[7]);
  return (
    box === 'ftyp' ||
    box === 'moov' ||
    box === 'moof' ||
    box === 'styp' ||
    box === 'sidx'
  );
}

/**
 * 是否为疑似伪装分片：
 * - 首字节 0x47 → 标准 TS，直接放行（最快路径）
 * - fMP4 → 放行
 * - 其余（JPEG SOI / PNG 签名 / 其他）→ 视为疑似伪装，交给扫描确认
 */
export function isDisguisedSegment(data: Uint8Array): boolean {
  if (data.length <= TS_PACKET * 2) return false;
  if (data[0] === TS_SYNC) return false;
  if (isFmp4(data)) return false;
  return true;
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
 * 因此即使对非图片数据做扫描也不会误判；PAT 校验只是额外保险。
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
 *          若疑似伪装但找不到 TS 同步则抛出错误（由调用方捕获并降级，
 *          原始数据原样交回，不引入新错误）
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
