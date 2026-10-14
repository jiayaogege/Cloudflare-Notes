import "./styles.css";
import { ApiError, exportEncrypted, login, logout, putNote, register, sync } from "./api";
import { decryptNote, encryptNote, generateId, wipeKey } from "./crypto";
import type { Note, Session, StoredNote, SyncNote } from "./types";
import {
  countPending,
  deleteOutboxIfMutation,
  getMeta,
  getOutbox,
  getOutboxForNote,
  getStoredNote,
  listStoredNotes,
  noteKey,
  putMeta,
  putOutbox,
  putStoredNote,
  rebaseOutboxIfMutation
} from "./storage";

const app = document.querySelector<HTMLDivElement>("#app")!;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

type AuthMode = "login" | "register";
type EditorMode = "edit" | "preview";
type Theme = "system" | "light" | "dark";

interface AppState {
  session: Session | null;
  notes: Map<string, Note>;
  selectedId: string | null;
  authMode: AuthMode;
  editorMode: EditorMode;
  search: string;
  category: string;
  online: boolean;
  status: string;
  error: string;
  pending: number;
  syncing: boolean;
  busy: boolean;
  cursor: number;
  theme: Theme;
}

const THEME_STORAGE_KEY = "private-notes:theme";
const themeMedia = window.matchMedia?.("(prefers-color-scheme: dark)");

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

function resolvedTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return themeMedia?.matches ? "dark" : "light";
}

function applyTheme(): void {
  const actualTheme = resolvedTheme(state.theme);
  document.documentElement.dataset.theme = actualTheme;
  document.documentElement.dataset.themePreference = state.theme;
  document.documentElement.style.colorScheme = actualTheme;
}

const state: AppState = {
  session: null,
  notes: new Map(),
  selectedId: null,
  authMode: "login",
  editorMode: "edit",
  search: "",
  category: "",
  online: navigator.onLine,
  status: "",
  error: "",
  pending: 0,
  syncing: false,
  busy: false,
  cursor: 0,
  theme: readTheme()
};

let saveTimer: number | undefined;
const MAX_NOTE_BODY_CHARS = 350_000;

applyTheme();
if (themeMedia) {
  const handleThemeChange = () => {
    if (state.theme === "system") applyTheme();
  };
  const media = themeMedia as MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", handleThemeChange);
  else media.addListener?.(handleThemeChange);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

function notePreview(note: Note): string {
  const text = note.body.replace(/[#*_`>\-\[\]()]/g, "").replace(/\s+/g, " ").trim();
  return text.slice(0, 88) || "空白笔记";
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
  };
  const inline = (value: string): string => {
    let safe = escapeHtml(value);
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    safe = safe.replace(/_([^_]+)_/g, "<em>$1</em>");
    safe = safe.replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return safe;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    output.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  return output.join("");
}

function setStatus(message: string): void {
  state.status = message;
  document.querySelectorAll<HTMLElement>(".status-text").forEach((element) => {
    element.textContent = message;
  });
}

function showToast(message: string, kind: "info" | "error" = "info"): void {
  const toast = document.querySelector<HTMLElement>("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${kind}`;
  window.setTimeout(() => {
    toast.className = "toast hidden";
  }, 4200);
}

function setBusy(value: boolean): void {
  state.busy = value;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    if (button.dataset.keepEnabled !== "true") button.disabled = value;
  });
}

function filteredNotes(): Note[] {
  const query = state.search.trim().toLowerCase();
  return [...state.notes.values()]
    .filter((note) => !note.deleted)
    .filter((note) => !state.category || note.category === state.category)
    .filter((note) => {
      if (!query) return true;
      return [note.title, note.body, note.category, note.tags.join(" ")].join("\n").toLowerCase().includes(query);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function categories(): string[] {
  return [...new Set([...state.notes.values()].map((note) => note.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function themeOptions(): string {
  return [
    ["system", "跟随系统"],
    ["light", "浅色"],
    ["dark", "深色"]
  ]
    .map(([value, label]) => `<option value="${value}" ${state.theme === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function renderThemePicker(className = ""): string {
  return `
    <label class="theme-picker ${className}">
      <span class="sr-only">界面主题</span>
      <select id="theme-select" aria-label="界面主题">${themeOptions()}</select>
    </label>`;
}

function wireThemePicker(): void {
  const picker = app.querySelector("#theme-select") as HTMLSelectElement | null;
  picker?.addEventListener("change", (event: Event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== "system" && value !== "light" && value !== "dark") return;
    state.theme = value;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // A private browsing context may reject localStorage; the in-memory preference still applies.
    }
    applyTheme();
  });
}

function renderAuth(): void {
  app.innerHTML = `
    <main class="auth-layout">
      <section class="auth-hero">
        <div class="brand-mark">CF</div>
        <p class="eyebrow">PRIVATE NOTES / CLIENT-SIDE ENCRYPTION</p>
        <h1>把想法留在<br /><span>自己的密钥里。</span></h1>
        <p class="hero-copy">笔记在浏览器内加密，Cloudflare 只负责保存不可读的密文和同步版本。没有第三方分析、邮件服务或付费存储依赖。</p>
        <div class="hero-facts">
          <span><i></i> AES-GCM 端到端加密</span>
          <span><i></i> IndexedDB 离线缓存</span>
          <span><i></i> Cloudflare Workers + D1</span>
        </div>
      </section>
      <section class="auth-panel">
        ${renderThemePicker("auth-theme-picker")}
        <div class="auth-tabs" role="tablist">
          <button class="${state.authMode === "login" ? "active" : ""}" data-auth-mode="login">登录</button>
          <button class="${state.authMode === "register" ? "active" : ""}" data-auth-mode="register">创建账户</button>
        </div>
        <div class="panel-heading">
          <p class="eyebrow">${state.authMode === "login" ? "WELCOME BACK" : "NEW VAULT"}</p>
          <h2>${state.authMode === "login" ? "解锁你的笔记" : "创建私人笔记库"}</h2>
          <p>${state.authMode === "login" ? "输入邮箱和主密码，浏览器会在本地解锁密钥。" : "原始主密码不会上传。请使用至少 12 位的高熵口令，并保存离线备份。"}</p>
        </div>
        <form id="auth-form" class="form-stack">
          <label>邮箱<input name="email" type="email" autocomplete="email" required placeholder="you@example.com" /></label>
          <label>主密码<input name="password" type="password" autocomplete="${state.authMode === "login" ? "current-password" : "new-password"}" required minlength="12" placeholder="至少 12 位" /></label>
          ${state.authMode === "register" ? '<label>确认主密码<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" placeholder="再次输入主密码" /></label>' : ""}
          <button class="primary-button" type="submit">${state.busy ? "处理中…" : state.authMode === "login" ? "解锁并同步" : "创建并进入"}</button>
          ${state.error ? `<p class="form-error">${escapeHtml(state.error)}</p>` : ""}
        </form>
        <p class="auth-note">忘记主密码无法由服务器恢复明文。请在进入后导出加密备份，并把恢复信息保存在离线位置。</p>
      </section>
    </main>`;
  wireThemePicker();
  app.querySelectorAll<HTMLButtonElement>("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode as AuthMode;
      state.error = "";
      renderAuth();
    });
  });
  app.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    state.error = "";
    if (password.length < 12) {
      state.error = "主密码至少需要 12 位。";
      renderAuth();
      return;
    }
    if (state.authMode === "register" && password !== confirmPassword) {
      state.error = "两次输入的主密码不一致。";
      renderAuth();
      return;
    }
    setBusy(true);
    renderAuth();
    try {
      const result = state.authMode === "login" ? await login(email, password) : await register(email, password);
      await enterSession(result);
    } catch (error) {
      state.error = error instanceof Error ? error.message : "操作失败，请稍后重试。";
      setBusy(false);
      renderAuth();
    }
  });
}

function renderApp(): void {
  const selected = state.selectedId ? state.notes.get(state.selectedId) : undefined;
  const list = filteredNotes();
  const categoryOptions = categories().map((category) => `<option value="${escapeHtml(category)}" ${state.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("");
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-brand"><div class="brand-mark small">CF</div><div><strong>Private Notes</strong><span>encrypted workspace</span></div></div>
        <div class="topbar-actions">
          <span class="connection-pill ${state.online ? "online" : "offline"}"><i></i>${state.online ? "在线" : "离线"}</span>
          <span class="status-text">${escapeHtml(state.status || (state.pending ? `待同步 ${state.pending} 项` : "已同步"))}</span>
          <button class="icon-button" id="export-button" title="导出加密备份" aria-label="导出加密备份">⇩</button>
          ${renderThemePicker()}
          <button class="ghost-button" id="logout-button">退出</button>
        </div>
      </header>
      <div class="workspace">
        <aside class="sidebar">
          <div class="sidebar-head"><div><p class="eyebrow">YOUR VAULT</p><h2>笔记</h2></div><button class="new-button" id="new-note" title="新建笔记">＋</button></div>
          <div class="search-wrap"><span>⌕</span><input id="search-input" value="${escapeHtml(state.search)}" placeholder="搜索已解密内容…" /></div>
          <select id="category-filter" class="category-filter"><option value="">所有分类</option>${categoryOptions}</select>
          <div class="note-count">${list.length} 条笔记${state.pending ? ` · ${state.pending} 项待同步` : ""}</div>
          <div class="note-list">${renderNoteList(list)}</div>
        </aside>
        <main class="editor-area">
          ${selected ? renderEditor(selected) : renderEmptyEditor()}
        </main>
      </div>
      <div id="toast" class="toast hidden"></div>
    </div>`;
  wireThemePicker();
  wireAppEvents();
}

function renderNoteList(list: Note[]): string {
  if (!list.length) {
    return '<div class="empty-list"><span>✦</span><p>还没有匹配的笔记</p><small>点击右上角 ＋ 创建第一条</small></div>';
  }
  return list.map((note) => `
    <button class="note-row ${note.id === state.selectedId ? "selected" : ""}" data-note-id="${note.id}">
      <span class="note-row-title">${escapeHtml(note.title || "未命名笔记")}</span>
      <span class="note-row-preview">${escapeHtml(notePreview(note))}</span>
      <span class="note-row-meta">${note.category ? escapeHtml(note.category) : "未分类"} · ${formatDate(note.updatedAt)}</span>
    </button>`).join("");
}

function renderEmptyEditor(): string {
  return `<section class="empty-editor"><div class="empty-orbit">✦</div><h2>从一页空白开始</h2><p>你的笔记会在浏览器内加密后同步到 Cloudflare。</p><button class="primary-button compact" id="empty-new-note">创建笔记</button></section>`;
}

function renderEditor(note: Note): string {
  const tags = note.tags.join(", ");
  return `
    <section class="editor">
      <div class="editor-head">
        <div class="editor-breadcrumb"><span>笔记库</span><b>/</b><span>${note.category ? escapeHtml(note.category) : "未分类"}</span></div>
        <div class="editor-actions"><button class="icon-button" id="delete-note" title="删除笔记" aria-label="删除笔记">⌫</button></div>
      </div>
      <input id="title-input" class="title-input" value="${escapeHtml(note.title)}" placeholder="无标题" aria-label="笔记标题" />
      <div class="metadata-row">
        <label>分类<input id="category-input" value="${escapeHtml(note.category)}" placeholder="例如：工作" /></label>
        <label>标签<input id="tags-input" value="${escapeHtml(tags)}" placeholder="用逗号分隔" /></label>
        <div class="updated-label">更新于<br /><strong>${formatDate(note.updatedAt)}</strong></div>
      </div>
      <div class="editor-toolbar">
        <div class="editor-toolbar-controls">
          <div class="segmented" role="tablist" aria-label="编辑模式"><button class="${state.editorMode === "edit" ? "active" : ""}" data-editor-mode="edit">编辑</button><button class="${state.editorMode === "preview" ? "active" : ""}" data-editor-mode="preview">预览</button></div>
          ${state.editorMode === "edit"
            ? `<div class="markdown-tools" role="toolbar" aria-label="Markdown 格式">
                <button class="editor-tool" type="button" data-format="bold" title="粗体（Ctrl/Cmd+B）" aria-label="插入粗体"><strong>B</strong></button>
                <button class="editor-tool" type="button" data-format="italic" title="斜体（Ctrl/Cmd+I）" aria-label="插入斜体"><em>I</em></button>
                <button class="editor-tool" type="button" data-format="heading" title="标题" aria-label="插入标题">H</button>
                <button class="editor-tool" type="button" data-format="quote" title="引用" aria-label="插入引用">❯</button>
                <button class="editor-tool" type="button" data-format="bullet" title="无序列表" aria-label="插入无序列表">•</button>
                <button class="editor-tool" type="button" data-format="code" title="代码" aria-label="插入代码">&lt;/&gt;</button>
                <button class="editor-tool" type="button" data-format="link" title="链接（Ctrl/Cmd+K）" aria-label="插入链接">↗</button>
              </div>`
            : ""}
        </div>
        <span class="markdown-hint">Markdown · 自动保存</span>
      </div>
      ${state.editorMode === "edit"
        ? `<textarea id="body-input" class="body-input" spellcheck="true" placeholder="写下此刻正在想的事…">${escapeHtml(note.body)}</textarea>`
        : `<article class="markdown-preview">${renderMarkdown(note.body)}</article>`}
      <div class="editor-footer"><span class="status-dot ${state.pending ? "pending" : "saved"}"></span><span class="status-text">${escapeHtml(state.status || (state.pending ? "等待同步" : "已同步到加密存储"))}</span><span class="word-count">${note.body.length} 字符</span></div>
    </section>`;
}

function formatBodyInput(textarea: HTMLTextAreaElement, format: string): void {
  const value = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = value.slice(start, end);
  let replacement = selected;
  let nextStart = start;
  let nextEnd = end;

  if (format === "bold" || format === "italic" || format === "code") {
    const marker = format === "bold" ? "**" : format === "italic" ? "*" : "`";
    const content = selected || (format === "code" ? "代码" : format === "bold" ? "粗体文字" : "斜体文字");
    replacement = `${marker}${content}${marker}`;
    nextStart = start + marker.length;
    nextEnd = nextStart + content.length;
  } else if (format === "link") {
    const content = selected || "链接文字";
    replacement = `[${content}](https://)`;
    nextStart = start + content.length + 3;
    nextEnd = nextStart + 8;
  } else if (format === "heading" || format === "quote" || format === "bullet") {
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const block = value.slice(lineStart, lineEnd);
    const prefix = format === "heading" ? "# " : format === "quote" ? "> " : "- ";
    const lines = block.split("\n");
    const prefixed = lines.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : `${prefix}${line}`));
    replacement = prefixed.join("\n");
    nextStart = lineStart;
    nextEnd = lineStart + replacement.length;
  }

  textarea.value = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(nextStart, nextEnd);
  updateSelectedNote({ body: textarea.value });
}

function wireNoteRows(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-note-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.noteId || null;
      state.editorMode = "edit";
      state.status = "";
      renderApp();
    });
  });
}

function refreshNoteList(): void {
  const list = filteredNotes();
  const count = app.querySelector<HTMLElement>(".note-count");
  if (count) count.textContent = `${list.length} 条笔记${state.pending ? ` · ${state.pending} 项待同步` : ""}`;
  const listElement = app.querySelector<HTMLElement>(".note-list");
  if (!listElement) return;
  listElement.innerHTML = renderNoteList(list);
  wireNoteRows();
}

function wireAppEvents(): void {
  wireNoteRows();
  app.querySelector<HTMLInputElement>("#search-input")?.addEventListener("input", (event) => {
    state.search = (event.target as HTMLInputElement).value;
    refreshNoteList();
  });
  const categoryFilter = app.querySelector("#category-filter") as HTMLSelectElement | null;
  categoryFilter?.addEventListener("change", (event: Event) => {
    state.category = (event.target as HTMLSelectElement).value;
    renderApp();
  });
  app.querySelector<HTMLButtonElement>("#new-note")?.addEventListener("click", () => void createNote());
  app.querySelector<HTMLButtonElement>("#empty-new-note")?.addEventListener("click", () => void createNote());
  app.querySelector<HTMLButtonElement>("#logout-button")?.addEventListener("click", () => void signOut());
  app.querySelector<HTMLButtonElement>("#export-button")?.addEventListener("click", () => void downloadBackup());
  app.querySelector<HTMLButtonElement>("#delete-note")?.addEventListener("click", () => void deleteSelectedNote());
  app.querySelectorAll<HTMLButtonElement>("[data-editor-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editorMode = button.dataset.editorMode as EditorMode;
      renderApp();
    });
  });
  const titleInput = app.querySelector<HTMLInputElement>("#title-input");
  const categoryInput = app.querySelector<HTMLInputElement>("#category-input");
  const tagsInput = app.querySelector<HTMLInputElement>("#tags-input");
  const bodyInput = app.querySelector<HTMLTextAreaElement>("#body-input");
  titleInput?.addEventListener("input", () => updateSelectedNote({ title: titleInput.value }));
  categoryInput?.addEventListener("input", () => updateSelectedNote({ category: categoryInput.value }));
  tagsInput?.addEventListener("input", () => updateSelectedNote({ tags: normalizeTags(tagsInput.value) }));
  bodyInput?.addEventListener("input", () => updateSelectedNote({ body: bodyInput.value }));
  app.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((button) => {
    button.addEventListener("click", () => {
      if (bodyInput) formatBodyInput(bodyInput, button.dataset.format || "");
    });
  });
  bodyInput?.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    const format = key === "b" ? "bold" : key === "i" ? "italic" : key === "k" ? "link" : "";
    if (!format) return;
    event.preventDefault();
    formatBodyInput(bodyInput, format);
  });
}

function updateSelectedNote(patch: Partial<Note>): void {
  if (!state.selectedId) return;
  const note = state.notes.get(state.selectedId);
  if (!note) return;
  if (typeof patch.body === "string" && patch.body.length > MAX_NOTE_BODY_CHARS) {
    showToast(`笔记正文不能超过 ${MAX_NOTE_BODY_CHARS.toLocaleString()} 个字符。`, "error");
    return;
  }
  Object.assign(note, patch, { updatedAt: Date.now() });
  setStatus("本地已保存，等待同步");
  scheduleSave(note);
  const row = [...app.querySelectorAll<HTMLButtonElement>(".note-row")].find(
    (candidate) => candidate.dataset.noteId === note.id
  );
  if (row) {
    const title = row.querySelector<HTMLElement>(".note-row-title");
    const preview = row.querySelector<HTMLElement>(".note-row-preview");
    const meta = row.querySelector<HTMLElement>(".note-row-meta");
    if (title) title.textContent = note.title || "未命名笔记";
    if (preview) preview.textContent = notePreview(note);
    if (meta) meta.textContent = `${note.category || "未分类"} · ${formatDate(note.updatedAt)}`;
  }
  const breadcrumb = app.querySelector<HTMLElement>(".editor-breadcrumb span:last-child");
  if (breadcrumb) breadcrumb.textContent = note.category || "未分类";
  const updated = app.querySelector<HTMLElement>(".updated-label strong");
  if (updated) updated.textContent = formatDate(note.updatedAt);
  const count = document.querySelector(".word-count");
  if (count) count.textContent = `${note.body.length} 字符`;
}

function scheduleSave(note: Note): void {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void persistNote(note).then(() => {
      if (state.online) void flushOutbox();
    }).catch(() => {
      setStatus("本地保存失败，请检查浏览器存储空间");
      showToast("本地保存失败，当前修改尚未写入 IndexedDB。", "error");
    });
  }, 1000);
}

async function persistNote(note: Note): Promise<void> {
  if (!state.session) return;
  const previous = await getStoredNoteSafe(state.session.user.userId, note.id);
  const baseRev = previous?.serverRev ?? 0;
  const envelope = await encryptNote(state.session.user.userId, note, state.session.vaultKey);
  const stored: StoredNote = {
    key: noteKey(state.session.user.userId, note.id),
    userId: state.session.user.userId,
    noteId: note.id,
    serverRev: baseRev,
    updatedAt: note.updatedAt,
    deleted: Boolean(note.deleted),
    envelope
  };
  await putStoredNote(stored);
  if (envelope.byteSize > 1_400_000) {
    setStatus("笔记超过服务器大小上限，已保存在本地但未同步");
    return;
  }
  await putOutbox({
    key: stored.key,
    userId: stored.userId,
    noteId: stored.noteId,
    baseRev,
    mutationId: generateId(),
    createdAt: Date.now(),
    envelope,
    deleted: stored.deleted
  });
  state.pending = await countPending(state.session.user.userId);
  setStatus(state.online ? "已保存，正在同步…" : "已保存到本地，等待联网");
}

async function getStoredNoteSafe(userId: string, noteId: string): Promise<StoredNote | undefined> {
  try {
    return await getStoredNote(userId, noteId);
  } catch {
    return undefined;
  }
}

async function createNote(): Promise<void> {
  if (!state.session) return;
  const timestamp = Date.now();
  const note: Note = {
    id: generateId(),
    title: "",
    body: "",
    category: "",
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.notes.set(note.id, note);
  state.selectedId = note.id;
  state.editorMode = "edit";
  renderApp();
  await persistNote(note);
  if (state.online) await flushOutbox();
}

async function deleteSelectedNote(): Promise<void> {
  if (!state.session || !state.selectedId) return;
  const note = state.notes.get(state.selectedId);
  if (!note) return;
  if (!window.confirm("删除这条笔记？删除会先同步为墓碑，其他设备也会隐藏它。")) return;
  note.deleted = true;
  await persistNote(note);
  state.notes.delete(note.id);
  state.selectedId = filteredNotes()[0]?.id || null;
  renderApp();
  if (state.online) await flushOutbox();
}

async function handleConflict(item: Awaited<ReturnType<typeof getOutbox>>[number], remote: SyncNote | null): Promise<void> {
  if (!state.session || !remote) return;
  try {
    const local = await decryptNote(state.session.user.userId, item.noteId, item.envelope, state.session.vaultKey);
    const localCopy: Note = {
      ...local,
      id: generateId(),
      title: `冲突副本 · ${local.title || "未命名笔记"}`,
      updatedAt: Date.now()
    };
    state.notes.set(localCopy.id, localCopy);
    await persistNote(localCopy);
    if (remote.deleted) {
      state.notes.delete(item.noteId);
      await putStoredNote({
        key: noteKey(state.session.user.userId, item.noteId),
        userId: state.session.user.userId,
        noteId: item.noteId,
        serverRev: remote.serverRev,
        updatedAt: remote.updatedAt,
        deleted: true,
        envelope: remote
      });
    } else {
      const remoteNote = await decryptNote(state.session.user.userId, remote.noteId, remote, state.session.vaultKey);
      state.notes.set(remoteNote.id, remoteNote);
      await putStoredNote({
        key: noteKey(state.session.user.userId, remote.noteId),
        userId: state.session.user.userId,
        noteId: remote.noteId,
        serverRev: remote.serverRev,
        updatedAt: remote.updatedAt,
        deleted: false,
        envelope: remote
      });
    }
    await deleteOutboxIfMutation(state.session.user.userId, item.noteId, item.mutationId);
    showToast("检测到同步冲突，已保留一份“冲突副本”。", "info");
  } catch {
    showToast("冲突处理失败，已保留本地队列等待下次重试。", "error");
  }
}

async function flushOutbox(): Promise<void> {
  if (!state.session || !state.online || state.syncing) return;
  state.syncing = true;
  try {
    const items = await getOutbox(state.session.user.userId);
    for (const item of items) {
      try {
        const response = await putNote(item.noteId, state.session.csrfToken, {
          ...item.envelope,
          mutationId: item.mutationId,
          baseRev: item.baseRev,
          deleted: item.deleted
        });
        const serverNote = response.note;
        const latest = await getOutboxForNote(state.session.user.userId, item.noteId);
        if (serverNote && latest && latest.mutationId !== item.mutationId) {
          const local = state.notes.get(item.noteId);
          await putStoredNote({
            key: noteKey(state.session.user.userId, item.noteId),
            userId: state.session.user.userId,
            noteId: item.noteId,
            serverRev: serverNote.serverRev,
            updatedAt: local?.updatedAt ?? Date.now(),
            deleted: latest.deleted,
            envelope: latest.envelope
          });
          await rebaseOutboxIfMutation(
            state.session.user.userId,
            item.noteId,
            latest.mutationId,
            serverNote.serverRev
          );
          continue;
        }
        if (serverNote) {
          const local = state.notes.get(item.noteId);
          await putStoredNote({
            key: noteKey(state.session.user.userId, item.noteId),
            userId: state.session.user.userId,
            noteId: item.noteId,
            serverRev: serverNote.serverRev,
            updatedAt: serverNote.updatedAt,
            deleted: item.deleted,
            envelope: item.envelope
          });
          if (item.deleted) state.notes.delete(item.noteId);
          else if (local && state.selectedId === item.noteId) state.status = "已同步到加密存储";
        }
        await deleteOutboxIfMutation(state.session.user.userId, item.noteId, item.mutationId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const latest = await getOutboxForNote(state.session.user.userId, item.noteId);
          await handleConflict(latest || item, (error.data.note as SyncNote | null) || null);
          continue;
        }
        break;
      }
    }
    state.pending = await countPending(state.session.user.userId);
    setStatus(state.pending ? `待同步 ${state.pending} 项` : "已同步到加密存储");
  } finally {
    state.syncing = false;
    document.querySelectorAll<HTMLElement>(".status-text").forEach((element) => {
      element.textContent = state.status;
    });
  }
}

async function pullSync(): Promise<void> {
  if (!state.session || !state.online || state.syncing) return;
  state.syncing = true;
  try {
    let hasMore = true;
    while (hasMore) {
      const response = await sync(state.cursor);
      for (const remote of response.notes) {
        const pending = await getOutboxForNote(state.session.user.userId, remote.noteId);
        if (pending) continue;
        if (remote.deleted) {
          state.notes.delete(remote.noteId);
          await putStoredNote({
            key: noteKey(state.session.user.userId, remote.noteId),
            userId: state.session.user.userId,
            noteId: remote.noteId,
            serverRev: remote.serverRev,
            updatedAt: remote.updatedAt,
            deleted: true,
            envelope: remote
          });
          continue;
        }
        try {
          const note = await decryptNote(state.session.user.userId, remote.noteId, remote, state.session.vaultKey);
          state.notes.set(note.id, note);
          await putStoredNote({
            key: noteKey(state.session.user.userId, remote.noteId),
            userId: state.session.user.userId,
            noteId: remote.noteId,
            serverRev: remote.serverRev,
            updatedAt: remote.updatedAt,
            deleted: false,
            envelope: remote
          });
        } catch {
          await putStoredNote({
            key: noteKey(state.session.user.userId, remote.noteId),
            userId: state.session.user.userId,
            noteId: remote.noteId,
            serverRev: remote.serverRev,
            updatedAt: remote.updatedAt,
            deleted: false,
            envelope: remote
          });
          showToast("有一条同步笔记无法解密，已跳过并保留密文缓存。", "error");
        }
      }
      state.cursor = response.cursor;
      hasMore = response.hasMore;
      await putMeta(`cursor:${state.session.user.userId}`, state.cursor);
    }
  } finally {
    state.syncing = false;
  }
}

async function enterSession(result: { user: Session["user"]; csrfToken: string; vaultKey: Uint8Array }): Promise<void> {
  state.session = result;
  state.notes.clear();
  state.error = "";
  state.status = "正在加载本地密文…";
  state.cursor = (await getMeta<number>(`cursor:${result.user.userId}`)) || 0;
  const stored = await listStoredNotes(result.user.userId);
  for (const record of stored) {
    if (record.deleted) continue;
    try {
      const note = await decryptNote(result.user.userId, record.noteId, record.envelope, result.vaultKey);
      state.notes.set(note.id, note);
    } catch {
      // Do not discard undecryptable ciphertext. It remains in IndexedDB for export/recovery.
    }
  }
  state.selectedId = [...state.notes.keys()][0] || null;
  state.pending = await countPending(result.user.userId);
  renderApp();
  if (state.online) {
    try {
      await flushOutbox();
      await pullSync();
      await flushOutbox();
      await pullSync();
    } catch {
      setStatus("网络暂时不可用，本地数据仍可继续编辑");
    }
    renderApp();
  } else {
    setStatus("离线模式：本地密文可继续编辑");
  }
}

async function signOut(): Promise<void> {
  if (!state.session) return;
  try {
    await logout(state.session.csrfToken);
  } catch {
    // Local key is still wiped even if the network is unavailable.
  }
  wipeKey(state.session.vaultKey);
  state.session = null;
  state.notes.clear();
  state.selectedId = null;
  state.pending = 0;
  state.status = "";
  state.error = "";
  renderAuth();
}

async function downloadBackup(): Promise<void> {
  try {
    const blob = await exportEncrypted();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `cloudflare-notes-encrypted-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("加密备份已导出。请离线妥善保存。");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "导出失败", "error");
  }
}

async function reconcile(): Promise<void> {
  if (!state.session || !state.online) return;
  const before = [...state.notes.values()].map((note) => `${note.id}:${note.updatedAt}`).join("|");
  try {
    await pullSync();
    await flushOutbox();
  } catch {
    setStatus("同步暂时失败，待网络恢复后自动重试");
  }
  if (state.session) {
    state.pending = await countPending(state.session.user.userId);
    const after = [...state.notes.values()].map((note) => `${note.id}:${note.updatedAt}`).join("|");
    const active = document.activeElement;
    const editing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (before !== after && !editing) renderApp();
  }
}

window.addEventListener("online", () => {
  state.online = true;
  if (state.session) void reconcile();
  const pill = document.querySelector(".connection-pill");
  if (pill) {
    pill.className = "connection-pill online";
    pill.innerHTML = "<i></i>在线";
  }
});
window.addEventListener("offline", () => {
  state.online = false;
  setStatus("网络已断开，编辑会保存在本地");
  const pill = document.querySelector(".connection-pill");
  if (pill) {
    pill.className = "connection-pill offline";
    pill.innerHTML = "<i></i>离线";
  }
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && state.session) {
    event.preventDefault();
    const note = state.selectedId ? state.notes.get(state.selectedId) : undefined;
    if (note) {
      void persistNote(note).then(() => {
        if (state.online) return flushOutbox();
      });
    }
  }
});

window.setInterval(() => {
  if (state.session && state.online) void reconcile();
}, 60_000);

renderAuth();
