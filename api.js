// Minimal Node server with built-in http (no frameworks).
// Serves index.html and provides /api/* endpoints.
// Data lives in ./storage CSVs (users.csv, journeys.csv, likes.csv)

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ---------- CSV helpers (quoted fields supported) ----------
function parseCSV(text) {
  // Returns [{col:value,...}, ...] using first row as header.
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ",") { pushField(); i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { pushField(); pushRow(); i++; continue; }
      field += ch; i++; continue;
    }
  }
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) pushRow();
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map(cols => {
    const o = {};
    header.forEach((h, idx) => { o[h] = cols[idx] ?? ""; });
    return o;
  });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeCSV(filePath, header, rows) {
  const head = header.join(",") + "\n";
  const body = rows.map(r => header.map(h => csvEscape(r[h])).join(",")).join("\n");
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, head + body + (rows.length ? "\n" : ""));
  fs.renameSync(tmp, filePath);
}

function loadCSV(filePath) {
  const txt = fs.readFileSync(filePath, "utf8");
  return parseCSV(txt);
}

// ---------- Load data from ./storage ----------
const STORAGE_DIR = path.join(process.cwd(), "storage");
function safeJSON(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }

function loadUsers() {
  const rows = loadCSV(path.join(STORAGE_DIR, "users.csv"));
  const byId = {};
  for (const r of rows) {
    byId[r.id] = {
      id: r.id,
      name: r.name || r.id,
      password_hash: r.password_hash || "",
      follows: safeJSON(r.follows || "[]", []),
      created_at: Number(r.created_at || Date.now()),
    };
  }
  return byId;
}

function loadJourneys() {
  const rows = loadCSV(path.join(STORAGE_DIR, "journeys.csv"));
  const arr = rows.map(r => ({
    id: r.id,
    author: r.author_id,
    title: r.title,
    cover_img: r.cover_img,
    start_date: r.start_date,
    end_date: r.end_date,
    summary: r.summary,
    highlight_comment: r.highlight_comment,
    folders: safeJSON(r.folders || "[]", []),
    days: safeJSON(r.days || "[]", []),
    created_at: Number(r.created_at || Date.now()),
    updated_at: Number(r.updated_at || Date.now()),
  }));
  return { list: arr, byId: Object.fromEntries(arr.map(j => [j.id, j])) };
}

function loadLikes() {
  const file = path.join(STORAGE_DIR, "likes.csv");
  if (!fs.existsSync(file)) {
    writeCSV(file, ["post_id","user_id","created_at"], []); // ensure file exists
  }
  const rows = loadCSV(file);
  return rows.map(r => ({
    post_id: r.post_id,
    user_id: r.user_id,
    created_at: Number(r.created_at || Date.now()),
  }));
}

// One-time load at startup
let USERS = loadUsers();
let JOURNEYS_DATA = loadJourneys();
let LIKES = loadLikes();

// Like write serialization (avoid interleaved writes)
let likeWriteQueue = Promise.resolve();
function persistLikes() {
  const file = path.join(STORAGE_DIR, "likes.csv");
  const header = ["post_id","user_id","created_at"];
  const rows = LIKES.map(l => ({ post_id: l.post_id, user_id: l.user_id, created_at: l.created_at }));
  writeCSV(file, header, rows);
}

// ---------- Derived helpers ----------
function dateRangeStr(j){ return j.start_date === j.end_date ? j.start_date : `${j.start_date} → ${j.end_date}`; }
function totalWaypoints(j) {
  try { return (j.days || []).reduce((sum,d)=> sum + ((d.waypoints || []).length), 0); }
  catch { return 0; }
}
function likeCountFor(postId) { return LIKES.reduce((n,l)=> n + (l.post_id === postId ? 1 : 0), 0); }
function likedByUser(postId, userId) { return LIKES.some(l => l.post_id === postId && l.user_id === userId); }
function globalLikeCount() { return LIKES.length; }

// ---------- Cookie & HTTP helpers ----------
function parseCookies(req){
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(/;\s*/).filter(Boolean).map(kv=>{
      const i = kv.indexOf("="); return [decodeURIComponent(kv.slice(0,i)), decodeURIComponent(kv.slice(i+1))];
    })
  );
}
function setUserCookie(username){
  return `tripline_user=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}
function getUserFromCookie(req){
  const c = parseCookies(req);
  return c.tripline_user || null;
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let data=""; req.on("data",chunk=>data+=chunk); req.on("end",()=>resolve(data)); req.on("error",reject);
  });
}
function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type":"application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function serveIndex(res){
  const fp = path.join(process.cwd(), "index.html");
  fs.readFile(fp, (err, buf)=>{
    if(err){ res.writeHead(404); res.end("index.html not found"); return; }
    res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
    res.end(buf);
  });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- API: login/logout/whoami ----
  if(url.pathname === "/api/login" && req.method === "POST"){
    try{
      const body = JSON.parse(await readBody(req) || "{}");
      const { username, password } = body;
      const u = USERS[username];
      if(!u || u.password_hash !== password){
        return sendJSON(res, 401, { error: "Invalid credentials" });
      }
      res.writeHead(200, { "Content-Type":"application/json", "Set-Cookie": setUserCookie(username) });
      return res.end(JSON.stringify({ ok:true, name: u.name }));
    }catch(e){
      return sendJSON(res, 400, { error:"Bad request" });
    }
  }

  if(url.pathname === "/api/logout" && req.method === "POST"){
    res.writeHead(200, { "Content-Type":"application/json", "Set-Cookie": "tripline_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
    return res.end(JSON.stringify({ ok:true }));
  }

  if(url.pathname === "/api/whoami" && req.method === "GET"){
    const username = getUserFromCookie(req);
    if(!username) return sendJSON(res, 200, null);
    const u = USERS[username];
    return sendJSON(res, 200, { username, name: u?.name || username });
  }

  // ---- Auth guard for the rest ----
  if(url.pathname.startsWith("/api/")){
    const username = getUserFromCookie(req);
    if(!username) return sendJSON(res, 401, { error:"Not authenticated" });

    // /api/feed: only my posts + people I follow, with like info
    if (url.pathname === "/api/feed" && req.method === "GET") {
      const me = USERS[username];
      if (!me) return sendJSON(res, 401, { error: "Unknown user" });
      const visibleAuthors = new Set([username, ...(me.follows || [])]);
      const items = JOURNEYS_DATA.list
        .filter(j => visibleAuthors.has(j.author))
        .sort((a,b) => a.start_date < b.start_date ? 1 : (a.start_date > b.start_date ? -1 : 0))
        .map(j => ({
          ...j,
          author_name: USERS[j.author]?.name || j.author,
          total_waypoints: totalWaypoints(j),
          date_range: dateRangeStr(j),
          like_count: likeCountFor(j.id),
          liked_by_me: likedByUser(j.id, username),
        }));
      return sendJSON(res, 200, { items, global_like_count: globalLikeCount() });
    }

    // /api/journey?id=...
    if (url.pathname === "/api/journey" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const j = JOURNEYS_DATA.byId[id];
      if (!j) return sendJSON(res, 404, { error: "Not found" });
      const enriched = {
        ...j,
        author_name: USERS[j.author]?.name || j.author,
        total_waypoints: totalWaypoints(j),
        date_range: dateRangeStr(j),
        like_count: likeCountFor(j.id),
        liked_by_me: likedByUser(j.id, username),
      };
      return sendJSON(res, 200, enriched);
    }

    // /api/like : { post_id, action: "like" | "unlike" }  (idempotent)
    if (url.pathname === "/api/like" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req) || "{}"); }
      catch { return sendJSON(res, 400, { error: "Bad request" }); }
      const { post_id, action } = body || {};
      if (!post_id || !JOURNEYS_DATA.byId[post_id]) {
        return sendJSON(res, 404, { error: "Post not found" });
      }
      if (!["like","unlike"].includes(action)) {
        return sendJSON(res, 400, { error: "Invalid action" });
      }

      // serialize writes
      likeWriteQueue = likeWriteQueue.then(async () => {
        const existsIdx = LIKES.findIndex(l => l.post_id === post_id && l.user_id === username);
        if (action === "like") {
          if (existsIdx === -1) {
            LIKES.push({ post_id, user_id: username, created_at: Date.now() });
            persistLikes();
          }
        } else if (action === "unlike") {
          if (existsIdx !== -1) {
            LIKES.splice(existsIdx, 1);
            persistLikes();
          }
        }
      }).catch(err => console.error("like write error:", err));

      await likeWriteQueue;

      return sendJSON(res, 200, {
        post_id,
        like_count: likeCountFor(post_id),
        liked_by_me: likedByUser(post_id, username),
        global_like_count: globalLikeCount(),
      });
    }

    // /api/account
    if (url.pathname === "/api/account" && req.method === "GET") {
      const folders = {};
      JOURNEYS_DATA.list.forEach(j => {
        if (j.author === username) {
          (j.folders || ["Uncategorized"]).forEach(f => {
            (folders[f] ||= []).push({
              ...j,
              total_waypoints: totalWaypoints(j),
              date_range: dateRangeStr(j),
              like_count: likeCountFor(j.id),
              liked_by_me: likedByUser(j.id, username),
            });
          });
        }
      });
      const u = USERS[username];
      return sendJSON(res, 200, { username, name: u?.name || username, folders, global_like_count: globalLikeCount() });
    }

    return sendJSON(res, 404, { error:"No such endpoint" });
  }

  // SPA routes → serve index.html
  if (["/","/login","/feed","/account"].includes(url.pathname) || url.pathname.startsWith("/journey/")){
    return serveIndex(res);
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tripline running at http://localhost:${PORT}`));
