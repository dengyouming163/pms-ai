# pms-ai-crew/src/agents/__init__.py
_agents = {}

def get_agent(name: str):
    if name not in _agents:
        if name == "store_manager":
            from src.agents.store_manager import store_manager_agent
            _agents[name] = store_manager_agent
        elif name == "sales_manager":
            from src.agents.sales_manager import sales_manager_agent
            _agents[name] = sales_manager_agent
        elif name == "customer_steward":
            from src.agents.customer_steward import customer_steward_agent
            _agents[name] = customer_steward_agent
        elif name == "ops_manager":
            from src.agents.ops_manager import ops_manager_agent
            _agents[name] = ops_manager_agent
        elif name == "ota_expert":
            from src.agents.ota_expert import ota_expert_agent
            _agents[name] = ota_expert_agent
        elif name == "xhs_expert":
            from src.agents.xhs_expert import xhs_expert_agent
            _agents[name] = xhs_expert_agent
        elif name == "video_expert":
            from src.agents.video_expert import video_expert_agent
            _agents[name] = video_expert_agent
    return _agents[name]

__all__ = ["get_agent"]
