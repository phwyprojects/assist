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
const CONTEXT_SHEET_ID = process.env.CONTEXT_SHEET_ID;

const BASE_SYSTEM_PROMPT = `You are MP, a smart and efficient assistant for Matt, an artist manager. Matt manages an artist named Ninajirachi.

Matt will email you directly to get things done — asking questions, forwarding emails from promoters or press, thinking through decisions, drafting communications, managing the tour schedule, keeping track of tasks.

Tone: Sharp and direct. Matt is busy. Don't pad responses. Get to the point, then offer to go deeper if needed.

When Matt forwards an email or pastes one in, read it and figure out what's needed — a reply draft, a task, a schedule item, or just a summary and your take on it.

You have access to:
- Matt's live tour schedule (Google Sheet, always up to date)
- A key context and info sheet with background on Ninajirachi, team, and ongoing projects
- Live announced show data from Seated — when Matt asks about announced or confirmed shows, this data is fetched automatically and provided to you in the context below. Do not say you cannot access Seated or external APIs — you can, and the data will be present in your context when relevant.
- The ability to read URLs that Matt pastes into emails — their content will be provided to you automatically
- The ability to read PDF and image attachments that Matt sends or forwards
- Permanent memory of things Matt has asked you to remember

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

    const { email_id, from, subject, cc = [] } = event.data;
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
    console.log("Cleaned body:", cleanedBody.slice(0, 300));
    console.log("URLs found:", extractUrls(cleanedBody));

    // Memory commands
    const memoryMatch = cleanedBody.match(/^remember[:\s]+(.+)/is);
    const forgetMatch = cleanedBody.match(/^forget[:\s]+(.+)/is);
    const showMemoryMatch = cleanedBody.match(/^(show memory|what do you remember|memory)/i);

    if (memoryMatch) {
      await addMemory(memoryMatch[1].trim());
      await sendReply(senderEmail, subject, `Got it, saved to permanent memory:\n\n"${memoryMatch[1].trim()}"`, null);
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

    // Extract URLs from email and fetch content
    const urls = extractUrls(cleanedBody);
    const attachmentMeta = event.data.attachments || [];
    // Only fetch Seated shows when explicitly asked
    const wantsShows = /announced|confirmed shows|show list|tour dates|seated|upcoming shows|what shows|which shows|nina.*shows|shows.*nina/i.test(cleanedBody);

    // Spotify track lookup
    const spotifyMatch = cleanedBody.match(/(?:isrc|track length|duration|spotify).*?["‘’“”]?([^"\n]{3,60})["‘’“”]?/i)
      || cleanedBody.match(/(?:look up|find|get|search).*?(?:track|song)[^\w]+([\w][^
]{3,60})/i);

    const [memories, sheetData, contextData, seatedShows, spotifyData, attachments, ...urlContents] = await Promise.all([
      getMemories(),
      fetchAllSheetTabs(SHEET_ID),
      fetchAllSheetTabs(CONTEXT_SHEET_ID),
      wantsShows ? fetchSeatedShows() : Promise.resolve(null),
      spotifyMatch ? searchSpotifyTrack(spotifyMatch[1].trim()) : Promise.resolve(null),
      fetchAttachments(email_id, attachmentMeta),
      ...urls.map(url => fetchUrl(url)),
    ]);

    const memoryContext = memories.length
      ? `\n\nPermanent context:\n${memories.map(m => `- ${m}`).join("\n")}`
      : "";

    const sheetContext = sheetData
      ? `\n\nTour schedule (Google Sheet):\n${sheetData}`
      : "";

    const seatedContext = seatedShows
      ? `\n\nUpcoming shows (live from Seated):\n${seatedShows}`
      : "";

    const contextSheetContext = contextData
      ? `\n\nKey context and info:\n${contextData}`
      : "";

    const spotifyContext = spotifyData
      ? `\n\nSpotify track data:\n${spotifyData}`
      : "";

    const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + sheetContext + seatedContext + contextSheetContext + spotifyContext;

    const raw = await redis.get(THREAD_KEY);
    const history = raw ? JSON.parse(raw) : [];

    // Build user message - include URL content and attachments inline
    const userContent = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.type === "document") {
          userContent.push({ type: "document", source: { type: "base64", media_type: att.media_type, data: att.data } });
        } else if (att.type === "image") {
          userContent.push({ type: "image", source: { type: "base64", media_type: att.media_type, data: att.data } });
        }
      }
    }

    // Append URL content directly to user message text
    const fetchedUrls = urlContents.filter(Boolean);
    const urlSection = fetchedUrls.length
      ? "\n\n---\nI fetched the following URLs for you:\n" + fetchedUrls.map((c, i) => `[${urls[i]}]:\n${c}`).join("\n\n")
      : "";

    userContent.push({ type: "text", text: cleanedBody + urlSection });

    history.push({ role: "user", content: userContent });

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

    const ccEmails = cc.map(c => parseEmail(c)).filter(e => e && e !== senderEmail);
    await sendReply(senderEmail, subject, reply, ccEmails.length ? ccEmails : null);
    console.log("Reply sent to:", senderEmail);
  } catch (err) {
    console.error("Error:", err);
  }
});

// Fetch all tabs from Google Sheet using Sheets API
async function fetchAllSheetTabs(sheetId) {
  if (!sheetId || !GOOGLE_API_KEY) return null;
  try {
    // First get the list of sheets/tabs
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${GOOGLE_API_KEY}&fields=sheets.properties`;
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
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tab)}?key=${GOOGLE_API_KEY}`;
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

async function sendReply(to, subject, text, cc = null) {
  const opts = {
    from: `MP <${ASSISTANT_EMAIL}>`,
    to,
    subject: subject?.startsWith("Re:") ? subject : `Re: ${subject}`,
    text,
    html: toHtml(text),
  };
  if (cc && cc.length) opts.cc = cc;
  await resend.emails.send(opts);
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

// Extract URLs from text
function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const matches = text.match(urlRegex) || [];
  // Skip google sheets/docs (already handled separately), limit to 3 URLs
  return matches
    .filter(url => !url.includes("docs.google.com") && !url.includes("sheets.google.com"))
    .slice(0, 3);
}

// Fetch a URL and return its text content
async function fetchUrl(url) {
  try {
    console.log("Fetching URL:", url);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MPAssistant/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    // Strip HTML tags and clean up whitespace
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000); // Cap at 3000 chars per URL
    return text;
  } catch (err) {
    console.log("URL fetch failed:", url, err.message);
    return null;
  }
}

// Fetch attachments from Resend and convert to base64
async function fetchAttachments(emailId, attachmentMeta) {
  if (!attachmentMeta || attachmentMeta.length === 0) return [];
  
  const results = [];
  for (const att of attachmentMeta.slice(0, 5)) { // max 5 attachments
    try {
      console.log("Fetching attachment:", att.filename, att.content_type);
      
      // Fetch attachment from Resend attachments API
      const url = `https://api.resend.com/emails/receiving/${emailId}/attachments/${att.id}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      
      if (!response.ok) {
        const errText = await response.text();
        console.log("Attachment fetch failed:", response.status, errText);
        continue;
      }
      
      const data = await response.json();
      console.log("Attachment API response keys:", Object.keys(data));

      // Resend returns a download_url, not the content directly
      if (!data.download_url) {
        console.log("No download_url in attachment response");
        continue;
      }

      const dlResponse = await fetch(data.download_url);
      if (!dlResponse.ok) {
        console.log("Attachment download failed:", dlResponse.status);
        continue;
      }

      const buffer = await dlResponse.arrayBuffer();
      const base64Data = Buffer.from(buffer).toString("base64");
      console.log("Attachment downloaded, base64 length:", base64Data.length);
      
      const ct = att.content_type || "";
      
      if (ct === "application/pdf") {
        results.push({ type: "document", media_type: "application/pdf", data: base64Data });
      } else if (ct.includes("image/")) {
        const imgType = ct.includes("png") ? "image/png" : ct.includes("gif") ? "image/gif" : ct.includes("webp") ? "image/webp" : "image/jpeg";
        results.push({ type: "image", media_type: imgType, data: base64Data });
      } else if (ct.includes("word") || ct.includes("document") || att.filename?.endsWith(".docx") || att.filename?.endsWith(".doc")) {
        // Word docs — treat as document with PDF media type won't work, extract as text note
        results.push({ type: "document", media_type: "application/pdf", data: base64Data });
      }
    } catch (err) {
      console.log("Attachment error:", err.message);
    }
  }
  
  return results;
}

// Fetch Ninajirachi shows from Seated API
async function fetchSeatedShows() {
  try {
    console.log("Fetching Seated shows...");
    const response = await fetch(
      "https://cdn.seated.com/api/tour/22d23327-0a5a-4431-826d-3baa90fd57e0?include=tour-events",
      { headers: { "Accept": "application/vnd.api+json", "User-Agent": "Mozilla/5.0" } }
    );
    console.log("Seated response status:", response.status);
    if (!response.ok) return null;
    const data = await response.json();
    console.log("Seated data keys:", Object.keys(data));
    console.log("Seated included count:", data.included?.length || 0);

    const events = data.included?.filter(i => i.type === "tour-events") || [];
    if (!events.length) {
      // Try alternate structure
      const altEvents = data.data || [];
      console.log("Alt events count:", altEvents.length);
      if (altEvents.length) {
        const lines = altEvents.map(e => {
          const a = e.attributes || {};
          return `${a.starts_at_date || a.date || ""} | ${a.venue_name || a.venue || ""} | ${a.city || ""}, ${a.country_code || a.country || ""} | ${a.ticket_status || ""}`;
        });
        return lines.join("\n");
      }
      return null;
    }

    // Log first event to check field names
    if (events.length > 0) {
      console.log("Sample Seated event attributes:", JSON.stringify(events[0].attributes, null, 2).slice(0, 500));
    }

    const lines = events.map(e => {
      const a = e.attributes || {};
      const date = a.starts_at_date || a.starts_at || a.date || "";
      const venue = a.venue_name || a.name || "";
      const city = a.city || a.location || "";
      const country = a.country_code || a.country || "";
      const status = a.ticket_status || a.status || "";
      return `${date} | ${venue} | ${city}, ${country} | ${status}`;
    }).filter(line => line.replace(/\|/g, "").trim());

    console.log("Seated shows found:", lines.length);
    return lines.join("\n");
  } catch (err) {
    console.error("Seated fetch error:", err);
    return null;
  }
}

// Spotify API
async function getSpotifyToken() {
  const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await response.json();
  return data.access_token;
}

async function searchSpotifyTrack(query) {
  try {
    const token = await getSpotifyToken();
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    const tracks = data.tracks?.items || [];
    if (!tracks.length) return "No tracks found.";
    return tracks.map(t => {
      const mins = Math.floor(t.duration_ms / 60000);
      const secs = String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0");
      const isrc = t.external_ids?.isrc || "N/A";
      return `${t.name} — ${t.artists.map(a => a.name).join(", ")}\nISRC: ${isrc}\nLength: ${mins}:${secs}\nAlbum: ${t.album.name} (${t.album.release_date?.slice(0,4)})`;
    }).join("\n\n");
  } catch (err) {
    console.error("Spotify error:", err);
    return null;
  }
}
