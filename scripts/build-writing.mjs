#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const postsDir = path.join(root, "posts");
const writingDir = path.join(root, "writing");
const check = process.argv.includes("--check");
const siteUrl = "https://sh-patterson.github.io";

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function parseValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatter(source, file) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${file} is missing frontmatter`);
  const data = {};
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && key) {
      data[key] = Array.isArray(data[key]) ? data[key] : [];
      data[key].push(parseValue(listItem[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    key = pair[1];
    const value = pair[2].trim();
    if (value === "") data[key] = [];
    else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map((item) => parseValue(item)).filter(Boolean);
    } else {
      data[key] = parseValue(value);
    }
  }
  const body = source.slice(match[0].length).trim();
  return { data, body };
}

function slugFromFile(file) {
  return path.basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function inline(text) {
  let value = escapeHtml(text)
    .replace(/\\-/g, "-")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return value;
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let list = null;
  let blockquote = [];
  let code = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  }
  function flushList() {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  }
  function flushQuote() {
    if (!blockquote.length) return;
    html.push(`<blockquote><p>${inline(blockquote.join(" "))}</p></blockquote>`);
    blockquote = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (code) {
      if (trimmed.startsWith("```")) {
        html.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
        code = null;
      } else code.lines.push(line);
      continue;
    }
    if (trimmed.startsWith("```")) {
      flushParagraph(); flushList(); flushQuote();
      code = { lines: [] };
      continue;
    }
    if (!trimmed) {
      flushParagraph(); flushList(); flushQuote();
      continue;
    }
    if (/^<!--[\s\S]*-->$/.test(trimmed)) {
      flushParagraph(); flushList(); flushQuote();
      html.push(trimmed);
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const level = heading[1].length;
      if (level === 1) continue;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(trimmed)) {
      flushParagraph(); flushList(); flushQuote();
      html.push("<hr>");
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph(); flushList();
      blockquote.push(trimmed.replace(/^>\s?/, ""));
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph(); flushQuote();
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) flushList();
      list = list || { type, items: [] };
      list.items.push((ordered || unordered)[1]);
      continue;
    }
    flushList(); flushQuote();
    paragraph.push(trimmed);
  }
  flushParagraph(); flushList(); flushQuote();
  if (code) html.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
  return html.join("\n");
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

function rssDate(date) {
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

function renderPost(post) {
  const title = escapeHtml(post.title);
  const dek = escapeHtml(post.dek);
  const url = `${siteUrl}/writing/${post.slug}/`;
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.dek,
    datePublished: post.date,
    dateModified: post.date,
    author: { "@type": "Person", name: "Shawn Patterson", url: siteUrl },
    mainEntityOfPage: url,
  }, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | Shawn Patterson</title>
    <meta name="description" content="${dek}">
    <link rel="canonical" href="${url}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${dek}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${url}">
    <meta property="og:image" content="${siteUrl}/og-image.png">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${dek}">
    <meta name="twitter:image" content="${siteUrl}/og-image.png">
    <script type="application/ld+json">${json}</script>
    <link rel="icon" href="../../favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="../../style.css">
</head>
<body class="paper">
    <main class="paper-shell">
        <nav class="paper-nav" aria-label="Writing navigation">
            <a href="/">Home</a>
            <a href="/writing/">Writing</a>
        </nav>
        <article class="post">
            <header class="post-header">
                <p class="post-date">${formatDate(post.date)}</p>
                <h1>${title}</h1>
                <p class="post-dek">${dek}</p>
            </header>
            <div class="post-body">
${post.html}
            </div>
        </article>
        <footer class="post-footer">
            <p>I run Patterson Research, an AI-first research shop for Democratic campaigns and the firms that serve them. — <a href="https://github.com/sh-patterson">GitHub</a> · <a href="https://www.linkedin.com/in/shawn-patterson-573b98361/">LinkedIn</a></p>
        </footer>
    </main>
</body>
</html>
`;
}

function renderArchive(posts) {
  const byYear = new Map();
  for (const post of posts) {
    const year = post.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(post);
  }
  const groups = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, items]) => `
            <section class="writing-year" aria-labelledby="writing-${year}">
                <h2 id="writing-${year}">${year}</h2>
                <ol class="writing-list">
${items.map((post) => `                    <li>
                        <time datetime="${post.date}">${formatDate(post.date)}</time>
                        <a href="/writing/${post.slug}/">${escapeHtml(post.title)}</a>
                        <p>${escapeHtml(post.dek)}</p>
                    </li>`).join("\n")}
                </ol>
            </section>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Writing | Shawn Patterson</title>
    <meta name="description" content="Notes on research, AI systems, and the craft of finding things out.">
    <link rel="canonical" href="${siteUrl}/writing/">
    <link rel="alternate" type="application/rss+xml" title="Shawn Patterson writing" href="/writing/feed.xml">
    <link rel="icon" href="../favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="../style.css">
</head>
<body class="writing-archive">
    <main class="site-shell writing-shell">
        <header class="writing-header">
            <nav class="contact-inline" aria-label="Writing navigation">
                <a href="/">Home</a>
                <a href="/writing/feed.xml">RSS</a>
            </nav>
            <h1>Writing</h1>
            <p class="section-copy">Notes on research, AI systems, and the craft of finding things out.</p>
        </header>
${groups || "        <p class=\"section-copy\">Published essays will appear here after Shawn's review.</p>"}
    </main>
</body>
</html>
`;
}

function renderFeed(posts) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Shawn Patterson writing</title>
    <link>${siteUrl}/writing/</link>
    <description>Notes on research, AI systems, and the craft of finding things out.</description>
${posts.map((post) => `    <item>
      <title>${escapeHtml(post.title)}</title>
      <link>${siteUrl}/writing/${post.slug}/</link>
      <guid>${siteUrl}/writing/${post.slug}/</guid>
      <pubDate>${rssDate(post.date)}</pubDate>
      <description><![CDATA[${post.html}]]></description>
    </item>`).join("\n")}
  </channel>
</rss>
`;
}

function renderHomeSection(posts) {
  const items = posts.slice(0, 3).map((post) => `                <article>
                    <div class="project-title">
                        <h3><a href="/writing/${post.slug}/">${escapeHtml(post.title)}</a></h3>
                        <span class="proof-object">${formatDate(post.date)}</span>
                    </div>
                    <p>${escapeHtml(post.dek)}</p>
                </article>`).join("\n");
  const list = items ? `            <div class="project-list writing-home-list">\n${items}\n            </div>` : "";
  return `        <section class="folio-section writing-home" aria-labelledby="writing-title">
            <div class="folio-inner">
            <h2 id="writing-title">Writing</h2>
${list}
            <p class="section-copy writing-archive-link"><a href="/writing/">Browse the archive →</a></p>
            </div>
        </section>`;
}

async function loadPosts() {
  if (!existsSync(postsDir)) return [];
  const files = (await readdir(postsDir)).filter((file) => file.endsWith(".md")).sort();
  const posts = [];
  for (const file of files) {
    const source = await readFile(path.join(postsDir, file), "utf8");
    const { data, body } = parseFrontmatter(source, file);
    for (const field of ["title", "date", "dek", "draft"]) {
      if (data[field] === undefined || data[field] === "") throw new Error(`${file} is missing ${field}`);
    }
    const tags = Array.isArray(data.tags) ? data.tags : [];
    if (tags.length > 3) throw new Error(`${file} has more than 3 tags`);
    const slug = data.slug || slugFromFile(file);
    posts.push({ ...data, tags, slug, sourceFile: file, html: renderMarkdown(body) });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}

async function writeChecked(file, content, outputs) {
  outputs.set(file, content);
  if (check) {
    const current = await readFile(file, "utf8").catch(() => null);
    if (current !== content) throw new Error(`Writing build is stale: ${path.relative(root, file)}`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

async function updateHomepage(published, outputs) {
  const file = path.join(root, "index.html");
  const current = await readFile(file, "utf8");
  const start = "<!-- writing-section:start -->";
  const end = "<!-- writing-section:end -->";
  if (!current.includes(start) || !current.includes(end)) return;
  const next = current.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${renderHomeSection(published)}\n        ${end}`);
  await writeChecked(file, next, outputs);
}

async function main() {
  const posts = await loadPosts();
  const published = posts.filter((post) => !post.draft);
  const outputs = new Map();
  if (!check) await rm(writingDir, { recursive: true, force: true });
  for (const post of posts) {
    await writeChecked(path.join(writingDir, post.slug, "index.html"), renderPost(post), outputs);
  }
  await writeChecked(path.join(writingDir, "index.html"), renderArchive(published), outputs);
  await writeChecked(path.join(writingDir, "feed.xml"), renderFeed(published), outputs);
  await updateHomepage(published, outputs);
  const verb = check ? "checked" : "built";
  console.log(`Writing ${verb}: ${posts.length} posts (${published.length} published).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
