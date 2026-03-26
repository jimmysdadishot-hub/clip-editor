import { useState, useRef, useEffect, useCallback } from "react";

// Display size (CSS pixels) and internal render size (2x for crisp text)
const PW = 270, PH = 480;
const CW = 540, CH = 960, FC_FRAC = 0.44;

// ── IndexedDB ─────────────────────────────────────────────────────────────────
const DB_NAME = "ClipEditorDB", STORE = "videos";
const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
  r.onsuccess = e => res(e.target.result);
  r.onerror = () => rej(r.error);
});
const dbPut = async (id, blob) => {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(blob, id);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
};
const dbGet = async (id) => {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readonly");
    const r = t.objectStore(STORE).get(id);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
};
const dbDel = async (id) => {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).delete(id);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
};
const saveProjects = ps => { try { localStorage.setItem("ce_projects", JSON.stringify(ps)); } catch {} };
const loadProjects = () => { try { return JSON.parse(localStorage.getItem("ce_projects") || "[]"); } catch { return []; } };

// ── CSS ───────────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; font-family: 'DM Sans', sans-serif; }
  ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0d0d0d; } ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }
  input:focus { outline: none !important; }
  textarea:focus { outline: none !important; border-color: #3a3a3a !important; }
  input::placeholder { color: #333; }
  textarea::placeholder { color: #333; }
  .card-hover { transition: background .15s, transform .12s; }
  .card-hover:hover { background: #161616 !important; transform: translateY(-1px); }
  .icon-btn:hover { background: #1a1a1a !important; }
  .btn-p:hover { opacity:.88; } .btn-p:active { transform:scale(.97); }
  .btn-g:hover { border-color:#3a3a3a !important; color:#888 !important; }
  .drop-zone:hover { border-color:#3a3a3a !important; background:#111 !important; }
  .trim-handle { transition: background .1s; }
  .trim-handle:hover { background: #fff !important; }
  input[type=range] { -webkit-appearance:none; appearance:none; width:100%; height:3px; border-radius:2px; background:#1e1e1e; outline:none; cursor:pointer; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:13px; height:13px; border-radius:50%; background:#e8e8e8; cursor:pointer; }
  .proj-row:hover { background: #111 !important; }
  .delete-btn { opacity:0; transition:opacity .15s; }
  .proj-row:hover .delete-btn { opacity:1; }
  .cut-chip:hover { background: #2a0a0a !important; }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = s => { if (!isFinite(s)) return "0:00"; const m = Math.floor(s/60), sec = Math.floor(s%60); return `${m}:${sec.toString().padStart(2,"0")}`; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Merge overlapping cuts and sort
const mergeCuts = cuts => {
  if (!cuts.length) return [];
  const sorted = [...cuts].sort((a,b) => a.s - b.s);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length-1];
    if (sorted[i].s <= last.e) last.e = Math.max(last.e, sorted[i].e);
    else out.push({ ...sorted[i] });
  }
  return out;
};
// Given merged cuts, return array of {start,end} keep segments
const keepSegments = (cuts, dur) => {
  const merged = mergeCuts(cuts);
  const segs = [];
  let pos = 0;
  for (const c of merged) {
    if (c.s > pos) segs.push({ s: pos, e: c.s });
    pos = c.e;
  }
  if (pos < dur) segs.push({ s: pos, e: dur });
  return segs;
};

export default function App() {
  const [page, setPage]               = useState("dash");
  const [projects, setProjects]       = useState(() => loadProjects());
  const [projName, setProjName]       = useState("");
  const [modal, setModal]             = useState(false);
  const [modalStep, setModalStep]     = useState(1); // 1=name, 2=facecam question
  const [hasFacecam, setHasFacecam]   = useState(true);
  const [clipXPct, setClipXPct]       = useState(50); // 0=left 100=right, for no-facecam mode
  const [xKeyframes, setXKeyframes]   = useState([]); // [{t, x}] sorted by time
  const [search, setSearch]           = useState("");
  const [activeProj, setActiveProj]   = useState(null);
  const [step, setStep]               = useState(1);
  const [videoSrc, setVideoSrc]       = useState(null);
  const [vidDur, setVidDur]           = useState(0);
  const [trimIn, setTrimIn]           = useState(0);
  const [trimOut, setTrimOut]         = useState(0);
  const [cuts, setCuts]               = useState([]); // [{s, e}] regions to remove
  const [currentTime, setCurrentTime] = useState(0);
  const [fcRect, setFcRect]           = useState(null);
  const [fcConfirmed, setFcConfirmed] = useState(false);
  const [drawMode, setDrawMode]       = useState(false); // canvas active only in draw mode
  const [caption, setCaption]         = useState("");
  const [captionSize, setCaptionSize] = useState(6.5); // % of canvas width
  const [captionY, setCaptionY]       = useState(50);  // % of canvas height 0=top 100=bottom
  const [captionDuration, setCaptionDuration] = useState(0); // 0 = whole clip
  const [genning, setGenning]         = useState(false);
  const [segs, setSegs]               = useState([]);
  const [oaiKey, setOaiKey]           = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [freeTranscribing, setFreeTranscribing] = useState(false);
  const [freeTranscribeStatus, setFreeTranscribeStatus] = useState("");
  const [aaiKey, setAaiKey]           = useState(() => localStorage.getItem("aai_key") || "");
  const [aaiTranscribing, setAaiTranscribing] = useState(false);
  const [exporting, setExporting]     = useState(false);
  const [exportUrl, setExportUrl]     = useState(null);
  const [volume, setVolume]           = useState(0.8);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [loadingProj, setLoadingProj] = useState(false);
  const [fullscreen, setFullscreen]   = useState(false);

  const vidRef      = useRef(null);
  const selVidRef   = useRef(null);
  const selCanRef   = useRef(null);
  const prevCanRef  = useRef(null);
  const fileRef     = useRef(null);
  const rafRef      = useRef(null);
  const timelineRef = useRef(null);
  const chunks      = useRef([]);
  const acRef       = useRef(null);
  const adstRef     = useRef(null);

  // Drag refs
  const draggingRef    = useRef(false);
  const anchorRef      = useRef(null);
  const boxRef         = useRef(null);
  const trimDragRef    = useRef(null); // "in"|"out"|"seek"|null
  const cutDragRef     = useRef(null); // {startPct} while drawing a cut
  const cutAnchorRef   = useRef(null);

  // Latest values for RAF
  const fcRectRef         = useRef(null);
  const captionRef        = useRef("");
  const captionSizeRef    = useRef(6.5);
  const captionYRef       = useRef(50);
  const captionDurRef     = useRef(0);
  const hasFacecamRef     = useRef(true);
  const clipXPctRef       = useRef(50);
  const xKeyframesRef     = useRef([]); // [{t, x}]
  const curSubRef         = useRef("");
  const trimInRef         = useRef(0);
  const trimOutRef        = useRef(0);
  const cutsRef           = useRef([]);
  const vidDurRef         = useRef(0);

  useEffect(() => { fcRectRef.current = fcRect; },           [fcRect]);
  useEffect(() => { captionRef.current = caption; },         [caption]);
  useEffect(() => { captionSizeRef.current = captionSize; }, [captionSize]);
  useEffect(() => { captionYRef.current = captionY; },       [captionY]);
  useEffect(() => { captionDurRef.current = captionDuration;}, [captionDuration]);
  useEffect(() => { hasFacecamRef.current = hasFacecam; },   [hasFacecam]);
  useEffect(() => { clipXPctRef.current = clipXPct; },       [clipXPct]);
  useEffect(() => { xKeyframesRef.current = xKeyframes; },   [xKeyframes]);
  useEffect(() => { trimInRef.current = trimIn; },           [trimIn]);
  useEffect(() => { trimOutRef.current = trimOut; },         [trimOut]);
  useEffect(() => { cutsRef.current = cuts; },               [cuts]);
  useEffect(() => { vidDurRef.current = vidDur; },           [vidDur]);

  // ── Persist ───────────────────────────────────────────────────────────────────
  useEffect(() => { saveProjects(projects); }, [projects]);
  useEffect(() => { if (vidRef.current) vidRef.current.volume = volume; }, [volume]);

  const saveProjectState = useCallback((updates = {}) => {
    if (!activeProj) return;
    setProjects(prev => prev.map(p => p.id === activeProj.id ? { ...p, ...updates } : p));
  }, [activeProj]);

  // ── Project ───────────────────────────────────────────────────────────────────
  const createProject = () => {
    if (!projName.trim()) return;
    const p = { id: Date.now(), name: projName.trim(), date: new Date().toLocaleDateString(), hasVideo: false, hasFacecam };
    hasFacecamRef.current = hasFacecam; // sync ref immediately — don't wait for useEffect
    clipXPctRef.current = 50;
    setProjects(prev => [p, ...prev]);
    setActiveProj(p); setModal(false); setModalStep(1); setProjName("");
    setClipXPct(50);
    resetEditor(); setPage("editor");
  };

  const openModal = () => { setModalStep(1); setProjName(""); setHasFacecam(true); setModal(true); };

  const deleteProject = async (id, e) => {
    e.stopPropagation();
    await dbDel(id).catch(() => {});
    setProjects(prev => prev.filter(p => p.id !== id));
  };

  const openProject = async (p) => {
    setLoadingProj(true); setActiveProj(p); resetEditor(); setPage("editor");
    if (p.hasVideo) {
      try {
        const blob = await dbGet(p.id);
        if (blob) {
          const url = URL.createObjectURL(blob);
          setVideoSrc(url);
          const v = vidRef.current;
          if (v) { v.src = url; v.load(); v.play().catch(() => {}); setIsPlaying(true); }
          if (p.fcRect) { setFcRect(p.fcRect); setFcConfirmed(true); }
          if (p.hasFacecam !== undefined) { setHasFacecam(p.hasFacecam); hasFacecamRef.current = p.hasFacecam; }
          if (p.clipXPct !== undefined) { setClipXPct(p.clipXPct); clipXPctRef.current = p.clipXPct; }
          if (p.xKeyframes) { setXKeyframes(p.xKeyframes); xKeyframesRef.current = p.xKeyframes; }
          if (p.caption) setCaption(p.caption);
          if (p.captionSize) setCaptionSize(p.captionSize);
          if (p.captionY !== undefined) setCaptionY(p.captionY);
          if (p.captionDuration !== undefined) setCaptionDuration(p.captionDuration);
          if (p.cuts) setCuts(p.cuts);
          if (p.trimIn !== undefined) setTrimIn(p.trimIn);
          if (p.trimOut) setTrimOut(p.trimOut);
          setStep(p.fcRect ? 3 : 2);
        }
      } catch (err) { console.error(err); }
    }
    setLoadingProj(false);
  };

  const resetEditor = () => {
    setStep(1); setVideoSrc(null); setFcRect(null); setFcConfirmed(false); setDrawMode(false);
    setCaption(""); setCaptionSize(6.5); setCaptionDuration(0); setCaptionY(50);
    setSegs([]); setExportUrl(null); setIsPlaying(false);
    setTrimIn(0); setTrimOut(0); setVidDur(0); setCurrentTime(0); setCuts([]); setXKeyframes([]);
    curSubRef.current = ""; fcRectRef.current = null;
    captionRef.current = ""; trimInRef.current = 0; trimOutRef.current = 0;
    cutsRef.current = []; vidDurRef.current = 0; xKeyframesRef.current = [];
    acRef.current = null; adstRef.current = null;
  };

  // ── Upload ────────────────────────────────────────────────────────────────────
  const handleFile = async f => {
    if (!f?.type.startsWith("video/")) return;
    const url = URL.createObjectURL(f);
    setVideoSrc(url); setFcRect(null); setFcConfirmed(false);
    setCaption(""); setSegs([]); setExportUrl(null); setCuts([]);
    const v = vidRef.current;
    if (v) { v.src = url; v.load(); v.play().catch(() => {}); setIsPlaying(true); }
    setStep(2);
    try { await dbPut(activeProj.id, f); saveProjectState({ hasVideo: true }); }
    catch (err) { console.error("DB save failed", err); }
  };

  // ── Video meta ────────────────────────────────────────────────────────────────
  const onVidMeta = () => {
    const v = vidRef.current; if (!v) return;
    const dur = v.duration;
    setVidDur(dur); vidDurRef.current = dur;
    setTrimIn(0); setTrimOut(dur);
    trimInRef.current = 0; trimOutRef.current = dur;
    setCaptionDuration(dur);
  };

  // ── Subtitle + trim loop enforcement ─────────────────────────────────────────
  useEffect(() => {
    const v = vidRef.current; if (!v) return;
    const onTime = () => {
      const t = v.currentTime;
      setCurrentTime(t);
      const s = segs.find(x => t >= x.s && t <= x.e);
      curSubRef.current = s?.t || "";
      // If inside a cut region, jump to end of that cut
      const activeCut = cutsRef.current.find(c => t >= c.s && t < c.e);
      if (activeCut) { v.currentTime = activeCut.e; return; }
      // Trim out
      if (t >= trimOutRef.current) v.currentTime = trimInRef.current;
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [segs]);

  // ── X interpolation from keyframes ───────────────────────────────────────────
  // Returns interpolated X (0–100) at time t given sorted keyframes
  const getXAtTime = (kfs, t) => {
    if (!kfs || kfs.length === 0) return clipXPctRef.current;
    if (kfs.length === 1) return kfs[0].x;
    if (t <= kfs[0].t) return kfs[0].x;
    if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].x;
    // Find surrounding keyframes
    let lo = kfs[0], hi = kfs[kfs.length - 1];
    for (let i = 0; i < kfs.length - 1; i++) {
      if (t >= kfs[i].t && t <= kfs[i + 1].t) { lo = kfs[i]; hi = kfs[i + 1]; break; }
    }
    const pct = (t - lo.t) / (hi.t - lo.t);
    // Smooth easing (ease-in-out)
    const ease = pct < 0.5 ? 2 * pct * pct : -1 + (4 - 2 * pct) * pct;
    return lo.x + (hi.x - lo.x) * ease;
  };

  // ── RAF preview ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = prevCanRef.current, v = vidRef.current;
      if (!canvas || !v || !v.src || v.readyState < 2) return;
      const ctx = canvas.getContext("2d");
      // Internal 2x resolution
      const W = CW, H = CH;
      const vw = v.videoWidth || 1, vh = v.videoHeight || 1;

      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);

      if (hasFacecamRef.current) {
        // ── Split layout: facecam top, gameplay bottom ──────────────────────────
        const fcH = Math.round(H * FC_FRAC), mainH = H - fcH;

        // Gameplay bottom — cover fill
        const gs = Math.max(W/vw, mainH/vh);
        ctx.drawImage(v, (W-vw*gs)/2, fcH+(mainH-vh*gs)/2, vw*gs, vh*gs);

        // Facecam top
        const fc = fcRectRef.current;
        if (fc && fc.w > 4 && fc.h > 4) {
          const fs = Math.max(W/fc.w, fcH/fc.h);
          ctx.drawImage(v, fc.x, fc.y, fc.w, fc.h, (W-fc.w*fs)/2, (fcH-fc.h*fs)/2, fc.w*fs, fc.h*fs);
        } else {
          ctx.fillStyle = "#0e0e0e"; ctx.fillRect(0, 0, W, fcH);
          ctx.fillStyle = "#333"; ctx.font = `${Math.round(W*0.04)}px DM Mono, monospace`; ctx.textAlign = "center";
          ctx.fillText("Select facecam in Step 2", W/2, fcH/2); ctx.textAlign = "left";
        }
        // Divider
        ctx.fillStyle = "#000"; ctx.fillRect(0, fcH-2, W, 4);
      } else {
        // ── Full frame: fill entire 9:16 with clip, X-axis adjustable ──────────
        const scale = Math.max(W/vw, H/vh);
        const dw = vw * scale, dh = vh * scale;
        const maxOffsetX = (dw - W) / 2;
        // Use keyframe-interpolated X if keyframes exist, else static clipXPct
        const kfs = xKeyframesRef.current;
        const xVal = kfs.length > 0 ? getXAtTime(kfs, v.currentTime) : clipXPctRef.current;
        const offsetX = ((xVal - 50) / 50) * maxOffsetX;
        const dx = (W - dw) / 2 - offsetX;
        const dy = (H - dh) / 2;
        ctx.drawImage(v, dx, dy, dw, dh);
      }

      // ── Caption — multiline, thick stroke, Y position ───────────────────────
      const cap = captionRef.current;
      const ct = v.currentTime;
      const cdur = captionDurRef.current;
      if (cap && (cdur === 0 || ct <= cdur)) {
        const fs = Math.round(W * (captionSizeRef.current / 100));
        const lines = cap.split("\n").filter(l => l.trim() !== "");
        const lineH = fs * 1.3;
        const totalH = lines.length * lineH;
        const baseY = (captionYRef.current / 100) * H - totalH / 2 + fs;
        ctx.save();
        ctx.font = `900 ${fs}px Arial Black, Arial`;
        ctx.textAlign = "center"; ctx.lineJoin = "round"; ctx.lineCap = "round";
        lines.forEach((line, i) => {
          const y = baseY + i * lineH;
          // Draw stroke 3x for really thick outline like the reference
          ctx.strokeStyle = "#000"; ctx.lineWidth = fs * 0.55;
          ctx.strokeText(line, W/2, y);
          ctx.strokeText(line, W/2, y);
          ctx.strokeText(line, W/2, y);
          ctx.fillStyle = "#fff";
          ctx.fillText(line, W/2, y);
        });
        ctx.restore();
      }

      // ── Subtitle ─────────────────────────────────────────────────────────────
      const sub = curSubRef.current;
      if (sub) {
        const fs = Math.round(W * 0.05);
        ctx.save(); ctx.font = `bold ${fs}px Arial`; ctx.textAlign = "center"; ctx.lineJoin = "round";
        ctx.strokeStyle = "#000"; ctx.lineWidth = fs * 0.3;
        ctx.strokeText(sub, W/2, H - 36);
        ctx.fillStyle = "#ffee58"; ctx.fillText(sub, W/2, H - 36);
        ctx.restore();
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Facecam drag ──────────────────────────────────────────────────────────────
  const syncCanvas = () => {
    const sv = selVidRef.current, c = selCanRef.current; if (!sv||!c) return;
    const r = sv.getBoundingClientRect();
    if (r.width > 10) { c.width = Math.round(r.width); c.height = Math.round(r.height); }
  };
  const redrawOverlay = b => {
    const c = selCanRef.current; if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0,0,c.width,c.height);
    if (!b||b.w<2||b.h<2) return;
    ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0,0,c.width,c.height);
    ctx.clearRect(b.x,b.y,b.w,b.h);
    ctx.strokeStyle = "#a8ff78"; ctx.lineWidth = 2; ctx.strokeRect(b.x,b.y,b.w,b.h);
    ctx.fillStyle = "#a8ff78"; ctx.font = "bold 11px monospace";
    ctx.fillText("FACECAM", b.x+5, b.y+15);
  };
  const exy = (e, el) => { const r = el.getBoundingClientRect(); return [e.clientX-r.left, e.clientY-r.top]; };
  const onMouseDown = useCallback(e => {
    e.preventDefault(); syncCanvas();
    const c = selCanRef.current; if (!c) return;
    const [x,y] = exy(e,c);
    draggingRef.current = true; anchorRef.current = [x,y]; boxRef.current = null;
    c.getContext("2d").clearRect(0,0,c.width,c.height);
  }, []);
  const onMouseMove = useCallback(e => {
    if (!draggingRef.current||!anchorRef.current) return;
    const c = selCanRef.current; if (!c) return;
    const [x2,y2] = exy(e,c), [ax,ay] = anchorRef.current;
    const b = {x:Math.min(ax,x2),y:Math.min(ay,y2),w:Math.abs(x2-ax),h:Math.abs(y2-ay)};
    boxRef.current = b; redrawOverlay(b);
  }, []);
  const onMouseUp = useCallback(() => {
    if (!draggingRef.current) return; draggingRef.current = false;
    const b = boxRef.current; if (!b||b.w<6||b.h<6) return;
    const sv = selVidRef.current, c = selCanRef.current; if (!sv||!c) return;
    const rect = {x:b.x*(sv.videoWidth/c.width), y:b.y*(sv.videoHeight/c.height), w:b.w*(sv.videoWidth/c.width), h:b.h*(sv.videoHeight/c.height)};
    setFcRect(rect); setFcConfirmed(true); saveProjectState({fcRect:rect});
  }, [saveProjectState]);

  // ── Timeline (trim + cut) ─────────────────────────────────────────────────────
  const getPct = (e, el) => {
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const [pendingCut, setPendingCut] = useState(null); // {s, e} in seconds being drawn

  const onTimelineDown = e => {
    e.preventDefault();
    const el = timelineRef.current; if (!el || !vidDur) return;
    const pct = getPct(e, el);
    const t = pct * vidDur;
    const inPct = trimIn/vidDur, outPct = trimOut/vidDur;
    const dIn = Math.abs(pct - inPct), dOut = Math.abs(pct - outPct);

    if (dIn < 0.04) { trimDragRef.current = "in"; return; }
    if (dOut < 0.04) { trimDragRef.current = "out"; return; }

    // Check if clicking existing cut to delete it
    const hitCut = cuts.findIndex(c => t >= c.s && t <= c.e);
    if (hitCut !== -1) {
      // single click = remove cut
      setCuts(prev => { const n = prev.filter((_,i)=>i!==hitCut); cutsRef.current=n; saveProjectState({cuts:n}); return n; });
      return;
    }

    // Start drawing a new cut
    cutAnchorRef.current = t;
    cutDragRef.current = true;
    setPendingCut({s: t, e: t});
    if (vidRef.current) vidRef.current.currentTime = t;
  };

  const onTimelineMove = e => {
    if (!timelineRef.current || !vidDur) return;
    const pct = getPct(e, timelineRef.current);
    const t = pct * vidDur;

    if (trimDragRef.current === "in") {
      const v = clamp(t, 0, trimOut - 0.5);
      setTrimIn(v); trimInRef.current = v;
      if (vidRef.current) vidRef.current.currentTime = v;
    } else if (trimDragRef.current === "out") {
      const v = clamp(t, trimIn + 0.5, vidDur);
      setTrimOut(v); trimOutRef.current = v;
      if (vidRef.current) vidRef.current.currentTime = v;
    } else if (cutDragRef.current && cutAnchorRef.current !== null) {
      const s = Math.min(cutAnchorRef.current, t);
      const en = Math.max(cutAnchorRef.current, t);
      setPendingCut({s, e: en});
    }
  };

  const onTimelineUp = () => {
    if (trimDragRef.current) {
      saveProjectState({trimIn, trimOut});
      trimDragRef.current = null;
    }
    if (cutDragRef.current && pendingCut && (pendingCut.e - pendingCut.s) > 0.2) {
      setCuts(prev => {
        const next = mergeCuts([...prev, pendingCut]);
        cutsRef.current = next;
        saveProjectState({cuts: next});
        return next;
      });
    }
    cutDragRef.current = false;
    cutAnchorRef.current = null;
    setPendingCut(null);
  };

  useEffect(() => {
    window.addEventListener("mousemove", onTimelineMove);
    window.addEventListener("mouseup", onTimelineUp);
    return () => { window.removeEventListener("mousemove", onTimelineMove); window.removeEventListener("mouseup", onTimelineUp); };
  }, [vidDur, trimIn, trimOut, cuts, pendingCut]);

  // ── Play/Pause ────────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = vidRef.current; if (!v) return;
    if (v.paused) {
      if (v.currentTime >= trimOutRef.current) v.currentTime = trimInRef.current;
      v.play(); setIsPlaying(true);
    } else { v.pause(); setIsPlaying(false); }
  };

  // ── AI caption ────────────────────────────────────────────────────────────────
  const genCaption = async () => {
    setGenning(true);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:200,
          system:"Generate a short (2–6 word) viral TikTok caption for a gaming clip. No hashtags, no quotes, no punctuation. Output ONLY the words.",
          messages:[{role:"user", content:`Project: "${activeProj?.name}". Punchy caption.`}] })
      });
      const d = await r.json();
      const cap = d.content?.[0]?.text?.trim().replace(/["']/g,"") || "";
      setCaption(cap); saveProjectState({caption:cap});
    } catch(err) { console.error(err); }
    setGenning(false);
  };

  // ── Whisper ───────────────────────────────────────────────────────────────────
  const doTranscribe = async () => {
    if (!oaiKey || !videoSrc) return; setTranscribing(true);
    try {
      const blob = await fetch(videoSrc).then(r => r.blob());
      const fd = new FormData();
      fd.append("file", blob, "clip.mp4"); fd.append("model","whisper-1");
      fd.append("response_format","verbose_json"); fd.append("timestamp_granularities[]","segment");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions",
        {method:"POST", headers:{Authorization:`Bearer ${oaiKey}`}, body:fd});
      const d = await r.json();
      setSegs((d.segments||[]).map(s=>({s:s.start,e:s.end,t:s.text.trim()})));
    } catch(err) { console.error(err); alert("Transcription failed."); }
    setTranscribing(false);
  };

  // ── Free transcribe — Web Speech API ─────────────────────────────────────────
  const doFreeTranscribe = () => {
    const v = vidRef.current;
    if (!v || !videoSrc) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Your browser doesn't support free transcription. Try Chrome."); return; }
    setFreeTranscribing(true); setFreeTranscribeStatus("Starting — keep volume up...");
    const newSegs = [];
    const rec = new SR();
    rec.continuous = true; rec.interimResults = false; rec.lang = "en-US";
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const t = e.results[i][0].transcript.trim();
          const now = v.currentTime;
          newSegs.push({ s: Math.max(0, now - 3), e: now, t });
          setFreeTranscribeStatus(`Captured: "${t.slice(0,40)}..."`);
        }
      }
    };
    rec.onerror = err => { console.error(err); };
    rec.onend = () => {
      if (freeTranscribing) rec.start(); // restart if still going
    };
    // Play from trimIn, stop at trimOut
    v.currentTime = trimInRef.current;
    v.play(); setIsPlaying(true);
    rec.start();
    const stopAt = (trimOutRef.current - trimInRef.current) * 1000;
    setTimeout(() => {
      rec.stop(); v.pause(); setIsPlaying(false);
      setSegs(newSegs);
      setFreeTranscribing(false);
      setFreeTranscribeStatus(`✓ Done — ${newSegs.length} segments captured`);
    }, stopAt + 500);
  };

  // ── AssemblyAI transcription (free tier) ──────────────────────────────────────
  const doAssemblyTranscribe = async () => {
    if (!aaiKey || !videoSrc) return;
    localStorage.setItem("aai_key", aaiKey);
    setAaiTranscribing(true);
    try {
      // Step 1: upload the file
      const blob = await fetch(videoSrc).then(r => r.blob());
      const upRes = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: { authorization: aaiKey, "content-type": "application/octet-stream" },
        body: blob
      });
      const { upload_url } = await upRes.json();
      // Step 2: request transcript
      const txRes = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: aaiKey, "content-type": "application/json" },
        body: JSON.stringify({ audio_url: upload_url })
      });
      const { id } = await txRes.json();
      // Step 3: poll until done
      let result;
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`,
          { headers: { authorization: aaiKey } });
        result = await poll.json();
        if (result.status === "completed") break;
        if (result.status === "error") throw new Error(result.error);
      }
      if (result?.words) {
        // Group words into ~4 word chunks
        const chunks = [];
        for (let i = 0; i < result.words.length; i += 4) {
          const slice = result.words.slice(i, i + 4);
          chunks.push({
            s: slice[0].start / 1000,
            e: slice[slice.length-1].end / 1000,
            t: slice.map(w => w.text).join(" ")
          });
        }
        setSegs(chunks);
      }
    } catch (err) {
      console.error(err); alert("AssemblyAI failed: " + err.message);
    }
    setAaiTranscribing(false);
  };
  const doExport = async () => {
    const canvas = prevCanRef.current, video = vidRef.current;
    if (!canvas || !video) return;
    setExporting(true); setExportUrl(null); chunks.current = [];
    try {
      const keeps = keepSegments(cutsRef.current, vidDurRef.current)
        .filter(k => k.e > trimInRef.current && k.s < trimOutRef.current)
        .map(k => ({s: Math.max(k.s, trimInRef.current), e: Math.min(k.e, trimOutRef.current)}));

      if (!keeps.length) { alert("Nothing to export — entire clip is cut."); setExporting(false); return; }

      video.pause(); video.currentTime = keeps[0].s;
      await new Promise(r => { video.onseeked = r; setTimeout(r,800); });

      const vs = canvas.captureStream(30);
      if (!acRef.current) {
        const ac = new AudioContext(), src = ac.createMediaElementSource(video), dst = ac.createMediaStreamDestination();
        src.connect(dst); src.connect(ac.destination); acRef.current = ac; adstRef.current = dst;
      }
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
      const stream = new MediaStream([...vs.getVideoTracks(), ...adstRef.current.stream.getAudioTracks()]);
      const rec = new MediaRecorder(stream, {mimeType:mime, videoBitsPerSecond:6_000_000});
      rec.ondataavailable = e => { if (e.data.size>0) chunks.current.push(e.data); };
      rec.onstop = () => {
        setExportUrl(URL.createObjectURL(new Blob(chunks.current, {type:mime})));
        setExporting(false); video.loop=true; video.play(); setIsPlaying(true);
      };

      let segIdx = 0;
      rec.start(100); video.play(); setIsPlaying(true);

      const checkInterval = setInterval(() => {
        const t = video.currentTime;
        if (t >= keeps[segIdx].e - 0.08) {
          segIdx++;
          if (segIdx >= keeps.length) { clearInterval(checkInterval); rec.stop(); video.pause(); }
          else {
            video.pause();
            video.currentTime = keeps[segIdx].s;
            video.play();
          }
        }
      }, 60);
    } catch(err) { console.error(err); setExporting(false); alert("Export failed: "+err.message); }
  };

  // ── Styles ────────────────────────────────────────────────────────────────────
  const T = {
    input: {background:"#0d0d0d",border:"1px solid #1e1e1e",borderRadius:8,padding:"9px 14px",color:"#d0d0d0",fontSize:13,width:"100%",fontFamily:"DM Sans, sans-serif"},
    btnP: {padding:"9px 20px",borderRadius:8,border:"none",background:"#e8e8e8",color:"#000",fontWeight:600,cursor:"pointer",fontSize:13,fontFamily:"DM Sans, sans-serif"},
    btnG: {padding:"9px 18px",borderRadius:8,background:"transparent",color:"#555",border:"1px solid #1e1e1e",fontWeight:500,cursor:"pointer",fontSize:13,fontFamily:"DM Sans, sans-serif"},
    card: {background:"#111",borderRadius:14,padding:20,border:"1px solid #1a1a1a"},
    label: {fontSize:10,color:"#3a3a3a",marginBottom:8,display:"block",fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",fontFamily:"DM Mono, monospace"},
    row: {display:"flex",alignItems:"center",gap:10},
  };

  const filtered = projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  const mergedCuts = mergeCuts(cuts);

  // ══ DASHBOARD ════════════════════════════════════════════════════════════════
  if (page === "dash") return (
    <div style={{display:"flex",height:"100vh",background:"#0a0a0a",color:"#d0d0d0",fontFamily:"DM Sans, sans-serif",overflow:"hidden"}}>
      <style>{css}</style>
      {/* Sidebar */}
      <div style={{width:56,background:"#0d0d0d",borderRight:"1px solid #141414",display:"flex",flexDirection:"column",alignItems:"center",padding:"16px 0",gap:4,flexShrink:0}}>
        <div style={{fontSize:18,marginBottom:20}}>✂️</div>
        {[["🏠","Home"],["⚙️","Settings"]].map(([icon,label])=>(
          <button key={label} className="icon-btn" title={label}
            style={{width:36,height:36,borderRadius:8,border:"none",background:label==="Home"?"#1a1a1a":"transparent",cursor:"pointer",fontSize:16}}>{icon}</button>
        ))}
        <div style={{flex:1}}/>
        <div style={{width:28,height:28,borderRadius:"50%",background:"#2a2a2a",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#666"}}>M</div>
      </div>
      {/* Main */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"18px 28px",borderBottom:"1px solid #141414",display:"flex",alignItems:"center",gap:16,flexShrink:0}}>
          <div>
            <h1 style={{fontSize:22,fontWeight:700,color:"#e0e0e0"}}>Projects</h1>
            <p style={{fontSize:12,color:"#333",marginTop:2}}>Your saved TikTok clips</p>
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:10,alignItems:"center"}}>
            <div style={{position:"relative"}}>
              <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#333",fontSize:13}}>🔍</span>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search projects..."
                style={{...T.input,width:220,paddingLeft:32,fontSize:12}}/>
            </div>
            <button className="btn-p" onClick={openModal}
              style={{...T.btnP,display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}>
              + New Project
            </button>
          </div>
        </div>
        {/* Action cards */}
        <div style={{padding:"24px 28px 0",display:"flex",gap:12,flexShrink:0}}>
          {[
            {icon:"📹",label:"New Clip",sub:"Start from a video",action:openModal},
            {icon:"🎬",label:"Recent",sub:`${projects.length} project${projects.length!==1?"s":""}`,action:null},
            {icon:"⬇️",label:"Downloads",sub:"Exported clips",action:null},
          ].map(c=>(
            <div key={c.label} className="card-hover" onClick={c.action||undefined}
              style={{background:"#111",borderRadius:12,padding:"14px 18px",border:"1px solid #1a1a1a",cursor:c.action?"pointer":"default",display:"flex",alignItems:"center",gap:12,flex:1}}>
              <span style={{fontSize:22}}>{c.icon}</span>
              <div>
                <div style={{fontWeight:600,fontSize:13,color:"#ccc"}}>{c.label}</div>
                <div style={{fontSize:11,color:"#383838",marginTop:2}}>{c.sub}</div>
              </div>
              <span style={{marginLeft:"auto",color:"#282828",fontSize:16}}>›</span>
            </div>
          ))}
        </div>
        {/* Project list */}
        <div style={{flex:1,overflowY:"auto",padding:"20px 28px"}}>
          {filtered.length===0 ? (
            <div style={{textAlign:"center",marginTop:80,color:"#222"}}>
              <div style={{fontSize:36,marginBottom:14}}>🎬</div>
              <div style={{fontSize:14,fontWeight:500,color:"#2a2a2a"}}>No projects yet</div>
              <div style={{fontSize:12,color:"#1e1e1e",marginTop:6}}>Hit "New Project" to get started</div>
            </div>
          ) : (
            <>
              <div style={{fontSize:10,color:"#2a2a2a",letterSpacing:"0.1em",fontFamily:"DM Mono, monospace",marginBottom:10}}>ALL PROJECTS</div>
              {filtered.map(p=>(
                <div key={p.id} className="proj-row" onClick={()=>openProject(p)}
                  style={{display:"flex",alignItems:"center",gap:14,padding:"12px 14px",borderRadius:10,cursor:"pointer",marginBottom:4,transition:"background .12s"}}>
                  <div style={{width:36,height:36,background:"#161616",borderRadius:8,border:"1px solid #1e1e1e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🎬</div>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:13,color:"#c0c0c0"}}>{p.name}</div>
                    <div style={{fontSize:11,color:"#333",marginTop:2,fontFamily:"DM Mono, monospace"}}>{p.date} {p.hasVideo?"· video saved":"· no video"}</div>
                  </div>
                  <button className="delete-btn" onClick={e=>deleteProject(p.id,e)}
                    style={{background:"transparent",border:"none",color:"#444",cursor:"pointer",fontSize:16,padding:"4px 8px",borderRadius:6}}>🗑</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {modal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.9)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}}
          onClick={e=>{if(e.target===e.currentTarget){setModal(false);setModalStep(1);}}}>
          <div style={{background:"#111",borderRadius:18,padding:32,width:380,border:"1px solid #1e1e1e"}}>
            {modalStep===1&&(
              <>
                <div style={T.label}>NEW PROJECT — STEP 1 OF 2</div>
                <input value={projName} onChange={e=>setProjName(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&projName.trim()&&setModalStep(2)}
                  placeholder="e.g. Kai Cenat Rage Moment"
                  style={{...T.input,marginBottom:18,marginTop:8}} autoFocus/>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button onClick={()=>{setModal(false);setModalStep(1);}} className="btn-g" style={T.btnG}>Cancel</button>
                  <button onClick={()=>projName.trim()&&setModalStep(2)} className="btn-p" style={T.btnP}>Next →</button>
                </div>
              </>
            )}
            {modalStep===2&&(
              <>
                <div style={T.label}>NEW PROJECT — STEP 2 OF 2</div>
                <p style={{fontSize:14,fontWeight:600,color:"#ccc",marginBottom:6,marginTop:8}}>Does this clip have a facecam?</p>
                <p style={{fontSize:12,color:"#333",marginBottom:20,lineHeight:1.6}}>Facecam = a streamer's face in the corner. If yes, the layout splits into facecam top + gameplay bottom. If no, the clip fills the full screen.</p>
                <div style={{display:"flex",gap:10,marginBottom:20}}>
                  <button onClick={()=>setHasFacecam(true)}
                    style={{...T.btnG,flex:1,background:hasFacecam?"#0e1a0e":"transparent",color:hasFacecam?"#a8ff78":"#555",border:`1px solid ${hasFacecam?"#1a3a1a":"#1e1e1e"}`,fontWeight:hasFacecam?700:400}}>
                    ✓ Yes, has facecam
                  </button>
                  <button onClick={()=>setHasFacecam(false)}
                    style={{...T.btnG,flex:1,background:!hasFacecam?"#1a1a0e":"transparent",color:!hasFacecam?"#ffee58":"#555",border:`1px solid ${!hasFacecam?"#3a3a1a":"#1e1e1e"}`,fontWeight:!hasFacecam?700:400}}>
                    ✗ No facecam
                  </button>
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button onClick={()=>setModalStep(1)} className="btn-g" style={T.btnG}>← Back</button>
                  <button onClick={createProject} className="btn-p" style={T.btnP}>Create →</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // ══ EDITOR ════════════════════════════════════════════════════════════════════
  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:"#0a0a0a",color:"#d0d0d0",fontFamily:"DM Sans, sans-serif",overflow:"hidden"}}>
      <style>{css}</style>

      {/* Nav */}
      <div style={{background:"#0d0d0d",borderBottom:"1px solid #141414",padding:"10px 20px",display:"flex",alignItems:"center",gap:14,flexShrink:0}}>
        <button onClick={()=>setPage("dash")} style={{background:"transparent",border:"none",color:"#444",cursor:"pointer",fontSize:18,lineHeight:1,padding:"2px 6px"}}>←</button>
        <span style={{fontWeight:600,fontSize:13,color:"#aaa"}}>{activeProj?.name}</span>
        {loadingProj&&<span style={{fontSize:11,color:"#333",fontFamily:"DM Mono, monospace"}}>loading...</span>}
        <div style={{marginLeft:"auto",display:"flex",gap:5}}>
          {["Upload","Facecam & Trim","Caption","Export"].map((s,i)=>(
            <div key={i} onClick={()=>videoSrc&&setStep(i+1)}
              style={{padding:"4px 12px",borderRadius:20,fontSize:11,fontWeight:600,cursor:videoSrc?"pointer":"default",fontFamily:"DM Mono, monospace",
                background:step===i+1?"#e8e8e8":step>i+1?"#0e1a0e":"#111",
                color:step===i+1?"#000":step>i+1?"#4a8a4a":"#2a2a2a",
                border:`1px solid ${step>i+1?"#1a3a1a":"transparent"}`}}>
              {step>i+1?"✓ ":""}{s}
            </div>
          ))}
        </div>
      </div>

      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {/* Left */}
        <div style={{flex:1,padding:28,overflowY:"auto",borderRight:"1px solid #111"}}>

          {/* STEP 1 */}
          {step===1&&(
            <div>
              <div style={T.label}>Step 1</div>
              <h2 style={{fontSize:20,fontWeight:700,marginBottom:6}}>Upload Clip</h2>
              <p style={{color:"#333",fontSize:13,marginBottom:24}}>Drop your stream clip to start</p>
              <div className="drop-zone" onDragOver={e=>e.preventDefault()}
                onDrop={e=>{e.preventDefault();handleFile(e.dataTransfer.files[0]);}}
                onClick={()=>fileRef.current?.click()}
                style={{border:"2px dashed #1a1a1a",borderRadius:16,padding:"64px 40px",textAlign:"center",cursor:"pointer",maxWidth:480,background:"#090909"}}>
                <div style={{fontSize:38,marginBottom:12}}>📹</div>
                <div style={{fontWeight:600,marginBottom:6,fontSize:14}}>Drop video here or click</div>
                <div style={{color:"#2a2a2a",fontSize:12,fontFamily:"DM Mono, monospace"}}>MP4 · MOV · WebM</div>
                <input ref={fileRef} type="file" accept="video/*" style={{display:"none"}} onChange={e=>handleFile(e.target.files?.[0])}/>
              </div>
            </div>
          )}

          {/* STEP 2 — Facecam + Trim + Cuts */}
          {step===2&&videoSrc&&(
            <div>
              <div style={T.label}>Step 2</div>
              <h2 style={{fontSize:20,fontWeight:700,marginBottom:6}}>Facecam & Trim</h2>

              {/* Facecam selector */}
              {/* Facecam selector — only shown if project has facecam */}
              {hasFacecam&&(<>
              <p style={{color:"#333",fontSize:13,marginBottom:12}}>Scrub to the right frame, then enable draw mode and drag a box over the facecam.</p>

              {/* Draw mode toggle */}
              <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:14}}>
                <button onClick={()=>setDrawMode(m=>!m)}
                  style={{...T.btnP,
                    background: drawMode ? "#a8ff78" : "#191919",
                    color: drawMode ? "#000" : "#555",
                    border: drawMode ? "none" : "1px solid #2a2a2a",
                    fontWeight: 700
                  }}>
                  {drawMode ? "✏️ Drawing — drag on video" : "✏️ Enable Draw Mode"}
                </button>
                {drawMode && <span style={{fontSize:12,color:"#a8ff78",fontFamily:"DM Mono, monospace"}}>drag over the facecam now</span>}
                {!drawMode && <span style={{fontSize:12,color:"#333",fontFamily:"DM Mono, monospace"}}>video controls active — scrub freely</span>}
              </div>

              <div style={{position:"relative",maxWidth:560,width:"100%",userSelect:"none"}}>
                <video ref={selVidRef} src={videoSrc} controls
                  style={{width:"100%",display:"block",borderRadius:10}}
                  onLoadedMetadata={syncCanvas}/>
                {/* Canvas only intercepts mouse when drawMode is on */}
                <canvas ref={selCanRef}
                  style={{
                    position:"absolute",top:0,left:0,width:"100%",height:"100%",
                    borderRadius:10,
                    cursor: drawMode ? "crosshair" : "default",
                    pointerEvents: drawMode ? "all" : "none"
                  }}
                  onMouseDown={e=>{ if(!drawMode)return; onMouseDown(e); }}
                  onMouseMove={e=>{ if(!drawMode)return; onMouseMove(e); }}
                  onMouseUp={e=>{ if(!drawMode)return; onMouseUp(e); setDrawMode(false); }}
                  onMouseLeave={e=>{ if(!drawMode)return; onMouseUp(e); }}/>
              </div>
              </>)}
              {fcConfirmed&&<p style={{color:"#4a8a4a",fontSize:12,fontFamily:"DM Mono, monospace",marginTop:10}}>✓ facecam locked — check preview →</p>}

              {!hasFacecam&&videoSrc&&(
                <div style={{marginTop:20}}>

                  {/* Playbar */}
                  <div style={{...T.card, marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                      <button className="btn-g" onClick={togglePlay}
                        style={{...T.btnG,padding:"6px 14px",fontSize:13,flexShrink:0}}>
                        {isPlaying?"⏸":"▶"}
                      </button>
                      <span style={{fontSize:12,color:"#555",fontFamily:"DM Mono, monospace",flexShrink:0}}>
                        {fmt(currentTime)} / {fmt(vidDur)}
                      </span>
                    </div>
                    {vidDur>0&&(
                      <div style={{position:"relative",height:28,cursor:"pointer"}}
                        onClick={e=>{
                          const r=e.currentTarget.getBoundingClientRect();
                          const pct=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
                          if(vidRef.current) vidRef.current.currentTime=pct*vidDur;
                        }}>
                        <div style={{position:"absolute",top:"50%",left:0,right:0,height:4,background:"#1a1a1a",borderRadius:2,transform:"translateY(-50%)"}}>
                          <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${(currentTime/vidDur)*100}%`,background:"#a8ff78",borderRadius:2}}/>
                        </div>
                        <div style={{position:"absolute",left:`${(currentTime/vidDur)*100}%`,top:"50%",transform:"translate(-50%,-50%)",width:14,height:14,borderRadius:"50%",background:"#e8e8e8",boxShadow:"0 0 6px rgba(0,0,0,.6)",pointerEvents:"none"}}/>
                      </div>
                    )}
                  </div>

                  {/* Default X slider */}
                  <div style={{...T.card, marginBottom:12}}>
                    <div style={{...T.label,marginBottom:6}}>Default Horizontal Position</div>
                    <p style={{fontSize:12,color:"#333",marginBottom:12}}>Used when no keyframe is active</p>
                    <input type="range" min={0} max={100} step={1} value={clipXPct}
                      onChange={e=>{const v=parseInt(e.target.value);setClipXPct(v);clipXPctRef.current=v;saveProjectState({clipXPct:v});}}/>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#2a2a2a",fontFamily:"DM Mono, monospace",marginTop:4}}>
                      <span>← Left</span><span>Center</span><span>Right →</span>
                    </div>
                  </div>

                  {/* Keyframe editor */}
                  <div style={{...T.card}}>
                    <div style={{...T.label,marginBottom:4}}>X-Axis Keyframes</div>
                    <p style={{fontSize:12,color:"#333",marginBottom:14,lineHeight:1.6}}>
                      Scrub to a moment, set the X position, then hit <span style={{color:"#a8ff78"}}>+ Add Keyframe</span>. The clip smoothly moves between keyframes during playback.
                    </p>
                    <div style={{marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        <span style={{fontSize:11,color:"#444",fontFamily:"DM Mono, monospace"}}>X AT {fmt(currentTime)}</span>
                        <span style={{marginLeft:"auto",fontSize:12,color:"#a8ff78",fontFamily:"DM Mono, monospace"}}>{clipXPct}%</span>
                      </div>
                      <input type="range" min={0} max={100} step={1} value={clipXPct}
                        onChange={e=>{const v=parseInt(e.target.value);setClipXPct(v);clipXPctRef.current=v;}}/>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#2a2a2a",fontFamily:"DM Mono, monospace",marginTop:4}}>
                        <span>← Left</span><span>Center</span><span>Right →</span>
                      </div>
                    </div>
                    <button onClick={()=>{
                      const kf={t:parseFloat(currentTime.toFixed(2)),x:clipXPct};
                      const next=[...xKeyframes.filter(k=>Math.abs(k.t-kf.t)>0.1),kf].sort((a,b)=>a.t-b.t);
                      setXKeyframes(next); xKeyframesRef.current=next; saveProjectState({xKeyframes:next});
                    }} style={{...T.btnP,background:"#0e2a0e",color:"#a8ff78",border:"1px solid #1a4a1a",marginBottom:xKeyframes.length?14:0}}>
                      + Add Keyframe at {fmt(currentTime)}
                    </button>
                    {xKeyframes.length>0&&(
                      <div style={{borderTop:"1px solid #1a1a1a",paddingTop:12}}>
                        <div style={{fontSize:10,color:"#333",fontFamily:"DM Mono, monospace",marginBottom:8}}>
                          {xKeyframes.length} KEYFRAME{xKeyframes.length!==1?"S":""} — click timestamp to seek · drag slider to adjust
                        </div>
                        {xKeyframes.map((kf,i)=>(
                          <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:"#0d0d0d",borderRadius:8,marginBottom:6,border:"1px solid #1a1a1a"}}>
                            <button onClick={()=>{if(vidRef.current)vidRef.current.currentTime=kf.t;}}
                              style={{background:"transparent",border:"none",color:"#a8ff78",fontFamily:"DM Mono, monospace",fontSize:12,cursor:"pointer",padding:0,flexShrink:0}}>
                              ▶ {fmt(kf.t)}
                            </button>
                            <div style={{flex:1,height:3,background:"#1a1a1a",borderRadius:2,position:"relative"}}>
                              <div style={{position:"absolute",left:`${kf.x}%`,top:"50%",transform:"translate(-50%,-50%)",width:8,height:8,borderRadius:"50%",background:"#a8ff78"}}/>
                            </div>
                            <span style={{fontSize:11,color:"#555",fontFamily:"DM Mono, monospace",flexShrink:0,width:34}}>
                              {kf.x<33?"Left":kf.x<66?"Mid":"Right"}
                            </span>
                            <input type="range" min={0} max={100} step={1} value={kf.x}
                              onChange={e=>{
                                const next=xKeyframes.map((k,j)=>j===i?{...k,x:parseInt(e.target.value)}:k);
                                setXKeyframes(next); xKeyframesRef.current=next; saveProjectState({xKeyframes:next});
                              }} style={{width:70}}/>
                            <button onClick={()=>{
                              const next=xKeyframes.filter((_,j)=>j!==i);
                              setXKeyframes(next); xKeyframesRef.current=next; saveProjectState({xKeyframes:next});
                            }} style={{background:"transparent",border:"none",color:"#444",cursor:"pointer",fontSize:14,padding:"0 4px",flexShrink:0}}>✕</button>
                          </div>
                        ))}
                        <button onClick={()=>{setXKeyframes([]);xKeyframesRef.current=[];saveProjectState({xKeyframes:[]});}}
                          style={{...T.btnG,fontSize:11,padding:"5px 12px",marginTop:4}}>Clear all</button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Timeline */}
              {vidDur>0&&(
                <div style={{marginTop:28}}>
                  <div style={T.label}>Trim & Cut</div>
                  <p style={{color:"#333",fontSize:12,marginBottom:6}}>
                    Drag the <span style={{color:"#a8ff78"}}>green handles</span> to trim start/end.
                    Drag anywhere in the middle to <span style={{color:"#ff6b6b"}}>cut</span> a section. Click a red region to remove the cut.
                  </p>

                  <div style={{...T.card, padding:"18px 20px"}}>
                    {/* Timeline bar */}
                    <div ref={timelineRef}
                      style={{position:"relative",height:44,background:"#0d0d0d",borderRadius:8,cursor:"crosshair",userSelect:"none",marginBottom:10}}
                      onMouseDown={onTimelineDown}>

                      {/* Trim: dim outside */}
                      <div style={{position:"absolute",left:0,top:0,width:`${(trimIn/vidDur)*100}%`,height:"100%",background:"rgba(0,0,0,.7)",borderRadius:"8px 0 0 8px"}}/>
                      <div style={{position:"absolute",right:0,top:0,width:`${((vidDur-trimOut)/vidDur)*100}%`,height:"100%",background:"rgba(0,0,0,.7)",borderRadius:"0 8px 8px 0"}}/>

                      {/* Active region (green tint) */}
                      <div style={{position:"absolute",left:`${(trimIn/vidDur)*100}%`,width:`${((trimOut-trimIn)/vidDur)*100}%`,top:0,height:"100%",background:"#0e1a0e",border:"1px solid #1a3a1a",borderRadius:4}}/>

                      {/* Cut regions (red) */}
                      {mergedCuts.map((c,i)=>(
                        <div key={i} style={{position:"absolute",left:`${(c.s/vidDur)*100}%`,width:`${((c.e-c.s)/vidDur)*100}%`,top:0,height:"100%",background:"rgba(180,40,40,.55)",borderLeft:"2px solid #ff4444",borderRight:"2px solid #ff4444",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}
                          title="Click to remove cut">
                          <span style={{fontSize:9,color:"#ff8888",fontFamily:"DM Mono, monospace",pointerEvents:"none"}}>CUT</span>
                        </div>
                      ))}

                      {/* Pending cut being drawn */}
                      {pendingCut&&pendingCut.e-pendingCut.s>0.05&&(
                        <div style={{position:"absolute",left:`${(pendingCut.s/vidDur)*100}%`,width:`${((pendingCut.e-pendingCut.s)/vidDur)*100}%`,top:0,height:"100%",background:"rgba(180,40,40,.35)",borderLeft:"1px dashed #ff4444",borderRight:"1px dashed #ff4444",pointerEvents:"none"}}/>
                      )}

                      {/* Trim handles */}
                      <div className="trim-handle" style={{position:"absolute",left:`${(trimIn/vidDur)*100}%`,top:0,width:5,height:"100%",background:"#a8ff78",borderRadius:3,transform:"translateX(-50%)",cursor:"ew-resize",zIndex:3}}/>
                      <div className="trim-handle" style={{position:"absolute",left:`${(trimOut/vidDur)*100}%`,top:0,width:5,height:"100%",background:"#a8ff78",borderRadius:3,transform:"translateX(-50%)",cursor:"ew-resize",zIndex:3}}/>

                      {/* Playhead */}
                      <div style={{position:"absolute",left:`${(currentTime/vidDur)*100}%`,top:0,width:2,height:"100%",background:"#fff",opacity:.7,transform:"translateX(-50%)",pointerEvents:"none",zIndex:4}}/>
                    </div>

                    {/* Time labels */}
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,fontFamily:"DM Mono, monospace",color:"#444",marginBottom:10}}>
                      <span>In: <span style={{color:"#a8ff78"}}>{fmt(trimIn)}</span></span>
                      <span style={{color:"#2a2a2a"}}>Playable: {fmt(trimOut-trimIn)}</span>
                      <span>Out: <span style={{color:"#a8ff78"}}>{fmt(trimOut)}</span></span>
                    </div>

                    {/* Cut chips */}
                    {mergedCuts.length>0&&(
                      <div style={{borderTop:"1px solid #1a1a1a",paddingTop:10}}>
                        <div style={{fontSize:10,color:"#444",fontFamily:"DM Mono, monospace",marginBottom:8}}>CUTS ({mergedCuts.length}) — click chip to remove</div>
                        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                          {mergedCuts.map((c,i)=>(
                            <button key={i} className="cut-chip"
                              onClick={()=>{ setCuts(prev=>{const n=prev.filter((_,j)=>j!==i);cutsRef.current=n;saveProjectState({cuts:n});return n;}); }}
                              style={{background:"#1a0a0a",border:"1px solid #3a1a1a",borderRadius:6,color:"#ff6b6b",fontSize:11,fontFamily:"DM Mono, monospace",padding:"3px 10px",cursor:"pointer"}}>
                              ✕ {fmt(c.s)}–{fmt(c.e)}
                            </button>
                          ))}
                          <button onClick={()=>{setCuts([]);cutsRef.current=[];saveProjectState({cuts:[]});}}
                            style={{background:"transparent",border:"1px solid #1e1e1e",borderRadius:6,color:"#333",fontSize:11,fontFamily:"DM Mono, monospace",padding:"3px 10px",cursor:"pointer"}}>
                            clear all
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div style={{marginTop:20}}>
                <button className="btn-p" onClick={()=>setStep(3)}
                  style={{...T.btnP,background:(fcConfirmed||!hasFacecam)?"#e8e8e8":"#191919",color:(fcConfirmed||!hasFacecam)?"#000":"#555",border:(fcConfirmed||!hasFacecam)?"none":"1px solid #2a2a2a"}}>
                  {hasFacecam?(fcConfirmed?"Next →":"Skip Facecam →"):"Next →"}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3 — Caption */}
          {step===3&&(
            <div style={{maxWidth:480}}>
              <div style={T.label}>Step 3</div>
              <h2 style={{fontSize:20,fontWeight:700,marginBottom:20}}>Caption & Subtitles</h2>

              <div style={{...T.card,marginBottom:12}}>
                <div style={{...T.label,marginBottom:10}}>Bold caption — one line per row</div>
                <div style={{display:"flex",gap:8,marginBottom:16}}>
                  <textarea value={caption}
                    onChange={e=>{setCaption(e.target.value);saveProjectState({caption:e.target.value});}}
                    placeholder={"what he did\nis crazy"}
                    rows={3}
                    style={{...T.input, resize:"vertical", lineHeight:1.5, fontFamily:"DM Mono, monospace", fontSize:12}}/>
                  <button className="btn-p" onClick={genCaption} disabled={genning}
                    style={{...T.btnP,flexShrink:0,alignSelf:"flex-start",background:genning?"#141414":"#e8e8e8",color:genning?"#444":"#000",border:genning?"1px solid #222":"none"}}>
                    {genning?"...":"✨ AI"}
                  </button>
                </div>

                {/* Font size */}
                <div style={{marginBottom:16}}>
                  <div style={{...T.row,marginBottom:6}}>
                    <span style={{fontSize:11,color:"#444",fontFamily:"DM Mono, monospace",textTransform:"uppercase",letterSpacing:"0.06em"}}>Font Size</span>
                    <span style={{marginLeft:"auto",fontSize:12,color:"#a8ff78",fontFamily:"DM Mono, monospace"}}>{captionSize.toFixed(1)}%</span>
                  </div>
                  <input type="range" min={3} max={12} step={0.1} value={captionSize}
                    onChange={e=>{const v=parseFloat(e.target.value);setCaptionSize(v);saveProjectState({captionSize:v});}}/>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#2a2a2a",fontFamily:"DM Mono, monospace",marginTop:4}}>
                    <span>Small</span><span>Large</span>
                  </div>
                </div>

                {/* Y Position */}
                <div style={{marginBottom:16}}>
                  <div style={{...T.row,marginBottom:6}}>
                    <span style={{fontSize:11,color:"#444",fontFamily:"DM Mono, monospace",textTransform:"uppercase",letterSpacing:"0.06em"}}>Vertical Position</span>
                    <span style={{marginLeft:"auto",fontSize:12,color:"#a8ff78",fontFamily:"DM Mono, monospace"}}>
                      {captionY < 33 ? "Top" : captionY < 66 ? "Middle" : "Bottom"}
                    </span>
                  </div>
                  <input type="range" min={5} max={95} step={1} value={captionY}
                    onChange={e=>{const v=parseInt(e.target.value);setCaptionY(v);saveProjectState({captionY:v});}}/>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#2a2a2a",fontFamily:"DM Mono, monospace",marginTop:4}}>
                    <span>Top</span><span>Middle</span><span>Bottom</span>
                  </div>
                </div>

                {/* Caption duration */}
                {vidDur>0&&(
                  <div>
                    <div style={{...T.row,marginBottom:6}}>
                      <span style={{fontSize:11,color:"#444",fontFamily:"DM Mono, monospace",textTransform:"uppercase",letterSpacing:"0.06em"}}>Show caption for</span>
                      <span style={{marginLeft:"auto",fontSize:12,color:"#a8ff78",fontFamily:"DM Mono, monospace"}}>
                        {captionDuration>=vidDur ? "Whole clip" : fmt(captionDuration)}
                      </span>
                    </div>
                    <input type="range" min={0.5} max={vidDur} step={0.1} value={captionDuration}
                      onChange={e=>{const v=parseFloat(e.target.value);setCaptionDuration(v);saveProjectState({captionDuration:v});}}/>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#2a2a2a",fontFamily:"DM Mono, monospace",marginTop:4}}>
                      <span>0:00</span><span>Whole clip ({fmt(vidDur)})</span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{...T.card,marginBottom:24}}>
                <div style={{...T.label,marginBottom:12}}>Auto-captions</div>

                {/* Option 1 — Free / Browser */}
                <div style={{marginBottom:16,paddingBottom:16,borderBottom:"1px solid #1a1a1a"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <span style={{fontSize:11,fontWeight:600,color:"#ccc"}}>🆓 Free (Browser)</span>
                    <span style={{fontSize:10,color:"#2a5a2a",fontFamily:"DM Mono, monospace",background:"#0a1a0a",padding:"2px 7px",borderRadius:10}}>no signup</span>
                  </div>
                  <p style={{fontSize:11,color:"#333",marginBottom:10,lineHeight:1.6}}>
                    Plays your clip and listens in real time. Keep volume up. Chrome only.
                  </p>
                  <button onClick={doFreeTranscribe} disabled={freeTranscribing}
                    style={{...T.btnG,background:freeTranscribing?"#0b1a0b":"transparent",color:freeTranscribing?"#4a8a4a":"#555",border:"1px solid #1e1e1e",marginBottom: freeTranscribeStatus?8:0}}>
                    {freeTranscribing?"🎙 Listening...":"🎙 Free Transcribe"}
                  </button>
                  {freeTranscribeStatus&&<div style={{fontSize:11,color:"#4a8a4a",fontFamily:"DM Mono, monospace",marginTop:6}}>{freeTranscribeStatus}</div>}
                </div>

                {/* Option 2 — AssemblyAI */}
                <div style={{marginBottom:16,paddingBottom:16,borderBottom:"1px solid #1a1a1a"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <span style={{fontSize:11,fontWeight:600,color:"#ccc"}}>⚡ AssemblyAI</span>
                    <span style={{fontSize:10,color:"#2a3a5a",fontFamily:"DM Mono, monospace",background:"#0a0d1a",padding:"2px 7px",borderRadius:10}}>free tier · no card</span>
                  </div>
                  <p style={{fontSize:11,color:"#333",marginBottom:10,lineHeight:1.6}}>
                    Much better accuracy. Free account at <span style={{color:"#5a8aaa"}}>assemblyai.com</span> → API Keys.
                  </p>
                  <input value={aaiKey} onChange={e=>{setAaiKey(e.target.value);localStorage.setItem("aai_key",e.target.value);}}
                    placeholder="your_assemblyai_key" type="password" style={{...T.input,marginBottom:8,fontSize:12}}/>
                  <button onClick={doAssemblyTranscribe} disabled={aaiTranscribing||!aaiKey}
                    style={{...T.btnG,background:aaiKey&&!aaiTranscribing?"#0b1a0b":"transparent",color:aaiKey&&!aaiTranscribing?"#4a8a4a":"#2a2a2a",border:`1px solid ${aaiKey?"#1a3a1a":"#1a1a1a"}`}}>
                    {aaiTranscribing?"Processing (up to 30s)...":segs.length?`✓ ${segs.length} segments`:"Transcribe with AssemblyAI"}
                  </button>
                </div>

                {/* Option 3 — OpenAI Whisper */}
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <span style={{fontSize:11,fontWeight:600,color:"#ccc"}}>🎯 OpenAI Whisper</span>
                    <span style={{fontSize:10,color:"#3a2a1a",fontFamily:"DM Mono, monospace",background:"#1a0f0a",padding:"2px 7px",borderRadius:10}}>~$0.006/min · best accuracy</span>
                  </div>
                  <input value={oaiKey} onChange={e=>setOaiKey(e.target.value)} placeholder="sk-..." type="password" style={{...T.input,marginBottom:8,fontSize:12}}/>
                  <button onClick={doTranscribe} disabled={transcribing||!oaiKey}
                    style={{...T.btnG,background:oaiKey&&!transcribing?"#0b1a0b":"transparent",color:oaiKey&&!transcribing?"#4a8a4a":"#2a2a2a",border:`1px solid ${oaiKey?"#1a3a1a":"#1a1a1a"}`}}>
                    {transcribing?"Transcribing...":"Transcribe with Whisper"}
                  </button>
                </div>
              </div>

              <button className="btn-p" onClick={()=>setStep(4)} style={{...T.btnP,padding:"10px 26px"}}>Preview & Export →</button>
            </div>
          )}

          {/* STEP 4 */}
          {step===4&&(
            <div style={{maxWidth:460}}>
              <div style={T.label}>Step 4</div>
              <h2 style={{fontSize:20,fontWeight:700,marginBottom:8}}>Export</h2>
              <p style={{color:"#333",fontSize:13,marginBottom:4}}>Records the preview, skipping all cut regions.</p>
              <div style={{fontSize:11,color:"#2a2a2a",fontFamily:"DM Mono, monospace",marginBottom:24}}>
                Trim: {fmt(trimIn)} → {fmt(trimOut)} · {mergedCuts.length} cut{mergedCuts.length!==1?"s":""}
              </div>
              {!exporting&&!exportUrl&&(
                <button className="btn-p" onClick={doExport} style={{...T.btnP,padding:"12px 30px",fontSize:14}}>▶ Start Export</button>
              )}
              {exporting&&(
                <div style={{...T.card,textAlign:"center",padding:36}}>
                  <div style={{fontSize:26,marginBottom:10}}>⏳</div>
                  <div style={{fontWeight:600,marginBottom:6}}>Recording...</div>
                  <div style={{color:"#333",fontSize:12,fontFamily:"DM Mono, monospace"}}>Skipping {mergedCuts.length} cut region{mergedCuts.length!==1?"s":""}</div>
                </div>
              )}
              {exportUrl&&(
                <div style={{...T.card,border:"1px solid #1a3a1a",background:"#090f09"}}>
                  <div style={{color:"#4a8a4a",fontWeight:700,marginBottom:16,fontFamily:"DM Mono, monospace"}}>✓ Export complete</div>
                  <a href={exportUrl} download="tiktok-clip.webm"
                    style={{...T.btnP,background:"#1a3a1a",color:"#a8e8a8",display:"inline-block",textDecoration:"none",marginRight:10,padding:"10px 22px"}}>
                    ⬇ Download .webm
                  </a>
                  <button onClick={doExport} className="btn-g" style={T.btnG}>Re-export</button>
                </div>
              )}
              <button className="btn-g" onClick={()=>setStep(3)} style={{...T.btnG,marginTop:18}}>← Back</button>
            </div>
          )}
        </div>

        {/* Right — Preview */}
        <div style={{width:310,flexShrink:0,background:"#060606",padding:"18px 16px",display:"flex",flexDirection:"column",alignItems:"center",overflowY:"auto"}}>
          <div style={{display:"flex",alignItems:"center",width:"100%",marginBottom:14}}>
            <div style={T.label}>PREVIEW</div>
            {videoSrc&&(
              <button onClick={()=>setFullscreen(true)} title="Fullscreen"
                style={{marginLeft:"auto",background:"transparent",border:"1px solid #1e1e1e",borderRadius:7,color:"#444",cursor:"pointer",fontSize:14,padding:"3px 9px"}}>
                ⛶
              </button>
            )}
          </div>
          <div style={{position:"relative",width:PW,height:videoSrc?PH:200}}>
            <video ref={vidRef} loop playsInline onLoadedMetadata={onVidMeta}
              style={{position:"absolute",top:0,left:0,width:PW,height:PH,objectFit:"cover",borderRadius:16,zIndex:0}}/>
            <canvas ref={prevCanRef} width={CW} height={CH}
              style={{position:"absolute",top:0,left:0,width:PW,height:PH,borderRadius:16,border:"1px solid #141414",boxShadow:"0 0 30px rgba(0,0,0,.8)",zIndex:1,display:videoSrc?"block":"none"}}/>
            {!videoSrc&&(
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:"#1e1e1e",fontSize:12,fontFamily:"DM Mono, monospace",textAlign:"center",lineHeight:1.8}}>
                Upload a video<br/>to see preview
              </div>
            )}
          </div>
          {videoSrc&&(
            <div style={{width:"100%",marginTop:14,display:"flex",flexDirection:"column",gap:10}}>
              <div style={T.row}>
                <button className="btn-g" onClick={togglePlay} style={{...T.btnG,padding:"7px 16px",fontSize:13,flexShrink:0}}>
                  {isPlaying?"⏸":"▶"}
                </button>
                <span style={{fontSize:11,color:"#333",fontFamily:"DM Mono, monospace",flexShrink:0}}>
                  {fmt(currentTime)} / {fmt(vidDur)}
                </span>
              </div>
              <div style={T.row}>
                <span style={{fontSize:13,flexShrink:0}}>{volume===0?"🔇":volume<0.5?"🔉":"🔊"}</span>
                <input type="range" min={0} max={1} step={0.01} value={volume}
                  onChange={e=>setVolume(parseFloat(e.target.value))} style={{flex:1}}/>
                <span style={{fontSize:11,color:"#333",fontFamily:"DM Mono, monospace",width:30,textAlign:"right"}}>{Math.round(volume*100)}%</span>
              </div>
            </div>
          )}
          <div style={{marginTop:14,color:"#1a1a1a",fontSize:10,fontFamily:"DM Mono, monospace"}}>9:16 · TikTok Format</div>
        </div>
      </div>

      {/* Fullscreen overlay */}
      {fullscreen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.96)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setFullscreen(false)}>
          <div style={{position:"relative"}} onClick={e=>e.stopPropagation()}>
            {/* Big canvas mirror — just scale the preview canvas up visually */}
            <canvas
              ref={el=>{
                if(!el||!prevCanRef.current)return;
                // Copy current frame from preview canvas
                el.width=CW; el.height=CH;
                const animate=()=>{
                  if(!fullscreen)return;
                  el.getContext("2d").drawImage(prevCanRef.current,0,0);
                  requestAnimationFrame(animate);
                };
                animate();
              }}
              width={PW} height={PH}
              style={{
                width: Math.min(window.innerWidth*0.88, window.innerHeight*0.88*(PW/PH)),
                height: "auto",
                borderRadius:20,
                boxShadow:"0 0 80px rgba(0,0,0,1)",
                display:"block",
                maxHeight:"90vh"
              }}
            />
            <button onClick={()=>setFullscreen(false)}
              style={{position:"absolute",top:12,right:12,background:"rgba(0,0,0,.7)",border:"1px solid #333",borderRadius:8,color:"#aaa",cursor:"pointer",fontSize:16,padding:"4px 10px"}}>
              ✕
            </button>
            {/* Play controls in fullscreen */}
            <div style={{position:"absolute",bottom:16,left:"50%",transform:"translateX(-50%)",display:"flex",alignItems:"center",gap:12,background:"rgba(0,0,0,.7)",padding:"8px 16px",borderRadius:20}}>
              <button onClick={togglePlay} style={{background:"transparent",border:"none",color:"#fff",fontSize:20,cursor:"pointer"}}>{isPlaying?"⏸":"▶"}</button>
              <span style={{color:"#666",fontSize:12,fontFamily:"DM Mono, monospace"}}>{fmt(currentTime)} / {fmt(vidDur)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
