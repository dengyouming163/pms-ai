'use client';

import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface RunFormProps {
  onSubmit: (goal: string) => void;
  running?: boolean;
  disabled?: boolean;
}

/** 预置场景：点击即把目标填入输入框 */
const SCENARIOS = [
  { label: '收益调价', goal: '明天青岩店要不要涨价？' },
  { label: '晨报诊断', goal: '生成今天的经营晨报，并指出需要关注的异常' },
  { label: '住中客服', goal: '住客询问能否延迟退房到 14 点，怎么回复？' },
  { label: '渠道体检', goal: '检查各渠道价差与超时风险' },
];

export function RunForm({ onSubmit, running = false, disabled = false }: RunFormProps) {
  const [goal, setGoal] = useState('');
  const trimmed = goal.trim();
  const canSubmit = trimmed.length > 0 && !running && !disabled;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.label}
            type="button"
            disabled={disabled}
            onClick={() => setGoal(scenario.goal)}
            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scenario.label}
          </button>
        ))}
      </div>

      <Textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="描述你希望 AI 完成的经营任务，例如：明天青岩店要不要涨价？"
        rows={3}
        disabled={disabled || running}
        className="mt-3 resize-none text-sm"
      />

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-slate-400">
          AI 会自主拆解任务、调用工具；涉及调价等敏感动作时会请求人工审批。
        </p>
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-700"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {running ? '运行中…' : '开始运行'}
        </Button>
      </div>
    </div>
  );
}
