# Design QA — 企业微信聊天模拟器

- Source of truth: `reference/selected-wecom-chat.png`
- Behavioral source: `backend/public/compare-v2.html` LangGraph column
- Rendered implementation: `reference/implementation-compare-v2-first-turn.png`
- Combined visual comparison: `reference/qa-real-flow-side-by-side.png`
- Target app viewport: iPhone 393 × 852 CSS px (mobile runtime)
- Source pixels: 853 × 1844
- Implementation capture: 393 × 852 pixels at 393 × 852 CSS px, density 1
- Verified states: empty thread; first direct LangGraph turn; delayed multi-reply rendering; second turn with returned thread ID; archived new conversation

## Comparison

- Structure: passed. Status area, 44 px chat header, message stream, fixed composer, and safe-area home indicator follow the selected layout.
- Content: passed. Static sample messages, quick-reply chips, channel welcome, and service selection are absent; visible copy comes directly from LangGraph.
- Visual hierarchy: passed. Assistant messages use white bubbles; user messages use WeChat green; avatars and tails are correctly aligned by role.
- Interaction state: passed. Typing indicator appears only during an actual model request instead of remaining as a permanent decorative element.
- Simulator ownership: passed. Device bezel, status bar, keyboard, safe areas, and home indicator remain owned by the protected iOS runtime.
- Copy: passed against the direct LangGraph response. No deterministic channel welcome or service-choice copy is inserted.
- Typography: passed. App content uses the iOS/PingFang system stack, 16 px message copy, and preserved paragraph breaks.
- Spacing/layout: passed. Multi-part LangGraph replies remain inside the message viewport, and new messages automatically scroll above the fixed composer.
- Colors/tokens: passed. `#ededed` chat background, white assistant bubbles, and `#95ec69` user bubbles preserve the selected visual system.
- Image/icon quality: passed. Generated avatars remain crisp at 40 px; the incorrect speaker glyph was replaced with a library phone icon.
- Fidelity caveat: message content intentionally differs from the generated visual because the compare-v2 LangGraph entry behavior is now the stronger product truth.

## Functional checks

- Production build and TypeScript: passed.
- Protected mobile runtime integrity (28 files): passed.
- Direct `/api/chat-langgraph` request containing only `message`, persistent `deviceId`, and returned `threadId` on later turns: passed.
- First message → two LangGraph replies with 2.5-second gap → second turn using the same thread: passed.
- New conversation archives the transcript and resets only thread state; separate new-user action rotates device identity: passed.
- Latest LangGraph reply remains visible after automatic scroll: passed.
- Chat info sheet/session reset: passed.
- Emoji and more panels: passed.
- Browser console errors on a clean verification tab: none.
- No LangGraph node, prompt, knowledge-base, or production-store changes: passed.

## Comparison history

- P1: static design-sample conversation made the simulator appear to preselect company dining, taste, restrictions, and goals. Fixed by removing seeded messages and sending every user turn directly through the compare-v2 LangGraph entry.
- P1: a development-only enterprise-WeChat simulator route incorrectly replaced the compare-v2 entry logic with deterministic channel onboarding. Fixed by removing that route and restoring direct `/api/chat-langgraph` calls.
- P2: long replies could leave the newest message outside the visible region. Fixed with automatic end-of-thread scrolling; post-fix browser evidence confirms the latest LangGraph bubble is visible.
- P2: the header used a speaker glyph instead of a call icon. Fixed with a library phone icon.
- Post-fix visual evidence: `reference/implementation-compare-v2-first-turn.png`.

final result: passed
