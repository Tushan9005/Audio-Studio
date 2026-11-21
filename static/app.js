/* Audio Studio front end: library, waveform player with selection, and the tool panels. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var REGION_COLOR = 'rgba(240, 162, 59, .10)';
  // Tune: one analysis per file (key, guitar tuning, pitch) shared by the Tune and Vocal layers tabs
  var TS = { infos: {}, keyFor: null, key: 'C', scale: 'major', strength: 100, style: 0, ref: 'guitar', scales: null, voices: null, summary: null };
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function nice(n) { return String(n).replace('#', '♯'); }
  var S = { files: [], cur: null, ticks: [], filter: 'all', ws: null, regions: null, region: null, presets: {}, voices: {}, rate: 1, abPlay: false, gapT: null, fxPreview: null };
  var fxAudioContext = null, fxSources = new WeakMap(), fxRebuildTimer = null;

  // ── helpers ──
  function fmt(t) { t = Math.round(Math.max(0, t || 0) * 10) / 10; var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Notifications: small cards bottom-right. toast() = a short message; notify() = a titled card with an action.
  function notify(o) {
    var box = $('notes'), n = document.createElement('div');
    n.className = 'note-card' + (o.kind === 'err' ? ' err' : o.kind === 'info' ? ' info' : '');
    n.innerHTML = (o.title ? '<b>' + esc(o.title) + '</b>' : '') + (o.text ? '<p>' + esc(o.text) + '</p>' : '') +
      '<div class="note-actions">' + (o.action ? '<button class="btn small" type="button">' + esc(o.action.label) + '</button>' : '') + '</div>' +
      '<button class="note-x" type="button" aria-label="Dismiss">✕</button>';
    var close = function () { n.classList.add('out'); setTimeout(function () { n.remove(); }, 160); };
    if (o.action) n.querySelector('.note-actions .btn').onclick = function () { o.action.fn(); close(); };
    n.querySelector('.note-x').onclick = close;
    var t = setTimeout(close, o.timeout || (o.kind === 'err' ? 12000 : 9000));
    n.addEventListener('mouseenter', function () { clearTimeout(t); });
    n.addEventListener('mouseleave', function () { t = setTimeout(close, 4000); });
    box.appendChild(n);
    while (box.children.length > 4) box.firstChild.remove();
    return n;
  }
  function toast(msg, err) { notify({ text: msg, kind: err ? 'err' : 'info', timeout: err ? 9000 : 4500 }); }
  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
        return j;
      });
    });
  }
  function post(url, body) { return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  function curFile() { return S.files.filter(function (f) { return f.id === S.cur; })[0] || null; }
  function byId(id) { return S.files.filter(function (f) { return f.id === id; })[0]; }

  // ── background jobs: everything long runs on the server (or uploads in the browser) while you keep working.
  // The header's Jobs tray shows progress; a notification (and, if allowed, a Windows notification) says when
  // each one finishes, with an Open button. Server jobs survive a page reload (/api/jobs).
  var JOBS = {}, jobHooks = {}, jobTimer = null, clientSeq = 0, jobsCleared = {};
  function eta(j) {
    var p = j.progress;
    if (j.stage) return j.stage + '…';
    if (p == null) return 'Working… ' + Math.round(j.elapsed || 0) + ' s';
    var left = p > 0.06 ? Math.max(3, (j.elapsed || 0) / p * (1 - p)) : null;
    return Math.round(p * 100) + '%' + (left ? ' · about ' + (left > 90 ? Math.round(left / 60) + ' min' : Math.round(left / 5) * 5 + ' s') + ' left' : '');
  }
  function jobStep(j) {   // what the job is doing right now, in words
    if (j.action === 'tune_prepare' && j.progress != null && !j.stage) return j.progress < 0.86 ? 'Separating your voice from the guitar · ' + eta(j) : 'Measuring your pitch and key · ' + eta(j);
    if (j.action === 'split' && !j.stage && j.progress != null && j.progress < 0.02) return 'Loading the splitter…';
    return eta(j);
  }
  function renderJobs() {
    var list = Object.keys(JOBS).map(function (k) { return JOBS[k]; }).sort(function (a, b) { return b.started - a.started; });
    var running = list.filter(function (j) { return !j.done; }).length;
    $('jobsCount').hidden = !running; $('jobsCount').textContent = running;
    $('jobsBtn').classList.toggle('busy', running > 0);
    $('jobsEmpty').hidden = list.length > 0;
    $('jobsNotify').hidden = !('Notification' in window) || Notification.permission !== 'default';
    $('jobsList').innerHTML = list.map(function (j) {
      var state = !j.done ? 'run' : j.error ? 'fail' : 'ok';
      var pct = j.progress == null ? null : Math.round(j.progress * 100);
      var meta = !j.done ? jobStep(j) : j.error ? j.error : 'Done in ' + Math.max(1, Math.round(j.elapsed || 0)) + ' s';
      var openable = j.done && !j.error && (j.result && (j.result.file || j.result.files || j.result.analysis || j.result.sound_check || j.action === 'tune_prepare') || j.files);
      return '<li class="job ' + state + '" data-job="' + j.id + '">' +
        '<span class="job-ic" aria-hidden="true"></span>' +
        '<div class="job-main"><div class="job-title">' + esc(j.label) + (j.fname ? ' <span>· ' + esc(j.fname) + '</span>' : '') + '</div>' +
        (j.done ? '' : '<div class="job-bar' + (pct == null ? ' indet' : '') + '"><i style="width:' + (pct == null ? 35 : pct) + '%"></i></div>') +
        '<div class="job-meta">' + esc(meta) + '</div></div>' +
        (openable ? '<button class="btn small" type="button" data-open="' + j.id + '">Open</button>' : '') + '</li>';
    }).join('');
    // the buttons that started a job show its progress while you stay on that file
    var mine = function (action) { return list.filter(function (j) { return !j.done && j.action === action && j.fid === S.cur; })[0]; };
    var ta = mine('tune_prepare'), sp = mine('split');
    if (ta) { $('tuAnalyse').disabled = true; $('tuAnalyse').textContent = 'Analysing… ' + (ta.progress == null ? '' : Math.round(ta.progress * 100) + '%'); }
    else if ($('tuAnalyse').textContent.indexOf('Analysing') === 0) { $('tuAnalyse').disabled = false; renderTuneUI(); }
    if (sp) { $('splitBtn').disabled = true; $('splitBtn').textContent = 'Splitting… ' + (sp.progress == null ? '' : Math.round(sp.progress * 100) + '%'); }
    else if ($('splitBtn').textContent.indexOf('Splitting') === 0) { $('splitBtn').disabled = false; $('splitBtn').textContent = 'Split song'; }
  }
  function openJob(j) {
    var r = j.result || {}, fid = (r.file && r.file.id) || (r.files && r.files[0] && r.files[0].id) || j.fid;
    var tab = { tune_prepare: 'tune', analyse: 'analyse', sound_check: 'analyse' }[j.action];
    var go = function () {
      if (fid && byId(fid)) select(fid);
      if (tab) document.querySelector('.tabs [data-t="' + tab + '"]').click();
      if (r.analysis) showStats(r.analysis);
      if (r.sound_check) showSoundCheck(r.sound_check);
      $('jobsTray').hidden = true; $('jobsBtn').setAttribute('aria-expanded', 'false');
    };
    if (fid && !byId(fid)) load().then(go); else go();
  }
  function jobFinished(j) {
    var hook = jobHooks[j.id] || {};
    delete jobHooks[j.id];
    if (j.error) {
      (hook.fail || []).forEach(function (fn) { fn(new Error(j.error)); });
      notify({ kind: 'err', title: j.label + ' failed', text: j.error + (j.fname ? ' (' + j.fname + ')' : '') });
      desktopNote(j.label + ' failed', j.error);
      return;
    }
    var r = j.result || {}, files = r.files || (r.file ? [r.file] : []);
    if (files.length) load();
    (hook.done || []).forEach(function (fn) { fn(r); });
    var text = files.length > 1 ? files.length + ' files added: ' + files.map(function (f) { return f.name.split(' · ').pop(); }).join(', ') :
      files.length ? '"' + files[0].name + '" is in your library.' : j.action === 'tune_prepare' ? (r.keys ? 'Key ' + r.keys[0].label + (r.together ? ', guitar at A = ' + r.guitar_a + ' Hz' : '') + '. Ready to tune.' : 'Ready.') :
      j.action === 'analyse' ? 'Tempo, key and loudness are ready.' : j.action === 'sound_check' ? 'Your sound check is ready.' : '';
    if (!hook.quiet) notify({ title: j.label + ' done' + (j.fname && !files.length ? ' · ' + j.fname : ''), text: text, action: { label: 'Open', fn: function () { openJob(j); } } });
    desktopNote(j.label + ' done', text);
  }
  function desktopNote(title, body) {   // only when this tab is in the background and you allowed it
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { var n = new Notification('Audio Studio: ' + title, { body: body || '', tag: 'audio-studio' }); n.onclick = function () { window.focus(); n.close(); }; } catch (e) {}
  }
  function pollJobs() {
    clearTimeout(jobTimer);
    return api('/api/jobs').then(function (j) {
      j.jobs.forEach(function (job) {
        if (jobsCleared[job.id]) return;
        var prev = JOBS[job.id];
        JOBS[job.id] = job;
        if (job.done && ((prev && !prev.done) || (!prev && jobHooks[job.id]))) jobFinished(job);
      });
      renderJobs();
      var running = Object.keys(JOBS).some(function (k) { return !JOBS[k].done; });
      if (running) jobTimer = setTimeout(pollJobs, 800);
    }).catch(function () { jobTimer = setTimeout(pollJobs, 3000); });
  }
  // track a server job; done/fail callbacks run when it finishes (even if you are elsewhere in the app)
  function trackJob(jid, done, fail, quiet) {
    var h = jobHooks[jid] = jobHooks[jid] || { done: [], fail: [] };
    if (done) h.done.push(done); if (fail) h.fail.push(fail); if (quiet) h.quiet = true;
    JOBS[jid] = JOBS[jid] || { id: jid, label: 'Starting…', fname: '', progress: null, done: false, started: Date.now() / 1000, elapsed: 0 };
    renderJobs(); pollJobs();
  }
  function startJob(url, body, done, fail) {
    return post(url, body).then(function (j) { trackJob(j.job, done, fail); return j.job; });
  }
  // a job that runs in the browser (uploads, saving a recording)
  function clientJob(label, fname) {
    var id = 'c' + (++clientSeq), j = JOBS[id] = { id: id, label: label, fname: fname || '', progress: 0, done: false, started: Date.now() / 1000, elapsed: 0, client: true };
    var tick = setInterval(function () { j.elapsed = Date.now() / 1000 - j.started; renderJobs(); }, 1000);
    renderJobs();
    return {
      progress: function (p) { j.progress = p; j.elapsed = Date.now() / 1000 - j.started; renderJobs(); },
      finish: function (result) { clearInterval(tick); j.done = true; j.result = result; j.elapsed = Date.now() / 1000 - j.started; renderJobs(); jobFinished(j); },
      fail: function (err) { clearInterval(tick); j.done = true; j.error = err.message || String(err); renderJobs(); jobFinished(j); }
    };
  }
  $('jobsBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = $('jobsTray').hidden; $('jobsTray').hidden = !open; this.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderJobs();
  });
  document.addEventListener('click', function (e) { if (!$('jobsTray').hidden && !e.target.closest('#jobsTray, #jobsBtn, .note-card')) { $('jobsTray').hidden = true; $('jobsBtn').setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('jobsTray').hidden) { $('jobsTray').hidden = true; $('jobsBtn').setAttribute('aria-expanded', 'false'); $('jobsBtn').focus(); } });
  $('jobsList').addEventListener('click', function (e) { var b = e.target.closest('[data-open]'); if (b && JOBS[b.getAttribute('data-open')]) openJob(JOBS[b.getAttribute('data-open')]); });
  $('jobsClear').addEventListener('click', function () { Object.keys(JOBS).forEach(function (k) { if (JOBS[k].done) { jobsCleared[k] = 1; delete JOBS[k]; } }); renderJobs(); });
  $('jobsNotify').addEventListener('click', function () { Notification.requestPermission().then(function () { renderJobs(); }); });
  function anyPreview() { return !!(S.fxPreview || LP || TP); }

  // ── library ──
  function load(selectId) {
    return api('/api/files').then(function (j) {
      S.files = j.files; S.presets = j.preset_values; S.voices = j.voices;
      S.ticks = S.ticks.filter(byId);
      if (!$('vVoice').options.length) {
        Object.keys(j.voices).forEach(function (k) { $('vVoice').add(new Option(j.voices[k], k)); });
        renderSoundGrid();
      }
      drawList(); fillMusic();
      if (selectId) select(selectId);
      else if (S.cur && !byId(S.cur)) { S.cur = null; showStage(); }
      if (!S.cur && S.files.length && !selectId) select(S.files[0].id);
      updateNotes();
    });
  }
  function drawList() {
    var icon = { audio: '♪', video: '▶', image: '▣' };
    var html = S.files.filter(function (f) { return S.filter === 'all' || f.kind === S.filter; }).map(function (f) {
      var sub = (f.kind === 'image' ? (f.width + '×' + f.height) : fmt(f.duration)) + ' · ' + f.ext.toUpperCase() + (f.op && f.op !== 'upload' ? ' · ' + f.op : '');
      var ti = S.ticks.indexOf(f.id);
      return '<li data-id="' + f.id + '" class="' + (f.id === S.cur ? 'on' : '') + '">' +
        '<input type="checkbox" aria-label="Tick ' + esc(f.name) + '"' + (ti >= 0 ? ' checked' : '') + ' title="' + (ti >= 0 ? 'Ticked #' + (ti + 1) : 'Tick') + '">' +
        '<span class="ic ' + f.kind + '">' + icon[f.kind] + '</span><span><div class="nm">' + esc(f.name) + '</div><div class="sub">' + esc(sub) + '</div></span></li>';
    }).join('');
    $('files').innerHTML = html || '<li class="none">Nothing here yet. Add a song or press Record.</li>';
    $('libCount').textContent = S.files.length ? S.files.length + (S.files.length === 1 ? ' file' : ' files') : '';
  }
  function fillMusic() {
    document.querySelectorAll('.music-pick').forEach(function (sel) {
      var keep = sel.value;
      sel.innerHTML = (sel.getAttribute('data-none') ? '<option value="">No music</option>' : '');
      S.files.filter(function (f) { return f.kind === 'audio'; }).forEach(function (f) { sel.add(new Option(f.name + ' (' + fmt(f.duration) + ')', f.id)); });
      if (keep && byId(keep)) sel.value = keep;
    });
  }
  function updateNotes() {
    var aud = S.ticks.filter(function (id) { var f = byId(id); return f && f.kind === 'audio'; }).length;
    var vis = S.ticks.filter(function (id) { var f = byId(id); return f && f.kind !== 'audio'; }).length;
    $('joinNote').textContent = aud >= 2 ? aud + ' sound files ticked (joined in the order you ticked them).' : 'Tick 2 or more sound files in the library.';
    $('brNote').textContent = vis ? vis + ' video/photo clip' + (vis > 1 ? 's' : '') + ' ticked (used in the order ticked, repeating if needed).' : 'Tick videos or photos in the library (used in the order ticked, repeating if needed).';
  }
  $('files').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-id]'); if (!li) return;
    var id = li.getAttribute('data-id');
    if (e.target.matches('input[type=checkbox]')) {
      var i = S.ticks.indexOf(id);
      if (e.target.checked && i < 0) S.ticks.push(id); else if (!e.target.checked && i >= 0) S.ticks.splice(i, 1);
      drawList(); updateNotes(); return;
    }
    select(id);
  });
  document.querySelector('.chips').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.filter = b.getAttribute('data-k');
    document.querySelectorAll('.chips button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    drawList();
  });

  // ── upload (button + drag & drop) ──
  function upload(list) {
    if (!list || !list.length) return;
    var fd = new FormData(), n = list.length;
    Array.prototype.forEach.call(list, function (f) { fd.append('files', f, f.name); });
    var cj = clientJob('Adding ' + n + ' file' + (n > 1 ? 's' : ''), n === 1 ? list[0].name : '');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = function (e) { if (e.lengthComputable) cj.progress(e.loaded / e.total * 0.95); };
    xhr.onload = function () {
      var j = {}; try { j = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 400 || !j.files) { cj.fail(new Error(j.error || 'Upload failed (' + xhr.status + ').')); return; }
      cj.finish({ files: j.files });
      if (!S.cur || !anyPreview()) load(j.files[0].id);   // you just added it: show it, unless a preview is playing
    };
    xhr.onerror = function () { cj.fail(new Error('Upload failed. Is Audio Studio still running?')); };
    xhr.send(fd);
    $('up').value = '';
  }
  $('up').addEventListener('change', function () { upload(this.files); });
  ['dragenter', 'dragover'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); $('drop').classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) $('drop').classList.remove('over'); }); });
  document.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) upload(e.dataTransfer.files); });

  // ── recording (voice processing OFF so guitar and singing are captured as they are) ──
  var rec = null;
  $('recBtn').addEventListener('click', function () {
    if (rec) return;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } }).then(function (stream) {
      var chunks = [], mr = new MediaRecorder(stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 } : {});
      var ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an);
      var buf = new Float32Array(an.fftSize), t0 = Date.now(), cv = $('recMeter').getContext('2d');
      rec = { mr: mr, stream: stream, ac: ac };
      mr.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      mr.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); }); ac.close(); cancelAnimationFrame(rec.raf); rec = null;
        $('recBar').hidden = true;
        var blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), fd = new FormData();
        fd.append('file', blob, 'take.webm');
        var d = new Date(), name = 'Recording ' + d.toLocaleDateString('en-GB') + ' ' + d.toTimeString().slice(0, 5);
        var cj = clientJob('Saving recording', name);
        cj.progress(null);
        api('/api/record?name=' + encodeURIComponent(name), { method: 'POST', body: fd })
          .then(function (j) { cj.finish({ file: j.file }); if (!anyPreview()) load(j.file.id); })
          .catch(function (x) { cj.fail(x); });
      };
      (function meter() {
        an.getFloatTimeDomainData(buf); var pk = 0; for (var i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
        cv.clearRect(0, 0, 120, 22); cv.fillStyle = pk > 0.95 ? '#e8634f' : (pk > 0.7 ? '#f0a23b' : '#67c48a'); cv.fillRect(0, 6, 120 * Math.min(1, pk), 10);
        var s = Math.floor((Date.now() - t0) / 1000); $('recTime').textContent = Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2);
        rec.raf = requestAnimationFrame(meter);
      })();
      mr.start(1000); $('recBar').hidden = false;
    }).catch(function () { toast('Could not use the microphone. Allow it in Chrome (the icon in the address bar).', true); });
  });
  $('recStop').addEventListener('click', function () { if (rec) rec.mr.stop(); });

  // ── stage: player + waveform + selection ──
  function showStage() { $('empty').hidden = !!S.cur; $('stage').hidden = !S.cur; }
  function select(id) {
    var f = byId(id); if (!f) return;
    stopFxPreview(); stopLayerPreview(); stopTunePreview();
    S.cur = id; showStage(); drawList();
    $('fname').value = f.name;
    $('fmeta').textContent = f.kind === 'image' ? (f.width + '×' + f.height + ' photo') : (fmt(f.duration) + ' · ' + f.ext.toUpperCase() + (f.kind === 'video' ? ' · ' + f.width + '×' + f.height + (f.has_audio ? '' : ' · no sound') : ''));
    $('dl').href = '/download/' + id;
    if (S.ws) { S.ws.destroy(); S.ws = null; S.region = null; }
    var vid = $('vid'), img = $('img');
    vid.pause(); vid.hidden = f.kind !== 'video'; img.hidden = f.kind !== 'image';
    $('transport').hidden = f.kind === 'image'; $('wave').hidden = f.kind === 'image' || (f.kind === 'video' && !f.has_audio);
    if (f.kind === 'image') { img.src = '/media/' + id; vid.removeAttribute('src'); }
    else {
      var opts = { container: '#wave', height: 140, waveColor: '#5b5047', progressColor: '#f0a23b', cursorColor: '#f8b957', cursorWidth: 2, barWidth: 2, barGap: 1, barRadius: 2, normalize: true };
      if (f.kind === 'video') { vid.src = '/media/' + id; opts.media = vid; } else { opts.url = '/media/' + id; }
      if (f.kind === 'audio' || f.has_audio) {
        S.ws = WaveSurfer.create(opts);
        S.regions = S.ws.registerPlugin(WaveSurfer.Regions.create());
        S.regions.enableDragSelection({ color: REGION_COLOR });
        S.regions.on('region-created', function (r) { S.regions.getRegions().forEach(function (o) { if (o !== r) o.remove(); }); S.region = r; showSel(); });
        S.regions.on('region-update', function () { showSel(); });     // live while a handle is dragged
        S.regions.on('region-updated', function () { showSel(); });
        S.ws.on('timeupdate', function (t) { $('time').textContent = fmt(t) + ' / ' + fmt(S.ws.getDuration()); regionEnd(t); if (graphStatic) drawPlayhead(); });
        S.ws.on('ready', function () { $('time').textContent = '0:00.0 / ' + fmt(S.ws.getDuration()); applyZoom(); applyRate(); if (!S.region) resetFrame(); });
        S.ws.on('interaction', function () { S.abPlay = false; clearTimeout(S.gapT); S.gapT = null; });
        S.ws.on('play', function () { $('play').textContent = '❚❚'; });
        S.ws.on('pause', function () { if (!S.gapT) $('play').textContent = '▶'; });
        S.ws.on('finish', function () { $('play').textContent = '▶'; });
      }
    }
    S.region = null; S.abPlay = false; clearTimeout(S.gapT); S.gapT = null; showSel();
    var hasSound = f.kind === 'audio' || (f.kind === 'video' && f.has_audio);
    ['splitBtn', 'setA', 'setB', 'clearAB', 'trReset'].forEach(function (k) { $(k).disabled = !hasSound; });
    document.querySelectorAll('[data-nudge], [data-here]').forEach(function (b) { b.disabled = !hasSound; });
    $('trimCard').querySelector('.exact').open = f.kind === 'video' && !f.has_audio;   // no waveform: type the times
    document.querySelector('[data-do="practice"]').disabled = !hasSound;
    // tools that don't fit this file are greyed out
    document.querySelectorAll('[data-audio]').forEach(function (el) { el.disabled = f.kind !== 'audio'; el.classList.toggle('disabled-card', el.tagName !== 'BUTTON' && f.kind !== 'audio'); });
    document.querySelectorAll('[data-video-only]').forEach(function (el) { el.disabled = f.kind !== 'video'; });
    document.querySelectorAll('[data-needs-video]').forEach(function (el) { el.hidden = f.kind === 'video'; });
    document.querySelector('[data-do="video_music"]').disabled = f.kind !== 'video';
    var fxButton = document.querySelector('[data-do="effects"]');
    fxButton.disabled = !hasSound;
    fxButton.textContent = f.kind === 'video' ? 'Polish video sound → new MP4' : 'Apply effects → new copy';
    $('fxPreview').disabled = !hasSound;
    $('lpPreview').disabled = !hasSound;
    refreshTune(f);
    renderJobs();
    if (!document.querySelector('[data-p="fx"]').hidden) loadSuggestion(); else markSuggested();
  }
  // The whole file is always framed by two draggable handles. A frame that still covers the whole
  // file counts as "nothing selected", so Play plays everything and Trim asks you to drag first.
  function isFull() {
    var r = S.region, d = S.ws ? S.ws.getDuration() : 0;
    return !r || !d || (r.start <= 0.05 && r.end >= d - 0.05);
  }
  function selected() { return S.region && !isFull() ? S.region : null; }
  function resetFrame() {
    if (!S.ws || !S.ws.getDuration()) return;
    S.abPlay = false; clearTimeout(S.gapT); S.gapT = null;
    setRegion(0, S.ws.getDuration());
  }
  function showSel() {
    var r = S.region, sel = selected(), d = S.ws ? S.ws.getDuration() : 0;
    var full = !sel;
    $('wave').classList.toggle('full', full);
    $('trimCard').classList.toggle('is-full', full);
    if (sel) {
      $('selInfo').innerHTML = 'Selected <b>' + fmt(sel.start) + ' – ' + fmt(sel.end) + '</b> · ' + (sel.end - sel.start).toFixed(1) + ' s · Play ' + ($('prLoop').checked ? 'repeats' : 'plays') + ' it';
    } else {
      $('selInfo').textContent = S.ws ? 'Drag the amber handles to trim, or drag across the waveform to pick a part' : '';
    }
    $('trS').textContent = r ? fmt(r.start) : '–';
    $('trE').textContent = r ? fmt(r.end) : '–';
    $('trL').textContent = r ? fmt(r.end - r.start) : '–';
    $('trCut').textContent = !r ? '' : (full ? 'the whole file' : 'cuts ' + fmt(r.start + (d - r.end)));
    $('selS').value = r ? r.start.toFixed(2) : ''; $('selE').value = r ? r.end.toFixed(2) : '';
  }
  function moveEdge(which, t) {
    var r = S.region, d = S.ws ? S.ws.getDuration() : 0; if (!r || !d) return;
    var s = r.start, e = r.end;
    if (which === 'start') s = Math.max(0, Math.min(t, e - 0.1)); else e = Math.min(d, Math.max(t, s + 0.1));
    setRegion(s, e);
  }
  document.querySelectorAll('[data-nudge]').forEach(function (b) {
    b.addEventListener('click', function () {
      var w = b.getAttribute('data-nudge'); if (!S.region) return;
      moveEdge(w, S.region[w] + Number(b.getAttribute('data-by')));
    });
  });
  document.querySelectorAll('[data-here]').forEach(function (b) {
    b.addEventListener('click', function () { if (S.ws) moveEdge(b.getAttribute('data-here'), S.ws.getCurrentTime()); });
  });
  $('trReset').addEventListener('click', resetFrame);
  function setSelFromInputs() {
    if (!S.regions) return;
    var s = parseFloat($('selS').value), e = parseFloat($('selE').value);
    if (!(e > s)) return;
    S.regions.clearRegions();
    S.region = S.regions.addRegion({ start: s, end: e, color: REGION_COLOR });
    showSel();
  }
  $('selS').addEventListener('change', setSelFromInputs); $('selE').addEventListener('change', setSelFromInputs);
  $('play').addEventListener('click', function () {
    if (!S.ws) { var v = $('vid'); if (!v.hidden) (v.paused ? v.play() : v.pause()); return; }
    var waiting = !!S.gapT; clearTimeout(S.gapT); S.gapT = null;
    if (S.ws.isPlaying() || waiting) { S.ws.pause(); S.abPlay = false; $('play').textContent = '▶'; return; }
    var sel = selected();
    if (sel) {
      var t = S.ws.getCurrentTime();
      if (t < sel.start || t >= sel.end - 0.05) S.ws.setTime(sel.start);
      S.abPlay = true;
    } else S.abPlay = false;
    S.ws.play();
  });
  // The selected part stops at its end, or repeats (with an optional pause) when "Loop" is on.
  function regionEnd(t) {
    var r = S.region;
    if (!S.abPlay || !r || !S.ws.isPlaying() || t < r.end - 0.02) return;
    S.ws.pause(); S.ws.setTime(r.start);
    if (!$('prLoop').checked) { S.abPlay = false; return; }
    var gap = Number($('prGap').value) * 1000;
    if (!gap) { S.ws.play(); return; }
    $('play').textContent = '❚❚';   // still "playing": the pause is part of the loop
    S.gapT = setTimeout(function () { S.gapT = null; if (S.abPlay && S.region === r && S.ws) S.ws.play(); }, gap);
  }

  // ── practice: speed (pitch kept) and A–B ──
  function applyRate() {
    if (S.ws) S.ws.setPlaybackRate(S.rate, true);
    var pct = Math.round(S.rate * 100);
    $('prRate').value = pct; $('prRateO').textContent = pct + '%';
    $('rateTag').hidden = pct === 100; $('rateTag').textContent = pct + '% speed';
    document.querySelectorAll('#prQuick [data-rate]').forEach(function (b) { b.setAttribute('aria-pressed', Number(b.getAttribute('data-rate')) === pct ? 'true' : 'false'); });
  }
  $('prRate').addEventListener('input', function () { S.rate = Number(this.value) / 100; applyRate(); });
  $('prQuick').addEventListener('click', function (e) { var b = e.target.closest('[data-rate]'); if (!b) return; S.rate = Number(b.getAttribute('data-rate')) / 100; applyRate(); });
  function setRegion(s, e) {
    if (!S.regions) return;
    S.regions.clearRegions();
    S.region = S.regions.addRegion({ start: s, end: e, color: REGION_COLOR });
    showSel();
  }
  $('setA').addEventListener('click', function () {
    if (!S.ws) return; var t = S.ws.getCurrentTime(), d = S.ws.getDuration();
    setRegion(t, S.region && S.region.end > t + 0.2 ? S.region.end : Math.min(d, t + 8));
  });
  $('setB').addEventListener('click', function () {
    if (!S.ws) return; var t = S.ws.getCurrentTime();
    if (S.region && t > S.region.start + 0.2) setRegion(S.region.start, t);
    else if (t > 0.2) setRegion(Math.max(0, t - 8), t);
  });
  $('clearAB').addEventListener('click', resetFrame);
  $('prLoop').addEventListener('change', showSel);

  // ── split a song (runs in the background; the page shows progress) ──
  $('splitBtn').addEventListener('click', function () {
    var f = curFile(); if (!f) return;
    var stems = Array.prototype.map.call(document.querySelectorAll('[data-stem]:checked'), function (c) { return c.getAttribute('data-stem'); });
    if (!stems.length) { toast('Tick at least one thing to make.', true); return; }
    startJob('/api/split', { id: f.id, stems: stems }).then(function () {
      toast('Splitting "' + f.name + '" in the background. Keep working; you will be told when it is done.');
    }, function (x) { toast(x.message, true); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); $('play').click(); }
    else if (e.key === '[' && S.ws) { e.preventDefault(); moveEdge('start', S.ws.getCurrentTime()); }
    else if (e.key === ']' && S.ws) { e.preventDefault(); moveEdge('end', S.ws.getCurrentTime()); }
  });
  function applyZoom() { if (S.ws) try { S.ws.zoom(Number($('zoom').value)); } catch (e) {} }
  $('zoom').addEventListener('input', applyZoom);
  $('fname').addEventListener('change', function () {
    if (!S.cur) return;
    post('/api/files/' + S.cur + '/rename', { name: this.value }).then(function () { return load(); });
  });
  $('del').addEventListener('click', function () {
    var f = curFile(); if (!f || !confirm('Delete "' + f.name + '" from the library? This can\'t be undone.')) return;
    api('/api/files/' + f.id, { method: 'DELETE' }).then(function () { S.cur = null; return load(); }).then(function () { toast('Deleted.'); });
  });

  // ── tabs ──
  var VOICE_GROUPS = [
    ['In key (from the Tune tab)', [['tuned', 'Your voice, tuned'], ['double', 'Double (tuned, humanised)'], ['h3up', '3rd above'], ['h4up', '4th above'], ['h5up', '5th above'], ['h6up', '6th above'], ['h8up', 'Octave above'], ['h3dn', '3rd below'], ['h4dn', '4th below'], ['h5dn', '5th below'], ['h6dn', '6th below'], ['h8dn', 'Octave below']]],
    ['Other', [['fixed', 'Fixed shift (semitones)'], ['backing', 'Guitar & backing']]]
  ];
  function isSmart(v) { return v !== 'fixed' && v !== 'backing'; }
  function layerVoiceUI(row) {
    var v = row.querySelector('[data-layer="voice"]').value;
    row.querySelector('.f-shift').hidden = v !== 'fixed';
    row.querySelector('.f-source').hidden = v === 'backing';
    var pan = row.querySelector('[data-layer="pan"]'); pan.disabled = v === 'backing'; if (v === 'backing') pan.value = 0;
    row.classList.toggle('is-backing', v === 'backing');
  }
  function addVocalLayer(name, voice, db, pan, delay, shift, seed) {
    if ($('layerTracks').children.length >= 10) { toast('Maximum ten layers.', true); return; }
    voice = voice || 'tuned';
    var row = document.createElement('div'); row.className = 'layer-track';
    var opts = VOICE_GROUPS.map(function (g) { return '<optgroup label="' + esc(g[0]) + '">' + g[1].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === voice ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</optgroup>'; }).join('');
    var num = function (k, label, lo, hi, val, step, cls) { return '<label class="' + (cls || '') + '">' + label + '<input type="number" data-layer="' + k + '" min="' + lo + '" max="' + hi + '" value="' + val + '" step="' + step + '"></label>'; };
    row.innerHTML = '<label>Part<input class="layer-name" value="' + esc(name) + '"></label>' +
      '<label>Voice<select data-layer="voice">' + opts + '</select></label>' +
      '<label class="f-source">Sung by<select data-layer="source"><option value="">This recording</option></select></label>' +
      num('shift', 'Semitones', -12, 12, shift || 0, 1, 'f-shift') + num('db', 'Level (dB)', -36, 6, db, 1) + num('pan', 'Pan (−1 L / +1 R)', -1, 1, pan || 0, .1) + num('delay', 'Offset (ms)', 0, 5000, delay || 0, 10) +
      '<input type="hidden" data-layer="seed" value="' + (seed == null ? Math.floor(Math.random() * 9000) : seed) + '">' +
      '<label class="tick"><input type="checkbox" data-layer="mute">Mute</label><label class="tick"><input type="checkbox" data-layer="solo">Solo</label><button class="btn ghost" type="button">Remove</button>';
    S.files.filter(function (f) { return f.kind === 'audio' && f.id !== S.cur; }).forEach(function (f) { row.querySelector('[data-layer="source"]').add(new Option(f.name, f.id)); });
    row.querySelector('button').onclick = function () { row.remove(); markLayersCustom(); scheduleLayerPreview(); };
    row.querySelector('[data-layer="voice"]').addEventListener('change', function () { layerVoiceUI(row); });
    $('layerTracks').appendChild(row);
    layerVoiceUI(row);
  }
  // tracks: [part, voice, level dB, pan, offset ms, semitones (fixed only), seed]. 'In key' voices follow the key
  // and guitar tuning from the Tune tab and are built from your corrected voice, so they are always in tune.
  var G = ['Guitar & backing', 'backing', 0, 0, 0];
  var layerArrangements = {
    k_tuned: {group: 1, name: 'Tuned voice + guitar', help: 'Just your voice, pitch-corrected, with your guitar. Set how natural or robotic it sounds in the Tune tab.', tracks: [['Lead', 'tuned', 0, 0, 0], G]},
    k_third: {group: 1, name: 'Sweet third above', help: 'A soft harmony a third above you, following the key note by note. The classic duet sound.', tracks: [['Lead', 'tuned', -1, 0, 0], ['3rd above', 'h3up', -9, .25, 0, 0, 11], G]},
    k_sixth: {group: 1, name: 'Warm duet: sixth below', help: 'A harmony a sixth below you: warm and full, common in film-song duets.', tracks: [['Lead', 'tuned', -1, 0, 0], ['6th below', 'h6dn', -8, -.25, 0, 0, 12], G]},
    k_pop: {group: 1, name: 'Pop stack: 3rd + 5th', help: 'Third above on the left, fifth above on the right, both following the key: a big chorus sound.', tracks: [['Lead', 'tuned', -1, 0, 0], ['3rd above', 'h3up', -10, -.4, 0, 0, 21], ['5th above', 'h5up', -12, .4, 0, 0, 22], G]},
    k_doubles: {group: 1, name: 'Wide tuned doubles', help: 'Two slightly different tuned copies of you, left and right, so it sounds like you sang it three times.', tracks: [['Lead', 'tuned', -1, 0, 0], ['Double left', 'double', -13, -.7, 18, 0, 31], ['Double right', 'double', -13, .7, 31, 0, 32], G]},
    k_choir: {group: 1, name: 'Choir: six voices', help: 'Doubles, a third and fifth above and an octave below, each with its own small human drift: like a small choir behind you.', tracks: [['Lead', 'tuned', -2, 0, 0], ['Double left', 'double', -14, -.6, 22, 0, 41], ['Double right', 'double', -14, .6, 35, 0, 42], ['3rd above', 'h3up', -13, -.35, 12, 0, 43], ['5th above', 'h5up', -15, .35, 16, 0, 44], ['Octave below', 'h8dn', -17, 0, 8, 0, 45], G]},
    k_gospel: {group: 1, name: 'Gospel spread', help: 'Third and fifth above, octave above and a third below: rich and soulful. Best on long, held notes.', tracks: [['Lead', 'tuned', -1, 0, 0], ['3rd above', 'h3up', -11, -.3, 0, 0, 51], ['5th above', 'h5up', -13, .3, 0, 0, 52], ['Octave above', 'h8up', -18, 0, 10, 0, 53], ['3rd below', 'h3dn', -14, 0, 0, 0, 54], G]},
    k_air: {group: 1, name: 'Ethereal octaves', help: 'Quiet octaves above and below plus a double: airy and dreamy, good for slow songs.', tracks: [['Lead', 'tuned', -1, 0, 0], ['Octave above', 'h8up', -16, .3, 10, 0, 61], ['Octave below', 'h8dn', -15, -.3, 14, 0, 62], ['Double', 'double', -16, 0, 25, 0, 63], G]},
    intimate: {group: 2, name: 'Intimate double', help: 'Lead plus a quiet 18 ms copy for subtle thickness (not tuned).', tracks: [['Lead', 'fixed', -3, 0, 0], ['Soft double', 'fixed', -18, .15, 18]]},
    wide: {group: 2, name: 'Wide pop doubles', help: 'Lead with quiet left/right delayed copies (not tuned).', tracks: [['Lead', 'fixed', -3, 0, 0], ['Double left', 'fixed', -18, -.8, 18], ['Double right', 'fixed', -18, .8, 32]]},
    low: {group: 2, name: 'Warm lower octave', help: 'A quiet octave below (fixed shift, not tuned).', tracks: [['Lead', 'fixed', -3, 0, 0], ['Lower octave', 'fixed', -18, 0, 0, -12]]},
    major: {group: 2, name: 'Major third + fifth + bass', help: 'Fixed +4 and +7 semitones: they do not follow your key, so some notes may clash.', tracks: [['Lead', 'fixed', -3, 0, 0], ['Major third', 'fixed', -12, -.5, 0, 4], ['Fifth', 'fixed', -15, .5, 0, 7], ['Octave bass', 'fixed', -18, 0, 0, -12]]},
    minor: {group: 2, name: 'Minor third + fifth + bass', help: 'Fixed +3 and +7 semitones: they do not follow your key, so some notes may clash.', tracks: [['Lead', 'fixed', -3, 0, 0], ['Minor third', 'fixed', -12, -.5, 0, 3], ['Fifth', 'fixed', -15, .5, 0, 7], ['Octave bass', 'fixed', -18, 0, 0, -12]]}
  };
  [['In key: always in tune (uses the Tune tab)', 1], ['Classic fixed shifts', 2]].forEach(function (g) {
    var og = document.createElement('optgroup'); og.label = g[0];
    Object.keys(layerArrangements).forEach(function (k) { if (layerArrangements[k].group === g[1]) og.appendChild(new Option(layerArrangements[k].name, k)); });
    $('layerPreset').appendChild(og);
  });
  $('layerPresetHelp').textContent = 'Choose an arrangement: it loads straight away, and plays at once if Live preview is on.';


  // ── Tune: pitch correction ("autotune") ──
  function tuneParams() {
    var inf = TS.infos[S.cur];
    return { key: TS.key, scale: TS.scale, strength: TS.strength, style: TS.style, ref: TS.ref === 'guitar' && inf ? inf.tuning_cents : 0 };
  }
  function tuneQuery() { var p = tuneParams(); return Object.keys(p).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&'); }
  function analyseTune(fid, together) {
    var running = Object.keys(JOBS).map(function (k) { return JOBS[k]; }).filter(function (j) { return !j.done && j.action === 'tune_prepare' && j.fid === fid; })[0];
    return new Promise(function (ok, fail) {
      var done = function (info) { TS.infos[fid] = info; if (S.cur === fid) renderTuneUI(); ok(info); };
      if (running) { trackJob(running.id, done, fail); return; }      // already analysing: wait for that one
      startJob('/api/tune/prepare', { id: fid, together: together }, done, fail).catch(fail);
    });
  }
  // every source that an in-key voice (or the guitar) needs is analysed first; the lead uses the Tune tab choice
  function ensureLayerAnalyses(leadOnly) {
    var need = [];
    var leadTogether = document.querySelector('input[name="tuTogether"]:checked').value === '1';
    if (leadOnly) need.push([S.cur, leadTogether]);
    else layerRows().forEach(function (r) {
      if ((isSmart(r.voice) || r.voice === 'backing') && !TS.infos[r.src] && !need.some(function (n) { return n[0] === r.src; }))
        need.push([r.src, r.src === S.cur ? leadTogether : false]);
    });
    if (!need.length || need.every(function (n) { return TS.infos[n[0]]; })) return Promise.resolve();
    if (need.some(function (n) { return n[0] === S.cur && !TS.infos[n[0]]; }))
      toast((leadTogether ? 'Separating your voice from the guitar and finding the key' : 'Measuring your pitch and finding the key') + ' in the background (once per recording). See Jobs.');
    return need.reduce(function (pr, n) { return pr.then(function () { return TS.infos[n[0]] ? null : analyseTune(n[0], n[1]); }); }, Promise.resolve())
      .then(function () { renderTuneUI(); });
  }
  function refreshTune(f) {
    var hasSound = f.kind === 'audio' || (f.kind === 'video' && f.has_audio);
    $('tuAnalyse').disabled = !hasSound;
    if (!hasSound) { renderTuneUI(); return; }
    api('/api/tune/info/' + f.id).then(function (j) {
      if (!TS.scales) {
        TS.scales = j.scales;
        NOTE_NAMES.forEach(function (n) { $('tuKey').add(new Option(nice(n), n)); });
        Object.keys(j.scales).forEach(function (k) { $('tuScale').add(new Option(j.scales[k], k)); });
      }
      if (j.info) TS.infos[f.id] = j.info; else delete TS.infos[f.id];
      if (S.cur === f.id) renderTuneUI();
    }).catch(function () {});
  }
  function renderTuneUI() {
    var f = curFile(), inf = f && TS.infos[f.id];
    if (inf && TS.keyFor !== f.id) { TS.keyFor = f.id; TS.key = inf.keys[0].key; TS.scale = inf.keys[0].scale; TS.ref = 'guitar'; }
    ['tuPreview', 'tuSave'].forEach(function (k) { $(k).disabled = !inf; });
    $('tuSettings').classList.toggle('disabled-card', !inf);
    $('tuAnalyse').textContent = inf ? 'Analyse again' : 'Analyse my singing';
    if (inf) document.querySelector('input[name="tuTogether"][value="' + (inf.together ? 1 : 0) + '"]').checked = true;
    if (TS.scales) { $('tuKey').value = TS.key; $('tuScale').value = TS.scale; }
    $('tuStrength').value = TS.strength; $('tuStrengthO').textContent = TS.strength + '%';
    $('tuStyle').value = TS.style; $('tuStyleO').textContent = TS.style < 20 ? 'Natural' : TS.style < 70 ? 'Pop' : 'Robotic';
    document.querySelectorAll('#tuStyles [data-style]').forEach(function (b) { b.classList.toggle('chosen', Number(b.getAttribute('data-style')) === Number(TS.style)); });
    $('tuRefWrap').hidden = !(inf && inf.together);
    $('tuRef').value = TS.ref;
    if (inf && inf.together) $('tuRef').options[0].text = "your guitar's tuning (A = " + inf.guitar_a + ' Hz)';
    if (!inf) {
      $('tuNote').textContent = 'Analyse your recording to start.';
      $('tuKeyNote').textContent = 'The key is detected from your guitar (or your singing). You can change it.';
      $('tuBefore').textContent = $('tuAfter').textContent = '–'; TS.summary = null; drawTuneGraph();
    } else {
      var others = inf.keys.slice(1).map(function (k) { return k.label; }).join(', ');
      $('tuKeyNote').textContent = 'Detected: ' + inf.keys[0].label + (others ? ' (also possible: ' + others + ')' : '') + '. ' +
        (inf.together ? 'Your guitar is tuned ' + Math.abs(inf.tuning_cents) + ' cents ' + (inf.tuning_cents < 0 ? 'flat' : 'sharp') + ', so your voice is tuned to match it.' : 'Tuned to standard pitch.');
      if (!TP) $('tuNote').textContent = 'Ready. Press Live preview, then adjust while it plays.';
      loadTuneSummary();
    }
    var lk = $('layersKey');
    lk.textContent = inf ? 'In-key voices use ' + nice(TS.key) + ' ' + (TS.scales ? TS.scales[TS.scale].split(' (')[0].toLowerCase() : TS.scale) + ' and the correction settings from the Tune tab.' :
      'In-key arrangements analyse your singing first (once per recording).';
  }
  var tuneTimer = null;
  function tuneChanged() {
    renderTuneUI();
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(function () { if (TP) tpLoad(); scheduleLayerPreview(); }, 250);
  }
  $('tuKey').addEventListener('change', function () { TS.key = this.value; tuneChanged(); });
  $('tuScale').addEventListener('change', function () { TS.scale = this.value; tuneChanged(); });
  $('tuStrength').addEventListener('input', function () { TS.strength = Number(this.value); tuneChanged(); });
  $('tuStyle').addEventListener('input', function () { TS.style = Number(this.value); tuneChanged(); });
  $('tuRef').addEventListener('change', function () { TS.ref = this.value; tuneChanged(); });
  $('tuStyles').addEventListener('click', function (e) { var b = e.target.closest('[data-style]'); if (!b || !TS.infos[S.cur]) return; TS.style = Number(b.getAttribute('data-style')); TS.strength = 100; tuneChanged(); });
  $('tuAnalyse').addEventListener('click', function () {
    var f = curFile(); if (!f) return;
    var together = document.querySelector('input[name="tuTogether"]:checked').value === '1';
    stopTunePreview(); stopLayerPreview();
    TS.keyFor = null;
    analyseTune(f.id, together).then(function () { if (S.cur === f.id) renderTuneUI(); }, function () {});
    toast('Analysing in the background: keep listening or working. You will be told when it is ready.');
  });

  // pitch graph: what you sang (grey) and the tuned pitch (amber) on the notes of the key
  var tuneSumTimer = null, graphStatic = null;
  function loadTuneSummary() {
    clearTimeout(tuneSumTimer);
    var fid = S.cur;
    tuneSumTimer = setTimeout(function () {
      api('/api/tune/summary/' + fid + '?' + tuneQuery()).then(function (j) {
        if (S.cur !== fid) return;
        TS.summary = j; $('tuBefore').textContent = j.before + '%'; $('tuAfter').textContent = j.after + '%';
        drawTuneGraph();
      }).catch(function (e) { toast(e.message, true); });
    }, 120);
  }
  function drawTuneGraph() {
    var cv = $('tuGraph'), wrap = cv.parentNode, j = TS.summary;
    $('tuGraphEmpty').hidden = !!j;
    var w = wrap.clientWidth, h = 240, dpr = window.devicePixelRatio || 1;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    var c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    graphStatic = null;
    if (!j || !j.t.length) return;
    var sorted = j.sung.slice().sort(function (a, b) { return a - b; });
    var lo = Math.floor(sorted[Math.floor(sorted.length * .02)] - 1.5), hi = Math.ceil(sorted[Math.floor(sorted.length * .98)] + 1.5);
    var dur = Math.max(j.t[j.t.length - 1], S.ws ? S.ws.getDuration() : 0) || 1, L = 34;
    var X = function (t) { return L + (w - L - 8) * t / dur; }, Y = function (m) { return h - 10 - (h - 20) * (m - lo) / (hi - lo); };
    var root = NOTE_NAMES.indexOf(TS.key);
    c.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    j.notes.forEach(function (n) {
      if (n < lo || n > hi) return;
      var y = Math.round(Y(n)) + .5, isRoot = ((n % 12) + 12) % 12 === root;
      c.strokeStyle = isRoot ? 'rgba(240,162,59,.28)' : 'rgba(255,232,205,.07)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(L, y); c.lineTo(w - 8, y); c.stroke();
      c.fillStyle = isRoot ? '#c98a3a' : '#675d53'; c.fillText(nice(NOTE_NAMES[((n % 12) + 12) % 12]) + (Math.floor(n / 12) - 1), 2, y + 3);
    });
    function line(arr, colour, width) {
      c.strokeStyle = colour; c.lineWidth = width; c.lineJoin = 'round'; c.beginPath();
      for (var i = 0; i < arr.length; i++) {
        var x = X(j.t[i]), y = Y(arr[i]);
        if (i && j.t[i] - j.t[i - 1] < 0.05) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke();
    }
    line(j.sung, 'rgba(200,187,170,.45)', 1.4);
    line(j.fixed, '#f0a23b', 2);
    graphStatic = document.createElement('canvas'); graphStatic.width = cv.width; graphStatic.height = cv.height;
    graphStatic.getContext('2d').drawImage(cv, 0, 0);   // the still picture; the playhead is drawn on top
    cv._map = { X: X, dur: dur, L: L, w: w };
    drawPlayhead();
  }
  function drawPlayhead() {
    var cv = $('tuGraph'); if (!graphStatic || !cv._map || !S.ws) return;
    var c = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); c.drawImage(graphStatic, 0, 0); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var x = Math.round(cv._map.X(S.ws.getCurrentTime())) + .5;
    c.strokeStyle = '#f8b957'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, cv.height / dpr); c.stroke();
  }
  $('tuGraph').addEventListener('click', function (e) {
    var m = this._map; if (!m || !S.ws) return;
    var x = e.clientX - this.getBoundingClientRect().left;
    S.ws.setTime(Math.max(0, Math.min(m.dur, (x - m.L) / (m.w - m.L - 8) * m.dur)));
    drawPlayhead();
  });
  window.addEventListener('resize', function () { if (!document.querySelector('[data-p="tune"]').hidden) drawTuneGraph(); });

  // live preview: the tuned song (same file Save adds) played in sync with the player; changes cross-fade in
  var TP = null;
  function tpMediaDirect(on) {
    var media = TP.media, fxs = fxSources.get(media);
    media.muted = !on;
    if (fxs) { try { fxs.disconnect(); } catch (e) {} if (on) fxs.connect(TP.ac.destination); }
  }
  function tpVoice(buf, pos, fadeIn) {
    var ac = TP.ac, v = { src: ac.createBufferSource(), gain: ac.createGain() };
    v.src.buffer = buf; v.src.connect(v.gain); v.gain.connect(TP.bus);
    v.gain.gain.setValueAtTime(fadeIn ? 0 : 1, ac.currentTime); if (fadeIn) v.gain.gain.linearRampToValueAtTime(1, ac.currentTime + 0.06);
    v.src.start(0, Math.max(0, Math.min(pos, buf.duration - 0.01)));
    return v;
  }
  function tpKill(v, fade) {
    if (!v) return;
    var ac = TP.ac;
    if (fade) { v.gain.gain.setValueAtTime(v.gain.gain.value, ac.currentTime); v.gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.06); try { v.src.stop(ac.currentTime + 0.07); } catch (e) {} }
    else { try { v.src.stop(); } catch (e) {} try { v.gain.disconnect(); } catch (e) {} }
  }
  function tpHalt() { if (!TP) return; tpKill(TP.v); TP.v = null; TP.playing = false; }
  function tpPlay() {
    if (!TP) return; tpHalt();
    var pos = TP.media.currentTime; TP.t0 = TP.ac.currentTime - pos; TP.playing = true;
    if (TP.buf) TP.v = tpVoice(TP.buf, pos, false);
  }
  function tpLoad() {
    if (!TP) return;
    var tp = TP, req = ++tp.req;
    $('tuNote').textContent = 'LIVE · tuning…';
    fetch('/api/tune/audio/' + encodeURIComponent(S.cur) + '?' + tuneQuery())
      .then(function (r) { if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || (r.status === 404 ? 'Audio Studio needs a restart: close the black window and double-click Start Audio Studio.bat.' : 'Could not tune this.')); }); return r.arrayBuffer(); })
      .then(function (ab) { return tp.ac.decodeAudioData(ab); })
      .then(function (buf) {
        if (TP !== tp || req !== tp.req) return;
        tp.buf = buf;
        if (tp.playing && !tp.media.paused) { var old = tp.v; tp.v = tpVoice(buf, tp.ac.currentTime - tp.t0, true); tpKill(old, true); }
        if (!tp.bypass) $('tuNote').textContent = 'LIVE · change the key, strength or style while it plays.';
      })
      .catch(function (e) { if (TP === tp) { toast(e.message, true); stopTunePreview(); } });
  }
  function stopTunePreview() {
    if (!TP) return;
    var tp = TP; tpHalt(); clearInterval(tp.drift);
    tp.listeners.forEach(function (x) { tp.media.removeEventListener(x[0], x[1]); });
    try { tp.bus.disconnect(); } catch (e) {}
    tpMediaDirect(true); tp.media.muted = tp.prevMuted;
    TP = null;
    $('tuPreview').classList.remove('on'); $('tuPreview').textContent = '▶ Live preview';
    $('tuBypass').disabled = true; $('tuBypass').setAttribute('aria-pressed', 'false'); $('tuBypass').textContent = 'Hear original';
    if (TS.infos[S.cur]) $('tuNote').textContent = 'Ready. Press Live preview, then adjust while it plays.';
  }
  $('tuPreview').addEventListener('click', function () {
    if (TP) { stopTunePreview(); return; }
    if (!S.ws || !TS.infos[S.cur]) return;
    stopFxPreview(); stopLayerPreview();
    try {
      if (!fxAudioContext) fxAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      var ac = fxAudioContext, media = S.ws.getMediaElement();
      if (S.rate !== 1) { S.rate = 1; applyRate(); }
      var bus = ac.createGain(); bus.connect(ac.destination);
      TP = { ac: ac, media: media, bus: bus, buf: null, v: null, playing: false, t0: 0, req: 0, bypass: false, prevMuted: media.muted, listeners: [] };
      var on = function (ev, fn) { media.addEventListener(ev, fn); TP.listeners.push([ev, fn]); };
      on('play', tpPlay); on('pause', tpHalt); on('ended', tpHalt);
      on('seeked', function () { if (!media.paused) tpPlay(); });
      TP.drift = setInterval(function () { if (TP && TP.playing && TP.v && !media.paused && Math.abs(TP.ac.currentTime - TP.t0 - media.currentTime) > 0.15) tpPlay(); }, 400);
      tpMediaDirect(false); ac.resume();
      this.classList.add('on'); this.textContent = '■ Stop preview'; $('tuBypass').disabled = false;
      tpLoad();
      if (media.paused) S.ws.play(); else tpPlay();
    } catch (e) { stopTunePreview(); toast('Live preview could not start in this browser. Reload the page and try again.', true); }
  });
  $('tuBypass').addEventListener('click', function () {
    if (!TP) return;
    TP.bypass = !TP.bypass;
    TP.bus.gain.setTargetAtTime(TP.bypass ? 0 : 1, TP.ac.currentTime, 0.01);
    tpMediaDirect(TP.bypass);
    this.setAttribute('aria-pressed', TP.bypass ? 'true' : 'false'); this.textContent = TP.bypass ? 'Hear tuned' : 'Hear original';
    $('tuNote').textContent = TP.bypass ? 'ORIGINAL · your recording as it was.' : 'LIVE · change the key, strength or style while it plays.';
  });

  // ── vocal layers: live preview ──
  // The server makes each layer's pitch-shifted voice with the SAME ffmpeg chain as the final render
  // (/api/layer_stem, cached), so the preview is the real harmony, not an approximation. The browser then
  // mixes the layers in sync with the waveform player: level, pan, start offset, mute and solo use the same
  // maths as the render (dB → gain, equal-power pan, delay) and change instantly while it plays.
  var LP = null, lpTimer = null;
  function layerRows() {
    var rows = Array.from($('layerTracks').children).map(function (row) {
      var v = function (k) { return row.querySelector('[data-layer="' + k + '"]'); };
      var num = function (k, lo, hi, d) { var x = Number(v(k).value); return isFinite(x) && v(k).value !== '' ? Math.max(lo, Math.min(hi, x)) : d; };
      var voice = v('voice').value, src = (voice === 'backing' ? '' : v('source').value) || S.cur, shift = Math.round(num('shift', -12, 12, 0) * 100) / 100, seed = v('seed').value;
      var q = 'voice=' + voice + '&shift=' + shift + '&seed=' + seed + (isSmart(voice) ? '&' + tuneQuery() : '');
      return { row: row, src: src, shift: shift, voice: voice, q: q, key: src + '|' + q, db: num('db', -36, 6, -6), pan: voice === 'backing' ? 0 : num('pan', -1, 1, 0),
               delay: num('delay', 0, 5000, 0) / 1000, mute: v('mute').checked, solo: v('solo').checked };
    });
    var solo = rows.some(function (r) { return r.solo; });
    rows.forEach(function (r) { r.audible = !r.mute && (!solo || r.solo); });
    return rows;
  }
  function lpMediaDirect(on) {   // the selected file's own sound: off while the layers play, on for "Hear original"
    var media = LP.media, fxs = fxSources.get(media);
    media.muted = !on;
    if (fxs) { try { fxs.disconnect(); } catch (e) {} if (on) fxs.connect(LP.ac.destination); }
  }
  function lpParams(v, r) {
    var t = LP.ac.currentTime;
    v.gain.gain.setTargetAtTime(r.audible ? Math.pow(10, r.db / 20) : 0, t, 0.015);
    v.pan.pan.setTargetAtTime(r.pan, t, 0.015);
    v.delay.delayTime.setValueAtTime(r.delay, t);
    r.row.classList.toggle('silent', !r.audible);
  }
  function lpVoice(r, pos) {
    var buf = LP.bufs[r.key]; if (!(buf instanceof AudioBuffer) || pos >= buf.duration) return null;
    var ac = LP.ac, v = { row: r.row, key: r.key, src: ac.createBufferSource(), gain: ac.createGain(), pan: ac.createStereoPanner(), delay: ac.createDelay(5.1) };
    v.src.buffer = buf; v.src.connect(v.gain); v.gain.connect(v.pan); v.pan.connect(v.delay); v.delay.connect(LP.bus);
    v.gain.gain.value = 0; lpParams(v, r);
    v.src.start(0, Math.max(0, pos));
    return v;
  }
  function lpKill(v) { try { v.src.stop(); } catch (e) {} [v.src, v.gain, v.pan, v.delay].forEach(function (n) { try { n.disconnect(); } catch (e) {} }); }
  function lpHalt() { if (!LP) return; LP.voices.forEach(lpKill); LP.voices = []; LP.playing = false; }
  function lpPlay() {   // (re)start every layer at the player's position
    if (!LP) return; lpHalt();
    var pos = LP.media.currentTime; LP.t0 = LP.ac.currentTime - pos; LP.playing = true;
    layerRows().forEach(function (r) { var v = lpVoice(r, pos); if (v) LP.voices.push(v); });
  }
  function lpLoad(r) {
    LP.bufs[r.key] = 'loading';
    var lp = LP;
    fetch('/api/layer_stem/' + encodeURIComponent(r.src) + '?' + r.q)
      .then(function (res) { if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || (res.status === 404 ? 'Audio Studio needs a restart to use the layer preview: close the black window and double-click Start Audio Studio.bat.' : 'Could not prepare that layer.')); }); return res.arrayBuffer(); })
      .then(function (ab) { return lp.ac.decodeAudioData(ab); })
      .then(function (buf) { if (LP !== lp) return; lp.bufs[r.key] = buf; syncLayerPreview(); })
      .catch(function (e) { if (LP !== lp) return; delete lp.bufs[r.key]; toast(e.message, true); syncLayerPreview(); });
  }
  function syncLayerPreview() {
    if (!LP) return;
    var rows = layerRows(), waiting = [];
    rows.forEach(function (r) {
      var b = LP.bufs[r.key];
      if (!b) lpLoad(r);
      if (!(LP.bufs[r.key] instanceof AudioBuffer)) waiting.push(r);
      r.row.classList.toggle('loading', !(LP.bufs[r.key] instanceof AudioBuffer));
    });
    $('layersEmpty').hidden = rows.length > 0;
    if (!LP.bypass) $('lpNote').textContent = !rows.length ? 'LIVE · add or load layers to hear them.' :
      waiting.length ? 'LIVE · preparing ' + waiting.length + ' voice' + (waiting.length > 1 ? 's' : '') + '…' :
      'LIVE · change voices, levels, pan, offset, mute or solo while it plays.';
    if (!LP.playing) return;
    var pos = LP.ac.currentTime - LP.t0, keep = [];
    LP.voices.forEach(function (v) {
      var r = rows.filter(function (x) { return x.row === v.row; })[0];
      if (r && r.key === v.key) { lpParams(v, r); keep.push(v); } else lpKill(v);
    });
    rows.forEach(function (r) {
      if (keep.some(function (v) { return v.row === r.row; })) return;
      var v = lpVoice(r, pos); if (v) keep.push(v);
    });
    LP.voices = keep;
  }
  function scheduleLayerPreview() {
    $('layersEmpty').hidden = $('layerTracks').children.length > 0;
    if (!LP) return; clearTimeout(lpTimer); lpTimer = setTimeout(syncLayerPreview, 120);
  }
  function stopLayerPreview() {
    clearTimeout(lpTimer);
    if (!LP) return;
    var lp = LP;
    lpHalt(); clearInterval(lp.drift);
    lp.listeners.forEach(function (x) { lp.media.removeEventListener(x[0], x[1]); });
    try { lp.bus.disconnect(); lp.limiter.disconnect(); } catch (e) {}
    lpMediaDirect(true); lp.media.muted = lp.prevMuted;
    Array.from($('layerTracks').children).forEach(function (row) { row.classList.remove('loading', 'silent'); });
    LP = null;
    $('lpPreview').classList.remove('on'); $('lpPreview').textContent = '▶ Live preview';
    $('lpBypass').disabled = true; $('lpBypass').setAttribute('aria-pressed', 'false'); $('lpBypass').textContent = 'Hear original';
    $('lpNote').textContent = 'Live preview plays all layers together while you adjust them.';
  }
  $('lpPreview').addEventListener('click', function () {
    if (LP) { stopLayerPreview(); return; }
    var f = curFile(), btn = this;
    if (!f || !S.ws || !S.ws.getMediaElement) { toast('Select your recording first.', true); return; }
    if (!$('layerTracks').children.length) { toast('Choose an arrangement or add a layer first.', true); return; }
    var fid = S.cur, ready = !layerRows().some(function (r) { return (isSmart(r.voice) || r.voice === 'backing') && !TS.infos[r.src]; });
    if (ready) { startLayerPreview(btn); return; }
    // analysing takes a while: it runs in the background and the preview starts only when you press it again
    ensureLayerAnalyses().then(function () { if (S.cur === fid) notify({ title: 'Layers ready', text: 'Press Live preview to hear them.', action: { label: 'Live preview', fn: function () { if (S.cur === fid && !LP) $('lpPreview').click(); } } }); }, function (e) { toast(e.message, true); });
  });
  function startLayerPreview(btn) {
    stopFxPreview(); stopTunePreview();
    try {
      if (!fxAudioContext) fxAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      var ac = fxAudioContext, media = S.ws.getMediaElement();
      if (S.rate !== 1) { S.rate = 1; applyRate(); toast('Layer preview plays at normal speed.'); }
      var bus = ac.createGain(), lim = ac.createDynamicsCompressor();   // like the render's limiter
      lim.threshold.value = -0.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
      bus.connect(lim); lim.connect(ac.destination);
      LP = { ac: ac, media: media, bus: bus, limiter: lim, bufs: {}, voices: [], playing: false, t0: 0, bypass: false, prevMuted: media.muted, listeners: [] };
      var on = function (ev, fn) { media.addEventListener(ev, fn); LP.listeners.push([ev, fn]); };
      on('play', lpPlay); on('pause', lpHalt); on('ended', lpHalt);
      on('seeked', function () { if (!media.paused) lpPlay(); });
      LP.drift = setInterval(function () {   // keep the layers locked to the player
        if (LP && LP.playing && !media.paused && Math.abs(LP.ac.currentTime - LP.t0 - media.currentTime) > 0.15) lpPlay();   // seeks and loops re-sync at once via "seeked"
      }, 400);
      lpMediaDirect(false); ac.resume();
      btn.classList.add('on'); btn.textContent = '■ Stop preview'; $('lpBypass').disabled = false;
      syncLayerPreview();
      if (media.paused) S.ws.play(); else lpPlay();
    } catch (e) { stopLayerPreview(); toast('Live preview could not start in this browser. Reload the page and try again.', true); }
  }
  $('lpBypass').addEventListener('click', function () {
    if (!LP) return;
    LP.bypass = !LP.bypass;
    LP.bus.gain.setTargetAtTime(LP.bypass ? 0 : 1, LP.ac.currentTime, 0.01);
    lpMediaDirect(LP.bypass);
    this.setAttribute('aria-pressed', LP.bypass ? 'true' : 'false'); this.textContent = LP.bypass ? 'Hear layers' : 'Hear original';
    $('lpNote').textContent = LP.bypass ? 'ORIGINAL · the selected file on its own, for comparison.' : 'LIVE · change voices, levels, pan, offset, mute or solo while it plays.';
    if (!LP.bypass) syncLayerPreview();
  });
  // Arrangements load as soon as they are picked. Once you change a layer yourself the dropdown shows
  // "Custom", and only then does picking another arrangement ask before replacing your changes.
  var layersCustom = false, layersFrom = '';
  function markLayersCustom() {
    if (!$('layerTracks').children.length) return;
    layersCustom = true;
    var c = $('layerPreset').querySelector('option[value="custom"]'); c.hidden = false; $('layerPreset').value = 'custom';
    $('layerPresetHelp').textContent = 'Your own arrangement' + (layersFrom ? ' (started from ' + layersFrom + ')' : '') + '. Picking another arrangement replaces it.';
  }
  function applyArrangement(key) {
    var preset = layerArrangements[key]; if (!preset) return;
    var smart = preset.tracks.some(function (v) { return v[1] !== 'fixed'; });
    if (smart && !TS.infos[S.cur]) {   // in-key voices need the singing analysed first: do it now, then apply
      var fid = S.cur;
      ensureLayerAnalyses(true).then(function () { if (S.cur === fid && $('layerPreset').value === key) applyArrangement(key); }, function (e) { toast(e.message, true); $('layerPreset').value = ''; });
      return;
    }
    var together = TS.infos[S.cur] && TS.infos[S.cur].together;
    $('layerTracks').replaceChildren();
    preset.tracks.forEach(function (v) { if (v[1] !== 'backing' || together) addVocalLayer(v[0], v[1], v[2], v[3], v[4], v[5], v[6] == null ? 0 : v[6]); });
    layersCustom = false; layersFrom = preset.name;
    $('layerPreset').querySelector('option[value="custom"]').hidden = true; $('layerPreset').value = key;
    $('layerPresetHelp').textContent = preset.help;
    scheduleLayerPreview();
  }
  var layersPrev = '';
  $('layerPreset').addEventListener('focus', function () { layersPrev = this.value; });
  $('layerPreset').addEventListener('change', function () {
    var key = this.value;
    if (!layerArrangements[key]) return;
    if (layersCustom && !confirm('Replace your own layer changes with "' + layerArrangements[key].name + '"?')) { this.value = 'custom'; return; }
    applyArrangement(key); layersPrev = key;
  });
  $('layerTracks').addEventListener('input', function () { markLayersCustom(); scheduleLayerPreview(); });
  $('layerTracks').addEventListener('change', function () { markLayersCustom(); scheduleLayerPreview(); });
  $('layerAdd').onclick = function () { addVocalLayer('Harmony', 0, -9, 0); markLayersCustom(); scheduleLayerPreview(); };
  document.querySelector('.tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-t]'); if (!b) return;
    document.querySelectorAll('.tabs button').forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.getAttribute('data-p') !== b.getAttribute('data-t'); });
    if (b.getAttribute('data-t') === 'tune') drawTuneGraph();
    if (b.getAttribute('data-t') === 'fx') loadSuggestion();
  });

  // ── sliders show their values ──
  function outFor(inp) {
    var o = inp.parentNode.querySelector('output'); if (!o) return;
    var v = Number(inp.value), k = inp.getAttribute('data-fx') || inp.id;
    var unit = { noise: '', highpass: v ? ' Hz' : ' off', reverb: '%', reverb_tone: '%', predelay: ' ms', echo: '%', room: ' s', echo_ms: ' ms', speed: '×', pitch: ' st', comp: '', width: '', vSpeed: '×' }[k];
    if (/Db$|^vol$|vmOrig|vMdb/.test(k) || ['bass', 'mud', 'mid', 'presence', 'treble'].indexOf(k) >= 0) o.textContent = (v > 0 ? '+' : '') + v + ' dB';
    else if (k === 'highpass') o.textContent = v ? v + ' Hz' : 'off';
    else o.textContent = (k === 'pitch' && v > 0 ? '+' : '') + v + (unit || '');
  }
  document.querySelectorAll('input[type=range]').forEach(function (i) { if (i.id !== 'zoom') { outFor(i); i.addEventListener('input', function () { outFor(i); }); } });
  $('vol').addEventListener('input', function () { $('volO').textContent = (this.value > 0 ? '+' : '') + this.value + ' dB'; });

  // ── effects: presets fill the controls ──
  function fxReset() {
    document.querySelectorAll('[data-fx]').forEach(function (el) {
      if (el.type === 'checkbox') el.checked = false;
      else if (el.tagName === 'SELECT') el.value = '';
      else el.value = el.defaultValue;
      if (el.type === 'range') outFor(el);
    });
    scheduleFxPreview();
  }
  $('fxReset').addEventListener('click', function () { fxReset(); setFxChosen(null); });
  // ── sound gallery: Instagram cover sounds first, with a suggestion for the selected recording ──
  var fxChosen = null, fxChosenName = '', fxEdited = false, fxSuggestCache = {};
  function presetMeta(p) {
    var bits = [];
    if (p.reverb) bits.push('Reverb ' + p.reverb + '%'); else bits.push('No reverb');
    if (p.comp) bits.push('Compression ' + p.comp);
    if (p.echo) bits.push('Echo');
    if (p.noise || p.hum) bits.push('Noise & hum cleanup');
    return bits.join(' · ');
  }
  function renderSoundGrid() {
    var tile = function (k) {
      var p = S.presets[k];
      return '<button type="button" role="listitem" class="sound-tile" data-preset="' + k + '" aria-pressed="false">' +
        '<span class="st-name">' + esc(p.label) + '</span><span class="st-best">' + esc(p.best || '') + '</span>' +
        '<span class="st-meta">' + esc(presetMeta(p)) + '</span></button>';
    };
    var keys = Object.keys(S.presets);
    $('soundGrid').innerHTML = keys.filter(function (k) { return S.presets[k].group === 'cover'; }).map(tile).join('');
    $('soundGridOther').innerHTML = keys.filter(function (k) { return S.presets[k].group !== 'cover'; }).map(tile).join('');
    markSuggested();
  }
  function setFxChosen(key, name) {
    fxChosen = key; fxEdited = false; fxChosenName = name || (key && S.presets[key] ? S.presets[key].label : '');
    document.querySelectorAll('.sound-tile').forEach(function (t) { var on = t.getAttribute('data-preset') === key; t.classList.toggle('chosen', on); t.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    $('fxCurrent').textContent = fxChosenName || 'None chosen';
    $('fxCurrentNote').textContent = fxChosenName ? (key ? 'ready to apply' : 'your preset') : 'pick one below';
  }
  function markFxEdited() {   // you moved a slider after picking a sound
    if (!fxChosenName || fxEdited) return;
    fxEdited = true; $('fxCurrentNote').textContent = 'changed by you';
  }
  function applyPreset(key) {
    var p = S.presets[key]; if (!p) return;
    fxReset();
    Object.keys(p).forEach(function (k) {
      var el = document.querySelector('[data-fx="' + k + '"]'); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!p[k]; else el.value = p[k];
      if (el.type === 'range') outFor(el);
    });
    setFxChosen(key);
    $('coverHelp').textContent = p.label + ': ' + (p.best || '') + (S.fxPreview ? '' : ' Turn on Live preview to hear it.');
    $('myPreset').value = '';
    scheduleFxPreview();
  }
  ['soundGrid', 'soundGridOther'].forEach(function (id) {
    $(id).addEventListener('click', function (e) { var t = e.target.closest('[data-preset]'); if (t) applyPreset(t.getAttribute('data-preset')); });
  });
  function markSuggested() {
    var sg = S.cur && fxSuggestCache[S.cur];
    document.querySelectorAll('.sound-tile').forEach(function (t) {
      var on = !!sg && t.getAttribute('data-preset') === sg.key;
      t.classList.toggle('suggested', on);
      var badge = t.querySelector('.st-badge');
      if (on && !badge) t.insertAdjacentHTML('afterbegin', '<span class="st-badge">Suggested</span>');
      if (!on && badge) badge.remove();
    });
    $('fxSuggest').hidden = !sg;
    if (sg && S.presets[sg.key]) $('fxSuggest').innerHTML = '<b>Suggested for this recording: ' + esc(S.presets[sg.key].label) + '.</b> ' + esc(sg.reason) + ' <span>This is based on how your recording sounds; trust your ears too.</span>';
  }
  function loadSuggestion() {
    var f = curFile();
    if (!f || !(f.kind === 'audio' || (f.kind === 'video' && f.has_audio))) { markSuggested(); return; }
    if (fxSuggestCache[f.id]) { markSuggested(); return; }
    api('/api/fx_suggest/' + f.id).then(function (j) { fxSuggestCache[f.id] = j; if (S.cur === f.id) markSuggested(); }).catch(function () {});
  }
  function fxValues() {
    var o = {};
    document.querySelectorAll('[data-fx]').forEach(function (el) { o[el.getAttribute('data-fx')] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; });
    return o;
  }
  var personalSounds = {};
  try { var savedSounds = JSON.parse(localStorage.getItem('audioStudio.personalSounds') || '{}'); if (savedSounds && typeof savedSounds === 'object' && !Array.isArray(savedSounds)) personalSounds = savedSounds; } catch (e) {}
  function listPersonalSounds() {
    $('myPreset').replaceChildren(new Option('Choose one of your presets…', ''));
    Object.keys(personalSounds).sort().forEach(function (name) { $('myPreset').add(new Option(name, name)); });
  }
  function persistSounds(next) {
    try { localStorage.setItem('audioStudio.personalSounds', JSON.stringify(next)); personalSounds = next; listPersonalSounds(); return true; }
    catch (e) { toast('This browser could not save your presets. Check available browser storage.', true); return false; }
  }
  listPersonalSounds();
  $('saveMyPreset').addEventListener('click', function () {
    var name = prompt('Name your preset (for example: My cover sound). It saves only the slider settings, not audio.', fxChosenName ? fxChosenName + (fxEdited ? ' (mine)' : '') : '');
    if (!name || !name.trim()) return; name = name.trim().slice(0, 80);
    if (Object.prototype.hasOwnProperty.call(personalSounds, name) && !confirm('Replace your preset “' + name + '”?')) return;
    var next = Object.assign(Object.create(null), personalSounds); next[name] = fxValues();
    if (persistSounds(next)) { $('myPreset').value = name; setFxChosen(null, name); toast('Preset “' + name + '” saved. Pick it from My presets any time.'); }
  });
  $('myPreset').addEventListener('change', function () {
    var settings = personalSounds[this.value]; if (!settings || typeof settings !== 'object') return;
    fxReset();
    document.querySelectorAll('[data-fx]').forEach(function (el) {
      var value = settings[el.getAttribute('data-fx')]; if (value == null) return;
      if (el.type === 'checkbox') el.checked = !!Number(value); else el.value = value;
      if (el.type === 'range') outFor(el);
    });
    setFxChosen(null, this.value);
    $('coverHelp').textContent = 'Your preset: ' + this.value + '.';
    scheduleFxPreview();
  });
  $('deleteMyPreset').addEventListener('click', function () {
    var name = $('myPreset').value; if (!name) { toast('Choose one of your presets first.', true); return; }
    if (!confirm('Delete your preset “' + name + '”?')) return;
    var next = Object.assign(Object.create(null), personalSounds); delete next[name]; persistSounds(next);
  });
  $('fxBypass').addEventListener('click', function () {
    var q = S.fxPreview; if (!q) return;
    if (!q.bypassed) {
      q.source.disconnect(); q.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
      q.source.connect(q.ac.destination); q.bypassed = true;
      this.textContent = 'Hear effects'; this.setAttribute('aria-pressed', 'true');
      $('fxPreviewNote').textContent = 'ORIGINAL — preview effects bypassed for comparison.';
    } else {
      q.bypassed = false; buildFxPreview(); this.textContent = 'Hear original'; this.setAttribute('aria-pressed', 'false');
      $('fxPreviewNote').textContent = 'LIVE — controls and presets update the sound instantly.';
    }
  });

  // ── live effects preview (Web Audio; the saved copy is still rendered by the high-quality server chain) ──
  function fxNumber(p, key, fallback) {
    var n = Number(p[key]); return Number.isFinite(n) ? n : fallback;
  }
  function makePreviewImpulse(ac, room, predelay, brightness) {
    var sr = ac.sampleRate, pre = Math.round(sr * predelay / 1000), tail = Math.max(1, Math.round(sr * room));
    var buf = ac.createBuffer(2, pre + tail, sr), seed = 7, peak = 0;
    function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 2147483648) - 1; }
    var cutoff = 2800 + brightness / 100 * 8200, a = 1 - Math.exp(-2 * Math.PI * Math.min(cutoff, sr * .46) / sr);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch), lp = 0;
      for (var i = 0; i < tail; i++) {
        lp += a * (rnd() - lp);
        var t = i / sr, env = Math.exp(-6.9 * t / room), fade = Math.min(1, t / .018);
        var v = lp * env * fade * .16; data[pre + i] = v; peak = Math.max(peak, Math.abs(v));
      }
    }
    [[13,.38,.20],[23,.18,.34],[37,.25,.15],[53,.12,.22],[79,.12,.08]].forEach(function (r) {
      var k = pre + Math.round(sr * r[0] / 1000); if (k >= buf.length) return;
      var l = buf.getChannelData(0), rr = buf.getChannelData(1); l[k] += r[1]; rr[Math.min(buf.length - 1, k + 31)] += r[2];
      peak = Math.max(peak, Math.abs(l[k]), Math.abs(rr[Math.min(buf.length - 1, k + 31)]));
    });
    // unit energy, exactly like the saved render (app/ops.py _impulse), so preview and saved file match
    var energy = 0;
    for (var e = 0; e < 2; e++) { var de = buf.getChannelData(e); for (var q = 0; q < de.length; q++) energy += de[q] * de[q]; }
    var norm = energy > 0 ? 1 / Math.sqrt(energy / 2) : 0;
    for (var c = 0; c < 2; c++) { var d = buf.getChannelData(c); for (var j = 0; j < d.length; j++) d[j] *= norm; }
    return buf;
  }
  function stopFxPreview() {
    clearTimeout(fxRebuildTimer); fxRebuildTimer = null;
    var q = S.fxPreview; if (!q) return;
    q.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
    $('fxBypass').disabled = true; $('fxBypass').setAttribute('aria-pressed', 'false'); $('fxBypass').textContent = 'Hear original';
    try { q.source.disconnect(); q.source.connect(q.ac.destination); } catch (e) {}
    S.fxPreview = null;
    $('fxPreview').classList.remove('on'); $('fxPreview').textContent = '▶ Live preview';
    $('fxPreviewNote').textContent = 'Preview changes instantly. Your original recording is always kept.';
  }
  function buildFxPreview() {
    var old = S.fxPreview, media = S.ws && S.ws.getMediaElement ? S.ws.getMediaElement() : null;
    if (!old || !media) return;
    if (old.bypassed) return;
    old.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
    var ac = old.ac, source = old.source, p = fxValues(), last = source, made = [];
    try { source.disconnect(); } catch (e) {}
    function biquad(type, frequency, gain, q) {
      var n = ac.createBiquadFilter(); n.type = type; n.frequency.value = frequency;
      if (gain != null) n.gain.value = gain; if (q != null) n.Q.value = q;
      last.connect(n); last = n; made.push(n);
    }
    var hp = fxNumber(p, 'highpass', 0); if (hp >= 20) biquad('highpass', hp, null, .71);
    if (Number(p.hum)) { biquad('notch', 50, null, 30); biquad('notch', 100, null, 30); biquad('notch', 150, null, 30); }
    var bass = fxNumber(p, 'bass', 0); if (bass) biquad('lowshelf', 110, bass, null);
    var mud = fxNumber(p, 'mud', 0); if (mud) biquad('peaking', 280, mud, 1.1);
    var mid = fxNumber(p, 'mid', 0); if (mid) biquad('peaking', 1000, mid, 1.2);
    var presence = fxNumber(p, 'presence', 0); if (presence) biquad('peaking', 3200, presence, 1);
    var treble = fxNumber(p, 'treble', 0); if (treble) biquad('highshelf', 8000, treble, null);
    if (Number(p.lofi)) { biquad('highpass', 180, null, .71); biquad('lowpass', 3800, null, .71); }
    if (Number(p.radio)) { biquad('highpass', 320, null, .71); biquad('lowpass', 3200, null, .71); }
    var comp = fxNumber(p, 'comp', 0);
    if (comp > 0) {
      var dc = ac.createDynamicsCompressor(); dc.threshold.value = -14 - 2 * comp; dc.ratio.value = 1.5 + comp;
      dc.knee.value = 2.83; dc.attack.value = .012; dc.release.value = .18; last.connect(dc); last = dc; made.push(dc);
      var makeup = ac.createGain(); makeup.gain.value = 1 + comp * 0.6;   // same make-up as the saved file (ops.effects) last.connect(makeup); last = makeup; made.push(makeup);
    }
    var sum = ac.createGain(), rv = Math.max(0, Math.min(100, fxNumber(p, 'reverb', 0))) / 100;
    var dry = ac.createGain(); dry.gain.value = 1 - rv * .6; last.connect(dry); dry.connect(sum); made.push(dry, sum);
    if (rv > 0) {
      var conv = ac.createConvolver(); conv.normalize = false;
      conv.buffer = makePreviewImpulse(ac, Math.max(.3, fxNumber(p, 'room', 1.5)), Math.max(0, fxNumber(p, 'predelay', 20)), Math.max(0, fxNumber(p, 'reverb_tone', 55)));
      var wet = ac.createGain(); wet.gain.value = rv; last.connect(conv); conv.connect(wet); wet.connect(sum); made.push(conv, wet);
    }
    var echo = Math.max(0, Math.min(100, fxNumber(p, 'echo', 0))) / 100;
    if (echo > 0) {
      var delay = ac.createDelay(1.6), feedback = ac.createGain(), eg = ac.createGain();
      delay.delayTime.value = Math.min(1.5, Math.max(.06, fxNumber(p, 'echo_ms', 350) / 1000)); feedback.gain.value = echo * .42; eg.gain.value = echo * .45;
      last.connect(delay); delay.connect(feedback); feedback.connect(delay); delay.connect(eg); eg.connect(sum); made.push(delay, feedback, eg);
    }
    var width = Math.max(0, Math.min(3, fxNumber(p, 'width', 0)));
    if (width > 0) {
      var split = ac.createChannelSplitter(2), merge = ac.createChannelMerger(2), w = 1 + width / 2, aa = (1 + w) / 2, bb = (1 - w) / 2;
      var ll = ac.createGain(), rl = ac.createGain(), lr = ac.createGain(), rr = ac.createGain(); ll.gain.value = rr.gain.value = aa; rl.gain.value = lr.gain.value = bb;
      sum.connect(split); split.connect(ll,0); split.connect(lr,0); split.connect(rl,1); split.connect(rr,1); ll.connect(merge,0,0); rl.connect(merge,0,0); lr.connect(merge,0,1); rr.connect(merge,0,1);
      last = merge; made.push(split, merge, ll, rl, lr, rr);
    } else last = sum;
    var limiter = ac.createDynamicsCompressor(); limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .1;
    last.connect(limiter); limiter.connect(ac.destination); made.push(limiter);
    S.fxPreview = { ac: ac, source: source, nodes: made };
  }
  function scheduleFxPreview() {
    if (!S.fxPreview) return; clearTimeout(fxRebuildTimer);
    fxRebuildTimer = setTimeout(buildFxPreview, 120);
  }
  $('fxPreview').addEventListener('click', function () {
    if (S.fxPreview) { stopFxPreview(); return; }
    stopLayerPreview(); stopTunePreview();
    if (!S.ws || !S.ws.getMediaElement) { toast('Select an audio file or a video with sound first.', true); return; }
    var media = S.ws.getMediaElement();
    try {
      if (!fxAudioContext) fxAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      var source = fxSources.get(media); if (!source) { source = fxAudioContext.createMediaElementSource(media); fxSources.set(media, source); }
      S.fxPreview = { ac: fxAudioContext, source: source, nodes: [] }; buildFxPreview(); fxAudioContext.resume();
      this.classList.add('on'); this.textContent = '■ Stop preview';
      $('fxBypass').disabled = false;
      $('fxPreviewNote').textContent = 'LIVE — controls and presets update the sound instantly.';
      if (!S.ws.isPlaying()) S.ws.play();
    } catch (e) { stopFxPreview(); toast('Live preview could not start in this browser. Reload the page and try again.', true); }
  });
  document.querySelectorAll('[data-fx]').forEach(function (el) { el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', function () { markFxEdited(); scheduleFxPreview(); }); });

  // ── run a tool ──
  var MSG = { effects: 'Applying effects…', effects_video: 'Polishing the sound and rebuilding your video…', beat_reel: 'Finding the beats and cutting your clips… (this can take a minute)', video_music: 'Mixing music into the video…',
              voice: 'Making the voiceover…', tune: 'Saving your tuned version…', vocal_layers: 'Mixing your vocal layers…', practice: 'Making your practice copy…', analyse: 'Listening for tempo and key…', best: 'Finding the best part…', export: 'Saving…' };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-do]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-do'), f = curFile();
    if (a === 'effects' && f && f.kind === 'video') a = 'effects_video';
    if (!f && !b.hasAttribute('data-any') && a !== 'join' && a !== 'beat_reel') { toast('Select a file in the library first.', true); return; }
    var body = { id: f ? f.id : null };
    if (a === 'tune') {
      if (!TS.infos[f.id]) { toast('Analyse your singing first.', true); return; }
      Object.assign(body, tuneParams()); stopTunePreview();
    }
    if (a === 'vocal_layers') {
      if (!f || !S.ws) { toast('Select your recording first.', true); return; }
      body.tune = tuneParams();
      var tracks = Array.from($('layerTracks').children).map(function (row) { var t = {}; row.querySelectorAll('[data-layer]').forEach(function (el) { t[el.dataset.layer] = el.type === 'checkbox' ? el.checked : el.value; }); return t; });
      var solo = tracks.some(function (t) { return t.solo; });
      body.layers = tracks.filter(function (t) { return !t.mute && (!solo || t.solo); });
      if (!body.layers.length) { toast('Add at least one audible layer.', true); return; }
      stopFxPreview(); stopLayerPreview();
      ensureLayerAnalyses().then(function () { runTool(a, body); }, function (e) { toast(e.message, true); });
      return;
    }
    if (a === 'trim' || a === 'cut') {
      var s = parseFloat($('selS').value), en = parseFloat($('selE').value);
      if (S.ws && !selected()) { toast('Drag the amber handles inwards (or drag across the waveform) to choose a part first.', true); return; }
      if (!(en > s)) { toast('Type the From and To times first.', true); return; }
      body.start = s; body.end = en;
    }
    if (a === 'fade') { body.fade_in = $('fadeIn').value; body.fade_out = $('fadeOut').value; }
    if (a === 'volume') body.db = $('vol').value;
    if (a === 'loop') body.times = $('loopN').value;
    if (a === 'join') { body.ids = S.ticks.filter(function (id) { return byId(id).kind === 'audio'; }); body.crossfade = $('xf').value; }
    if (a === 'export') { body.format = $('fmt').value; body.quality = $('qual').value; }
    if (a === 'effects' || a === 'effects_video') { body.fx = fxValues(); stopFxPreview(); }
    if (a === 'best') body.length = $('bestLen').value;
    if (a === 'practice') { body.rate = S.rate; var ps = selected(); if (ps) { body.start = ps.start; body.end = ps.end; } }
    if (a === 'video_music') {
      body.music = $('vmMusic').value; body.music_from = $('vmFrom').value; body.music_db = $('vmDb').value; body.keep_original = $('vmKeep').checked;
      body.duck = $('vmDuck').checked; body.original_db = $('vmOrig').value; body.fade_out = $('vmFade').value;
      if (!body.music) { toast('Add a song to the library first.', true); return; }
    }
    if (a === 'beat_reel') {
      body.clips = S.ticks.filter(function (id) { return byId(id).kind !== 'audio'; }); body.music = $('brMusic').value; body.music_from = $('brFrom').value;
      body.aspect = $('brAspect').value; body.length = $('brLen').value; body.beats_per_cut = $('brPer').value;
      if (!body.clips.length) { toast('Tick some videos or photos in the library first.', true); return; }
      if (!body.music) { toast('Add a song to the library first.', true); return; }
    }
    if (a === 'voice') { body.text = $('vText').value; body.voice = $('vVoice').value; body.speed = $('vSpeed').value; body.music = $('vMusic').value; body.music_db = $('vMdb').value; body.music_from = $('vFrom').value; }
    runTool(a, body);
  });

  function runTool(a, body) {
    var fid = body.id;
    startJob('/api/do/' + a, body, function (r) {
      if (r.sound_check && S.cur === fid) showSoundCheck(r.sound_check);
      if (r.analysis && S.cur === fid) showStats(r.analysis);
    }).then(function () {
      if (!$('jobsTray').hidden) return;
      toast((MSG[a] || 'Working…').replace('…', '') + ' in the background. See Jobs.');
    }, function (x) { toast(x.message, true); });
  }
  function showSoundCheck(report) {
    $('soundCheckResults').innerHTML = '<p>Checked first ' + esc(report.seconds) + ' s · Sample peak: ' + esc(report.peak_db) + ' dBFS · Average RMS: ' + esc(report.rms_db) + ' dBFS (not LUFS) · Near-full-scale samples: ' + esc(report.near_full_scale_percent) + '%</p><ul>' + report.tips.map(function (tip) { return '<li>' + esc(tip) + '</li>'; }).join('') + '</ul>';
  }

  function showStats(a) {
    var lufs = a.lufs, adv = lufs == null ? '' : (lufs < -18 ? 'quiet for Instagram/YouTube: try Loudness -14 in Effects' : (lufs > -11 ? 'very loud: may be turned down by apps' : 'good level for Instagram/YouTube'));
    var items = [['Tempo', a.bpm + ' BPM'], ['Key (estimate)', a.key], ['Loudness', lufs == null ? '–' : lufs.toFixed(1) + ' LUFS'], ['Peak', a.peak_db == null ? '–' : a.peak_db.toFixed(1) + ' dB'], ['Length', fmt(a.duration)], ['Beats found', a.beats]];
    $('stats').innerHTML = items.map(function (x) { return '<div class="stat"><b>' + esc(x[1]) + '</b><span>' + esc(x[0]) + '</span></div>'; }).join('') +
      (adv ? '<p class="note" style="grid-column:1/-1">Loudness: ' + esc(adv) + '. Key is a computer estimate from the notes it hears; check it on your guitar.</p>' : '');
  }

  // ── guitar tuner (all in the browser: mic → pitch detection, nothing is sent anywhere) ──
  var NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  var T = null;
  function midiOf(n) { var m = /^([A-G])(#?)(-?\d)$/.exec(n); return 'C D EF G A B'.indexOf(m[1]) + (m[2] ? 1 : 0) + (Number(m[3]) + 1) * 12; }
  function tuning() { return $('tnTuning').value.split(' ').map(midiOf); }
  function refA() { var r = Number($('tnRef').value); return r >= 415 && r <= 466 ? r : 440; }
  function freqOf(midi) { return refA() * Math.pow(2, (midi - 69) / 12); }
  function drawStrings() {
    $('tnStrings').innerHTML = tuning().map(function (m, i) { return '<span title="String ' + (6 - i) + '">' + NAMES[m % 12] + '</span>'; }).join('');
  }
  // YIN pitch detection: finds the repeat length (period) of the wave; reliable for low guitar strings.
  function yin(buf, sr, d, raw) {
    var W = buf.length >> 1, rms = 0, i, tau;
    for (i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / buf.length) < 0.008) return -1;   // too quiet
    var tMin = Math.floor(sr / 1100), tMax = Math.min(W - 2, Math.floor(sr / 60));
    for (tau = 1; tau <= tMax; tau++) {
      var s = 0; for (i = 0; i < W; i++) { var x = buf[i] - buf[i + tau]; s += x * x; } raw[tau] = s;
    }
    d[0] = 1; var run = 0;
    for (tau = 1; tau <= tMax; tau++) { run += raw[tau]; d[tau] = run ? raw[tau] * tau / run : 1; }
    for (tau = tMin; tau < tMax; tau++) {
      if (d[tau] < 0.12) {
        while (tau + 1 < tMax && d[tau + 1] < d[tau]) tau++;
        var a = raw[tau - 1], b = raw[tau], c = raw[tau + 1], den = 2 * (a - 2 * b + c);   // fine-tune on the raw curve
        return sr / (tau + (den ? (a - c) / den : 0));
      }
    }
    return -1;
  }
  function tunerShow(f) {
    var needle = $('tnNeedle'), noteEl = $('tnNote').parentNode;
    if (f < 0) { needle.style.left = '50%'; needle.className = 'tn-needle'; noteEl.className = 'tn-note'; document.querySelectorAll('#tnStrings span').forEach(function (s) { s.className = ''; }); return; }
    var n = 12 * Math.log2(f / refA()) + 69, r = Math.round(n), cents = (n - r) * 100;
    $('tnNote').textContent = NAMES[((r % 12) + 12) % 12]; $('tnOct').textContent = Math.floor(r / 12) - 1;
    var ok = Math.abs(cents) <= 5;
    needle.style.left = (50 + Math.max(-50, Math.min(50, cents))) + '%';
    needle.className = 'tn-needle ' + (ok ? 'ok' : 'off'); noteEl.className = 'tn-note' + (ok ? ' ok' : '');
    // advice for the nearest string of the chosen tuning
    var strs = tuning(), best = strs[0];
    strs.forEach(function (m) { if (Math.abs(n - m) < Math.abs(n - best)) best = m; });
    var idx = strs.indexOf(best), diff = 1200 * Math.log2(f / freqOf(best)), ad = Math.abs(diff);
    var msg = ad <= 5 ? 'in tune ✓' : (diff < 0 ? 'too low → tighten' : 'too high → loosen') + ' (' + (ad >= 100 ? (ad / 100).toFixed(1) + ' semitones' : Math.round(ad) + ' cents') + ')';
    $('tnRead').textContent = f.toFixed(1) + ' Hz · string ' + (6 - idx) + ' (' + NAMES[best % 12] + '): ' + msg;
    document.querySelectorAll('#tnStrings span').forEach(function (s, i) { s.className = i === idx ? (ad <= 5 ? 'ok' : 'on') : ''; });
  }
  function tunerOpen() {
    if (T) return;
    $('tuner').hidden = false; drawStrings(); $('tnRead').textContent = 'Allow the microphone, then play one string…';
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (stream) {
      if ($('tuner').hidden) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 4096;
      var hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 55;
      ac.createMediaStreamSource(stream).connect(hp); hp.connect(an);
      T = { stream: stream, ac: ac, buf: new Float32Array(an.fftSize), d: new Float32Array(an.fftSize), raw: new Float32Array(an.fftSize), hist: [], last: 0 };
      $('tnRead').textContent = 'Play one string…';
      (function loop() {
        an.getFloatTimeDomainData(T.buf);
        var f = yin(T.buf, ac.sampleRate, T.d, T.raw), now = performance.now();
        if (f > 0) {
          var h = T.hist;
          if (h.length && Math.abs(12 * Math.log2(f / h[h.length - 1])) > 0.7) h.length = 0;   // a new note: start fresh
          h.push(f); if (h.length > 7) h.shift();
          var m = h.slice().sort(function (a, b) { return a - b; })[h.length >> 1];
          T.last = now; tunerShow(m);
        } else if (T.last && now - T.last > 1500) { T.last = 0; T.hist.length = 0; tunerShow(-1); $('tnRead').textContent = 'Play one string…'; }
        T.raf = requestAnimationFrame(loop);
      })();
    }).catch(function () { $('tnRead').textContent = 'Could not use the microphone. Allow it in Chrome (the icon in the address bar).'; });
  }
  function tunerClose() {
    $('tuner').hidden = true;
    if (!T) return;
    cancelAnimationFrame(T.raf); T.stream.getTracks().forEach(function (t) { t.stop(); }); T.ac.close(); T = null;
    $('tnNote').textContent = '–'; $('tnOct').textContent = ''; tunerShow(-1);
  }
  $('tunerBtn').addEventListener('click', tunerOpen);
  $('tunerClose').addEventListener('click', tunerClose);
  $('tuner').addEventListener('click', function (e) { if (e.target === this) tunerClose(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('tuner').hidden) tunerClose(); });
  $('tnTuning').addEventListener('change', drawStrings);

  applyRate();
  load();
  pollJobs();
})();
