// AI 协作 DIY 会话 / 七步向导落盘 admin API（0079）。
//
// 谁调它：
//   · pms-ai-crew（wenlv_diy_crew）—— 经 X-Internal-Service-Token 读写会话、采纳落盘、读步①锚定；
//   · pms-platform-server（BFF）—— 验签 JWT 后用同一内部 token 转发浏览器请求。
// 鉴权与本目录其它 admin 端点逐字同款：X-Internal-Service-Token === INTERNAL_SERVICE_TOKEN。
//
// 纪律：草案（未采纳）只写 ai_sessions.draftSnapshots；只有 POST /sessions/:id/adopt 的事务
// 落 script_rooms/chapters/scenes/flows/npcs。本文件不调 LLM、不做发布闸判定。
import { Hono } from 'hono';
import { z } from 'zod';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';
import { serverError } from '../../lib/http-error.js';
import {
  AiSessionError,
  createOrResumeAiSession, getAiSession, findActiveAiSession, updateAiSession,
  appendTranscript, saveStageDraft, adoptStageDrafts, buildAnchorContext,
} from '../../services/wenlv/ai-session.js';

const route = new Hono();

route.use('*', async (c, next) => {
  if (c.req.header('X-Internal-Service-Token') !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: '禁止访问：内部服务认证失败' }, 403);
  }
  return next();
});

const stageEnum = z.enum(['intent', 'worldview', 'characters', 'skeleton', 'scenes', 'puzzles', 'publish']);
const statusEnum = z.enum(['active', 'paused', 'completed', 'abandoned']);
// 采纳草案各表项：身份/必填列显式校验，其余玩法字段 passthrough 透传 service 白名单落盘
// （condition/puzzle/atoms 等结构由 ai-crew LenientModel 与发布闸 R1-R10 双重兜底，不在此重复建模）。
const adoptNpcSchema = z.object({
  id: z.string().max(50).optional(),
  name: z.string().min(1, 'NPC 名称不能为空').max(50),
}).passthrough();
const adoptChapterSchema = z.object({
  id: z.string().max(50).optional(),
  title: z.string().min(1, '章节标题不能为空').max(200),
}).passthrough();
const adoptSceneSchema = z.object({
  id: z.string().max(50).optional(),
  chapterId: z.string().min(1, 'chapterId 不能为空').max(50),
  title: z.string().min(1, '场景标题不能为空').max(200),
}).passthrough();
const adoptFlowSchema = z.object({
  id: z.string().max(50).optional(),
  fromSceneId: z.string().min(1, 'fromSceneId 不能为空').max(50),
  toSceneId: z.string().min(1, 'toSceneId 不能为空').max(50),
}).passthrough();

const createSessionSchema = z.object({
  scriptRoomId: z.string().min(1, 'scriptRoomId 不能为空').max(50),
  userId: z.string().min(1, 'userId 不能为空').max(50),
  intent: z.unknown().optional(),
});
const patchSessionSchema = z.object({
  stage: stageEnum.optional(),
  status: statusEnum.optional(),
  intent: z.unknown().optional(),
});
const transcriptSchema = z.object({
  entries: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    stage: stageEnum.nullable().optional(),
    at: z.string().max(40).optional(),
  })).min(1, 'entries 不能为空'),
});
const draftBodySchema = z.object({
  draft: z.unknown(),
  advanceTo: stageEnum.optional(),
});
const adoptSchema = z.object({
  scriptRoomId: z.string().min(1, 'scriptRoomId 不能为空').max(50),
  worldview: z.unknown().optional(),
  npcs: z.array(adoptNpcSchema).optional(),
  chapters: z.array(adoptChapterSchema).optional(),
  scenes: z.array(adoptSceneSchema).optional(),
  flows: z.array(adoptFlowSchema).optional(),
  advanceTo: stageEnum.optional(),
});

/** 统一业务错误出口：AiSessionError 按自带 statusCode 直出安全文案，其余走通用 500。 */
function fail(c: any, e: unknown, fallback: string) {
  if (e instanceof AiSessionError) return c.json({ success: false, error: e.message }, e.status);
  return serverError(c, e, fallback);
}

async function parseBody(c: any) {
  return c.req.json().catch(() => ({}));
}

// POST /sessions → 建会话；同 room+user 已有 active 会话则幂等返回（resumed:true）。
route.post('/sessions', async (c) => {
  const body = await parseBody(c);
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  try {
    const { session, resumed } = await createOrResumeAiSession(parsed.data);
    return c.json({ success: true, data: { session, resumed } });
  } catch (e) {
    return fail(c, e, '创建 AI 会话失败');
  }
});

// GET /sessions/:id → 读会话（中断恢复时前端先持 id 直读）。
route.get('/sessions/:id', async (c) => {
  try {
    const session = await getAiSession(c.req.param('id'));
    if (!session) return c.json({ success: false, error: 'AI 会话不存在' }, 404);
    return c.json({ success: true, data: { session } });
  } catch (e) {
    return fail(c, e, '读取 AI 会话失败');
  }
});

// GET /rooms/:scriptRoomId/active-session?userId= → 按 room+user 恢复活跃会话（无则 404）。
route.get('/rooms/:scriptRoomId/active-session', async (c) => {
  const scriptRoomId = c.req.param('scriptRoomId');
  const userId = c.req.query('userId');
  if (!userId) return c.json({ success: false, error: 'userId 查询参数不能为空' }, 400);
  try {
    const session = await findActiveAiSession(scriptRoomId, userId);
    if (!session) return c.json({ success: false, error: '无活跃 AI 会话' }, 404);
    return c.json({ success: true, data: { session } });
  } catch (e) {
    return fail(c, e, '读取 AI 会话失败');
  }
});

// PATCH /sessions/:id → 推进 stage / 暂停恢复 / 置终态 / 改 intent。
route.patch('/sessions/:id', async (c) => {
  const body = await parseBody(c);
  const parsed = patchSessionSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  try {
    const session = await updateAiSession(c.req.param('id'), parsed.data);
    if (!session) return c.json({ success: false, error: 'AI 会话不存在' }, 404);
    return c.json({ success: true, data: { session } });
  } catch (e) {
    return fail(c, e, '更新 AI 会话失败');
  }
});

// POST /sessions/:id/transcript → 追加对话记录（仅 active）。
route.post('/sessions/:id/transcript', async (c) => {
  const body = await parseBody(c);
  const parsed = transcriptSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  try {
    const session = await appendTranscript(c.req.param('id'), parsed.data.entries);
    return c.json({ success: true, data: { transcriptLength: session.transcript.length } });
  } catch (e) {
    return fail(c, e, '追加对话记录失败');
  }
});

// PUT /sessions/:id/drafts/:stage → 存某步草案（换版覆盖该 stage 键），可选推进 stage；四表不写。
route.put('/sessions/:id/drafts/:stage', async (c) => {
  const stageParsed = stageEnum.safeParse(c.req.param('stage'));
  if (!stageParsed.success) return c.json({ success: false, error: '非法 stage' }, 400);
  const body = await parseBody(c);
  const parsed = draftBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  try {
    const session = await saveStageDraft(
      c.req.param('id'), stageParsed.data, parsed.data.draft, parsed.data.advanceTo,
    );
    return c.json({ success: true, data: { stage: session.stage, stages: Object.keys(session.draftSnapshots ?? {}) } });
  } catch (e) {
    return fail(c, e, '保存草案失败');
  }
});

// POST /sessions/:id/adopt → 采纳落盘事务：worldview/npcs/chapters/scenes/flows 按 id upsert。
route.post('/sessions/:id/adopt', async (c) => {
  const body = await parseBody(c);
  const parsed = adoptSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  try {
    const result = await adoptStageDrafts(
      c.req.param('id'),
      parsed.data.scriptRoomId,
      {
        worldview: parsed.data.worldview,
        npcs: parsed.data.npcs as any,
        chapters: parsed.data.chapters as any,
        scenes: parsed.data.scenes as any,
        flows: parsed.data.flows as any,
      },
      parsed.data.advanceTo,
    );
    return c.json({ success: true, data: { adopted: result } });
  } catch (e) {
    return fail(c, e, '采纳落盘失败');
  }
});

// GET /rooms/:id/anchor-context → 步①意图反向锚定：场地能力档案 + 商户配置 + 可绑点位。
route.get('/rooms/:id/anchor-context', async (c) => {
  try {
    const context = await buildAnchorContext(c.req.param('id'));
    return c.json({ success: true, data: context });
  } catch (e) {
    return fail(c, e, '读取锚定上下文失败');
  }
});

// 健康探针（内部 token 校验生效性测试用）。
route.get('/ping', async (c) => c.json({ success: true, data: { ok: true } }));

// 兜底：未匹配路由不落 404 HTML，回统一 JSON（ai-crew 客户端按 JSON 解析）。
route.all('*', async (c) => c.json({ success: false, error: 'Not Found' }, 404));

export default route;
