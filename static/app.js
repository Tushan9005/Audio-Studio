/* Audio Studio front end: library, waveform player with selection, and the tool panels. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = { files: [], cur: null, ticks: [], filter: 'all', ws: null, regions: null, region: null, presets: {}, voices: {} };

  // ── helpers ──
  function fmt(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, err ? 9000 : 4000);
  }
  function busy(on, msg) { $('busy').hidden = !on; $('busyMsg').textContent = msg || 'Working…'; }
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

  // ── library ──
  function load(selectId) {
    return api('/api/files').then(function (j) {
      S.files = j.files; S.presets = j.preset_values; S.voices = j.voices;
      S.ticks = S.ticks.filter(byId);
      if (!$('vVoice').options.length) {
        Object.keys(j.voices).forEach(function (k) { $('vVoice').add(new Option(j.voices[k], k)); });
        Object.keys(j.presets).forEach(function (k) { $('preset').add(new Option(j.presets[k], k)); });
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
    $('files').innerHTML = html || '<li style="cursor:default;color:var(--mute)">Nothing here yet.</li>';
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
    var fd = new FormData();
    Array.prototype.forEach.call(list, function (f) { fd.append('files', f, f.name); });
    busy(true, 'Adding ' + list.length + ' file' + (list.length > 1 ? 's' : '') + '…');
    api('/api/upload', { method: 'POST', body: fd }).then(function (j) {
      toast('Added ' + j.files.length + ' file' + (j.files.length > 1 ? 's' : '') + '.');
      return load(j.files[0] && j.files[0].id);
    }).catch(function (x) { toast(x.message, true); }).finally(function () { busy(false); $('up').value = ''; });
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
        busy(true, 'Saving your recording…');
        api('/api/record?name=' + encodeURIComponent(name), { method: 'POST', body: fd })
          .then(function (j) { toast('Recording saved.'); return load(j.file.id); })
          .catch(function (x) { toast(x.message, true); }).finally(function () { busy(false); });
      };
      (function meter() {
        an.getFloatTimeDomainData(buf); var pk = 0; for (var i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
        cv.clearRect(0, 0, 120, 22); cv.fillStyle = pk > 0.95 ? '#ef4444' : (pk > 0.7 ? '#f59e0b' : '#22c55e'); cv.fillRect(0, 6, 120 * Math.min(1, pk), 10);
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
      var opts = { container: '#wave', height: 128, waveColor: '#4b5563', progressColor: '#f59e0b', cursorColor: '#fbbf24', barWidth: 2, barGap: 1, barRadius: 2, normalize: true };
      if (f.kind === 'video') { vid.src = '/media/' + id; opts.media = vid; } else { opts.url = '/media/' + id; }
      if (f.kind === 'audio' || f.has_audio) {
        S.ws = WaveSurfer.create(opts);
        S.regions = S.ws.registerPlugin(WaveSurfer.Regions.create());
        S.regions.enableDragSelection({ color: 'rgba(245,158,11,.22)' });
        S.regions.on('region-created', function (r) { S.regions.getRegions().forEach(function (o) { if (o !== r) o.remove(); }); S.region = r; showSel(); });
        S.regions.on('region-updated', function () { showSel(); });
        S.ws.on('timeupdate', function (t) { $('time').textContent = fmt(t) + ' / ' + fmt(S.ws.getDuration()); });
        S.ws.on('ready', function () { $('time').textContent = '0:00.0 / ' + fmt(S.ws.getDuration()); applyZoom(); });
        S.ws.on('play', function () { $('play').textContent = '❚❚'; });
        S.ws.on('pause', function () { $('play').textContent = '▶'; });
        S.ws.on('finish', function () { $('play').textContent = '▶'; });
      }
    }
    S.region = null; showSel();
    // tools that don't fit this file are greyed out
    document.querySelectorAll('[data-audio]').forEach(function (el) { el.disabled = f.kind !== 'audio'; el.classList.toggle('disabled-card', el.tagName !== 'BUTTON' && f.kind !== 'audio'); });
    document.querySelectorAll('[data-video-only]').forEach(function (el) { el.disabled = f.kind !== 'video'; });
    document.querySelectorAll('[data-needs-video]').forEach(function (el) { el.hidden = f.kind === 'video'; });
    document.querySelector('[data-do="video_music"]').disabled = f.kind !== 'video';
    document.querySelector('[data-do="effects"]').disabled = f.kind !== 'audio';
  }
  function showSel() {
    var r = S.region;
    if (r) { $('selInfo').textContent = 'Selected ' + fmt(r.start) + ' – ' + fmt(r.end) + ' (' + (r.end - r.start).toFixed(1) + ' s) · Play plays the selection'; $('selS').value = r.start.toFixed(2); $('selE').value = r.end.toFixed(2); }
    else { $('selInfo').textContent = 'Drag on the waveform to select a part'; $('selS').value = ''; $('selE').value = ''; }
  }
  function setSelFromInputs() {
    if (!S.regions) return;
    var s = parseFloat($('selS').value), e = parseFloat($('selE').value);
    if (!(e > s)) return;
    S.regions.clearRegions();
    S.region = S.regions.addRegion({ start: s, end: e, color: 'rgba(245,158,11,.22)' });
    showSel();
  }
  $('selS').addEventListener('change', setSelFromInputs); $('selE').addEventListener('change', setSelFromInputs);
  $('play').addEventListener('click', function () {
    if (!S.ws) { var v = $('vid'); if (!v.hidden) (v.paused ? v.play() : v.pause()); return; }
    if (S.ws.isPlaying()) S.ws.pause(); else if (S.region) S.region.play(); else S.ws.play();
  });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !e.target.closest('input, textarea, select, button')) { e.preventDefault(); $('play').click(); }
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
  document.querySelector('.tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-t]'); if (!b) return;
    document.querySelectorAll('.tabs button').forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.getAttribute('data-p') !== b.getAttribute('data-t'); });
  });

  // ── sliders show their values ──
  function outFor(inp) {
    var o = inp.parentNode.querySelector('output'); if (!o) return;
    var v = Number(inp.value), k = inp.getAttribute('data-fx') || inp.id;
    var unit = { noise: '', highpass: v ? ' Hz' : ' off', reverb: '%', echo: '%', room: ' s', echo_ms: ' ms', speed: '×', pitch: ' st', comp: '', width: '', vSpeed: '×' }[k];
    if (/Db$|^vol$|vmOrig|vMdb/.test(k) || ['bass', 'mid', 'presence', 'treble'].indexOf(k) >= 0) o.textContent = (v > 0 ? '+' : '') + v + ' dB';
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
  }
  $('fxReset').addEventListener('click', function () { fxReset(); $('preset').value = ''; });
  $('preset').addEventListener('change', function () {
    var p = S.presets[this.value]; if (!p) return;
    fxReset();
    Object.keys(p).forEach(function (k) {
      var el = document.querySelector('[data-fx="' + k + '"]'); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!p[k]; else el.value = p[k];
      if (el.type === 'range') outFor(el);
    });
  });
  function fxValues() {
    var o = {};
    document.querySelectorAll('[data-fx]').forEach(function (el) { o[el.getAttribute('data-fx')] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; });
    return o;
  }

  // ── run a tool ──
  var MSG = { effects: 'Applying effects…', beat_reel: 'Finding the beats and cutting your clips… (this can take a minute)', video_music: 'Mixing music into the video…',
              voice: 'Making the voiceover…', analyse: 'Listening for tempo and key…', best: 'Finding the best part…', export: 'Saving…' };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-do]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-do'), f = curFile();
    if (!f && !b.hasAttribute('data-any') && a !== 'join' && a !== 'beat_reel') { toast('Select a file in the library first.', true); return; }
    var body = { id: f ? f.id : null };
    if (a === 'trim' || a === 'cut') {
      var s = parseFloat($('selS').value), en = parseFloat($('selE').value);
      if (!(en > s)) { toast('Drag on the waveform (or type From/To) to select a part first.', true); return; }
      body.start = s; body.end = en;
    }
    if (a === 'fade') { body.fade_in = $('fadeIn').value; body.fade_out = $('fadeOut').value; }
    if (a === 'volume') body.db = $('vol').value;
    if (a === 'loop') body.times = $('loopN').value;
    if (a === 'join') { body.ids = S.ticks.filter(function (id) { return byId(id).kind === 'audio'; }); body.crossfade = $('xf').value; }
    if (a === 'export') { body.format = $('fmt').value; body.quality = $('qual').value; }
    if (a === 'effects') body.fx = fxValues();
    if (a === 'best') body.length = $('bestLen').value;
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
    busy(true, MSG[a]);
    post('/api/do/' + a, body).then(function (j) {
      if (j.analysis) { showStats(j.analysis); return; }
      toast('Done: "' + j.file.name + '" added to the library.');
      return load(j.file.id);
    }).catch(function (x) { toast(x.message, true); }).finally(function () { busy(false); });
  });

  function showStats(a) {
    var lufs = a.lufs, adv = lufs == null ? '' : (lufs < -18 ? 'quiet for Instagram/YouTube: try Loudness -14 in Effects' : (lufs > -11 ? 'very loud: may be turned down by apps' : 'good level for Instagram/YouTube'));
    var items = [['Tempo', a.bpm + ' BPM'], ['Key (estimate)', a.key], ['Loudness', lufs == null ? '–' : lufs.toFixed(1) + ' LUFS'], ['Peak', a.peak_db == null ? '–' : a.peak_db.toFixed(1) + ' dB'], ['Length', fmt(a.duration)], ['Beats found', a.beats]];
    $('stats').innerHTML = items.map(function (x) { return '<div class="stat"><b>' + esc(x[1]) + '</b><span>' + esc(x[0]) + '</span></div>'; }).join('') +
      (adv ? '<p class="note" style="grid-column:1/-1">Loudness: ' + esc(adv) + '. Key is a computer estimate from the notes it hears; check it on your guitar.</p>' : '');
  }

  load();
})();
