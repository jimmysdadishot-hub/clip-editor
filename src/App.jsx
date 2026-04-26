import { useState, useRef, useEffect, useCallback } from "react";

const PW = 1080, PH = 1920, FC_FRAC = 0.44;
const DW = 270, DH = 480;

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080808; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #0d0d0d; }
  ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 4px; }
  .proj-card { transition: border-color .15s, transform .15s; }
  .proj-card:hover { border-color: #383838 !important; transform: translateY(-1px); }
  .new-proj:hover { border-color: #3a3a3a !important; }
  .drop-zone { transition: border-color .2s, background .2s; }
  .drop-zone:hover { border-color: #555 !important; background: #111 !important; }
  input:focus { outline: none; border-color: #3a3a3a !important; }
  input::placeholder { color: #333; }
  .btn-primary:hover { opacity: .88; }
  .btn-primary:active { transform: scale(.97); }
  .btn-ghost:hover { border-color: #3a3a3a !important; color: #888 !important; }
`;

export default function App() {
  const [page, setPage]             = useState("dash");
  const [projects, setProjects]     = useState([]);
  const [projName, setProjName]     = useState("");
  const [modal, setModal]           = useState(false);
  const [activeProj, setActiveProj] = useState(null);
  const [step, setStep]             = useState(1);
  const [videoSrc, setVideoSrc]     = useState(null);
  const [fcRect, setFcRect]         = useState(null);
  const [fcConfirmed, setFcConfirmed] = useState(false);
  const [caption, setCaption]       = useState("");
  const [genning, setGenning]       = useState(false);
  const [segs, setSegs]             = useState([]);
  const [oaiKey, setOaiKey]         = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [exporting, setExporting]   = useState(false);
  const [exportUrl, setExportUrl]   = useState(null);
  const [isPlaying, setIsPlaying]   = useState(false);

  // The ONE video element lives in the right panel BEHIND the canvas.
  // It's always on-screen so the browser never suspends it.
  const vidRef     = useRef(null);
  const selVidRef  = useRef(null);   // step-2 visible video for drag
  const selCanRef  = useRef(null);   // overlay canvas on step-2 video
  const prevCanRef = useRef(null);   // preview canvas (on top of vidRef)
  const fileRef    = useRef(null);
  const rafRef     = useRef(null);
  const chunks     = useRef([]);
  const acRef      = useRef(null);
  const adstRef    = useRef(null);

  // All drag state as refs — no stale closures
  const draggingRef = useRef(false);
  const anchorRef   = useRef(null);
  const boxRef      = useRef(null);

  // Latest values for RAF without re-renders
  const fcRectRef  = useRef(null);
  const captionRef = useRef("");
  const curSubRef  = useRef("");
  useEffect(() => { fcRectRef.current = fcRect; },   [fcRect]);
  useEffect(() => { captionRef.current = caption; }, [caption]);

  // ── Project ───────────────────────────────────────────────────────────────────
  const createProject = () => {
    if (!projName.trim()) return;
    const p = { id: Date.now(), name: projName.trim(), date: new Date().toLocaleDateString() };
    setProjects(prev => [p, ...prev]);
    setActiveProj(p);
    setModal(false); setProjName("");
    resetEditor();
    setPage("editor");
  };

  const resetEditor = () => {
    setStep(1); setVideoSrc(null); setFcRect(null); setFcConfirmed(false);
    setCaption(""); setSegs([]); setExportUrl(null); setIsPlaying(false);
    curSubRef.current = ""; fcRectRef.current = null; captionRef.current = "";
    acRef.current = null; adstRef.current = null;
  };

  // ── Upload ────────────────────────────────────────────────────────────────────
  const handleFile = f => {
    if (!f?.type.startsWith("video/")) return;
    const url = URL.createObjectURL(f);
    // Set src on the video element directly — don't wait for React re-render
    const v = vidRef.current;
    if (v) {
      v.src = url;
      v.load();
      v.play().then(() => setIsPlaying(true)).catch(() => {});
    }
    setVideoSrc(url);
    setFcRect(null); setFcConfirmed(false);
    setCaption(""); setSegs([]); setExportUrl(null);
    setStep(2);
  };

  // Subtitle sync
  useEffect(() => {
    const v = vidRef.current; if (!v) return;
    const fn = () => {
      const t = v.currentTime;
      const cur = segs.find(x => t >= x.s && t <= x.e);
      curSubRef.current = cur?.t || "";
    };
    v.addEventListener("timeupdate", fn);
    return () => v.removeEventListener("timeupdate", fn);
  }, [segs]);

  // ── RAF preview loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = prevCanRef.current;
      const v = vidRef.current;
      if (!canvas || !v) return;
      // Only draw if video has frame data
      if (v.readyState < 2) return;

      const ctx = canvas.getContext("2d");
      const W = PW, H = PH;
      const fcH = Math.round(H * FC_FRAC);
      const mainH = H - fcH;
      const vw = v.videoWidth || 1;
      const vh = v.videoHeight || 1;

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);

      // ── Bottom: gameplay — cover fill ─────────────────────────────────────────
      const gsc = Math.max(W / vw, mainH / vh);
      const gw = vw * gsc, gh = vh * gsc;
      const gx = (W - gw) / 2, gy = fcH + (mainH - gh) / 2;
      ctx.drawImage(v, gx, gy, gw, gh);

      // ── Top: facecam — cover fill selected region ─────────────────────────────
      const fc = fcRectRef.current;
      if (fc && fc.w > 4 && fc.h > 4) {
        const fsc = Math.max(W / fc.w, fcH / fc.h);
        const fw = fc.w * fsc, fh = fc.h * fsc;
        const fx = (W - fw) / 2, fy = (fcH - fh) / 2;
        ctx.drawImage(v, fc.x, fc.y, fc.w, fc.h, fx, fy, fw, fh);
      } else {
        ctx.fillStyle = "#0e0e0e";
        ctx.fillRect(0, 0, W, fcH);
        ctx.fillStyle = "#252525";
        ctx.font = "11px DM Mono, monospace";
        ctx.textAlign = "center";
        ctx.fillText("Select facecam in Step 2", W / 2, fcH / 2);
        ctx.textAlign = "left";
      }

      // ── Divider ───────────────────────────────────────────────────────────────
      ctx.fillStyle = "#000";
      ctx.fillRect(0, fcH - 1, W, 2);

      // ── Bold caption ──────────────────────────────────────────────────────────
      const cap = captionRef.current;
      if (cap) {
        const fs = Math.round(W * 0.065);
        ctx.save();
        ctx.font = `900 ${fs}px Arial Black, Arial`;
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = fs * 0.26;
        ctx.strokeText(`"${cap}"`, W / 2, fcH - 8);
        ctx.fillStyle = "#fff";
        ctx.fillText(`"${cap}"`, W / 2, fcH - 8);
        ctx.restore();
      }

      // ── Subtitle ──────────────────────────────────────────────────────────────
      const sub = curSubRef.current;
      if (sub) {
        const fs = Math.round(W * 0.045);
        ctx.save();
        ctx.font = `bold ${fs}px Arial`;
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = fs * 0.14;
        ctx.strokeText(sub, W / 2, H - 18);
        ctx.fillStyle = "#ffee58";
        ctx.fillText(sub, W / 2, H - 18);
        ctx.restore();
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Facecam drag ──────────────────────────────────────────────────────────────
  const syncCanvas = () => {
    const sv = selVidRef.current, c = selCanRef.current;
    if (!sv || !c) return;
    const r = sv.getBoundingClientRect();
    if (r.width > 10) { c.width = Math.round(r.width); c.height = Math.round(r.height); }
  };

  const redrawOverlay = b => {
    const c = selCanRef.current; if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!b || b.w < 2 || b.h < 2) return;
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.clearRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = "#a8ff78";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#a8ff78";
    ctx.font = "bold 11px monospace";
    ctx.fillText("FACECAM", b.x + 5, b.y + 15);
  };

  const xy = (e, el) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onMouseDown = useCallback(e => {
    e.preventDefault();
    syncCanvas();
    const c = selCanRef.current; if (!c) return;
    const [x, y] = xy(e, c);
    draggingRef.current = true;
    anchorRef.current = [x, y];
    boxRef.current = null;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }, []);

  const onMouseMove = useCallback(e => {
    if (!draggingRef.current || !anchorRef.current) return;
    const c = selCanRef.current; if (!c) return;
    const [x2, y2] = xy(e, c);
    const [ax, ay] = anchorRef.current;
    const b = { x: Math.min(ax, x2), y: Math.min(ay, y2), w: Math.abs(x2 - ax), h: Math.abs(y2 - ay) };
    boxRef.current = b;
    redrawOverlay(b);
  }, []);

  const onMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const b = boxRef.current;
    if (!b || b.w < 6 || b.h < 6) return;
    const sv = selVidRef.current, c = selCanRef.current;
    if (!sv || !c) return;
    const rect = {
      x: b.x * (sv.videoWidth / c.width),
      y: b.y * (sv.videoHeight / c.height),
      w: b.w * (sv.videoWidth / c.width),
      h: b.h * (sv.videoHeight / c.height),
    };
    setFcRect(rect);
    setFcConfirmed(true);
  }, []);

  // ── Toggle play/pause ─────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = vidRef.current; if (!v) return;
    if (v.paused) { v.play(); setIsPlaying(true); }
    else { v.pause(); setIsPlaying(false); }
  };

  // ── AI caption ────────────────────────────────────────────────────────────────
  const genCaption = async () => {
    setGenning(true);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 200,
          system: "Generate a short (2–6 word) viral TikTok caption for a gaming/streaming clip. No hashtags. Output ONLY the caption words, nothing else.",
          messages: [{ role: "user", content: `Project name: "${activeProj?.name}". Give me a punchy caption.` }]
        })
      });
      const d = await r.json();
      setCaption(d.content?.[0]?.text?.trim().replace(/["']/g, "") || "");
    } catch (err) { console.error(err); }
    setGenning(false);
  };

  // ── Whisper ───────────────────────────────────────────────────────────────────
  const doTranscribe = async () => {
    if (!oaiKey || !videoSrc) return;
    setTranscribing(true);
    try {
      const blob = await fetch(videoSrc).then(r => r.blob());
      const fd = new FormData();
      fd.append("file", blob, "clip.mp4");
      fd.append("model", "whisper-1");
      fd.append("response_format", "verbose_json");
      fd.append("timestamp_granularities[]", "segment");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions",
        { method: "POST", headers: { Authorization: `Bearer ${oaiKey}` }, body: fd });
      const d = await r.json();
      setSegs((d.segments || []).map(s => ({ s: s.start, e: s.end, t: s.text.trim() })));
    } catch (err) {
      console.error(err);
      alert("Transcription failed — check your OpenAI key.");
    }
    setTranscribing(false);
  };

  // ── Export ────────────────────────────────────────────────────────────────────
  const doExport = async () => {
    const canvas = prevCanRef.current, video = vidRef.current;
    if (!canvas || !video) return;
    setExporting(true); setExportUrl(null); chunks.current = [];
    try {
      video.loop = false; video.pause(); video.currentTime = 0;
      await new Promise(r => { video.onseeked = r; setTimeout(r, 800); });
      const vs = canvas.captureStream(30);
      if (!acRef.current) {
        const ac = new AudioContext();
        const src = ac.createMediaElementSource(video);
        const dst = ac.createMediaStreamDestination();
        src.connect(dst); src.connect(ac.destination);
        acRef.current = ac; adstRef.current = dst;
      }
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus" : "video/webm";
      const stream = new MediaStream([...vs.getVideoTracks(), ...adstRef.current.stream.getAudioTracks()]);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = () => {
        setExportUrl(URL.createObjectURL(new Blob(chunks.current, { type: mime })));
        setExporting(false);
        video.loop = true; video.muted = true; video.play(); setIsPlaying(true);
      };
      rec.start(100);
      video.muted = false; video.play(); setIsPlaying(true);
      video.onended = () => { rec.stop(); video.onended = null; };
    } catch (err) {
      console.error(err); setExporting(false);
      alert("Export failed: " + err.message);
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────────
  const T = {
    card: { background: "#111", borderRadius: 14, padding: 20, border: "1px solid #1e1e1e" },
    input: { background: "#0d0d0d", border: "1px solid #222", borderRadius: 8, padding: "10px 14px", color: "#e0e0e0", fontSize: 13, width: "100%", fontFamily: "DM Sans, sans-serif" },
    btnPrimary: { padding: "9px 20px", borderRadius: 8, border: "none", background: "#e8e8e8", color: "#000", fontWeight: 600, cursor: "pointer", fontSize: 13, fontFamily: "DM Sans, sans-serif", transition: "opacity .15s" },
    btnGhost: { padding: "9px 18px", borderRadius: 8, background: "transparent", color: "#555", border: "1px solid #222", fontWeight: 500, cursor: "pointer", fontSize: 13, fontFamily: "DM Sans, sans-serif", transition: "border-color .15s, color .15s" },
    label: { fontSize: 11, color: "#444", marginBottom: 6, display: "block", fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase" },
  };

  // ══ DASHBOARD ════════════════════════════════════════════════════════════════
  if (page === "dash") return (
    <div style={{ background: "#080808", minHeight: "100vh", color: "#e0e0e0", fontFamily: "DM Sans, sans-serif" }}>
      <style>{css}</style>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "52px 28px" }}>
        <div style={{ marginBottom: 44 }}>
          <div style={{ fontSize: 11, color: "#333", letterSpacing: "0.14em", fontFamily: "DM Mono, monospace", marginBottom: 10 }}>CLIP EDITOR</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "#e8e8e8", marginBottom: 6 }}>Projects</h1>
          <p style={{ color: "#333", fontSize: 13 }}>Each project is one TikTok clip</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 12 }}>
          {projects.map(p => (
            <div key={p.id} className="proj-card" onClick={() => { setActiveProj(p); setPage("editor"); }}
              style={{ ...T.card, cursor: "pointer", minHeight: 120, display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 22 }}>🎬</div>
              <div style={{ marginTop: "auto", paddingTop: 18 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#d0d0d0", marginBottom: 3 }}>{p.name}</div>
                <div style={{ color: "#333", fontSize: 11, fontFamily: "DM Mono, monospace" }}>{p.date}</div>
              </div>
            </div>
          ))}
          <div className="new-proj" onClick={() => setModal(true)}
            style={{ ...T.card, cursor: "pointer", minHeight: 120, border: "2px dashed #1e1e1e", background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <span style={{ fontSize: 22, color: "#2e2e2e" }}>+</span>
            <span style={{ color: "#383838", fontSize: 13, fontWeight: 500 }}>New Project</span>
          </div>
        </div>
      </div>
      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div style={{ background: "#111", borderRadius: 18, padding: 32, width: 360, border: "1px solid #1e1e1e" }}>
            <div style={{ fontSize: 11, color: "#444", letterSpacing: "0.12em", fontFamily: "DM Mono, monospace", marginBottom: 14 }}>NEW PROJECT</div>
            <input value={projName} onChange={e => setProjName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createProject()}
              placeholder="e.g. Kai Cenat Rage Moment"
              style={{ ...T.input, marginBottom: 18 }} autoFocus />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setModal(false)} className="btn-ghost" style={T.btnGhost}>Cancel</button>
              <button onClick={createProject} className="btn-primary" style={T.btnPrimary}>Create →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ══ EDITOR ════════════════════════════════════════════════════════════════════
  return (
    <div style={{ background: "#080808", minHeight: "100vh", color: "#e0e0e0", fontFamily: "DM Sans, sans-serif", display: "flex", flexDirection: "column" }}>
      <style>{css}</style>

      {/* Nav */}
      <div style={{ background: "#0d0d0d", borderBottom: "1px solid #141414", padding: "11px 20px", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
        <button onClick={() => setPage("dash")} style={{ background: "transparent", border: "none", color: "#444", cursor: "pointer", fontSize: 18, padding: "0 4px", lineHeight: 1 }}>←</button>
        <span style={{ fontWeight: 600, fontSize: 13, color: "#aaa" }}>{activeProj?.name}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          {["Upload", "Facecam", "Caption", "Export"].map((s, i) => (
            <div key={i} onClick={() => videoSrc && setStep(i + 1)}
              style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                cursor: videoSrc ? "pointer" : "default", fontFamily: "DM Mono, monospace",
                background: step === i+1 ? "#e8e8e8" : step > i+1 ? "#0e1a0e" : "#111",
                color: step === i+1 ? "#000" : step > i+1 ? "#4a8a4a" : "#2a2a2a",
                border: `1px solid ${step > i+1 ? "#1a3a1a" : "transparent"}` }}>
              {step > i+1 ? "✓ " : ""}{s}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* ── Left panel ── */}
        <div style={{ flex: 1, padding: 28, overflowY: "auto", borderRight: "1px solid #111" }}>

          {/* STEP 1 */}
          {step === 1 && (
            <div>
              <div style={T.label}>Step 1</div>
              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Upload Clip</h2>
              <p style={{ color: "#383838", fontSize: 13, marginBottom: 28 }}>Drop your Twitch or stream clip to get started</p>
              <div className="drop-zone"
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
                onClick={() => fileRef.current?.click()}
                style={{ border: "2px dashed #1e1e1e", borderRadius: 16, padding: "72px 40px", textAlign: "center", cursor: "pointer", maxWidth: 480, background: "#0a0a0a" }}>
                <div style={{ fontSize: 40, marginBottom: 14 }}>📹</div>
                <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>Drop video here or click</div>
                <div style={{ color: "#2e2e2e", fontSize: 12, fontFamily: "DM Mono, monospace" }}>MP4 · MOV · WebM</div>
                <input ref={fileRef} type="file" accept="video/*" style={{ display: "none" }} onChange={e => handleFile(e.target.files?.[0])} />
              </div>
            </div>
          )}

          {/* STEP 2 — Facecam */}
          {step === 2 && videoSrc && (
            <div>
              <div style={T.label}>Step 2</div>
              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Select Facecam</h2>
              <p style={{ color: "#383838", fontSize: 13, marginBottom: 4 }}>Pause the video then drag a box over the facecam. It gets cropped to the top of your TikTok.</p>
              <p style={{ color: "#2a5a2a", fontSize: 12, fontFamily: "DM Mono, monospace", marginBottom: 18 }}>Tip: pause the video first to make selection easier</p>
              <div style={{ position: "relative", maxWidth: 560, width: "100%", userSelect: "none" }}>
                <video ref={selVidRef} src={videoSrc} controls
                  style={{ width: "100%", display: "block", borderRadius: 10 }}
                  onLoadedMetadata={syncCanvas} />
                <canvas ref={selCanRef}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", cursor: "crosshair", borderRadius: 10 }}
                  onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp} />
              </div>
              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center" }}>
                {fcConfirmed && (
                  <span style={{ color: "#4a8a4a", fontSize: 12, fontWeight: 600, fontFamily: "DM Mono, monospace" }}>
                    ✓ locked in — check preview →
                  </span>
                )}
                <button className="btn-primary" onClick={() => setStep(3)}
                  style={{ ...T.btnPrimary, background: fcConfirmed ? "#e8e8e8" : "#191919", color: fcConfirmed ? "#000" : "#555", border: fcConfirmed ? "none" : "1px solid #2a2a2a" }}>
                  {fcConfirmed ? "Next →" : "Skip →"}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3 — Caption */}
          {step === 3 && (
            <div style={{ maxWidth: 460 }}>
              <div style={T.label}>Step 3</div>
              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>Caption & Subtitles</h2>
              <div style={{ ...T.card, marginBottom: 12 }}>
                <div style={{ ...T.label, marginBottom: 12 }}>Bold caption (between facecam & gameplay)</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={caption} onChange={e => setCaption(e.target.value)} placeholder="e.g. He Actually Did It" style={T.input} />
                  <button className="btn-primary" onClick={genCaption} disabled={genning}
                    style={{ ...T.btnPrimary, flexShrink: 0, background: genning ? "#141414" : "#e8e8e8", color: genning ? "#444" : "#000", border: genning ? "1px solid #222" : "none" }}>
                    {genning ? "..." : "✨ AI"}
                  </button>
                </div>
              </div>
              <div style={{ ...T.card, marginBottom: 24 }}>
                <div style={{ ...T.label, marginBottom: 4 }}>Auto-captions from audio</div>
                <div style={{ color: "#333", fontSize: 12, marginBottom: 14, fontFamily: "DM Mono, monospace" }}>Uses OpenAI Whisper — needs your API key</div>
                <input value={oaiKey} onChange={e => setOaiKey(e.target.value)} placeholder="sk-..." type="password" style={{ ...T.input, marginBottom: 10 }} />
                <button onClick={doTranscribe} disabled={transcribing || !oaiKey}
                  style={{ ...T.btnGhost, background: oaiKey && !transcribing ? "#0b1a0b" : "#0d0d0d", color: oaiKey && !transcribing ? "#4a8a4a" : "#2a2a2a", border: `1px solid ${oaiKey ? "#1a3a1a" : "#1a1a1a"}` }}>
                  {transcribing ? "Transcribing..." : segs.length ? `✓ ${segs.length} segments` : "Transcribe Audio"}
                </button>
              </div>
              <button className="btn-primary" onClick={() => setStep(4)} style={{ ...T.btnPrimary, padding: "10px 26px" }}>
                Preview & Export →
              </button>
            </div>
          )}

          {/* STEP 4 — Export */}
          {step === 4 && (
            <div style={{ maxWidth: 460 }}>
              <div style={T.label}>Step 4</div>
              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Export</h2>
              <p style={{ color: "#383838", fontSize: 13, marginBottom: 28 }}>
                Records the preview canvas. Keep this tab in focus and let the clip play all the way through.
              </p>
              {!exporting && !exportUrl && (
                <button className="btn-primary" onClick={doExport} style={{ ...T.btnPrimary, padding: "12px 30px", fontSize: 14 }}>
                  ▶ Start Export
                </button>
              )}
              {exporting && (
                <div style={{ ...T.card, textAlign: "center", padding: 36 }}>
                  <div style={{ fontSize: 26, marginBottom: 10 }}>⏳</div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Recording...</div>
                  <div style={{ color: "#333", fontSize: 12, fontFamily: "DM Mono, monospace" }}>Let it play all the way through</div>
                </div>
              )}
              {exportUrl && (
                <div style={{ ...T.card, border: "1px solid #1a3a1a", background: "#0a160a" }}>
                  <div style={{ color: "#4a8a4a", fontWeight: 700, marginBottom: 18, fontFamily: "DM Mono, monospace" }}>✓ Export complete</div>
                  <a href={exportUrl} download="tiktok-clip.webm"
                    style={{ ...T.btnPrimary, background: "#2a5a2a", color: "#a8e8a8", display: "inline-block", textDecoration: "none", marginRight: 10, padding: "10px 22px" }}>
                    ⬇ Download .webm
                  </a>
                  <button onClick={doExport} className="btn-ghost" style={T.btnGhost}>Re-export</button>
                </div>
              )}
              <button className="btn-ghost" onClick={() => setStep(3)} style={{ ...T.btnGhost, marginTop: 18 }}>← Back</button>
            </div>
          )}
        </div>

        {/* ── Right panel — Preview ── */}
        <div style={{ width: 320, flexShrink: 0, background: "#060606", padding: "22px 20px", display: "flex", flexDirection: "column", alignItems: "center", overflowY: "auto" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#1e1e1e", letterSpacing: "0.16em", fontFamily: "DM Mono, monospace", marginBottom: 18 }}>PREVIEW</div>

          {/*
            Stack: video BEHIND canvas using position:relative container.
            The video is always visible to the browser so it never gets suspended.
            The canvas sits on top and draws the formatted output.
          */}
          <div style={{ position: "relative", width: DW, height: videoSrc ? DH : 0 }}>
            {/* Video — same size as canvas, visible to browser, hidden behind canvas */}
            <video ref={vidRef} muted loop playsInline
              style={{ position: "absolute", top: 0, left: 0, width: DW, height: DH, objectFit: "cover", borderRadius: 16, zIndex: 0 }} />
            {/* Canvas on top — draws formatted TikTok layout */}
            <canvas ref={prevCanRef} width={PW} height={PH}
              style={{ position: "absolute", top: 0, left: 0, width: DW, height: DH, borderRadius: 16, border: "1px solid #141414", boxShadow: "0 0 40px rgba(0,0,0,.8)", zIndex: 1 }} />
          </div>

          {!videoSrc && (
            <div style={{ color: "#1a1a1a", fontSize: 13, textAlign: "center", marginTop: 120, fontFamily: "DM Mono, monospace", lineHeight: 1.8 }}>
              Upload a video<br />to see preview
            </div>
          )}

          {videoSrc && (
            <button className="btn-ghost" onClick={togglePlay}
              style={{ ...T.btnGhost, marginTop: 14, fontSize: 12, padding: "7px 18px" }}>
              {isPlaying ? "⏸ Pause" : "▶ Play"}
            </button>
          )}

          <div style={{ marginTop: 12, color: "#1a1a1a", fontSize: 10, fontFamily: "DM Mono, monospace" }}>
            9:16 · TikTok Format
          </div>
        </div>
      </div>
    </div>
  );
}
