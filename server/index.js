import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ==== 基础配置 ====
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;  // 在 Render 环境变量里填
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin"; // 简单保护导出接口
const MODEL = process.env.MODEL || "gpt-4o";
const MEMORY_WINDOW = parseInt(process.env.MEMORY_WINDOW || "12", 10); // 最近8–12轮
const GLOBAL_CONCURRENCY = parseInt(process.env.GLOBAL_CONCURRENCY || "5", 10); // 全局并发上限

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ==== 简易内存存储（实验够用；重启会丢）====
const memories = new Map(); // sessionId -> [{role, content, ts}]
const logs = [];            // 结构化日志，便于导出

function getSessionHistory(sessionId) {
  const arr = memories.get(sessionId) || [];
  // 只取最近 N 轮
  return arr.slice(-MEMORY_WINDOW);
}
function appendSessionMessage(sessionId, msg) {
  const arr = memories.get(sessionId) || [];
  arr.push({ ...msg, ts: Date.now() });
  memories.set(sessionId, arr);
}
function logEvent(e) {
  logs.push({ ts: new Date().toISOString(), ...e });
}

// ==== 全局并发信号量 ====
class Semaphore {
  constructor(max) { this.max = max; this.cur = 0; this.q = []; }
  async acquire() {
    if (this.cur < this.max) { this.cur++; return; }
    await new Promise(res => this.q.push(res));
    this.cur++;
  }
  release() {
    this.cur--;
    if (this.q.length) this.q.shift()();
  }
}
const sem = new Semaphore(GLOBAL_CONCURRENCY);

// ==== 每会话串行锁（避免同一会话并发写历史）====
const sessionLocks = new Map(); // sessionId -> lastPromise
async function runInSessionLock(sessionId, fn) {
  const last = sessionLocks.get(sessionId) || Promise.resolve();
  const next = last.then(fn).catch((e) => { throw e; });
  sessionLocks.set(sessionId, next.finally(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  }));
  return next;
}

// ==== 健康检查，避免 Render 判定超时 ====
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// ==== 核心聊天接口 ====
app.post("/chat", async (req, res) => {
  const { sessionId, userMessage } = req.body || {};
  if (!sessionId || !userMessage) {
    return res.status(400).json({ error: "sessionId and userMessage are required" });
  }

  try {
    await runInSessionLock(sessionId, async () => {
      // 记录用户消息
      appendSessionMessage(sessionId, { role: "user", content: String(userMessage) });
    });

    await sem.acquire();
    let answerText = "";
    let usage = null;
    try {
      const history = getSessionHistory(sessionId);

      // 组装提示：系统规则 + 最近N轮 + 当前消息（已在历史中）
      const systemRule = {
        role: "system",
        content:
          "你是小学生Scratch编程课堂小助手，小智。回答短、小学生能懂，聚焦题目本身，不跑题；必要时给关键步骤。",
      };
      const messages = [systemRule, ...history];

      // 调用 OpenAI（控制长度与风格）
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages,
        // 回答风格与长度控制：
        temperature: 0.3,    // 更稳定
        top_p: 0.9,
        max_tokens: 200,     // 控制输出长度
        presence_penalty: 0, // 保守输出
        frequency_penalty: 0.2,
      });
      const choice = resp.choices?.[0];
      answerText = choice?.message?.content?.trim() || "";
      usage = resp.usage;
    } finally {
      sem.release();
    }

    // 记录与落盘内存
    await runInSessionLock(sessionId, async () => {
      appendSessionMessage(sessionId, { role: "assistant", content: answerText });
      logEvent({
        type: "chat",
        sessionId,
        user: userMessage,
        assistant: answerText,
        usage
      });
    });

    res.json({ answer: answerText });
  } catch (err) {
    console.error(err);
    logEvent({ type: "error", sessionId, error: String(err?.message || err) });
    res.status(500).json({ error: "Server error" });
  }
});

// ==== 管理：导出日志（JSONL）====
app.get("/admin/export-logs", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 导出为 JSONL（每行一个事件）
  const body = logs.map(obj => JSON.stringify(obj)).join("\n");
  res.send(body);
});

// ==== 管理：查看活跃会话 ====
app.get("/admin/sessions", (req, res) => {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).send("Unauthorized");
  }
  const list = Array.from(memories.keys());
  res.json({ count: list.length, sessions: list });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
