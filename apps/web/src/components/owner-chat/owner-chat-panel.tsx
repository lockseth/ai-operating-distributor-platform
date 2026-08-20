"use client";

// =============================================================================
// Milestone 2 (fondasi chatbot bisnis Owner) -- Chat UI. Struktur percakapan
// penuh (riwayat, input, kirim) sudah jalan sekarang -- yang belum aktif
// cuma jawaban AI-nya sendiri (Milestone 4, butuh API key provider). Sampai
// saat itu, askOwnerChatAction akan balas dengan pesan "belum aktif" yang
// jelas (lihat chatbot.ts), bukan jawaban karangan.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { useTransition } from "react";
import { Bot, Loader2, Send, User } from "lucide-react";
import { askOwnerChatAction } from "@/lib/owner-chat/actions";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
}

export function OwnerChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function send() {
    const question = input.trim();
    if (!question || isPending) return;

    const history = messages.filter((m) => !m.isError).map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");

    startTransition(async () => {
      const result = await askOwnerChatAction(question, history);
      if (result.ok && result.answer) {
        setMessages((prev) => [...prev, { role: "assistant", content: result.answer! }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.error ?? "Terjadi kesalahan.", isError: true },
        ]);
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-xl border bg-white shadow-sm">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {messages.length === 0 ? (
          <p className="text-sm text-gray-400">
            Belum ada percakapan. Coba tanya, mis. &ldquo;produk apa yang paling laku bulan ini?&rdquo;
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              {m.role === "assistant" && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50">
                  <Bot className="h-4 w-4 text-blue-600" />
                </div>
              )}
              <div
                className={`max-w-[75%] whitespace-pre-wrap rounded-xl px-3.5 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-blue-600 text-white"
                    : m.isError
                      ? "bg-amber-50 text-amber-800"
                      : "bg-gray-100 text-gray-800"
                }`}
              >
                {m.content}
              </div>
              {m.role === "user" && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100">
                  <User className="h-4 w-4 text-gray-500" />
                </div>
              )}
            </div>
          ))
        )}
        {isPending && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sedang berpikir…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="flex items-end gap-2 border-t border-gray-100 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Tanya soal bisnis kamu…"
          disabled={isPending}
          className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
        <button
          onClick={send}
          disabled={isPending || !input.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
