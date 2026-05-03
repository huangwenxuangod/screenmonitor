export type ExtractedArticle = {
  title: string;
  summary: string;
  bodyMarkdown: string;
};

export type LayoutDraftRecord = {
  id: string;
  conversation_id: string;
  journey_id: string;
  message_id: string;
  source_markdown: string;
  rendered_markdown: string;
  rendered_html: string;
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
};

const ARTICLE_TAIL_PATTERNS = [
  /\n{2,}\*\*合规风控\*\*[\s\S]*$/m,
  /\n{2,}合规风控[\s\S]*$/m,
  /\n{2,}如果你想继续调[\s\S]*$/m,
  /\n{2,}如果你愿意，我可以继续帮你[:：][\s\S]*$/m,
  /\n{2,}搜索一下[^\n]*$/gm,
  /\n{2,}基于第一个选题[^\n]*$/gm,
  /\n{2,}给我生成一篇内容[^\n]*$/gm,
];

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "highlight"; lines: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "cta"; lines: string[] }
  | { type: "divider"; lines: string[] }
  | { type: "image"; lines: string[] };

export function extractArticleFromAssistantMessage(content: string): ExtractedArticle | null {
  const title = captureSection(content, "主标题", "公众号摘要");
  const summary = captureSection(content, "公众号摘要", "备选标题");
  const body = sanitizeArticlePreviewMarkdown(captureBody(content));

  if (title && body) {
    return {
      title: title.trim(),
      summary: summary.trim(),
      bodyMarkdown: body.trim(),
    };
  }

  return extractArticleFromRenderedMarkdown(content) ?? extractArticleFromLooseLongform(content);
}

export function renderWechatHtml(markdown: string) {
  const blocks = parseMarkdown(markdown);
  const html = blocks.map(renderBlock).join("");
  return `<section style="${containerStyle}">${html}</section>`;
}

export function sanitizeArticlePreviewMarkdown(markdown: string) {
  let next = markdown;

  for (const pattern of ARTICLE_TAIL_PATTERNS) {
    next = next.replace(pattern, "");
  }

  return next
    .replace(/---+\s*(?=#{1,3}\s)/g, "")
    .replace(/:::cta\s*\n?\*{0,2}\s*:::?/g, "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^\s*>\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeLayoutMarkdown(markdown: string) {
  let text = markdown.replace(/\r\n/g, "\n").trim();
  text = splitInlineHeadings(text);
  text = splitInlineOrderedLists(text);
  return text.trim();
}

function splitInlineHeadings(markdown: string) {
  const withHeadingBreaks = markdown
    .replace(/([^\n#])\s*(#{1,3}\s)/g, "$1\n\n$2")
    .replace(/(#{1,3}\s[^\n]{6,80})(#{1,3}\s)/g, "$1\n\n$2");
  const lines = withHeadingBreaks.split("\n");

  return lines
    .map((line) => {
      const trimmed = line.trim();
      const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (!headingMatch) {
        return line;
      }

      const marker = headingMatch[1];
      const content = headingMatch[2].trim();
      const splitIndex = findSafeHeadingSplitIndex(content);
      if (splitIndex < 0) {
        return `${marker} ${content}`;
      }

      const headingText = content.slice(0, splitIndex).trim();
      const restText = content.slice(splitIndex).trim();
      if (!headingText || !restText) {
        return `${marker} ${content}`;
      }

      return `${marker} ${headingText}\n\n${restText}`;
    })
    .join("\n");
}

function findSafeHeadingSplitIndex(content: string) {
  const candidates = [...content.matchAll(/[。！？?!]/g)]
    .map((match) => (typeof match.index === "number" ? match.index + match[0].length : -1))
    .filter((index) => index > 0);

  for (const index of candidates) {
    const headingText = content.slice(0, index).trim();
    const restText = content.slice(index).trim();
    if (headingText.length >= 8 && headingText.length <= 36 && restText.length >= 10) {
      return index;
    }
  }

  const sentenceStarterPatterns = [
    /这是/,
    /很多人/,
    /我这次/,
    /之前/,
    /现在/,
    /如果/,
    /你会/,
    /这种/,
    /对于/,
  ];

  for (const pattern of sentenceStarterPatterns) {
    const match = content.match(pattern);
    const index = match?.index ?? -1;
    if (index > 0) {
      const headingText = content.slice(0, index).trim();
      const restText = content.slice(index).trim();
      if (headingText.length >= 8 && headingText.length <= 42 && restText.length >= 8) {
        return index;
      }
    }
  }

  return -1;
}

function splitInlineOrderedLists(markdown: string) {
  return markdown.replace(/([。！？?!；;])\s+((?:\d+\.\s)|(?:-\s(?:\[[xX ]\]\s+)?)|(?:-\s))/g, "$1\n$2");
}

export function applyDefaultWechatLayout(markdown: string) {
  const normalized = normalizeLayoutMarkdown(markdown);
  if (!normalized) return "";

  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const nextBlocks = blocks.flatMap((block) => formatDefaultBlock(block));

  if (!nextBlocks.length) return normalized;

  const lastIndex = nextBlocks.length - 1;
  const lastBlock = nextBlocks[lastIndex];
  if (lastBlock && shouldWrapAsCta(lastBlock)) {
    nextBlocks[lastIndex] = `:::cta\n${stripCustomBlock(lastBlock)}\n:::`;
  }

  return nextBlocks.join("\n\n").trim();
}

function captureSection(content: string, startLabel: string, endLabel: string) {
  const escapedStart = escapeRegExp(`**${startLabel}**`);
  const escapedEnd = escapeRegExp(`**${endLabel}**`);
  const match = content.match(new RegExp(`${escapedStart}\\s*([\\s\\S]*?)\\s*${escapedEnd}`));
  return match?.[1] ?? "";
}

function captureBody(content: string) {
  const startLabel = escapeRegExp("**完整初稿**");
  const match = content.match(
    new RegExp(
      `${startLabel}\\s*([\\s\\S]*?)(?:\\n\\n\\*\\*合规风控\\*\\*|\\n\\n合规风控|\\n\\n如果你想继续调|\\n\\n如果你愿意，我可以继续帮你[:：]|$)`
    )
  );
  return match?.[1] ?? "";
}

function extractArticleFromRenderedMarkdown(content: string): ExtractedArticle | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized.startsWith("# ")) {
    return null;
  }

  const lines = normalized.split("\n");
  const title = lines[0]?.replace(/^#\s+/, "").trim();
  if (!title) {
    return null;
  }

  let cursor = 1;
  while (cursor < lines.length && !lines[cursor].trim()) {
    cursor += 1;
  }

  let summary = "";
  if (cursor < lines.length && lines[cursor].trim().startsWith(">")) {
    summary = lines[cursor].trim().replace(/^>\s*/, "").trim();
    cursor += 1;
  }

  const remaining = lines.slice(cursor).join("\n");
  const body = sanitizeArticlePreviewMarkdown(
    stripRedundantArticleLead(
      removeSection(removeSection(remaining.trim(), "备选标题"), "参考说明"),
      title
    )
  );

  if (!body) {
    return null;
  }

  return {
    title,
    summary,
    bodyMarkdown: body,
  };
}

function extractArticleFromLooseLongform(content: string): ExtractedArticle | null {
  const normalized = sanitizeArticlePreviewMarkdown(content.replace(/\r\n/g, "\n").trim());
  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 4) {
    return null;
  }

  const paragraphBlocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const headingCount = lines.filter((line) => /^(#{1,3}\s|[一二三四五六七八九十]+[、.．]|[0-9]+[、.．])/.test(line)).length;
  const totalLength = normalized.replace(/\s+/g, "").length;

  const looksLikeLongform =
    totalLength >= 320 &&
    (paragraphBlocks.length >= 4 || headingCount >= 2);

  if (!looksLikeLongform) {
    return null;
  }

  const firstHeading = lines.find((line) => /^(#{1,3}\s|[一二三四五六七八九十]+[、.．]|[0-9]+[、.．])/.test(line));
  const inferredTitle = sanitizeLooseTitle(firstHeading ?? lines[0] ?? "");
  const body = normalized;

  if (!body) {
    return null;
  }

  return {
    title: inferredTitle || "长文草稿",
    summary: "",
    bodyMarkdown: body,
  };
}

function sanitizeLooseTitle(line: string) {
  const cleaned = line
    .replace(/^#{1,3}\s+/, "")
    .replace(/^[一二三四五六七八九十0-9]+[、.．]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();

  if (!cleaned) return "";
  if (cleaned.length > 32) {
    return cleaned.slice(0, 32).trim();
  }
  return cleaned;
}

function formatDefaultBlock(block: string): string[] {
  if (!block) return [];
  if (block.startsWith(":::")) {
    const normalizedCustom = normalizeCustomBlock(block);
    return normalizedCustom ? [normalizedCustom] : [];
  }
  const structuredParts = splitStructuredBlock(block);
  if (structuredParts) {
    return structuredParts.flatMap((part) => formatDefaultBlock(part));
  }
  if (
    /^#{1,3}\s/.test(block) ||
    /^>\s*/.test(block) ||
    /^-\s/.test(block) ||
    /^-\s\[[xX ]\]\s/.test(block) ||
    /^\d+\.\s/.test(block)
  ) {
    return [block];
  }

  const expandedInlineList = expandInlineOrderedListBlock(block);
  if (expandedInlineList) {
    return expandedInlineList;
  }

  return splitLongParagraph(block);
}

function splitStructuredBlock(block: string): string[] | null {
  const lines = block
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());

  if (lines.length <= 1) {
    return null;
  }

  const hasInternalStructure = lines.some((line, index) => {
    if (index === 0) return false;
    const trimmed = line.trim();
    return (
      /^#{1,3}\s/.test(trimmed) ||
      /^>\s*/.test(trimmed) ||
      /^-\s/.test(trimmed) ||
      /^-\s\[[xX ]\]\s/.test(trimmed) ||
      /^\d+\.\s/.test(trimmed)
    );
  });

  if (!hasInternalStructure) {
    return null;
  }

  const parts: string[] = [];
  let paragraphBuffer: string[] = [];
  let listBuffer: string[] = [];
  let listMode: "ordered" | "unordered" | null = null;
  let quoteBuffer: string[] = [];

  const flushParagraph = () => {
    if (!paragraphBuffer.length) return;
    parts.push(paragraphBuffer.join("\n").trim());
    paragraphBuffer = [];
  };

  const flushList = () => {
    if (!listBuffer.length) return;
    parts.push(listBuffer.join("\n").trim());
    listBuffer = [];
    listMode = null;
  };

  const flushQuote = () => {
    if (!quoteBuffer.length) return;
    parts.push(quoteBuffer.join("\n").trim());
    quoteBuffer = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (/^#{1,3}\s/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      parts.push(trimmed);
      continue;
    }

    if (/^>\s*$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (/^>\s*/.test(trimmed)) {
      flushParagraph();
      flushList();
      quoteBuffer.push(trimmed);
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      if (listMode === "unordered") {
        flushList();
      }
      listMode = "ordered";
      listBuffer.push(trimmed);
      continue;
    }

    if (/^-\s\[[xX ]\]\s/.test(trimmed) || /^-\s/.test(trimmed)) {
      flushParagraph();
      flushQuote();
      if (listMode === "ordered") {
        flushList();
      }
      listMode = "unordered";
      listBuffer.push(trimmed);
      continue;
    }

    flushList();
    flushQuote();
    paragraphBuffer.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();

  return parts.filter(Boolean);
}

function normalizeCustomBlock(block: string) {
  const match = block.match(/^:::(\w+)\s*([\s\S]*?)\n:::\s*$/);
  if (!match) return stripCustomBlock(block);

  const blockType = match[1];
  const body = match[2].trim();
  if (!body) return "";

  if (blockType === "cta" || blockType === "image") {
    return `:::${blockType}\n${body}\n:::`;
  }

  if (blockType === "quote") {
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `> ${line}`)
      .join("\n");
  }

  return body;
}

function splitLongParagraph(paragraph: string) {
  const compact = paragraph.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return [];
  if (compact.length <= 110) return [compact];

  const sentences = compact.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [compact];
  const parts: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const next = `${current}${sentence}`.trim();
    if (current && next.length > 78) {
      parts.push(current.trim());
      current = sentence.trim();
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length ? parts : [compact];
}

function expandInlineOrderedListBlock(block: string) {
  const compact = block.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  const markerMatches = compact.match(/\d+\.\s/g) ?? [];
  if (markerMatches.length < 2) {
    return null;
  }

  const firstMarkerIndex = compact.search(/\d+\.\s/);
  if (firstMarkerIndex <= 0) {
    return null;
  }

  const intro = compact.slice(0, firstMarkerIndex).trim();
  const listPart = compact.slice(firstMarkerIndex).trim();
  const items = listPart.match(/\d+\.\s[\s\S]*?(?=(?:\s\d+\.\s)|$)/g) ?? [];
  if (items.length < 2) {
    return null;
  }

  return [
    ...(intro ? splitLongParagraph(intro) : []),
    ...items.map((item) => item.trim()),
  ].filter(Boolean);
}

function shouldWrapAsCta(block: string) {
  const text = stripCustomBlock(block);
  if (!text || /^#{1,3}\s/.test(text) || /^>\s/.test(text) || /^-\s/.test(text) || /^\d+\.\s/.test(text)) {
    return false;
  }
  return /(如果你|如果这篇|欢迎|建议你|不妨|可以先|收藏|留言|评论区|转给|下一步)/.test(text) || text.length <= 88;
}

function stripCustomBlock(block: string) {
  return block
    .replace(/^:::\w+\s*/g, "")
    .replace(/\n:::\s*$/g, "")
    .trim();
}

function parseMarkdown(markdown: string): Block[] {
  const lines = normalizeLayoutMarkdown(markdown).split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      index++;
      continue;
    }

    if (line.startsWith(":::")) {
      const blockType = line.slice(3).trim() as Block["type"];
      const collected: string[] = [];
      index++;
      while (index < lines.length && lines[index].trim() !== ":::") {
        collected.push(lines[index]);
        index++;
      }
      if (index < lines.length && lines[index].trim() === ":::") {
        index++;
      }
      if (blockType === "highlight" || blockType === "quote" || blockType === "cta" || blockType === "divider" || blockType === "image") {
        blocks.push({ type: blockType, lines: collected });
        continue;
      }
    }

    if (line.startsWith("### ")) {
      blocks.push({ type: "heading", level: 3, text: line.slice(4).trim() });
      index++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "heading", level: 2, text: line.slice(3).trim() });
      index++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "heading", level: 1, text: line.slice(2).trim() });
      index++;
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s/, ""));
        index++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    if (/^-\s\[[xX ]\]\s/.test(line) || line.startsWith("- ")) {
      const items: string[] = [];
      while (
        index < lines.length &&
        (/^-\s\[[xX ]\]\s/.test(lines[index].trim()) || lines[index].trim().startsWith("- "))
      ) {
        items.push(normalizeTaskListItem(lines[index].trim()));
        index++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^>\s*$/.test(line)) {
      index++;
      continue;
    }

    if (/^>\s*/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s*/.test(lines[index].trim())) {
        const normalizedQuote = lines[index].trim().replace(/^>\s*/, "").trim();
        if (normalizedQuote) {
          quoteLines.push(normalizedQuote);
        }
        index++;
      }
      if (quoteLines.length) {
        blocks.push({ type: "blockquote", lines: quoteLines });
      }
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (
        !current ||
        current.startsWith("#") ||
        current.startsWith("- ") ||
        /^-\s\[[xX ]\]\s/.test(current) ||
        /^\d+\.\s/.test(current) ||
        /^>\s*/.test(current) ||
        current.startsWith(":::")
      ) {
        break;
      }
      paragraphLines.push(lines[index]);
      index++;
    }
    if (!paragraphLines.length) {
      index++;
      continue;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ").trim() });
  }

  return blocks;
}

function renderBlock(block: Block) {
  switch (block.type) {
    case "heading":
      return renderHeading(block.level, block.text);
    case "paragraph":
      return `<p style="${paragraphStyle}">${formatInline(block.text)}</p>`;
    case "list":
      return block.ordered
        ? `<ol style="${orderedListStyle}">${block.items
            .map(
              (item) =>
                `<li style="${listItemStyle}"><span style="${listContentStyle}">${formatInline(item)}</span></li>`
            )
            .join("")}</ol>`
        : `<ul style="${unorderedListStyle}">${block.items
            .map(
              (item) =>
                `<li style="${listItemStyle}"><span style="${listContentStyle}">${formatInline(item)}</span></li>`
            )
            .join("")}</ul>`;
    case "blockquote":
      return `<blockquote style="${blockquoteStyle}">${block.lines.map((line) => `<p style="${blockquoteParagraphStyle}">${formatInline(line)}</p>`).join("")}</blockquote>`;
    case "highlight":
      return `<section style="${highlightStyle}">${block.lines.map((line) => `<p style="${highlightParagraphStyle}">${formatInline(line)}</p>`).join("")}</section>`;
    case "quote":
      return `<section style="${quoteCardStyle}">${block.lines.map((line) => `<p style="${quoteParagraphStyle}">${formatInline(line)}</p>`).join("")}</section>`;
    case "cta":
      return `<section style="${ctaStyle}">${block.lines.map((line) => `<p style="${ctaParagraphStyle}">${formatInline(line)}</p>`).join("")}</section>`;
    case "divider":
      return `<section style="${dividerWrapStyle}"><div style="${dividerLineStyle}"></div>${block.lines[0] ? `<span style="${dividerLabelStyle}">${formatInline(block.lines[0].trim())}</span>` : ""}</section>`;
    case "image":
      return `<section style="${imagePlaceholderStyle}"><span style="${imagePlaceholderLabelStyle}">配图建议</span>${block.lines.map((line) => `<p style="${imagePlaceholderTextStyle}">${formatInline(line)}</p>`).join("")}</section>`;
    default:
      return "";
  }
}

function renderHeading(level: 1 | 2 | 3, text: string) {
  if (level === 1) {
    return `<h1 style="${h1Style}">${formatInline(text)}</h1>`;
  }
  if (level === 2) {
    return `<section style="${sectionHeadingWrapStyle}"><div style="${sectionHeadingLineStyle}"></div><h2 style="${h2Style}">${formatInline(text)}</h2><div style="${sectionHeadingBottomLineStyle}"></div></section>`;
  }
  return `<h3 style="${h3Style}">${formatInline(text)}</h3>`;
}

function formatInline(text: string) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^✅\s/g, `<span style="${checkIconStyle}">✅</span>`)
    .replace(/^⬜\s/g, `<span style="${checkIconStyle}">⬜</span>`)
    .replace(/\*\*(.*?)\*\*/g, `<strong style="${strongStyle}">$1</strong>`)
    .replace(/`([^`]+)`/g, `<code style="${codeStyle}">$1</code>`);
}

function normalizeTaskListItem(line: string) {
  const checkedMatch = line.match(/^-\s\[(x|X)\]\s+(.+)$/);
  if (checkedMatch) {
    return `✅ ${checkedMatch[2].trim()}`;
  }

  const uncheckedMatch = line.match(/^-\s\[\s\]\s+(.+)$/);
  if (uncheckedMatch) {
    return `⬜ ${uncheckedMatch[1].trim()}`;
  }

  return line.slice(2).trim();
}

function stripRedundantArticleLead(markdown: string, title: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;

  while (cursor < lines.length && !lines[cursor].trim()) {
    cursor += 1;
  }

  while (
    cursor < lines.length &&
    /^知识库.*参考/.test(lines[cursor].trim())
  ) {
    cursor += 1;
    while (cursor < lines.length && lines[cursor].trim()) {
      cursor += 1;
    }
    while (cursor < lines.length && !lines[cursor].trim()) {
      cursor += 1;
    }
  }

  if (cursor < lines.length) {
    const normalizedTitle = title.replace(/\s+/g, "");
    const currentLine = lines[cursor].trim();
    if (
      currentLine.startsWith("# ") &&
      currentLine.replace(/^#\s+/, "").replace(/\s+/g, "") === normalizedTitle
    ) {
      cursor += 1;
      while (cursor < lines.length && !lines[cursor].trim()) {
        cursor += 1;
      }
    }
  }

  if (cursor < lines.length) {
    const normalizedTitle = title.replace(/\s+/g, "");
    const currentLine = lines[cursor]
      .trim()
      .replace(/^\*\*/, "")
      .replace(/\*\*$/, "");
    const normalizedCurrent = currentLine
      .replace(/^标题[:：]\s*/, "")
      .replace(/\s+/g, "");

    if (
      /^标题[:：]/.test(currentLine) &&
      normalizedCurrent === normalizedTitle
    ) {
      cursor += 1;
      while (cursor < lines.length && !lines[cursor].trim()) {
        cursor += 1;
      }
    }
  }

  return lines.slice(cursor).join("\n").trim();
}

function removeSection(markdown: string, heading: string) {
  const escapedHeading = escapeRegExp(heading);
  return markdown.replace(
    new RegExp(`^##\\s+${escapedHeading}\\s*\\n[\\s\\S]*?(?=^##\\s+|^#\\s+|\\Z)`, "m"),
    ""
  ).trim();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const themeVars = [
  "--niche-text:#222222",
  "--niche-text-soft:#645B51",
  "--niche-text-muted:#887D71",
  "--niche-primary:#B8864B",
  "--niche-primary-soft:#F7F2E8",
  "--niche-primary-line:#E7DACA",
  "--niche-surface:#FAF7F2",
  "--niche-quote-bg:#F8F4ED",
  "--niche-code-bg:#F4EFE7",
  "--niche-code-text:#9B6B34",
  "--niche-divider:#EAE1D6",
  "--niche-radius:14px",
  "--niche-font-size:16px",
  "--niche-line-height:1.85",
  "--niche-paragraph-gap:20px",
  "--niche-list-gap:10px",
].join(";");

const containerStyle = [
  themeVars,
  "max-width:100%",
  "padding:0 0 32px",
  "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif",
  "font-size:var(--niche-font-size)",
  "line-height:var(--niche-line-height)",
  "color:var(--niche-text)",
  "word-break:break-word",
].join(";");

const h1Style = [
  "margin:0 0 18px",
  "font-size:25px",
  "line-height:1.34",
  "font-weight:700",
  "color:var(--niche-text)",
  "letter-spacing:-0.02em",
].join(";");

const h2Style = [
  "margin:0 0 14px",
  "padding:0",
  "font-size:19px",
  "line-height:1.5",
  "font-weight:700",
  "color:var(--niche-text)",
  "letter-spacing:-0.01em",
  "text-align:center",
].join(";");

const h3Style = [
  "margin:32px 0 16px",
  "font-size:17px",
  "line-height:1.55",
  "font-weight:650",
  "color:var(--niche-text)",
].join(";");

const paragraphStyle = [
  "margin:0 0 var(--niche-paragraph-gap)",
  "color:var(--niche-text)",
  "text-align:left",
].join(";");

const orderedListStyle = [
  "margin:0 0 18px 22px",
  "padding:0",
  "color:var(--niche-primary)",
  "list-style-position:outside",
].join(";");

const unorderedListStyle = [
  "margin:0 0 18px 20px",
  "padding:0",
  "color:var(--niche-primary)",
  "list-style-position:outside",
].join(";");

const listItemStyle = [
  "margin:0 0 var(--niche-list-gap)",
  "padding-left:2px",
].join(";");

const listContentStyle = "color:var(--niche-text);";

const blockquoteStyle = [
  "margin:22px 0",
  "padding:12px 14px",
  "border-left:3px solid var(--niche-primary)",
  "background:var(--niche-quote-bg)",
  "border-radius:0 12px 12px 0",
].join(";");

const blockquoteParagraphStyle = "margin:0 0 8px;color:var(--niche-text-soft);line-height:1.8;";

const highlightStyle = [
  "margin:24px 0",
  "padding:16px 18px",
  "background:var(--niche-primary-soft)",
  "border:1px solid var(--niche-primary-line)",
  "border-radius:var(--niche-radius)",
].join(";");

const highlightParagraphStyle = "margin:0 0 10px;color:var(--niche-text);font-weight:600;";

const quoteCardStyle = [
  "margin:24px 0",
  "padding:16px 18px",
  "background:var(--niche-surface)",
  "border:1px solid var(--niche-divider)",
  "border-radius:var(--niche-radius)",
].join(";");

const quoteParagraphStyle = "margin:0 0 10px;color:var(--niche-text-soft);font-style:italic;line-height:1.8;";

const ctaStyle = [
  "margin:28px 0",
  "padding:16px 18px",
  "background:var(--niche-surface)",
  "border:1px solid var(--niche-primary-line)",
  "border-radius:16px",
  "box-shadow:inset 0 1px 0 rgba(255,255,255,0.7)",
].join(";");

const ctaParagraphStyle = "margin:0 0 8px;color:var(--niche-text);font-weight:520;line-height:1.8;";

const sectionHeadingWrapStyle = "margin:46px 0 30px;display:flex;flex-direction:column;justify-content:center;";
const sectionHeadingLineStyle = "width:100%;height:1px;background:var(--niche-divider);margin:0 0 20px;";
const sectionHeadingBottomLineStyle = "width:100%;height:1px;background:var(--niche-divider);margin:20px 0 0;";
const dividerWrapStyle = "display:flex;align-items:center;gap:12px;margin:26px 0;";
const dividerLineStyle = "flex:1;height:1px;background:var(--niche-divider);";
const dividerLabelStyle = "font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--niche-text-muted);";

const imagePlaceholderStyle = [
  "margin:24px 0",
  "padding:18px 18px",
  "border:1px dashed var(--niche-primary-line)",
  "border-radius:16px",
  "background:var(--niche-surface)",
].join(";");

const imagePlaceholderLabelStyle = [
  "display:inline-block",
  "margin-bottom:8px",
  "padding:4px 8px",
  "border-radius:999px",
  "background:var(--niche-primary-soft)",
  "font-size:11px",
  "letter-spacing:0.1em",
  "text-transform:uppercase",
  "color:var(--niche-text-soft)",
].join(";");

const imagePlaceholderTextStyle = "margin:0;color:var(--niche-text-muted);line-height:1.75;";
const strongStyle = "color:var(--niche-text);font-weight:700;";
const codeStyle = "padding:2px 6px;border-radius:6px;background:var(--niche-code-bg);font-size:0.9em;font-family:'SFMono-Regular',Consolas,monospace;color:var(--niche-code-text);";
const checkIconStyle = "display:inline-block;margin-right:6px;";
