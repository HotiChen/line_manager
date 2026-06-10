# Backup Information - v1.3.0

## 备份信息
- **版本**: v1.3.0
- **日期**: 2025-12-20
- **备份时间**: 12:36 (GMT+8)

## 本次备份包含的主要更新

### 1. Flow Designer 优化
- 移除缩放时的过多 toast 提示
- 加入 pageInit 函数支持导航整合
- 侧边栏编辑器用于简单节点（文字、URL、Postback、延迟）

### 2. 主选单重组
完全重组为 5 个功能导向分类：
- 系统设定
- 流程设计  
- 互动功能
- 讯息内容
- 客户管理

### 3. Bug 修复
- 重复 UI 元素（imagemap、keyword）
- base64 图片保存
- JavaScript 路径错误
- 事件监听器重复绑定

### 4. 技术改进
- FlowNodeAdapter 适配器
- MessageFactory 工厂模式
- 统一缓存版本号
- 防重复初始化机制

## 重要文件
- `CHANGELOG.md` - 完整版本历史
- `js/flow_designer.js` - Flow Designer 核心
- `js/flow_node_adapter.js` - 节点适配器
- `index.html` - 重组后的主选单

## 已知问题
- Richmenu/Flex/Imagemap/Keyword 编辑器尚未整合到 Flow Designer
- 建议从主选单访问这些功能

## 恢复方法
如需恢复到此版本：
```bash
cp -r frontend_backup_V1.3.0_* frontend_backup_V1.0/
```

## 下一步开发方向
- Flow Designer 节点验证
- Undo/Redo 功能
- 复杂节点整合
- Flow 导出/导入
