/**
 * 对 answerCriteria 做脱敏，生成前端可展示的方向提示。
 * 规则：去掉引号（单/双）内的具体答案值，保留动作和对象。
 * 若原文无引号包裹的答案，原样返回（本身就是方向）。
 * 示例：
 *   "说出城中暗号'朱雀玄武'" → "提及城中暗号"
 *   '提到老族长的孙子小名"阿福"' → "提及老族长的孙子"
 *   "展示商队信物" → "展示商队信物"（无具体答案，直接显示）
 */
export function desensitizeCriteria(criteria: string[] | null | undefined): string[] {
  if (!criteria?.length) return [];
  return criteria.map((c) => {
    if (!c || !c.trim()) return '关键线索';
    // 去掉引号内的内容（单引号或双引号包裹，要求前后引号类型一致）
    let masked = c.replace(/(["'])[^"']*\1/g, '').trim();
    // 去掉紧贴答案的"名字类"标签词（如小名/大名/名字），保留对象主体
    // 例："老族长的孙子小名'阿福'" 去掉引号后为"老族长的孙子小名"，再去掉"小名"得"老族长的孙子"
    masked = masked.replace(/(小名|大名|名字|名号|绰号)$/, '').trim();
    // 如果去掉引号后变成空或太短，降级为"关键线索"
    if (!masked || masked.length < 2) return '关键线索';
    // 统一前缀：把"说出/提到/告诉"等动词替换为"提及"（更通用的方向词）
    // 但保留"展示/拿出/给"等需要实物的动作
    masked = masked.replace(/^(说出|提到|告诉|提及|透露)/, '提及');
    return masked;
  });
}
