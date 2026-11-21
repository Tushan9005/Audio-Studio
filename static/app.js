/* Audio Studio front end: library, waveform player with selection, and the tool panels. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var REGION_COLOR = 'rgba(240, 162, 59, .10)';
  var S = { files: [], cur: null, ticks: [], filter: 'all', ws: null, regions: null, region: null, presets: {}, voices: {}, rate: 1, abPlay: false, gapT: null, fxPreview: null };
  var fxAudioContext = null, fxSources = new WeakMap(), fxRebuildTimer = null;

  // ── helpers ──
  function fmt(t) { t = Math.round(Math.max(0, t || 0) * 10) / 10; var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, err ? 9000 : 4000);
  }
  function busy(on, msg, pct) {
    $('busy').hidden = !on; $('busyMsg').textContent = msg || 'Working…';
    $('busyBar').hidden = !on || pct == null; if (pct != null) $('busyBar').firstChild.style.width = Math.round(pct * 100) + '%';
  }
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
    stopFxPreview(); stopLayerPreview();
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
        S.ws.on('timeupdate', function (t) { $('time').textContent = fmt(t) + ' / ' + fmt(S.ws.getDuration()); regionEnd(t); });
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
    $('lpPreview').disabled = f.kind !== 'audio';
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
    busy(true, 'Getting ready to split "' + f.name + '"…', 0);
    post('/api/split', { id: f.id, stems: stems }).then(function (j) {
      return new Promise(function (ok, fail) {
        (function poll() {
          api('/api/jobs/' + j.job).then(function (st) {
            if (st.done) { if (st.error) fail(new Error(st.error)); else ok(st.files); return; }
            var p = st.progress, left = p > 0.06 ? Math.max(5, st.elapsed / p * (1 - p)) : null;
            busy(true, 'Splitting "' + f.name + '"… ' + Math.round(p * 100) + '%' +
              (left ? ' · about ' + (left > 90 ? Math.round(left / 60) + ' min' : Math.round(left / 5) * 5 + ' s') + ' left' : (p < 0.02 ? ' · loading the splitter' : '')), p);
            setTimeout(poll, 1000);
          }).catch(fail);
        })();
      });
    }).then(function (files) {
      toast('Done: ' + files.length + ' new file' + (files.length > 1 ? 's' : '') + ' added (' + files.map(function (x) { return x.name.split(' · ').pop(); }).join(', ') + ').');
      return load(files[0].id);
    }).catch(function (x) { toast(x.message, true); }).finally(function () { busy(false); });
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
  function addVocalLayer(name, shift, db, pan, delay) {
    if ($('layerTracks').children.length >= 8) { toast('Maximum eight layers.', true); return; }
    var row = document.createElement('div'); row.className = 'layer-track';
    row.innerHTML = '<label>Part<input class="layer-name" value="' + esc(name) + '"></label><label>Source<select data-layer="source"><option value="">Selected lead</option></select></label>' +
      [['shift','Pitch (semitones)',-12,12,shift,1],['db','Level (dB)',-36,6,db,1],['pan','Pan (−1 left / +1 right)',-1,1,pan,.1],['delay','Start offset (ms)',0,5000,0,10]].map(function (v) { return '<label>' + v[1] + '<input type="number" data-layer="' + v[0] + '" min="' + v[2] + '" max="' + v[3] + '" value="' + v[4] + '" step="' + v[5] + '"></label>'; }).join('') + '<label class="tick"><input type="checkbox" data-layer="mute">Mute</label><label class="tick"><input type="checkbox" data-layer="solo">Solo</label><button class="btn ghost" type="button">Remove</button>';
    S.files.filter(function (f) { return f.kind === 'audio'; }).forEach(function (f) { row.querySelector('select').add(new Option(f.name, f.id)); });
    row.querySelector('button').onclick = function () { row.remove(); markLayersCustom(); scheduleLayerPreview(); };
    $('layerTracks').appendChild(row);
    row.querySelector('[data-layer="delay"]').value = delay || 0;
  }
  var layerArrangements = {
    intimate: {name:'Intimate double — start here', help:'Lead plus a quiet 18 ms copy for subtle thickness. No harmony notes are added. For a true double, choose a second sung take and reset its offset to 0, then align it.', tracks:[['Lead',0,-3,0],['Soft double',0,-18,.15,18]]},
    wide: {name:'Wide pop doubles', help:'Centered lead with quiet left/right delayed copies. Useful for a fuller chorus. Check mono compatibility; replace the copies with separate takes for natural double tracking.', tracks:[['Lead',0,-3,0],['Double left',0,-18,-.8,18],['Double right',0,-18,.8,32]]},
    low: {name:'Warm lower octave', help:'A quiet octave below supports the lead without adding a third. Useful for gentle weight; lower the octave if it becomes muddy or artificial.', tracks:[['Lead',0,-3,0],['Lower octave',-12,-18,0]]},
    air: {name:'Upper octave lift', help:'A very quiet octave above for a bright chorus lift. Large shifts can sound thin with the current engine; keep this layer low.', tracks:[['Lead',0,-3,0],['Upper octave',12,-21,.25]]},
    octaves: {name:'Three octave stack', help:'Lead, lower octave and upper octave for a larger hook. The low part follows the melody, not the chord roots. Use sparingly and listen for pitch-shifting artifacts.', tracks:[['Lead',0,-3,0],['Lower octave',-12,-18,-.25],['Upper octave',12,-21,.25]]},
    fifth: {name:'Open fifth duet — check chords', help:'Lead with a quiet +7 semitone fifth. This is a fixed parallel harmony and may clash with some notes or chords. Solo the harmony to check it.', tracks:[['Lead',0,-3,0],['Fifth',7,-15,.4]]},
    major: {name:'Major third + fifth + bass — fixed', help:'The original four-part arrangement. +4 and +7 are fixed intervals: choosing this does not set a major key or make every note fit your song.', tracks:[['Lead',0,-3,0],['Major third',4,-12,-.5],['Fifth',7,-15,.5],['Octave bass',-12,-18,0]]},
    minor: {name:'Minor third + fifth + bass — fixed', help:'Darker fixed +3 and +7 harmonies with a lower octave. This is not an automatic minor-key arrangement; check each phrase against your chords.', tracks:[['Lead',0,-3,0],['Minor third',3,-12,-.5],['Fifth',7,-15,.5],['Octave bass',-12,-18,0]]}
  };
  Object.keys(layerArrangements).forEach(function (key) { $('layerPreset').add(new Option(layerArrangements[key].name, key)); });
  $('layerPresetHelp').textContent = 'Choose an arrangement: it loads straight away, and plays at once if Live preview is on.';

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
      var src = v('source').value || S.cur, shift = Math.round(num('shift', -12, 12, 0) * 100) / 100;
      return { row: row, src: src, shift: shift, key: src + '|' + shift.toFixed(2), db: num('db', -36, 6, -6), pan: num('pan', -1, 1, 0),
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
    fetch('/api/layer_stem/' + encodeURIComponent(r.src) + '?shift=' + r.shift)
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
      waiting.length ? 'LIVE · preparing ' + waiting.map(function (r) { return (r.shift > 0 ? '+' : '') + r.shift + ' semitones'; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(', ') + '…' :
      'LIVE · change pitch, level, pan, offset, mute or solo while it plays.';
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
    var f = curFile();
    if (!f || f.kind !== 'audio' || !S.ws || !S.ws.getMediaElement) { toast('Select a vocals-only sound file first.', true); return; }
    if (!$('layerTracks').children.length) { toast('Load an arrangement or add a layer first.', true); return; }
    stopFxPreview();
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
      this.classList.add('on'); this.textContent = '■ Stop preview'; $('lpBypass').disabled = false;
      syncLayerPreview();
      if (media.paused) S.ws.play(); else lpPlay();
    } catch (e) { stopLayerPreview(); toast('Live preview could not start in this browser. Reload the page and try again.', true); }
  });
  $('lpBypass').addEventListener('click', function () {
    if (!LP) return;
    LP.bypass = !LP.bypass;
    LP.bus.gain.setTargetAtTime(LP.bypass ? 0 : 1, LP.ac.currentTime, 0.01);
    lpMediaDirect(LP.bypass);
    this.setAttribute('aria-pressed', LP.bypass ? 'true' : 'false'); this.textContent = LP.bypass ? 'Hear layers' : 'Hear original';
    $('lpNote').textContent = LP.bypass ? 'ORIGINAL · the selected file on its own, for comparison.' : 'LIVE · change pitch, level, pan, offset, mute or solo while it plays.';
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
    $('layerTracks').replaceChildren();
    preset.tracks.forEach(function (v) { addVocalLayer.apply(null, v); });
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
  $('fxReset').addEventListener('click', function () { fxReset(); $('preset').value = ''; });
  $('preset').addEventListener('change', function () {
    var p = S.presets[this.value]; if (!p) return;
    fxReset();
    Object.keys(p).forEach(function (k) {
      var el = document.querySelector('[data-fx="' + k + '"]'); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!p[k]; else el.value = p[k];
      if (el.type === 'range') outFor(el);
    });
    scheduleFxPreview();
  });
  var coverHelp = {
    cover_natural: 'Natural keeps the words clear, warms the guitar and adds a believable room around you.',
    cover_intimate: 'Intimate sounds close to the listener, with just enough space to avoid sounding dry.',
    cover_spacious: 'Spacious gives sustained notes a wider, longer tail while keeping the first word clear.'
  };
  document.querySelector('.cover-choices').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cover-preset]'); if (!b) return;
    var key = b.getAttribute('data-cover-preset'); $('preset').value = key;
    $('preset').dispatchEvent(new Event('change'));
    document.querySelectorAll('[data-cover-preset]').forEach(function (x) { x.classList.toggle('chosen', x === b); });
    $('coverHelp').textContent = coverHelp[key];
    toast('“' + b.textContent.trim().replace(/\s+/g, ' ') + '” settings loaded. Click Apply effects when ready.');
  });
  function fxValues() {
    var o = {};
    document.querySelectorAll('[data-fx]').forEach(function (el) { o[el.getAttribute('data-fx')] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; });
    return o;
  }
  var personalSounds = {};
  try { var savedSounds = JSON.parse(localStorage.getItem('audioStudio.personalSounds') || '{}'); if (savedSounds && typeof savedSounds === 'object' && !Array.isArray(savedSounds)) personalSounds = savedSounds; } catch (e) {}
  function listPersonalSounds() {
    $('myPreset').replaceChildren(new Option('Choose a saved sound…', ''));
    Object.keys(personalSounds).sort().forEach(function (name) { $('myPreset').add(new Option(name, name)); });
  }
  function persistSounds(next) {
    try { localStorage.setItem('audioStudio.personalSounds', JSON.stringify(next)); personalSounds = next; listPersonalSounds(); return true; }
    catch (e) { toast('This browser could not save your sounds. Check available browser storage.', true); return false; }
  }
  listPersonalSounds();
  $('saveMyPreset').addEventListener('click', function () {
    var name = prompt('Name this sound (for example: My warm acoustic cover)');
    if (!name || !name.trim()) return; name = name.trim().slice(0, 80);
    if (Object.prototype.hasOwnProperty.call(personalSounds, name) && !confirm('Replace the saved sound “' + name + '”?')) return;
    var next = Object.assign(Object.create(null), personalSounds); next[name] = fxValues();
    if (persistSounds(next)) { $('myPreset').value = name; toast('Sound saved in this browser.'); }
  });
  $('myPreset').addEventListener('change', function () {
    var settings = personalSounds[this.value]; if (!settings || typeof settings !== 'object') return;
    fxReset();
    document.querySelectorAll('[data-fx]').forEach(function (el) {
      var value = settings[el.getAttribute('data-fx')]; if (value == null) return;
      if (el.type === 'checkbox') el.checked = !!Number(value); else el.value = value;
      if (el.type === 'range') outFor(el);
    });
    $('preset').value = '';
    document.querySelectorAll('[data-cover-preset]').forEach(function (b) { b.classList.remove('chosen'); });
    $('coverHelp').textContent = 'Personal sound: ' + this.value;
    scheduleFxPreview();
  });
  $('deleteMyPreset').addEventListener('click', function () {
    var name = $('myPreset').value; if (!name || !confirm('Delete saved sound “' + name + '”?')) return;
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
    stopLayerPreview();
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
  document.querySelectorAll('[data-fx]').forEach(function (el) { el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', scheduleFxPreview); });

  // ── run a tool ──
  var MSG = { effects: 'Applying effects…', effects_video: 'Polishing the sound and rebuilding your video…', beat_reel: 'Finding the beats and cutting your clips… (this can take a minute)', video_music: 'Mixing music into the video…',
              voice: 'Making the voiceover…', practice: 'Making your practice copy…', analyse: 'Listening for tempo and key…', best: 'Finding the best part…', export: 'Saving…' };
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-do]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-do'), f = curFile();
    if (a === 'effects' && f && f.kind === 'video') a = 'effects_video';
    if (!f && !b.hasAttribute('data-any') && a !== 'join' && a !== 'beat_reel') { toast('Select a file in the library first.', true); return; }
    var body = { id: f ? f.id : null };
    if (a === 'vocal_layers') {
      if (!f || f.kind !== 'audio') { toast('Select a vocals-only audio file first.', true); return; }
      var tracks = Array.from($('layerTracks').children).map(function (row) { var t = {}; row.querySelectorAll('[data-layer]').forEach(function (el) { t[el.dataset.layer] = el.type === 'checkbox' ? el.checked : el.value; }); return t; });
      var solo = tracks.some(function (t) { return t.solo; });
      body.layers = tracks.filter(function (t) { return !t.mute && (!solo || t.solo); });
      if (!body.layers.length) { toast('Add at least one audible layer.', true); return; }
      stopFxPreview(); stopLayerPreview();
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
    busy(true, MSG[a]);
    post('/api/do/' + a, body).then(function (j) {
      if (j.sound_check) {
        var report = j.sound_check;
        $('soundCheckResults').innerHTML = '<p>Checked first ' + esc(report.seconds) + ' s · Sample peak: ' + esc(report.peak_db) + ' dBFS · Average RMS: ' + esc(report.rms_db) + ' dBFS (not LUFS) · Near-full-scale samples: ' + esc(report.near_full_scale_percent) + '%</p><ul>' + report.tips.map(function (tip) { return '<li>' + esc(tip) + '</li>'; }).join('') + '</ul>';
        return;
      }
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
})();
