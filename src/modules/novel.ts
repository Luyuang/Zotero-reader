import { config } from "../../package.json";

const PREF_PATH = `${config.prefsPrefix}.novelPath`;
const PREF_PROGRESS = `${config.prefsPrefix}.novelProgress`;
const XHTML = "http://www.w3.org/1999/xhtml";
const PAGE_CHAR_LIMIT = 200;
const SHORT_LINE_RATIO = 0.7;
const SENTENCE_END = /[。！？!?；;…．.][”’」』）》）】]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startsWithIndent(line: string): boolean {
  return /^(?: {2,}|　{1,})/.test(line);
}

function joinLines(left: string, right: string): string {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)
    ? `${left} ${right}`
    : `${left}${right}`;
}

function reflowParagraphs(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const nonEmptyLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const longestLineLength = nonEmptyLines.reduce(
    (longest, line) => Math.max(longest, line.length),
    0,
  );
  const paragraphs: string[] = [];
  let currentLines: string[] = [];

  const finishParagraph = () => {
    if (currentLines.length > 0) {
      paragraphs.push(currentLines.reduce(joinLines));
      currentLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      finishParagraph();
      continue;
    }

    const previousLine = currentLines[currentLines.length - 1];
    const previousLineEndsShortParagraph =
      previousLine !== undefined &&
      previousLine.length < longestLineLength * SHORT_LINE_RATIO &&
      SENTENCE_END.test(previousLine);
    if (
      currentLines.length > 0 &&
      (startsWithIndent(rawLine) || previousLineEndsShortParagraph)
    ) {
      finishParagraph();
    }
    currentLines.push(line);
  }
  finishParagraph();
  return paragraphs;
}

function paginateParagraphs(paragraphs: string[]): string[][] {
  const pages: string[][] = [];
  let currentPage: string[] = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    const nextLength = currentLength + paragraph.length;
    if (currentPage.length > 0 && nextLength > PAGE_CHAR_LIMIT) {
      pages.push(currentPage);
      currentPage = [];
      currentLength = 0;
    }
    currentPage.push(paragraph);
    currentLength += paragraph.length;
  }

  if (currentPage.length > 0) pages.push(currentPage);
  return pages.length > 0 ? pages : [[]];
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
  body.tabIndex = -1;

  const btn = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  btn.textContent = "Open file";

  const previous = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  previous.textContent = "Previous";
  previous.disabled = true;

  const next = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  next.textContent = "Next";
  next.disabled = true;

  const pageInput = doc.createElementNS(XHTML, "input") as HTMLInputElement;
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.step = "1";
  pageInput.disabled = true;
  pageInput.setAttribute("aria-label", "Page number");

  const jumpButton = doc.createElementNS(XHTML, "button") as HTMLButtonElement;
  jumpButton.textContent = "Go";
  jumpButton.disabled = true;

  const pageLabel = doc.createElementNS(XHTML, "span") as HTMLElement;
  pageLabel.textContent = "Page 0/0";

  const status = doc.createElementNS(XHTML, "div") as HTMLElement;
  status.setAttribute("aria-live", "polite");

  const box = doc.createElementNS(XHTML, "div") as HTMLElement;
  box.tabIndex = 0;
  box.setAttribute(
    "aria-label",
    "Novel text. Use the left and right arrow keys or square brackets to change pages.",
  );
  box.style.cssText = "line-height:1.8;padding:8px;";

  body.append(
    btn,
    previous,
    pageInput,
    jumpButton,
    pageLabel,
    next,
    status,
    box,
  );

  let changePage: ((offset: number) => void) | undefined;
  let goToPage: ((pageNumber: number) => void) | undefined;
  let setTextHidden: ((hidden: boolean) => void) | undefined;
  let loadGeneration = 0;

  previous.onclick = () => changePage?.(-1);
  next.onclick = () => changePage?.(1);
  const submitPageNumber = () => {
    const pageNumber = Number(pageInput.value);
    if (!pageInput.value || !Number.isInteger(pageNumber)) {
      status.textContent = "Enter a valid page number.";
      return;
    }
    goToPage?.(pageNumber);
  };
  jumpButton.onclick = submitPageNumber;
  body.addEventListener("click", (event) => {
    const target = event.target;
    if (target && typeof target === "object" && "tagName" in target) {
      const tagName = target.tagName;
      if (
        typeof tagName === "string" &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(tagName)
      ) {
        return;
      }
    }
    body.focus();
  });
  pageInput.addEventListener("keydown", (event) => {
    if ("key" in event && event.key === "Enter") {
      event.preventDefault();
      submitPageNumber();
    }
  });
  body.onkeydown = (event) => {
    if (!("key" in event) || typeof event.key !== "string") return;
    const target = event.target;
    if (target && typeof target === "object") {
      if (
        ("tagName" in target &&
          typeof target.tagName === "string" &&
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) ||
        ("isContentEditable" in target && target.isContentEditable === true)
      ) {
        return;
      }
    }
    const key = event.key;
    const code = "code" in event ? event.code : undefined;
    if (key === "ArrowLeft" || key === "[" || code === "BracketLeft") {
      event.preventDefault();
      changePage?.(-1);
    } else if (key === "ArrowRight" || key === "]" || code === "BracketRight") {
      event.preventDefault();
      changePage?.(1);
    } else if (key === "ArrowUp") {
      event.preventDefault();
      setTextHidden?.(true);
    } else if (key === "ArrowDown") {
      event.preventDefault();
      setTextHidden?.(false);
    }
  };

  const show = async (path: string) => {
    const generation = ++loadGeneration;
    changePage = undefined;
    goToPage = undefined;
    setTextHidden = undefined;
    box.textContent = "";
    pageLabel.textContent = "Page 0/0";
    previous.disabled = true;
    next.disabled = true;
    pageInput.disabled = true;
    jumpButton.disabled = true;
    try {
      const text = await loadNovel(path);
      if (generation !== loadGeneration) return;
      const pages = paginateParagraphs(reflowParagraphs(text));
      const pageCount = pages.length;
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

      let textHidden = false;
      const renderPage = () => {
        box.replaceChildren();
        if (!textHidden) {
          for (const paragraph of pages[page]) {
            const paragraphElement = doc.createElementNS(
              XHTML,
              "p",
            ) as HTMLParagraphElement;
            paragraphElement.textContent = paragraph;
            paragraphElement.style.cssText =
              "text-indent:2em;margin:0 0 0.75em;";
            box.append(paragraphElement);
          }
        }
        pageLabel.textContent = `Page ${page + 1}/${pageCount}`;
        previous.disabled = page === 0;
        next.disabled = page >= pageCount - 1;
        pageInput.value = String(page + 1);
        pageInput.max = String(pageCount);
        pageInput.disabled = false;
        jumpButton.disabled = false;
      };

      setTextHidden = (hidden) => {
        textHidden = hidden;
        renderPage();
      };

      goToPage = (pageNumber) => {
        if (
          !Number.isInteger(pageNumber) ||
          pageNumber < 1 ||
          pageNumber > pageCount
        ) {
          status.textContent = `Enter a page number from 1 to ${pageCount}.`;
          return;
        }
        page = pageNumber - 1;
        renderPage();
        status.textContent = "";
        try {
          Zotero.Prefs.set(PREF_PROGRESS, JSON.stringify({ path, page }), true);
        } catch (e) {
          status.textContent = `Could not save reading progress: ${e}`;
        }
      };
      changePage = (offset) => goToPage?.(page + offset + 1);
      renderPage();
    } catch (e) {
      if (generation !== loadGeneration) return;
      status.textContent = `Failed to read file: ${e}`;
      box.textContent = "";
      pageLabel.textContent = "Page 0/0";
      previous.disabled = true;
      next.disabled = true;
      pageInput.disabled = true;
      jumpButton.disabled = true;
      changePage = undefined;
      goToPage = undefined;
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
