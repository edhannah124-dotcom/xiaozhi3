// server/index.js  (CommonJS)
const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// 1) 健康检查路由 —— 放在最前面，确保一定能命中
app.get("/__ping", (req, res) => res.send("pong"));

// 2) 示例 API：转发到 OpenAI
app.post("/api/ask", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const messages = req.body?.messages || [{ role: "user", content: "Hello" }];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages
      })
    });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// 3) 托管前端静态文件（必须指向 client/dist）
const distPath = path.join(__dirname, "../client/dist");
if (!fs.existsSync(distPath)) {
  console.warn("[warn] client/dist 不存在，可能是构建没跑成功。Build Command 需要产出 dist。");
}
app.use(express.static(distPath));

// 4) 非 API 路由全部回前端入口
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// 5) 启动服务（绑定 Render 指定端口）
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
