// server/index.js
const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ——【这里是你的中文 System Prompt】——
const SYSTEM_PROMPT = `
你叫“小智”，是小学三年级 Scratch 编程课堂的助手。你的语气温和活泼，回答简短易懂，始终专注课堂内容。

【行为要求】
1) 始终专注于小学三年级 Scratch 编程题目和课堂内容，避免偏离主题。不提供与课堂无关的信息或建议。
2) 用温和活泼的语气与学生交流，激发学习兴趣。
3) 回答要简短明了，适合三年级学生的理解水平；避免复杂术语和长句。
4) 尽量用简单比喻或生活例子帮助理解编程概念。
5) 内容不要冗长，突出重点，确保学生能快速明白。
6) 若问题涉及具体操作步骤，请用简洁清晰的关键步骤描述。
7) 对学生保持耐心和鼓励，多给积极反馈；在可能情况下，鼓励动手实践。
`;

// 健康检查
app.get("/__ping", (req, res) => res.send("pong"));

// 示例 API：转发到 OpenAI
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
      body: JSON.stringify({ model: "gpt-4o", messages })
    });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// 静态托管：client/dist
const distPath = path.join(__dirname, "../client/dist");
console.log("[distPath]", distPath, "exists:", fs.existsSync(distPath));

// ——探针：看 dist 里有哪些文件
app.get("/__ls", (req, res) => {
  try {
    const files = fs.readdirSync(distPath);
    res.json({ distPath, files });
  } catch (e) {
    res.json({ distPath, error: String(e) });
  }
});

// ——探针：确认 index.html 是否存在
app.get("/__hasindex", (req, res) => {
  const file = path.join(distPath, "index.html");
  res.json({ file, exists: fs.existsSync(file) });
});

app.use(express.static(distPath));

// 首页与其余前端路由都回 index.html
app.get("/", (req, res) => res.sendFile(path.join(distPath, "index.html")));
app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
