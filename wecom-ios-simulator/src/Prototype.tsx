import {
  ChatBubbleIcon, ChevronLeftIcon, CopyIcon, Cross2Icon, DotsVerticalIcon, FaceIcon,
  FileIcon, ImageIcon, MagnifyingGlassIcon, PlusIcon, ResetIcon,
  TrashIcon, VideoIcon,
} from "@radix-ui/react-icons";
import { Phone } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { BottomSheet, KeyboardInput, MobileScroll, useKeyboard, useKeyboardInsets } from "./mobile";

type Role = "assistant" | "user";
type ChatMessage = { id: string; role: Role; text: string; failed?: boolean };
type Panel = "emoji" | "plus" | null;
type ChatArchive = { id: string; createdAt: string; messages: ChatMessage[] };

const emojis = ["😀", "😄", "🥰", "😋", "🤔", "👍", "👏", "💪", "🥗", "🍚", "🍎", "☕"];
const DEVICE_ID_STORAGE_KEY = "dietSecretary.deviceId";
const ARCHIVE_STORAGE_KEY = "wecomIosSimulator.archives";
const REPLY_GAP_MS = 2500;

function getTestIdentity() {
  const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  return id;
}

function loadArchives(): ChatArchive[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ARCHIVE_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function Prototype() {
  const keyboard = useKeyboard();
  const { bottomInset } = useKeyboardInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null);
  const [toast, setToast] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [archiveCount, setArchiveCount] = useState(() => loadArchives().length);
  const longPress = useRef<number | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const conversationEpoch = useRef(0);
  const composerBottom = panel ? 280 : bottomInset;
  const rootStyle = useMemo(() => ({ "--composer-bottom": `${composerBottom}px` }) as CSSProperties, [composerBottom]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      messagesEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, waiting]);

  const togglePanel = (next: Exclude<Panel, null>) => {
    keyboard.hide();
    setPanel((current) => current === next ? null : next);
  };

  const send = async (retryText?: string) => {
    const text = (retryText ?? input).trim();
    if (!text || waiting) return;
    const epoch = conversationEpoch.current;
    setInput(""); setPanel(null); keyboard.hide();
    setMessages((current) => [...current.filter((item) => !item.failed), { id: crypto.randomUUID(), role: "user", text }]);
    setWaiting(true);
    try {
        const response = await fetch("http://localhost:3001/api/chat-langgraph", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, deviceId: getTestIdentity(), ...(threadId ? { threadId } : {}) }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (epoch !== conversationEpoch.current) return;
        if (typeof data.threadId === "string") setThreadId(data.threadId);
        const replies = Array.isArray(data.replies) && data.replies.length ? data.replies : [data.reply];
        const visibleReplies = replies.filter(Boolean);
        for (let index = 0; index < visibleReplies.length; index += 1) {
          if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, REPLY_GAP_MS));
          if (epoch !== conversationEpoch.current) return;
          setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: visibleReplies[index] }]);
        }
    } catch {
      if (epoch === conversationEpoch.current) {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", text: `连接模型失败，点这里重试：${text}`, failed: true }]);
      }
    } finally {
      if (epoch === conversationEpoch.current) setWaiting(false);
    }
  };

  const archiveCurrentConversation = () => {
    const completed = messages.filter((message) => !message.failed);
    if (!completed.length) return;
    const archives = loadArchives();
    archives.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), messages: completed });
    localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(archives));
    setArchiveCount(archives.length);
  };

  const clearConversation = (replaceIdentity: boolean) => {
    archiveCurrentConversation();
    conversationEpoch.current += 1;
    if (replaceIdentity) localStorage.setItem(DEVICE_ID_STORAGE_KEY, crypto.randomUUID());
    setThreadId(null); setMessages([]); setWaiting(false); setInput("");
    setSheetOpen(false);
    setToast(replaceIdentity ? "已创建全新测试用户" : "已存档并新建对话");
  };
  const startPress = (event: PointerEvent, message: ChatMessage) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    longPress.current = window.setTimeout(() => setMenuMessage(message), 420);
  };
  const endPress = () => { if (longPress.current) window.clearTimeout(longPress.current); longPress.current = null; };

  return (
    <main className="wecom-root" style={rootStyle} aria-label="AI 饮食秘书企业微信聊天模拟器">
      <header className="chat-nav">
        <button className="nav-button nav-back" aria-label="返回"><ChevronLeftIcon /></button>
        <h1>AI 饮食秘书</h1>
        <div className="nav-actions">
          <button className="nav-button" aria-label="语音通话" onClick={() => setToast("语音通话仅作界面模拟")}><Phone weight="regular" /></button>
          <button className="nav-button" aria-label="聊天信息" onClick={() => setSheetOpen(true)}><DotsVerticalIcon /></button>
        </div>
      </header>

      <MobileScroll className="wecom-chat-scroll">
        <section className="message-list" aria-live="polite">
          {messages.map((message) => (
            <article className={`message-row ${message.role}`} key={message.id}>
              {message.role === "assistant" ? <img className="avatar" src="/assets/avatars/ai-diet-secretary.png" alt="AI 饮食秘书" /> : null}
              <button className={`bubble ${message.failed ? "failed" : ""}`} onPointerDown={(event) => startPress(event, message)} onPointerUp={endPress} onPointerCancel={endPress} onPointerLeave={endPress} onClick={() => message.failed && send(message.text.replace(/^连接模型失败，点这里重试：/, ""))}>{message.text}</button>
              {message.role === "user" ? <img className="avatar" src="/assets/avatars/test-user.png" alt="测试用户" /> : null}
            </article>
          ))}
          {waiting ? <article className="message-row assistant"><img className="avatar" src="/assets/avatars/ai-diet-secretary.png" alt="AI 饮食秘书" /><div className="bubble typing" aria-label="对方正在输入"><i /><i /><i /></div></article> : null}
          <div className="scroll-spacer" ref={messagesEnd} />
        </section>
      </MobileScroll>

      <footer className="composer" style={{ bottom: composerBottom }}>
        <button className="composer-icon voice" aria-label="按住说话" onClick={() => setToast("已切换到语音输入")}><span className="voice-ring"><span /></span></button>
        <KeyboardInput value={input} onChange={(event) => setInput(event.target.value)} onFocus={() => setPanel(null)} onKeyDown={(event) => { if (event.key === "Enter") void send(); }} placeholder="请输入" aria-label="消息" />
        {input.trim() ? <button className="send-button" onClick={() => void send()}>发送</button> : <><button className="composer-icon" aria-label="表情" onClick={() => togglePanel("emoji")}><FaceIcon /></button><button className="composer-icon" aria-label="更多" onClick={() => togglePanel("plus")}><PlusIcon /></button></>}
      </footer>

      {panel ? <section className={`utility-panel ${panel}`} style={{ bottom: 34 }} aria-label={panel === "emoji" ? "表情面板" : "更多功能面板"}>
        {panel === "emoji" ? <div className="emoji-grid">{emojis.map((emoji) => <button key={emoji} onClick={() => setInput((value) => value + emoji)}>{emoji}</button>)}</div> : <div className="plus-grid">
          <button onClick={() => setToast("图片选择器仅作模拟")}><span><ImageIcon /></span>相册</button><button onClick={() => setToast("相机仅作模拟")}><span><VideoIcon /></span>拍摄</button><button onClick={() => setToast("文件选择器仅作模拟")}><span><FileIcon /></span>文件</button><button onClick={() => setToast("位置功能仅作模拟")}><span><MagnifyingGlassIcon /></span>位置</button>
        </div>}
      </section> : null}

      {menuMessage ? <div className="context-layer" onClick={() => setMenuMessage(null)}><div className="context-menu" onClick={(event) => event.stopPropagation()}>
        <button onClick={() => { void navigator.clipboard.writeText(menuMessage.text); setMenuMessage(null); setToast("已复制"); }}><CopyIcon />复制</button>
        <button onClick={() => { setInput(`“${menuMessage.text}”\n`); setMenuMessage(null); }}><ChatBubbleIcon />引用</button>
        <button onClick={() => { setMessages((items) => items.filter((item) => item.id !== menuMessage.id)); setMenuMessage(null); }}><TrashIcon />删除</button>
      </div></div> : null}

      <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen} title="聊天信息" description="此设置只影响本地测试页面" snap={0.57}>
        <div className="sheet-profile"><img src="/assets/avatars/ai-diet-secretary.png" alt="" /><div><strong>AI 饮食秘书</strong><span>同一测试身份 · 新建对话只重置线程</span></div></div>
        <div className="sheet-setting"><div><strong>回复来源</strong><span>compare-v2 右栏逻辑 · 直接进入 LangGraph</span></div><span className="live-badge">原始入口</span></div>
        <div className="sheet-setting"><div><strong>本地对话存档</strong><span>新建对话时自动保存当前记录</span></div><span className="archive-count">{archiveCount} 份</span></div>
        <button className="sheet-action" onClick={() => clearConversation(false)}><ResetIcon />新建对话（保留测试用户）</button>
        <button className="sheet-action danger" onClick={() => clearConversation(true)}><ResetIcon />全新测试用户</button>
        <button className="sheet-action" onClick={() => setSheetOpen(false)}><Cross2Icon />关闭</button>
      </BottomSheet>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}
