# Sub2API Extra — 一键构建加密扩展包

## 用法

```bash
cd protection
npm install        # 首次使用
npm run build      # 构建加密包（~3秒）
```

产出：`protection/dist/extension-protected/`  
在 Chrome 中加载此目录即可使用。

## 它做了什么

1. 复制 `epoint-gpt-autoreg-extension/` 全部文件
2. 对所有 JS 深度混淆：
   - 控制流平坦化
   - 字符串全量 RC4/Base64 加密
   - 死代码注入
   - 标识符重命名

## 日常开发流程

```
修改原始代码 → npm run build → 分发 dist/extension-protected/
```

原始代码不受任何影响，`protection/` 目录可随时删除。

## 目录结构

```
protection/
├── package.json
├── scripts/
│   └── build-protected.js
├── dist/                        # 构建产出（git ignored）
│   └── extension-protected/
└── README.md
```
