// api/index.js
const fs = require("fs");
const path = require("path");

// ---- CSV helpers (your exact implementations) ----
function parseCSV(text) { /* ... paste your code ... */ }
function loadCSV(filePath) { return parseCSV(fs.readFileSync(filePath, "utf8")); }
function safeJSON(str, fb){ try { return JSON.parse(str); } catch { return fb; } }

// ---- Load data (read-only in serverless) ----
const STORAGE_DIR = path.join(process.cwd(), "storage");
const USERS = (() => {
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
})();

const JOURNEYS_DATA = (() => {
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
})();

// Likes: in-memory only on Vercel
let LIKES = (() => {
  try {
    const file = path.join(STORAGE_DIR, "likes.csv");
    if (!fs.existsSync(file)) return [];
    const rows = loadCSV(file);
    return rows.map(r => ({ post_id:r.post_id, user_id:r.user_id, created_at:Number(r.created_at||Date.now()) }));
  } catch { return []; }
})();
const likeCountFor = id => LIKES.reduce((n,l)=>n+(l.post_id===id?1:0),0);
const likedByUser = (id,u) => LIKES.some(l=>l.post_id===id && l.user_id===u);
const totalWaypoints = j => (j.days||[]).reduce((s,d)=>s+(d.waypoints||[]).length,0);
const dateRangeStr = j => j.start_date===j.end_date ? j.start_date : `${j.start_date} → ${j.end_date}`;

function parseCookies(req){
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(/;\s*/).filter(Boolean).map(kv=>{
      const i = kv.indexOf("="); return [decodeURIComponent(kv.slice(0,i)), decodeURIComponent(kv.slice(i+1))];
    })
  );
}
const setUserCookie = u => `tripline_user=${encodeURIComponent(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
const getUserFromCookie = req => (parseCookies(req).tripline_user || null);
const readBody = req => new Promise((res,rej)=>{ let d=""; req.on("data",c=>d+=c); req.on("end",()=>res(d)); req.on("error",rej); });

function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type","application/json");
  res.end(body);
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---------- API ----------
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/login" && req.method === "POST") {
      try{
        const { username, password } = JSON.parse(await readBody(req) || "{}");
        const u = USERS[username];
        if(!u || u.password_hash !== password) return sendJSON(res, 401, { error:"Invalid credentials" });
        res.setHeader("Set-Cookie", setUserCookie(username));
        return sendJSON(res, 200, { ok:true, name: u.name });
      }catch{ return sendJSON(res, 400, { error:"Bad request" }); }
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", "tripline_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return sendJSON(res, 200, { ok:true });
    }

    if (url.pathname === "/api/whoami" && req.method === "GET") {
      const username = getUserFromCookie(req);
      if (!username) return sendJSON(res, 200, null);
      const u = USERS[username];
      return sendJSON(res, 200, { username, name: u?.name || username });
    }

    // auth guard for the rest
    const username = getUserFromCookie(req);
    if (!username) return sendJSON(res, 401, { error:"Not authenticated" });

    if (url.pathname === "/api/feed" && req.method === "GET") {
      const me = USERS[username];
      if (!me) return sendJSON(res, 401, { error:"Unknown user" });
      const visible = new Set([username, ...(me.follows||[])]);
      const items = JOURNEYS_DATA.list
        .filter(j => visible.has(j.author))
        .sort((a,b)=> a.start_date < b.start_date ? 1 : (a.start_date > b.start_date ? -1 : 0))
        .map(j => ({
          ...j,
          author_name: USERS[j.author]?.name || j.author,
          total_waypoints: totalWaypoints(j),
          date_range: dateRangeStr(j),
          like_count: likeCountFor(j.id),
          liked_by_me: likedByUser(j.id, username),
        }));
      return sendJSON(res, 200, { items, global_like_count: LIKES.length });
    }

    if (url.pathname === "/api/journey" && req.method === "GET") {
      const id = url.searchParams.get("id");
      const j = JOURNEYS_DATA.byId[id];
      if (!j) return sendJSON(res, 404, { error:"Not found" });
      return sendJSON(res, 200, {
        ...j,
        author_name: USERS[j.author]?.name || j.author,
        total_waypoints: totalWaypoints(j),
        date_range: dateRangeStr(j),
        like_count: likeCountFor(j.id),
        liked_by_me: likedByUser(j.id, username),
      });
    }

    if (url.pathname === "/api/like" && req.method === "POST") {
      const { post_id, action } = JSON.parse(await readBody(req) || "{}");
      if (!post_id || !JOURNEYS_DATA.byId[post_id]) return sendJSON(res, 404, { error:"Post not found" });
      if (!["like","unlike"].includes(action)) return sendJSON(res, 400, { error:"Invalid action" });

      const idx = LIKES.findIndex(l => l.post_id === post_id && l.user_id === username);
      if (action === "like" && idx === -1) LIKES.push({ post_id, user_id: username, created_at: Date.now() });
      if (action === "unlike" && idx !== -1) LIKES.splice(idx, 1);

      return sendJSON(res, 200, {
        post_id,
        like_count: likeCountFor(post_id),
        liked_by_me: likedByUser(post_id, username),
        global_like_count: LIKES.length,
      });
    }

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
      return sendJSON(res, 200, { username, name: u?.name || username, folders, global_like_count: LIKES.length });
    }

    return sendJSON(res, 404, { error: "No such endpoint" });
  }

  // ---------- non-API: serve index.html ----------
  const fp = path.join(process.cwd(), "index.html");
  res.statusCode = 200;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.end(fs.readFileSync(fp));
};
