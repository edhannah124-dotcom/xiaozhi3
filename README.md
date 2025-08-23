# 小智 · 全栈课堂助教（Render 一体化部署）

## 目录
- 根 `package.json`：负责安装/构建/启动
- `server/`：Express 后端，`index.js` 提供 API 与前端静态文件
- `client/`：Vite + React 前端

## Render 设置
- Root Directory：留空
- Build Command：`npm ci && npm run build`
- Start Command：`npm start`
- 环境变量：添加 `OPENAI_API_KEY`

部署后访问 Render 的 URL 即可。
