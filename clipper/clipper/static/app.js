const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = t => { t = Math.max(0, Math.floor(t)); const h = Math.floor(t/3600), m = Math.floor(t%3600/60), s = t%60;
  return (h ? h + ":" + String(m).padStart(2,"0") : m) + ":" + String(s).padStart(2,"0"); };
let STATE = null;

async function api(method, url, body) {
  const r = await fetch(url, {method, headers: {"Content-Type": "application/json", "X-Clipper": "1"},
                              body: body ? JSON.stringify(body) : undefined});
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || r.statusText); }
  return r.json();
}

// ------------------------------------------------------------ Tabs
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("hidden", t.id !== "tab-" + b.dataset.tab));
});

$("#add").onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await api("POST", "/api/jobs", {urls: $("#urls").value, mode: $("#mode").value});
    $("#urls").value = ""; $("#addmsg").textContent = r.ids.length + " Link(s) hinzugefügt";
    refresh();
  } catch (err) { $("#addmsg").textContent = "Fehler: " + err.message; }
};

// ------------------------------------------------------------ Warteschlange
const STATUS = {queued:"wartet", downloading:"lädt", transcribing:"transkribiert", analyzing:"analysiert",
  rendering:"schneidet", done:"fertig", error:"Fehler", ready:"bereit", recording:"nimmt auf", stopping:"stoppt"};

function jobStatus(j) {
  if (j.status === "processing") return j.stage || "transcribing";
  return j.status;
}

function renderJobs(jobs) {
  if (!jobs.length) { $("#jobs").innerHTML = '<div class="empty">Noch keine Links in der Warteschlange.</div>'; return; }
  $("#jobs").innerHTML = jobs.map(j => {
    const st = jobStatus(j);
    let label = STATUS[st] || st;
    if (j.status === "recording" && j.stage) label += " · " + (STATUS[j.stage] || j.stage);
    const live = j.kind === "live";
    const sig = j.signal_type === "heatmap" ? "Heatmap" : j.signal_type === "chat" ? "Chat-Aktivität" : "kein Signal";
    const pct = live ? (j.chunks.total ? 100 * j.chunks.done / j.chunks.total : 0) : 100 * (j.progress || 0);
    const btns = [];
    if (live && ["ready","done","error","processing"].includes(j.status) && !j.recording) btns.push(`<button class="primary" onclick="act('POST','/api/jobs/${j.id}/live/start')">● Start</button>`);
    if (live && j.recording) btns.push(`<button class="danger" onclick="act('POST','/api/jobs/${j.id}/live/stop')">■ Stopp</button>`);
    if (j.status === "error") btns.push(`<button onclick="act('POST','/api/jobs/${j.id}/retry')">Erneut versuchen</button>`);
    btns.push(`<button class="danger" title="Entfernen" onclick="if(confirm('Job und Dateien löschen?'))act('DELETE','/api/jobs/${j.id}')">✕</button>`);
    return `<div class="job">
      <div>
        <div class="title">${esc(j.title || j.url)}</div>
        <div class="muted"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.url)}</a></div>
        <div style="margin-top:4px">
          <span class="badge s-${st}">${label}</span>
          ${j.kind ? `<span class="badge">${live ? "Livestream" : "Video"}</span>` : ""}
          ${j.kind ? `<span class="badge">${sig}</span>` : ""}
          <span class="muted">${esc(j.message)}</span>
        </div>
        <div class="muted">${j.chunks.total ? `${j.chunks.done}/${j.chunks.total} ${live ? "Segmente" : "Abschnitte"} · ` : ""}${j.clips.total} Kandidaten · ${j.clips.good} in Freigabe${j.duration ? " · " + fmt(j.duration) : ""}</div>
      </div>
      <div class="actions">${btns.join("")}</div>
      <div class="bar"><div style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
    </div>`;
  }).join("");
}

async function act(method, url, body) {
  try { await api(method, url, body); } catch (e) { alert(e.message); }
  refresh();
}

// ------------------------------------------------------------ Clips
function scoreLine(c) {
  const sig = c.signal_score == null ? "kein Signal" : `Signal ${Math.round(c.signal_score)}`;
  return `<div class="score ${c.score >= STATE.settings.threshold ? "hi" : ""}"><b>${Math.round(c.score)} %</b>
          <span class="muted">KI ${Math.round(c.ai_score)} · ${sig}</span></div>`;
}

function publishInfo(c) {
  return Object.entries(c.publish || {}).map(([p, r]) => r.ok
    ? `<div class="ok">✓ ${esc(STATE.platforms[p]?.label || p)}: <a href="${esc(r.url)}" target="_blank" rel="noopener">öffnen</a></div>`
    : `<div class="err">✗ ${esc(STATE.platforms[p]?.label || p)}: ${esc(r.error)}</div>`).join("");
}

function clipCard(c, kind) {
  const src = `<a href="${esc(c.source_url)}" target="_blank" rel="noopener">${esc(c.job_title)}</a>
               <span class="muted">· ${fmt(c.start)}–${fmt(c.end)} (${Math.round(c.end - c.start)} s)</span>`;
  const video = c.video ? `<video src="${c.video}" controls preload="metadata" playsinline></video>` : "";
  if (kind === "review") {
    const plats = Object.entries(STATE.platforms).map(([k, p]) =>
      `<label title="${p.configured ? "" : "Zugangsdaten in .env fehlen"}"><input type="checkbox" value="${k}" ${p.configured ? "checked" : "disabled"}> ${esc(p.label)}</label>`).join("");
    return `<div class="clip" data-id="${c.id}">
      ${video}${scoreLine(c)}
      <div>${src}</div>
      <input class="t" value="${esc(c.title)}" placeholder="Titel">
      <textarea class="d" rows="3" placeholder="Beschreibung">${esc(c.description)}</textarea>
      <div class="muted">${esc(c.reason)}</div>
      <div class="plats">${plats}</div>
      <div class="row"><button class="primary post">Posten (Entwurf)</button><button class="danger discard">Verwerfen</button></div>
      <div class="status"></div>
    </div>`;
  }
  const btn = kind === "archive" ? `<button class="restore">Wiederherstellen</button>` : "";
  return `<div class="clip" data-id="${c.id}">${video}${scoreLine(c)}<div>${src}</div>
    <div><b>${esc(c.title)}</b></div><div class="muted">${esc(c.description)}</div>
    <div class="status">${publishInfo(c)}</div>${btn}</div>`;
}

function syncGrid(el, clips, kind) {
  const have = new Map([...el.querySelectorAll(".clip")].map(n => [n.dataset.id, n]));
  const want = new Set(clips.map(c => String(c.id)));
  have.forEach((n, id) => { if (!want.has(id)) n.remove(); });
  clips.forEach((c, i) => {
    let n = have.get(String(c.id));
    if (!n) {
      const tmp = document.createElement("div"); tmp.innerHTML = clipCard(c, kind); n = tmp.firstElementChild;
      bindCard(n, c, kind);
    }
    if (el.children[i] !== n) el.insertBefore(n, el.children[i] || null);
    if (kind === "review") {
      const busy = c.status === "posting";
      n.querySelectorAll("button").forEach(b => b.disabled = busy);
      $(".status", n).innerHTML = busy ? '<div class="muted">Wird als Entwurf hochgeladen …</div>'
        : c.status === "error" ? `<div class="err">Rendern fehlgeschlagen: ${esc(c.error)}</div>` : publishInfo(c);
    }
  });
  if (!clips.length) el.innerHTML = `<div class="empty">${{review:"Noch keine Clips ≥ " + STATE.settings.threshold + " %.", posted:"Noch nichts als Entwurf hochgeladen.", archive:"Archiv ist leer."}[kind]}</div>`;
  else el.querySelectorAll(".empty").forEach(e => e.remove());
}

function bindCard(n, c, kind) {
  const id = c.id;
  if (kind === "review") {
    $(".t", n).onchange = () => api("PATCH", `/api/clips/${id}`, {title: $(".t", n).value});
    $(".d", n).onchange = () => api("PATCH", `/api/clips/${id}`, {description: $(".d", n).value});
    $(".post", n).onclick = () => {
      const platforms = [...n.querySelectorAll(".plats input:checked")].map(i => i.value);
      if (!platforms.length) return alert("Bitte mindestens eine konfigurierte Plattform wählen (.env).");
      act("POST", `/api/clips/${id}/post`, {platforms, title: $(".t", n).value, description: $(".d", n).value});
    };
    $(".discard", n).onclick = () => act("POST", `/api/clips/${id}/discard`);
  }
  if (kind === "archive") $(".restore", n).onclick = () => act("POST", `/api/clips/${id}/restore`);
}

// ------------------------------------------------------------ Polling
async function refresh() {
  try { STATE = await api("GET", "/api/state"); } catch { return; }
  const s = STATE.settings;
  $("#settings").innerHTML = [`KI: ${s.llm}`, `Whisper: ${String(s.whisper).split("/").pop()}`, `Schwelle: ${s.threshold} %`,
    `Gewichtung KI/Signal: ${s.ai_weight}/${s.signal_weight}`].map(x => `<span class="chip">${esc(x)}</span>`).join("");
  renderJobs(STATE.jobs);
  syncGrid($("#review"), STATE.review, "review");
  syncGrid($("#posted"), STATE.posted, "posted");
  syncGrid($("#archive"), STATE.archive, "archive");
  $("#n-queue").textContent = STATE.jobs.length || "";
  $("#n-review").textContent = STATE.review.length || "";
  $("#n-posted").textContent = STATE.posted.length || "";
  $("#n-archive").textContent = STATE.archive.length || "";
}
refresh();
setInterval(refresh, 2000);
