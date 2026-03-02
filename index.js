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

You operate as an email assistant. When Matt emails you, your response is sent back as an email reply — including to anyone CC'd on the thread. You CAN and DO send real emails. Never say you can't send emails or can only respond in chat — that's incorrect. Your replies are delivered via email to Matt and any CC'd recipients automatically.

Matt will email you directly to get things done — asking questions, forwarding emails from promoters or press, thinking through decisions, drafting communications, managing the tour schedule, keeping track of tasks.

Tone: Sharp and direct. Matt is busy. Don't pad responses. Get to the point, then offer to go deeper if needed.

When Matt forwards an email or pastes one in, read it and figure out what's needed — a reply draft, a task, a schedule item, or just a summary and your take on it.

You have access to tools you can call at any time:
- fetch_url: fetch any webpage or URL
- search_spotify: search Spotify for track info including ISRC codes and track length
- get_announced_shows: get Ninajirachi publicly announced shows from Seated
- search_dropbox: search Matt's Dropbox for files by name or content (contracts, riders, press kits, etc.)

Use these tools proactively whenever they would help answer Matt's question. Do not say you cannot access external data — use your tools.

Respond in plain text. If you are drafting an email, format it clearly. If there are tasks or schedule items, list them cleanly.`;

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));

const THREAD_KEY = "matt:conversation";
const MEMORY_KEY = "matt:memory";

const TOOLS = [
  {
    name: "fetch_url",
    description: "Fetch the text content of any URL. Use when Matt pastes a link and wants you to read it.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to fetch" } },
      required: ["url"]
    }
  },
  {
    name: "search_spotify",
    description: "Search Spotify for a track. Returns track name, artist, ISRC code, duration, and album. Use when Matt asks for ISRC, track length, or any Spotify data.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query e.g. Ninajirachi All I Am" } },
      required: ["query"]
    }
  },
  {
    name: "get_announced_shows",
    description: "Get Ninajirachi publicly announced upcoming shows from Seated. Use when Matt asks about announced, confirmed, or public shows.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "search_dropbox",
    description: "Search files in Matt's Dropbox by name or content. Use when Matt asks about contracts, riders, documents, press kits, or any files that might be stored in Dropbox. Returns file names, paths, and modified dates.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query e.g. Ninajirachi rider, press kit, contract" } },
      required: ["query"]
    }
  }
];

app.get("/", (req, res) => res.send("Running"));

app.post("/inbound", async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body;
    if (event.type !== "email.received") return;

    const { email_id, from, subject, cc = [], to = [] } = event.data;
    console.log("Received | From:", from, "| Subject:", subject);
    console.log("CC field:", JSON.stringify(cc));
    console.log("To field:", JSON.stringify(to));
    console.log("Full event.data keys:", Object.keys(event.data));

    const emailContent = await fetchReceivedEmail(email_id);
    if (!emailContent) return;
    
    // Download the raw email to get full To/Cc headers (Resend strips extra recipients from API response)
    let rawEmail = '';
    if (emailContent.raw?.download_url) {
      try {
        const rawRes = await fetch(emailContent.raw.download_url);
        if (rawRes.ok) rawEmail = await rawRes.text();
        console.log("Raw email (first 1000):", rawEmail.slice(0, 1000));
      } catch (err) { console.log("Raw email download failed:", err.message); }
    }
    
    // Parse To: and Cc: from raw email headers
    let rawRecipients = [];
    if (rawEmail) {
      // Get just the headers (before the first blank line)
      const headerSection = rawEmail.split(/\r?\n\r?\n/)[0] || '';
      // Unfold headers (continued lines start with whitespace)
      const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
      const toMatch = unfolded.match(/^To:\s*(.+)$/mi);
      const ccMatch = unfolded.match(/^Cc:\s*(.+)$/mi);
      const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
      if (toMatch) rawRecipients.push(...(toMatch[1].match(emailRegex) || []));
      if (ccMatch) rawRecipients.push(...(ccMatch[1].match(emailRegex) || []));
    }
    
    // Also grab from Resend API fields as backup
    const emailTo = Array.isArray(emailContent.to) ? emailContent.to : (emailContent.to ? [emailContent.to] : []);
    const emailCc = Array.isArray(emailContent.cc) ? emailContent.cc : (emailContent.cc ? [emailContent.cc] : []);
    
    // Dedupe all recipients from all sources
    const allEmails = new Set([
      ...emailTo.map(e => parseEmail(e).toLowerCase()),
      ...emailCc.map(e => parseEmail(e).toLowerCase()),
      ...rawRecipients.map(e => e.toLowerCase()),
    ]);
    
    console.log("Raw recipients:", JSON.stringify(rawRecipients));
    console.log("All unique emails:", JSON.stringify([...allEmails]));

    const body = emailContent.text || emailContent.plain_text || stripHtml(emailContent.html) || "";
    console.log("Body length:", body.length);
    if (!body.trim() && !subject.trim()) { console.log("Empty body and subject, returning"); return; }

    const senderEmail = parseEmail(from);
    const allowedEmails = (process.env.ALLOWED_EMAILS || YOUR_EMAIL).split(",").map(e => e.trim().toLowerCase());
    if (!allowedEmails.includes(senderEmail.toLowerCase())) {
      console.log("Ignoring unknown sender:", senderEmail);
      return;
    }

    const cleanedBody = cleanQuotedText(body);
    if (!cleanedBody.trim() && !subject.trim()) { console.log("Empty cleaned body and subject, returning"); return; }
    console.log("Cleaned body:", cleanedBody.slice(0, 200));

    // Memory commands
    const memoryMatch = cleanedBody.match(/^remember[:\s]+(.+)/is);
    const forgetMatch = cleanedBody.match(/^forget[:\s]+(.+)/is);
    const showMemoryMatch = cleanedBody.match(/^(show memory|what do you remember|memory)/i);

    if (memoryMatch) {
      await addMemory(memoryMatch[1].trim());
      await sendReply(senderEmail, subject, "Got it, saved to permanent memory:\n\n" + memoryMatch[1].trim(), null);
      return;
    }
    if (forgetMatch) {
      const removed = await removeMemory(forgetMatch[1].trim());
      await sendReply(senderEmail, subject, removed ? "Removed from memory: " + forgetMatch[1].trim() : "Couldn't find that in memory.");
      return;
    }
    if (showMemoryMatch) {
      const memories = await getMemories();
      const memText = memories.length
        ? "Permanent memory:\n\n" + memories.map((m, i) => (i + 1) + ". " + m).join("\n")
        : "Nothing in permanent memory yet.";
      await sendReply(senderEmail, subject, memText);
      return;
    }

    // Fetch always-on context
    const attachmentMeta = event.data.attachments || [];
    const [memories, sheetData, contextData, attachments] = await Promise.all([
      getMemories(),
      fetchAllSheetTabs(SHEET_ID),
      fetchAllSheetTabs(CONTEXT_SHEET_ID),
      fetchAttachments(email_id, attachmentMeta),
    ]);

    const memoryContext = memories.length ? "\n\nPermanent context:\n" + memories.map(m => "- " + m).join("\n") : "";
    const sheetContext = sheetData ? "\n\nTour schedule (Google Sheet):\n" + sheetData : "";
    const contextSheetContext = contextData ? "\n\nKey context and info:\n" + contextData : "";
    const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + sheetContext + contextSheetContext;

    // Build user message
    const userContent = [];
    for (const att of attachments) {
      if (att.type === "document") {
        userContent.push({ type: "document", source: { type: "base64", media_type: att.media_type, data: att.data } });
      } else if (att.type === "image") {
        userContent.push({ type: "image", source: { type: "base64", media_type: att.media_type, data: att.data } });
      }
    }
    const ccEmails = [...allEmails].filter(e => e && e !== senderEmail.toLowerCase() && e !== ASSISTANT_EMAIL.toLowerCase());
    console.log("CC emails to include:", JSON.stringify(ccEmails));
    const ccLine = ccEmails.length ? "\nCC: " + ccEmails.join(", ") + "\n" : "";
    userContent.push({ type: "text", text: "Subject: " + subject + ccLine + "\n" + cleanedBody });

    const raw = await redis.get(THREAD_KEY);
    const history = raw ? JSON.parse(raw) : [];
    history.push({ role: "user", content: userContent });

    // Agentic loop
    let reply = null;
    let currentMessages = [...history];

    while (!reply) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: systemPrompt,
        tools: TOOLS,
        messages: currentMessages,
      });

      if (response.stop_reason === "end_turn") {
        reply = response.content.map(b => b.text || "").join("").trim();
        currentMessages.push({ role: "assistant", content: response.content });
        break;
      }

      if (response.stop_reason === "tool_use") {
        currentMessages.push({ role: "assistant", content: response.content });
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          console.log("Tool call:", block.name, block.input);
          let result = "";
          try {
            if (block.name === "fetch_url") result = await fetchUrl(block.input.url) || "Could not fetch URL.";
            else if (block.name === "search_spotify") result = await searchSpotifyTrack(block.input.query) || "No results found.";
            else if (block.name === "get_announced_shows") result = await fetchSeatedShows() || "No announced shows found.";
            else if (block.name === "search_dropbox") result = await searchDropbox(block.input.query) || "No files found.";
          } catch (err) {
            result = "Error: " + err.message;
          }
          console.log("Tool result (" + block.name + "):", result.slice(0, 100));
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        currentMessages.push({ role: "user", content: toolResults });
      }
    }

    history.push({ role: "assistant", content: reply });
    const trimmed = history.length > 40 ? history.slice(-40) : history;
    await redis.set(THREAD_KEY, JSON.stringify(trimmed));

    await sendReply(senderEmail, subject, reply, ccEmails.length ? ccEmails : null);
    console.log("Reply sent to:", senderEmail);

  } catch (err) {
    console.error("Inbound error:", err);
  }
});

async function fetchReceivedEmail(emailId) {
  try {
    const res = await fetch("https://api.resend.com/emails/receiving/" + emailId, {
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY },
    });
    if (!res.ok) { console.log("fetchReceivedEmail failed:", res.status); return null; }
    return await res.json();
  } catch (err) { console.error("fetchReceivedEmail error:", err); return null; }
}

function parseEmail(str) {
  const m = str.match(/<([^>]+)>/);
  return m ? m[1] : str.trim();
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toHtml(text) {
  return "<pre style='font-family:sans-serif;white-space:pre-wrap'>" + text.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
}

function cleanQuotedText(text) {
  // Check if this is a forwarded email — preserve the full thread so MP has complete context
  const isForward = /[-]{3,}\s*Forwarded message\s*[-]{3,}/i.test(text)
    || /^Begin forwarded message:/im.test(text)
    || /^From:\s+.+\n(Sent|Date):\s+.+\nTo:\s+.+/im.test(text);
  
  if (isForward) {
    // Keep everything — MP needs to read the full thread including her own replies
    return text.trim();
  }
  
  // For regular back-and-forth replies, strip quoted text to avoid echoing
  return text
    .replace(/^(On .+?wrote:)\s*/ms, "")
    .replace(/^>.*$/gm, "")
    .replace(/^[-_]{3,}[\s\S]*$/m, "")
    .trim();
}

async function sendReply(to, subject, text, cc = null) {
  const opts = {
    from: "MP <" + ASSISTANT_EMAIL + ">",
    to,
    subject: subject && subject.startsWith("Re:") ? subject : "Re: " + subject,
    text,
    html: toHtml(text),
  };
  if (cc && cc.length) opts.cc = cc;
  await resend.emails.send(opts);
}

async function getMemories() {
  try {
    const raw = await redis.get(MEMORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
async function addMemory(item) {
  const memories = await getMemories();
  memories.push(item);
  await redis.set(MEMORY_KEY, JSON.stringify(memories));
}
async function removeMemory(item) {
  const memories = await getMemories();
  const idx = memories.findIndex(m => m.toLowerCase().includes(item.toLowerCase()));
  if (idx === -1) return false;
  memories.splice(idx, 1);
  await redis.set(MEMORY_KEY, JSON.stringify(memories));
  return true;
}

async function fetchAllSheetTabs(sheetId) {
  try {
    const metaRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + sheetId + "?key=" + GOOGLE_API_KEY);
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    const tabs = meta.sheets?.map(s => s.properties.title) || [];
    console.log("Sheet tabs:", tabs);
    const results = await Promise.all(tabs.map(async tab => {
      const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + sheetId + "/values/" + encodeURIComponent(tab) + "?key=" + GOOGLE_API_KEY);
      if (!r.ok) return null;
      const d = await r.json();
      const rows = d.values || [];
      if (!rows.length) return null;
      return "[" + tab + "]\n" + rows.map(row => row.join(" | ")).join("\n");
    }));
    return results.filter(Boolean).join("\n\n") || null;
  } catch (err) { console.error("Sheet error:", err); return null; }
}

async function fetchUrl(url) {
  try {
    console.log("Fetching URL:", url);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MPAssistant/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  } catch (err) { console.log("URL fetch failed:", url, err.message); return null; }
}

async function fetchAttachments(emailId, attachmentMeta) {
  if (!attachmentMeta || attachmentMeta.length === 0) return [];
  const results = [];
  for (const att of attachmentMeta.slice(0, 5)) {
    try {
      console.log("Fetching attachment:", att.filename, att.content_type);
      const url = "https://api.resend.com/emails/receiving/" + emailId + "/attachments/" + att.id;
      const response = await fetch(url, { headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY } });
      if (!response.ok) { console.log("Attachment fetch failed:", response.status); continue; }
      const data = await response.json();
      if (!data.download_url) { console.log("No download_url"); continue; }
      const dlResponse = await fetch(data.download_url);
      if (!dlResponse.ok) continue;
      const buffer = await dlResponse.arrayBuffer();
      const base64Data = Buffer.from(buffer).toString("base64");
      console.log("Attachment downloaded, size:", base64Data.length);
      const ct = att.content_type || "";
      if (ct === "application/pdf") {
        results.push({ type: "document", media_type: "application/pdf", data: base64Data });
      } else if (ct.includes("image/")) {
        const imgType = ct.includes("png") ? "image/png" : ct.includes("gif") ? "image/gif" : ct.includes("webp") ? "image/webp" : "image/jpeg";
        results.push({ type: "image", media_type: imgType, data: base64Data });
      }
    } catch (err) { console.log("Attachment error:", err.message); }
  }
  return results;
}

async function fetchSeatedShows() {
  try {
    console.log("Fetching Seated shows...");
    const response = await fetch(
      "https://cdn.seated.com/api/tour/22d23327-0a5a-4431-826d-3baa90fd57e0?include=tour-events",
      { headers: { "Accept": "application/vnd.api+json", "User-Agent": "Mozilla/5.0" } }
    );
    if (!response.ok) { console.log("Seated failed:", response.status); return null; }
    const data = await response.json();
    const events = data.included?.filter(i => i.type === "tour-events") || [];
    if (!events.length) return null;
    const lines = events.map(e => {
      const a = e.attributes || {};
      return (a.starts_at_date || "") + " | " + (a.venue_name || "") + " | " + (a.city || "") + ", " + (a.country_code || "") + " | " + (a.ticket_status || "");
    }).filter(l => l.replace(/\|/g, "").trim());
    console.log("Seated shows found:", lines.length);
    return lines.join("\n");
  } catch (err) { console.error("Seated error:", err); return null; }
}

async function getSpotifyToken() {
  const creds = Buffer.from(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET).toString("base64");
  const body = "grant_type=refresh_token&refresh_token=" + process.env.SPOTIFY_REFRESH_TOKEN;
  console.log("Spotify auth: using refresh token, length:", process.env.SPOTIFY_REFRESH_TOKEN?.length);
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + creds, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  console.log("Spotify token response keys:", Object.keys(data));
  console.log("Spotify token scope:", data.scope);
  if (data.error) console.log("Spotify token error:", data.error, data.error_description);
  return data.access_token;
}

async function searchSpotifyTrack(query) {
  try {
    console.log("Searching Spotify:", query);
    const token = await getSpotifyToken();
    console.log("Token type check - first 10 chars:", token?.slice(0, 10));
    const searchRes = await fetch("https://api.spotify.com/v1/search?q=" + encodeURIComponent(query) + "&type=track&limit=5&market=US", {
      headers: { Authorization: "Bearer " + token }
    });
    const searchData = await searchRes.json();
    const tracks = searchData.tracks?.items || [];
    if (!tracks.length) return "No tracks found.";
    
    // Fetch each track individually to get external_ids with user token
    const fullTracks = await Promise.all(tracks.slice(0, 3).map(async t => {
      try {
        const res = await fetch("https://api.spotify.com/v1/tracks/" + t.id, {
          headers: { Authorization: "Bearer " + token }
        });
        const full = await res.json();
        console.log("Track " + t.id + " external_ids:", JSON.stringify(full.external_ids));
        return full;
      } catch { return t; }
    }));
    
    return fullTracks.map(t => {
      const mins = Math.floor(t.duration_ms / 60000);
      const secs = String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0");
      const isrc = t.external_ids?.isrc || "N/A";
      return t.name + " - " + t.artists.map(a => a.name).join(", ") + "\nISRC: " + isrc + "\nLength: " + mins + ":" + secs + "\nAlbum: " + t.album.name + " (" + (t.album.release_date?.slice(0, 4) || "") + ")";
    }).join("\n\n");
  } catch (err) { console.error("Spotify error:", err); return null; }
}

async function getDropboxToken() {
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&refresh_token=" + process.env.DROPBOX_REFRESH_TOKEN + "&client_id=" + process.env.DROPBOX_APP_KEY + "&client_secret=" + process.env.DROPBOX_APP_SECRET,
  });
  const data = await response.json();
  if (data.error) console.log("Dropbox token error:", data.error);
  return data.access_token;
}

async function searchDropbox(query) {
  try {
    console.log("Searching Dropbox:", query);
    const token = await getDropboxToken();
    const response = await fetch("https://api.dropboxapi.com/2/files/search_v2", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, options: { max_results: 5 } }),
    });
    const data = await response.json();
    if (data.error) { console.log("Dropbox search error:", JSON.stringify(data.error)); return null; }
    const matches = data.matches || [];
    if (!matches.length) return "No files found.";
    console.log("Dropbox results:", matches.length);
    
    // Get sharing links for each file
    const results = await Promise.all(matches.map(async m => {
      const meta = m.metadata?.metadata || m.metadata || {};
      const name = meta.name || "Unknown";
      const path = meta.path_display || meta.path_lower || "";
      const modified = meta.server_modified || meta.client_modified || "";
      const size = meta.size ? Math.round(meta.size / 1024) + " KB" : "";
      const tag = meta[".tag"] || "unknown";
      console.log("File:", name, "| tag:", tag, "| path:", path);
      
      let link = "";
      if (path && tag !== "folder") {
        try {
          // Try to get existing shared link first
          const linkRes = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ path, direct_only: true }),
          });
          const linkData = await linkRes.json();
          console.log("List links response for " + name + ":", JSON.stringify(linkData).slice(0, 200));
          if (linkData.links?.length) {
            link = linkData.links[0].url;
          } else {
            // Create a new shared link
            const createRes = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
              method: "POST",
              headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
              body: JSON.stringify({ path }),
            });
            const createData = await createRes.json();
            console.log("Create link response for " + name + ":", JSON.stringify(createData).slice(0, 200));
            link = createData.url || "";
          }
        } catch (err) { console.log("Sharing link error for " + path + ":", err.message); }
      }
      
      return name + "\n  Path: " + path + (modified ? "\n  Modified: " + modified : "") + (size ? "\n  Size: " + size : "") + (link ? "\n  Link: " + link : "");
    }));
    
    return results.join("\n\n");
  } catch (err) { console.error("Dropbox error:", err); return null; }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Listening on port " + PORT);
  try {
    await redis.connect();
    console.log("Redis connected");
  } catch (err) {
    console.error("Redis connection failed:", err);
  }
});
