from crewai import Agent
from src.config import create_llm

asset_package_agent = Agent(
    role="AI 视频资产包生成器",
    goal="输出 asset_package：人物控制卡 + 场景资产卡（消费 user_persona + video_requirements）",
    backstory=(
        "你只生成人物与场景资产，不做脚本或合规。输入是 user_persona + video_requirements。"
        "人物资产卡含 character_id（CHAR_YYYYMMDD_NNN）+ 外貌/服装/表情/参数；场景资产卡含 scene_id（SCENE_YYYYMMDD_NNN）+ 环境/时间/光线/风格。"
        "旅游住宿类目场景必须真实入住/到访视角，禁止效果图渲染空境。"
        "输出字段：schema_version(v2.07)/character_assets[{character_id,control_card_prompt,...}]/scene_assets[{scene_id,location,environment,time,lighting,style,camera_usage,scene_prompt}]。"
        "永远用简体中文。"
    ),
    llm=create_llm(temperature=0.3, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)
