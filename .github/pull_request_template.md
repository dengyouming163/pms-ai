## 变更说明

<!-- 一句话说明改了什么，以及为什么改 -->

## 变更类型

- [ ] feat：新功能
- [ ] fix：缺陷修复
- [ ] refactor：重构（不改变外部行为）
- [ ] docs：文档
- [ ] test：测试或评测
- [ ] chore：构建、依赖或工具链

## 验证方式

<!-- 贴出实际执行的命令与结果，不要只写「已测试」 -->

```powershell
# 示例
cd pms-agent; .\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m eval.run_eval --suite revenue
```

## 关联 Issue

<!-- Closes #123 -->

## 检查清单

- [ ] 改动聚焦，未夹带无关重构
- [ ] 已补充或更新测试 / 评测用例
- [ ] 涉及接口、审批或部署的改动已同步文档
- [ ] 未提交 `.env`、密钥、证书或真实用户数据
- [ ] UI 变更已附截图
- [ ] 破坏性变更已在描述中明确标注
