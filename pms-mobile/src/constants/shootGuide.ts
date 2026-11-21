// 通用拍摄规范教学卡（与模板无关，兜底教学）与提交前自检清单
export const SHOOT_GUIDE_SECTIONS: Array<{ title: string; items: string[] }> = [
  { title: '光线', items: ['室内灯全开、白天用自然光', '别用闪光灯、别在阴天拍'] },
  { title: '对焦', items: ['拍前点一下屏幕对焦，对焦完成再拍'] },
  { title: '防抖', items: ['双手持机、手肘靠墙/桌', '站稳、可屏住呼吸', '没云台可用滑板/办公椅辅助「移」镜头'] },
  { title: '运镜四式', items: ['推：从远到近，特写主体', '拉：从近到远，交代环境', '摇：原地转动环视', '移：边走边拍，背景变换；全程匀速'] },
  { title: '画幅与时长', items: ['竖屏拍摄，主体避开抖音标题区', '单个素材 5~10 秒', '单主体、无剪辑、无复杂运镜'] },
]

/** 仅视频素材需自检的条目，图片素材跳过 */
export interface SelfCheckItem { id: string; label: string; videoOnly?: boolean }

/** 提交前自检清单：全部勾选才可提交 */
export const SELF_CHECK_ITEMS: SelfCheckItem[] = [
  { id: 'subject', label: '画面主体突出，只有一个拍摄主体' },
  { id: 'clear', label: '画面清晰，不模糊、不手抖' },
  { id: 'light', label: '光线明亮，不过曝/不过暗/无重滤镜' },
  { id: 'no-mark', label: '无文字/水印/字幕/二维码/联系方式' },
  { id: 'straight', label: '未歪斜（≤45°）、无黑边、无拼接' },
  { id: 'no-edit', label: '无剪辑、无转场、无复杂运镜', videoOnly: true },
  { id: 'duration', label: '时长 5~10 秒', videoOnly: true },
  { id: 'vertical', label: '竖屏拍摄，主体避开抖音标题区', videoOnly: true },
]
