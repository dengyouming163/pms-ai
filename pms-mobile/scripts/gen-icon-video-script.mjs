// 生成工作台「短视频脚本」图标 video-script.png（96×96 透明底 + 粉色播放三角）
// 无第三方依赖：仅用 node:zlib 手写 PNG（RGBA）编码，避免在仓库引入绘图库。
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const S = 96
const buf = Buffer.alloc(S * S * 4, 0) // 全透明

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
}

// 水平扫描线填充三角形（无抗锯齿，48px 图标视觉足够）
// 半开区间规则不含底边顶点所在行（如本例 y=74），渲染到 48px 视觉可忽略
function fillTriangle(x1, y1, x2, y2, x3, y3, [r, g, b]) {
  const edges = [[x1, y1, x2, y2], [x2, y2, x3, y3], [x3, y3, x1, y1]]
  for (let y = 0; y < S; y++) {
    const xs = []
    for (const [ax, ay, bx, by] of edges) {
      const cross = (ay <= y && by > y) || (by <= y && ay > y)
      if (!cross || by === ay) continue
      const t = (y - ay) / (by - ay)
      xs.push(ax + t * (bx - ax))
    }
    if (xs.length === 2) {
      xs.sort((p, q) => p - q)
      for (let x = Math.ceil(xs[0]); x <= Math.floor(xs[1]); x++) setPx(x, y, r, g, b)
    }
  }
}

// 右向播放三角：顶点 (34,22)/(34,74)/(74,48)，先淡后主，形成 2px 描边感
fillTriangle(34, 22, 34, 74, 74, 48, [249, 168, 212]) // #F9A8D4 描边
fillTriangle(38, 27, 38, 69, 68, 48, [236, 72, 153])  // #EC4899 主色

// ---- PNG 编码（RGBA/8bit，filter 0）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 6   // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const idat = deflateSync(raw)
const out = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
const target = new URL('../src/static/icon/video-script.png', import.meta.url)
writeFileSync(target, out)
console.log('written', target.pathname, out.length, 'bytes')
