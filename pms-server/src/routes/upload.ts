import { Hono } from 'hono';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { uploadToOSS } from '../services/aliyun/oss.js';
import { serverError } from '../lib/http-error.js';

const route = new Hono();
const UPLOAD_DIR = join(import.meta.dirname, '..', '..', 'uploads');
const USE_OSS = !!(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET);

async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) await mkdir(UPLOAD_DIR, { recursive: true });
}

route.post('/', async (c) => {
  try {
    await ensureUploadDir();
    const body = await c.req.parseBody();
    const file = body['file'] as File;
    if (!file) return c.json({ success: false, error: '未选择文件' }, 400);

    const imageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
    const audioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/x-m4a', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/flac'];
    const videoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/mov'];
    const docTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const allowedTypes = [...imageTypes, ...audioTypes, ...videoTypes, ...docTypes];
    if (!allowedTypes.includes(file.type)) return c.json({ success: false, error: `不支持的文件格式: ${file.type}` }, 400);

    const isAudio = audioTypes.includes(file.type);
    const isDoc = docTypes.includes(file.type);
    const isVideo = videoTypes.includes(file.type);
    const maxSize = isVideo ? 200 * 1024 * 1024 : isAudio ? 20 * 1024 * 1024 : isDoc ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file.size > maxSize) return c.json({ success: false, error: `文件大小不能超过 ${isVideo ? 200 : isAudio ? 20 : isDoc ? 20 : 5}MB` }, 400);

    const ext = file.name.split('.').pop() || (isVideo ? 'mp4' : isAudio ? 'mp3' : isDoc ? 'pdf' : 'png');
    const prefix = isVideo ? 'video' : isAudio ? 'audio' : isDoc ? 'doc' : 'img';
    const filename = `${prefix}_${Date.now()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    let url: string;
    if (USE_OSS) {
      // 优先使用 OSS
      const mimeType = file.type || (isAudio ? 'audio/mpeg' : 'image/jpeg');
      url = await uploadToOSS(buffer, `pms/${filename}`, mimeType);
    } else {
      // 本地存储兜底
      const filepath = join(UPLOAD_DIR, filename);
      await writeFile(filepath, buffer);
      const baseUrl = process.env.SERVER_BASE_URL || c.req.header('origin') || `http://localhost:${process.env.PORT || 9090}`;
      url = `${baseUrl}/uploads/${filename}`;
    }

    return c.json({ success: true, url, filename });
  } catch (err: any) {
    return serverError(c, err, '上传失败，请重试');
  }
});

export default route;
