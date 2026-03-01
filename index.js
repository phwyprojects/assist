import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import { createClient } from "redis";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const YOUR_EMAIL = process.env.YOUR_EMAIL;
const ASSISTANT_EMAIL = process.env.ASSISTANT_EMAIL;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;

const BASE_SYSTEM_PROMPT = `You are MP, a smart and efficient assistant for Matt, an artist manager. Matt manages an artist named Ninajirachi.

Matt will email you directly to get things done — asking questions, forwarding emails from promoters or press, thinking through decisions, drafting communications, managing the tour schedule, keeping track of tasks.

Tone: Sharp and direct. Matt is busy. Don't pad responses. Get to the point, then offer to go deeper if needed.

When Matt forwards an email or pastes one in, read it and figure out what's needed — a reply draft, a task, a schedule item, or just a summary and your take on it.

Respond in plain text. If you're drafting an email, format it clearly. If there are tasks or schedule items, list them cleanly.`;

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));

const THREAD_KEY = "matt:conversation";
const MEMORY_KEY = "matt:memory";

app.get("/", (req, res) => res.send("Running ✓"));

app.post("/inbound", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    if (event.type !== "email.received") return;

    const { email_id, from, subject } = event.data;
    console.log(`Received | From: ${from} | Subject: ${subject}`);

    const emailContent = await fetchReceivedEmail(email_id);
    if (!emailContent) return;

    const body = emailContent.text || emailContent.plain_text || stripHtml(emailContent.html) || "";
    if (!body.trim()) return;

    const senderEmail = parseEmail(from);
    const allowedEmails = (process.env.ALLOWED_EMAILS || YOUR_EMAIL).split(",").map(e => e.trim().toLowerCase());
    if (!allowedEmails.includes(senderEmail.toLowerCase())) {
      console.log(`Ignoring unknown sender: ${senderEmail}`);
      return;
    }

    const cleanedBody = cleanQuotedText(body);
    if (!cleanedBody.trim()) return;

    // Memory commands
    const memoryMatch = cleanedBody.match(/^remember[:\s]+(.+)/is);
    const forgetMatch = cleanedBody.match(/^forget[:\s]+(.+)/is);
    const showMemoryMatch = cleanedBody.match(/^(show memory|what do you remember|memory)/i);

    if (memoryMatch) {
      await addMemory(memoryMatch[1].trim());
      await sendReply(senderEmail, subject, `Got it, saved to permanent memory:\n\n"${memoryMatch[1].trim()}"`);
      return;
    }

    if (forgetMatch) {
      const removed = await removeMemory(forgetMatch[1].trim());
      await sendReply(senderEmail, subject, removed ? `Removed from memory: "${forgetMatch[1].trim()}"` : `Couldn't find that in memory.`);
      return;
    }

    if (showMemoryMatch) {
      const memories = await getMemories();
      const memText = memories.length
        ? `Permanent memory:\n\n${memories.map((m, i) => `${i + 1}. ${m}`).join("\n")}`
        : `Nothing in permanent memory yet. Email "remember: [something]" to add things.`;
      await sendReply(senderEmail, subject, memText);
      return;
    }

    // Fetch memories and all sheet tabs in parallel
    const [memories, sheetData] = await Promise.all([
      getMemories(),
      fetchAllSheetTabs(),
    ]);

    const memoryContext = memories.length
      ? `\n\nPermanent context:\n${memories.map(m => `- ${m}`).join("\n")}`
      : "";

    const sheetContext = sheetData
      ? `\n\nGoogle Sheet data (all tabs):\n${sheetData}`
      : "";

    const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + sheetContext;

    const raw = await redis.get(THREAD_KEY);
    const history = raw ? JSON.parse(raw) : [];
    history.push({ role: "user", content: cleanedBody });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content.map((b) => b.text || "").join("").trim();
    history.push({ role: "assistant", content: reply });
    const trimmed = history.length > 40 ? history.slice(-40) : history;
    await redis.set(THREAD_KEY, JSON.stringify(trimmed));

    await sendReply(senderEmail, subject, reply);
    console.log("Reply sent to:", senderEmail);
  } catch (err) {
    console.error("Error:", err);
  }
});

// Fetch all tabs from Google Sheet using Sheets API
async function fetchAllSheetTabs() {
  if (!SHEET_ID || !GOOGLE_API_KEY) return null;
  try {
    // First get the list of sheets/tabs
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?key=${GOOGLE_API_KEY}&fields=sheets.properties`;
    const metaRes = await fetch(metaUrl);
    if (!metaRes.ok) {
      console.error("Sheets API meta error:", metaRes.status);
      return null;
    }
    const meta = await metaRes.json();
    const tabs = meta.sheets.map(s => s.properties.title);
    console.log("Sheet tabs:", tabs);

    // Fetch each tab's data
    const tabResults = await Promise.all(tabs.map(async (tab) => {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab)}?key=${GOOGLE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = data.values || [];
      if (rows.length === 0) return null;
      const text = rows.map(row => row.join(" | ")).join("\n");
      return `=== ${tab} ===\n${text}`;
    }));

    return tabResults.filter(Boolean).join("\n\n");
  } catch (err) {
    console.error("Sheet fetch error:", err);
    return null;
  }
}

// Memory functions
async function getMemories() {
  const raw = await redis.get(MEMORY_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function addMemory(item) {
  const memories = await getMemories();
  if (!memories.includes(item)) {
    memories.push(item);
    await redis.set(MEMORY_KEY, JSON.stringify(memories));
  }
  console.log("Memory added:", item);
}

async function removeMemory(item) {
  const memories = await getMemories();
  const filtered = memories.filter(m => !m.toLowerCase().includes(item.toLowerCase()));
  if (filtered.length < memories.length) {
    await redis.set(MEMORY_KEY, JSON.stringify(filtered));
    return true;
  }
  return false;
}

async function sendReply(to, subject, text) {
  await resend.emails.send({
    from: `MP <${ASSISTANT_EMAIL}>`,
    to,
    subject: subject?.startsWith("Re:") ? subject : `Re: ${subject}`,
    text,
    html: toHtml(text),
  });
}

async function fetchReceivedEmail(emailId) {
  const endpoints = [
    `https://api.resend.com/emails/receiving/${emailId}`,
    `https://api.resend.com/receiving/emails/${emailId}`,
    `https://api.resend.com/emails/${emailId}`,
  ];
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      const data = await response.json();
      if (response.ok && (data.text || data.html || data.subject)) return data;
    } catch (err) {
      console.log("Endpoint failed:", url, err.message);
    }
  }
  console.error("Could not fetch email content");
  return null;
}

function toHtml(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:32px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;">
  <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.7;color:#222;">${escaped}</pre>
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;">MP · ${ASSISTANT_EMAIL}</div>
</body></html>`;
}

function parseEmail(from = "") {
  const m = from.match(/<(.+)>/) || from.match(/(\S+@\S+)/);
  return m ? m[1] : from;
}

function stripHtml(html = "") {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanQuotedText(text = "") {
  return text
    .split("\n")
    .filter(l => !l.startsWith(">"))
    .join("\n")
    .replace(/On .+wrote:\s*$/ms, "")
    .replace(/[-_]{3,}[\s\S]*$/m, "")
    .trim();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Listening on port ${PORT}`);
  try {
    await redis.connect();
    console.log("Redis connected ✓");
  } catch (err) {
    console.error("Redis connection failed:", err);
  }
});
