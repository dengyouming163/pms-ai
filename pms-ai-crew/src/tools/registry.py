from typing import Dict, List
from crewai.tools import BaseTool


class ToolRegistry:
    _tools: Dict[str, BaseTool] = {}

    @classmethod
    def register(cls, tool: BaseTool):
        cls._tools[tool.name] = tool

    @classmethod
    def get(cls, name: str) -> BaseTool:
        return cls._tools.get(name)

    @classmethod
    def get_all(cls, names: List[str]) -> List[BaseTool]:
        return [cls._tools[n] for n in names if n in cls._tools]

    @classmethod
    def list_all(cls) -> List[BaseTool]:
        return list(cls._tools.values())
