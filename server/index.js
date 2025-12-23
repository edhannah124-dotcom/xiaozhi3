import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import express from "express";
import cors from "cors";
import OpenAI from "openai";

// ==== 基础配置 ====
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;  // 在 Render 环境变量里填
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin"; // 简单保护导出接口
const MODEL = process.env.MODEL || "gpt-4o";
const MEMORY_WINDOW = parseInt(process.env.MEMORY_WINDOW || "12", 10); // 最近8–12轮
const GLOBAL_CONCURRENCY = parseInt(process.env.GLOBAL_CONCURRENCY ?? 10, 10); // 全局并发上限
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || "100", 10); // 允许排队的最大请求数

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
// ---- 并发限流（放在 /chat 之前）----
class Semaphore {
  constructor(max, maxQueue) {
    this.max = Math.max(1, max);
    this.cur = 0;
    this.q = [];
    this.maxQueue = Math.max(0, maxQueue);
  }

  snapshot() {
    return {
      inFlight: this.cur,
      queued: this.q.length,
      max: this.max,
      maxQueue: this.maxQueue,
    };
  }

  async acquire() {
    // 如果还有余量，直接进入
    if (this.cur < this.max) {
      this.cur++;
      return;
    }

    // 队列已满，直接拒绝
    if (this.q.length >= this.maxQueue) {
      const err = new Error("Server busy: queue is full");
      err.code = "QUEUE_FULL";
      throw err;
    }

    // 加入等待队列
    await new Promise((resolve) => this.q.push(resolve));
    this.cur++;
  }

  release() {
    if (this.cur > 0) this.cur--;
    // 叫醒队列中的下一个
    const next = this.q.shift();
    if (next) next();
  }
}

const sem = new Semaphore(GLOBAL_CONCURRENCY, MAX_QUEUE);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// 计算 __dirname（ESM）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 指向你的前端目录（如果你用打包产物，就把 client 改成 client/dist）
const clientDir = path.resolve(__dirname, "../client");

// 如果有 client/index.html，就把它当首页；否则给个友好提示
if (fs.existsSync(path.join(clientDir, "index.html"))) {
  app.use(express.static(clientDir));
  app.get("/", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.status(200).send("Backend OK. Use /healthz or POST /chat")
  );
}


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
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function callOpenAIWithRetry(payload, retries = 3) {
  let delay = 400; // 初始退避
  for (let i = 0; i <= retries; i++) {
    try {
      return await client.chat.completions.create(payload);
    } catch (e) {
      const status = e?.status || e?.response?.status;
      // 限速/服务端错误 → 退避重试；其它错误直接抛出
      if ((status === 429 || (status >= 500 && status < 600)) && i < retries) {
        await sleep(delay + Math.floor(Math.random() * 200));
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
}

function errInfo(e) {
  const status = e?.status || e?.response?.status;
  const data = e?.response?.data;
  return {
    status,
    message: e?.message,
    code: data?.error?.code || e?.code,
    type: data?.error?.type,
    details: data?.error?.message || undefined,
  };
}


// ==== 核心聊天接口 ====
app.post("/chat", async (req, res) => {
  const { sessionId, userMessage } = req.body || {};
  if (!sessionId || !userMessage) {
    return res.status(400).json({ error: "sessionId and userMessage are required" });
  }

  let acquired = false;
  try {
    await sem.acquire();
    acquired = true;

    await runInSessionLock(sessionId, async () => {
      // 记录用户消息
      appendSessionMessage(sessionId, { role: "user", content: String(userMessage) });
    });

    let answerText = "";
    let usage = null;
    const history = getSessionHistory(sessionId);

    // 组装提示：系统规则 + 最近N轮 + 当前消息（已在历史中）
    const systemRule = {
      role: "system",
      content: `你是一名小学Scratch 编程课堂的小助手，名字叫做小智。你的身份和任务是：协助教师，解答学生在课堂上的编程问题。
总要求：语言用小学三年级能懂的词汇，每句话尽量短。内容只谈 Scratch 课堂相关。不给不适宜未成年人的内容。不要写长篇讲道理。

在回答学生问题时，你需要在语言中自然体现计算思维过程，但不要使用生硬的结构标签。回答时可以按以下思路组织，但要用聊天式表达：

先用一句话和学生一起确认问题，例如“你是想做一个会自己数数的计时器，对吗？”
接着用引导式语言说明目标，例如“那我们要做的事情其实只有一件：让数字每秒变大一次。”
然后通过提问或提示帮助学生拆解问题，例如“那要不要先想一想，时间要不要存起来？存在哪里比较好？”
再用简短的话点出关键规律或方法，例如“在 Scratch 里，这种一直重复做的事情，通常会用到循环。”
最后给出清晰、可操作的步骤说明，并在结尾用一句轻松的话提醒学生如何检查效果。

风格：语气要亲切、有陪伴感，像在一起思考，而不是在讲说明书。可以适度使用“我们”“一起想想”“试试看”这样的表达，但不要闲聊，也不要偏离任务。`
    };

    const messages = [systemRule, ...history];

    // 调用 OpenAI（控制长度与风格）
    const resp = await callOpenAIWithRetry({
      model: MODEL,
      messages,
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 600,
      presence_penalty: 0,
      frequency_penalty: 0.2,
    });

    const choice = resp.choices?.[0];
    answerText = choice?.message?.content?.trim() || "";
    usage = resp.usage;

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
    if (err?.code === "QUEUE_FULL") {
      const payload = { error: "Server busy, please retry later" };
      const snapshot = sem.snapshot();
      logEvent({ type: "queue_full", sessionId, ...snapshot });
      return res.status(503).json(payload);
    }

    const info = errInfo(err);
    console.error("Chat error:", info, err?.stack);
    logEvent({ type: "error", sessionId, ...info });

    const payload = { error: "Server error" };
    if (process.env.DEBUG_ERRORS === "1") payload.debug = info; // 只有打开 DEBUG_ERRORS 才返回详细信息
    res.status(500).json(payload);
  } finally {
    if (acquired) sem.release();
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
