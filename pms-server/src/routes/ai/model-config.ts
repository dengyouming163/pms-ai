import { Hono } from 'hono';
import { AGENT_API_URL } from '../../constants.js';

/**
 * 模型配置代理 — 转发到 pms-agent 的 /model/* 端点
 * 支持运行时热切换 LLM 模型（DeepSeek ↔ 千问等）
 */

const modelConfig = new Hono();

// GET / — 查询当前模型和可用预设
modelConfig.get('/', async (c) => {
  try {
    const res = await fetch(`${AGENT_API_URL}/model`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`AI 服务错误: ${res.status}`);
    return c.json(await res.json());
  } catch (err: any) {
    return c.json({ success: false, error: '模型配置服务暂不可用' }, 502);
  }
});

// POST /switch — 切换模型预设
modelConfig.post('/switch', async (c) => {
  try {
    const body = await c.req.json();
    const res = await fetch(`${AGENT_API_URL}/model/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`AI 服务错误: ${res.status}`);
    return c.json(await res.json());
  } catch (err: any) {
    return c.json({ success: false, error: '模型切换服务暂不可用' }, 502);
  }
});

export default modelConfig;
