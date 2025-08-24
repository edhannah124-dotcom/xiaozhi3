import { useState } from "react";

export default function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    { role: "assistant", content: "你好，我是小智助教～" }
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    if (!input.trim() || loading) return;
    setError("");
    const next = [...messages, { role: "user", content: input }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "请求失败");

      // OpenAI chat completions 结构：choices[0].message.content
      const text =
        data?.choices?.[0]?.message?.content ??
        JSON.stringify(data, null, 2);

      setMessages([...next, { role: "assistant", content: text }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 16, fontFamily: "system-ui" }}>
      <h2 style={{ marginBottom: 12 }}>小智 · 编程课堂助教</h2>

      <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, minHeight: 240 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ margin: "8px 0" }}>
            <b>{m.role === "user" ? "我" : "小智"}</b>：{m.content}
          </div>
        ))}
        {loading && <div style={{ opacity: 0.6 }}>小智正在输入…</div>}
        {error && <div style={{ color: "tomato" }}>错误：{error}</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="输入你的问题，Enter 发送（Shift+Enter 换行）"
          rows={2}
          style={{ flex: 1, padding: 8, borderRadius: 6, border: "1px solid #ddd", resize: "vertical" }}
        />
        <button
          onClick={send}
          disabled={loading}
          style={{ width: 96, borderRadius: 6, border: "1px solid #ddd", background: "#111", color: "#fff" }}
        >
          发送
        </button>
      </div>
    </div>
  );
}
