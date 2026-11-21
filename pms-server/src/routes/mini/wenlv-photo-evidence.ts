/**
 * P3-C Task 3：拍照取证路由。
 *
 * 设计：玩家在节点现场拍照，后端调视觉 LLM（复用 asset-gen 的 callLlmVision + reviewModel）
 * 比对节点预期线索，返回 { matched, elements, hint }。
 * 玩家据此知道"拍对了/再试一次"，让实景与数字线索融合。
 *
 * 路由挂载：/api/mini/wenlv/photo-evidence（必须在 /api/mini/wenlv 之前注册，避免被 /:id 吞掉）。
 * 鉴权：parseMiniToken（与 /dialogue、/trigger 同款）。
 */
import { Hono } from 'hono';
// 0079：节点 = 非 ending 场景投影（nodeId=scene.id），由规范图装配，不再读旧 nodes 表。
import { loadRuntimeGraph } from '../../services/wenlv/script-room.js';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { callLlmVision } from '../../services/wenlv-asset-gen-scheduler.js';

const route = new Hono();

/**
 * POST /api/mini/wenlv/photo-evidence
 * Body: { productId, nodeId, imageData }
 *   - imageData: base64 字符串（不带 data: 前缀，后端补齐）
 * 返回：{ success: true, data: { matched, elements, hint } }
 *
 * 失败安全降级：LLM 不可用时返回 matched=false + 兜底提示，不阻断玩家拍照体验。
 */
route.post('/', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const body = await c.req.json().catch(() => ({}));
  const { productId, nodeId, imageData } = body as {
    productId?: string; nodeId?: string; imageData?: string;
  };
  if (!productId || !nodeId) return c.json({ success: false, error: '缺少 productId 或 nodeId' }, 400);
  if (!imageData) return c.json({ success: false, error: '缺少图片数据' }, 400);

  // 查节点（场景投影），取预期线索（storyText 作为场景描述供 LLM 比对）
  const runtime = await loadRuntimeGraph(productId);
  const node = runtime.nodes.find((n) => n.id === nodeId);
  if (!node) return c.json({ success: false, error: '节点不存在' }, 404);

  // 拼装 data URL（DashScope 兼容模式支持 data:image/jpeg;base64,...）
  // 兼容前端可能传带前缀或不带前缀的 base64
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const expectedClue = (node.storyText || '场景中的关键元素').slice(0, 200);
  const systemPrompt = [
    '你是叙事裁判。玩家拍了一张现场照片，请分析照片中是否包含与节点线索相关的元素。',
    '只返回 JSON，不要带任何解释或代码块标记。',
    '格式：{"matched": true/false, "elements": ["识别到的元素1", "元素2"], "hint": "给玩家的提示（若未匹配）"}',
  ].join('\n');
  const userPrompt = `节点预期线索：${expectedClue}\n\n请分析这张照片是否包含相关元素。`;

  try {
    const result = await callLlmVision(systemPrompt, userPrompt, [dataUrl]);
    // 解析 LLM 返回的 JSON
    let parsed: { matched?: boolean; elements?: string[]; hint?: string } = { matched: false, elements: [], hint: '未能识别，请重试' };
    try {
      // 兼容 LLM 可能返回带 ```json 代码块的情况
      const cleaned = result.text.replace(/^```json\s*|\s*```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // 解析失败，返回降级结果
      return c.json({
        success: true,
        data: {
          matched: false,
          elements: [],
          hint: '识别服务异常，请重试',
        },
      });
    }
    return c.json({
      success: true,
      data: {
        matched: !!parsed.matched,
        elements: Array.isArray(parsed.elements) ? parsed.elements : [],
        hint: parsed.hint || (parsed.matched ? '线索已印证' : '未找到相关元素，换个角度试试'),
      },
    });
  } catch (e: any) {
    // LLM 调用失败：降级返回，不阻断玩家体验
    return c.json({
      success: true,
      data: {
        matched: false,
        elements: [],
        hint: `识别服务暂时不可用：${e?.message || '未知错误'}`,
      },
    });
  }
});

export default route;
