import React, { useState } from "react";

export default function App() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  const ask = async () => {
    setAnswer("思考中…");
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: question || "打个招呼" }]
      })
    });
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || JSON.stringify(data);
    setAnswer(content);
  };

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>小智 · 全栈课堂助教</h1>
      <p style={{ color: "#666" }}>前后端一体：Express 提供 API，Vite 构建前端并由后端托管。</p>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1, padding: 8 }}
          placeholder="问点什么…"
          value={question}
          onChange={e => setQuestion(e.target.value)}
        />
        <button onClick={ask}>发送</button>
      </div>

      <pre style={{ whiteSpace: "pre-wrap", background: "#f6f8fa", padding: 12, marginTop: 16 }}>
        {answer || "回复会显示在这里"}
      </pre>
    </div>
  );
}
