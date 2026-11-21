/**
 * ⚠️ DEPRECATED — 本文件中的 /tts 和 /clone 端点为早期原型存根，
 * 不执行实际 AI 处理，仅记录请求日志。
 *
 * 实际 TTS 功能请使用:
 *   - POST /api/voice/tts       语音合成（百炼 API）
 *   - POST /api/voice/create    声音复刻（百炼 API）
 *
 * 实际视频合成请使用:
 *   - POST /api/video/fastcut   图文快剪（阿里云 ICE）
 *   - POST /api/video/digital-human  数字人口播（阿里云 VideoRetalk）
 */
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiAiChatHistory } from '../db/schema/index.js';

const route = new Hono();

// POST /api/video/tts — ⚠️ DEPRECATED 存根，仅用于日志记录
route.post('/tts', async (c) => {
  try {
    const body = await c.req.json();
    const { text, voice, mode: ttsMode } = body as { text: string; voice: string; mode: string };

    if (!text || text.trim().length === 0) {
      return c.json({ success: false, error: '文字内容不能为空' }, 400);
    }

    // 记录 TTS 请求到 AI 对话历史
    const durationMs = Math.round(text.length * 250); // 估算：约 250ms/字
    await db.insert(pmsBuiAiChatHistory).values({
      id: `tts_${Date.now()}`,
      merchantId: 'default',
      storeId: c.req.header('X-Store-Id') || 'default_store',
      userId: c.req.header('X-User-Id') || 'anonymous',
      sessionId: `tts_session_${Date.now()}`,
      role: 'assistant',
      content: JSON.stringify({
        type: 'tts',
        voice,
        mode: ttsMode,
        textLength: text.length,
        estimatedDurationMs: durationMs,
        timestamp: new Date().toISOString(),
      }),
      agentsInvolved: ['tts_engine'],
    } as any);

    return c.json({
      success: true,
      data: {
        textLength: text.length,
        estimatedDuration: `${Math.round(durationMs / 1000)}秒`,
        voice,
        mode: ttsMode,
        supportedVoices: [
          { key: 'warm_female', name: '温柔女声 (Xiaoxiao)', lang: 'zh-CN' },
          { key: 'lively_male', name: '活泼男声 (Yunyang)', lang: 'zh-CN' },
          { key: 'calm_female', name: '知性女声 (Xiaoyi)', lang: 'zh-CN' },
          { key: 'friendly_male', name: '亲和男声 (Yunxi)', lang: 'zh-CN' },
        ],
        note: '客户端使用浏览器 Web Speech API 进行语音合成播放。服务端 TTS 引擎（Volcengine/Edge-TTS）预留接入。',
      },
    });
  } catch (err) {
    console.error('[video/tts] 处理失败:', err);
    return c.json({ success: false, error: 'TTS 处理失败' }, 500);
  }
});

// POST /api/video/clone — ⚠️ DEPRECATED 存根，仅用于日志记录
route.post('/clone', async (c) => {
  try {
    const body = await c.req.json();
    const { text, sample_url, mode: cloneMode } = body as { text: string; sample_url: string; mode: string };

    if (!text || text.trim().length === 0) {
      return c.json({ success: false, error: '文字内容不能为空' }, 400);
    }

    // 记录声音复刻请求
    await db.insert(pmsBuiAiChatHistory).values({
      id: `clone_${Date.now()}`,
      merchantId: 'default',
      storeId: c.req.header('X-Store-Id') || 'default_store',
      userId: c.req.header('X-User-Id') || 'anonymous',
      sessionId: `clone_session_${Date.now()}`,
      role: 'assistant',
      content: JSON.stringify({
        type: 'voice_clone',
        mode: cloneMode,
        hasSample: !!sample_url,
        textLength: text.length,
        timestamp: new Date().toISOString(),
      }),
      agentsInvolved: ['voice_clone_engine'],
    } as any);

    return c.json({
      success: true,
      data: {
        textLength: text.length,
        hasVoiceSample: !!sample_url,
        supportedFeatures: [
          '浏览器语音合成播放（当前）',
          '声音样本上传（已支持）',
          'AI 声音复刻（预留：HeyGen/D-ID API）',
          '数字人口播视频生成（预留）',
        ],
        note: sample_url
          ? `声音样本已接收 (${sample_url.slice(0, 50)}...)，声音复刻引擎接入中`
          : '请先上传 30 秒声音样本。客户端使用浏览器语音合成播放。',
      },
    });
  } catch (err) {
    console.error('[video/clone] 处理失败:', err);
    return c.json({ success: false, error: '声音复刻处理失败' }, 500);
  }
});

// GET /api/video/status?id=xxx — 查询视频任务进度
route.get('/status', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ success: false, error: '缺少 id' }, 400);

  // Drizzle 的 db.execute 仅接受单个 sql 模板对象（禁 raw SQL 约定）；参数用 sql.param 占位防注入
  const result = await db.execute(
    sql`SELECT id, status, output_url, error_message FROM pms_bui_video_tasks WHERE id = ${id}`
  );
  const task = ((result as any).rows || [])[0];
  if (!task) return c.json({ success: false, data: null });

  return c.json({
    success: true,
    data: {
      id: task.id,
      status: task.status || 'processing',
      outputUrl: task.output_url || null,
      error: task.error_message || null,
    },
  });
});

export default route;
