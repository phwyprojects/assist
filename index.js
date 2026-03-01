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

const SYSTEM_PROMPT = `You are a smart, efficient assistant for Matt, an artist manager. Matt manages an artist named Ninajirachi.

Matt will email you directly to get things done — asking questions, forwarding emails from promoters or press, thinking through decisions, drafting communications, managing the tour schedule, keeping track of tasks. Treat every message as a direct conversation with Matt.

As you work together, you'll learn more about Ninajirachi, the team, preferences, and how Matt likes things handled. Build on that context over time.

Tone: Sharp and direct. Matt is busy. Don't pad responses. Get to the point, then offer to go deeper if needed.

When Matt forwards an email or pastes one in, read it and figure out what's needed — a reply draft, a task, a schedule item, or just a summary and your take on it.

You have no tools — just respond conversationally in plain text. If you're drafting an email, format it clearly. If there are tasks or schedule items, list them cleanly. No JSON, no structured output — just a natural email response that's easy to read.`;

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));

const THREAD_KEY = "matt:conversation";

app.get("/", (req, res) => res.send("Running ✓"));

app.post("/inbound", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    if (event.type !== "email.received") return;

    const { email_id, from, subject } = event.data;
    console.log(`Received email | From: ${from} | Subject: ${subject} | ID: ${email_id}`);

    // Fetch the full email content using the receiving API
    const emailContent = await fetchReceivedEmail(email_id);
    if (!emailContent) return;

    console.log("Email content keys:", Object.keys(emailContent));

    const body = emailContent.text || emailContent.plain_text || stripHtml(emailContent.html) || "";
    console.log("Body length:", body.length, "| Body preview:", body.slice(0, 100));

    if (!body.trim()) {
      console.log("Empty body, skipping");
      return;
    }

    const senderEmail = parseEmail(from);
    const allowedEmails = (process.env.ALLOWED_EMAILS || YOUR_EMAIL).split(",").map(e => e.trim().toLowerCase());
    if (!allowedEmails.includes(senderEmail.toLowerCase())) {
      console.log(`Ignoring unknown sender: ${senderEmail}`);
      return;
    }

    const cleanedBody = cleanQuotedText(body);
    if (!cleanedBody.trim()) return;

    const raw = await redis.get(THREAD_KEY);
    const history = raw ? JSON.parse(raw) : [];
    history.push({ role: "user", content: cleanedBody });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content.map((b) => b.text || "").join("").trim();
    history.push({ role: "assistant", content: reply });
    const trimmed = history.length > 40 ? history.slice(-40) : history;
    await redis.set(THREAD_KEY, JSON.stringify(trimmed));

    await resend.emails.send({
      from: `Claude <${ASSISTANT_EMAIL}>`,
      to: senderEmail,
      subject: subject?.startsWith("Re:") ? subject : `Re: ${subject}`,
      text: reply,
      html: toHtml(reply),
    });

    console.log("Reply sent to:", senderEmail);
  } catch (err) {
    console.error("Error:", err);
  }
});

// Fetch received email content from Resend's receiving API
async function fetchReceivedEmail(emailId) {
  // Try multiple possible endpoint formats
  const endpoints = [
    `https://api.resend.com/emails/receiving/${emailId}`,
    `https://api.resend.com/receiving/emails/${emailId}`,
    `https://api.resend.com/emails/${emailId}`,
  ];

  for (const url of endpoints) {
    try {
      console.log("Trying endpoint:", url);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      const data = await response.json();
      console.log(`Endpoint ${url} status:`, response.status, "| Keys:", Object.keys(data));
      if (response.ok && (data.text || data.html || data.subject)) {
        return data;
      }
    } catch (err) {
      console.log("Endpoint failed:", url, err.message);
    }
  }
  return null;
}

function toHtml(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:32px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;">
  <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.7;color:#222;">${escaped}</pre>
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;">Claude · ${ASSISTANT_EMAIL}</div>
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
