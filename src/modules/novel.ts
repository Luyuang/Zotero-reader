import { config } from "../../package.json";

const PREF_PATH = `${config.prefsPrefix}.novelPath`;
const PREF_PROGRESS = `${config.prefsPrefix}.novelProgress`;
const XHTML = "http://www.w3.org/1999/xhtml";
const PAGE_SIZE = 3000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageBoundary(text: string, pageIndex: number): number {
  const boundary = Math.min(pageIndex * PAGE_SIZE, text.length);
  if (boundary > 0 && boundary < text.length) {
    const code = text.charCodeAt(boundary);
    if (code >= 0xdc00 && code <= 0xdfff) return boundary - 1;
  }
  return boundary;
}

// Read a local txt file. Try UTF-8 first; if the bytes are not valid
// UTF-8 (typical for GBK files downloaded in China), fall back to GBK.
async function loadNovel(path: string): Promise<string> {
  const bytes = await IOUtils.read(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gbk").decode(bytes);
  }
}

async function renderNovel(body: HTMLElement) {
  const doc = body.ownerDocument;
  if (!doc) throw new Error("The novel panel has no owner document.");

  // onRender runs every time the selected item changes, so clear first
  // to avoid stacking duplicate buttons and listeners.
  body.replaceChildren();

  const btn = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  btn.textContent = "Open file";

  const previous = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  previous.textContent = "Previous";
  previous.disabled = true;

  const next = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  next.textContent = "Next";
  next.disabled = true;

  const pageLabel = doc.createElementNS(XHTML, "span") as HTMLElement;
  pageLabel.textContent = "Page 0/0";

  const status = doc.createElementNS(XHTML, "div") as HTMLElement;
  status.setAttribute("aria-live", "polite");

  const box = doc.createElementNS(XHTML, "div") as HTMLElement;
  box.tabIndex = 0;
  box.setAttribute(
    "aria-label",
    "Novel text. Use the left and right arrow keys to change pages.",
  );
  box.style.cssText = "white-space:pre-wrap;line-height:1.8;padding:8px;";

  body.append(btn, previous, pageLabel, next, status, box);

  let changePage: ((offset: number) => void) | undefined;
  let loadGeneration = 0;

  previous.onclick = () => changePage?.(-1);
  next.onclick = () => changePage?.(1);
  box.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      changePage?.(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      changePage?.(1);
    }
  });

  const show = async (path: string) => {
    const generation = ++loadGeneration;
    changePage = undefined;
    box.textContent = "";
    pageLabel.textContent = "Page 0/0";
    previous.disabled = true;
    next.disabled = true;
    try {
      const text = await loadNovel(path);
      if (generation !== loadGeneration) return;
      const pageCount = Math.max(1, Math.ceil(text.length / PAGE_SIZE));
      let page = 0;
      status.textContent = "";

      const saved = Zotero.Prefs.get(PREF_PROGRESS, true);
      if (saved !== undefined) {
        try {
          if (typeof saved !== "string") {
            throw new Error("Saved reading progress is not text.");
          }
          const parsed: unknown = JSON.parse(saved);
          if (
            !isRecord(parsed) ||
            typeof parsed.path !== "string" ||
            typeof parsed.page !== "number" ||
            !Number.isInteger(parsed.page) ||
            parsed.page < 0
          ) {
            throw new Error("Saved reading progress has an invalid format.");
          }
          if (parsed.path === path) {
            page = Math.min(parsed.page, pageCount - 1);
          }
        } catch (e) {
          status.textContent = `Could not restore reading progress: ${e}`;
        }
      }

      const renderPage = () => {
        const start = pageBoundary(text, page);
        const end = pageBoundary(text, page + 1);
        box.textContent = text.slice(start, end);
        pageLabel.textContent = `Page ${page + 1}/${pageCount}`;
        previous.disabled = page === 0;
        next.disabled = page >= pageCount - 1;
      };

      changePage = (offset) => {
        const newPage = page + offset;
        if (newPage < 0 || newPage >= pageCount) return;

        page = newPage;
        renderPage();
        try {
          Zotero.Prefs.set(PREF_PROGRESS, JSON.stringify({ path, page }), true);
        } catch (e) {
          status.textContent = `Could not save reading progress: ${e}`;
        }
      };
      renderPage();
    } catch (e) {
      if (generation !== loadGeneration) return;
      status.textContent = `Failed to read file: ${e}`;
      box.textContent = "";
      pageLabel.textContent = "Page 0/0";
      previous.disabled = true;
      next.disabled = true;
      changePage = undefined;
    }
  };

  btn.addEventListener("click", async () => {
    try {
      const path = await new ztoolkit.FilePicker("Open", "open", [
        ["Text (*.txt)", "*.txt"],
      ]).open();
      if (!path) return;
      Zotero.Prefs.set(PREF_PATH, path, true);
      await show(path);
    } catch (e) {
      status.textContent = `Could not open file: ${e}`;
    }
  });

  const saved = Zotero.Prefs.get(PREF_PATH, true);
  if (typeof saved === "string" && saved) await show(saved);
}

export function registerNovelSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "novel-reader",
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: `${addon.data.config.addonRef}-novel-header`,
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: `${addon.data.config.addonRef}-novel-sidenav`,
      icon: "chrome://zotero/skin/20/universal/book.svg",
    },
    onItemChange: ({ setEnabled }) => {
      setEnabled(true);
      return true;
    },
    onRender: ({ body }) => {
      renderNovel(body);
    },
  });
}
