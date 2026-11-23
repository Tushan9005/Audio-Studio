(function () {
  'use strict';
  var studio = window.AudioStudio;
  if (!studio) return;
  function $(id) { return document.getElementById(id); }
  function esc(value) { var node = document.createElement('span'); node.textContent = String(value == null ? '' : value); return node.innerHTML; }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, Number(value) || 0)); }
  function fmt(seconds) { seconds = Math.max(0, seconds || 0); return Math.floor(seconds / 60) + ':' + (seconds % 60).toFixed(1).padStart(4, '0'); }
  function notify(message, error) { studio.notify(message, !!error); }

  var L = { ctx:null, master:null, stream:null, tracks:[], takes:[], duration:0, phase:0, playing:false,
    raf:0, recording:null, comping:false, history:[], future:[], serial:0, takeSerial:0 };

  function loopSeconds() {
    return 60 / clamp($('loopBpm').value, 30, 240) * clamp($('loopMeter').value, 1, 12) * clamp($('loopBars').value, 1, 32);
  }
  function setStatus(text) { $('loopStatus').textContent = text; }
  function ensureContext() {
    if (!L.ctx) {
      L.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint:'interactive' });
      L.master = L.ctx.createGain(); L.master.connect(L.ctx.destination);
    }
    return L.ctx.resume().then(function () { return L.ctx; });
  }
  function releaseMic() {
    if (L.stream) L.stream.getTracks().forEach(function (track) { track.stop(); });
    L.stream = null;
  }
  async function ensureMic() {
    if (L.stream && L.stream.active) return L.stream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use a microphone.');
    if (!window.MediaRecorder) throw new Error('This browser cannot record audio tracks.');
    L.stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:2 } });
    return L.stream;
  }
  function setDuration(seconds) {
    L.duration = Math.max(.25, Math.min(180, Number(seconds) || 0));
    $('compStart').max = L.duration.toFixed(3); $('compEnd').max = L.duration.toFixed(3);
    $('compStart').value = 0; $('compEnd').value = L.duration.toFixed(3);
    ['loopLengthMode','loopBpm','loopBars','loopMeter'].forEach(function (id) { $(id).disabled = true; });
    renderState();
  }
  function clearDuration() {
    L.duration = 0; $('compStart').value = 0; $('compEnd').value = 0;
    ['loopLengthMode','loopBpm','loopBars','loopMeter'].forEach(function (id) { $(id).disabled = false; });
  }
  function updateTrackNodes(track) {
    if (!L.ctx || !track.gain) return;
    var anySolo = L.tracks.some(function (item) { return item.solo; });
    var audible = !track.mute && (!anySolo || track.solo);
    track.gain.gain.setTargetAtTime(audible ? track.volume : 0, L.ctx.currentTime, .012);
    if (track.panner) track.panner.pan.setTargetAtTime(track.pan, L.ctx.currentTime, .012);
  }
  function updateMixer() { L.tracks.forEach(updateTrackNodes); renderTracks(); }
  function attachNodes(track) {
    if (!L.ctx) return;
    if (track.gain) return;
    track.gain = L.ctx.createGain();
    track.panner = L.ctx.createStereoPanner ? L.ctx.createStereoPanner() : null;
    if (track.panner) { track.gain.connect(track.panner); track.panner.connect(L.master); }
    else track.gain.connect(L.master);
    updateTrackNodes(track);
  }
  function stopSource(track) { if (track.source) { try { track.source.stop(); } catch (error) {} try { track.source.disconnect(); } catch (error) {} track.source = null; } }
  function startSource(track, when, offset) {
    stopSource(track); attachNodes(track);
    var source = L.ctx.createBufferSource(); source.buffer = track.buffer; source.loop = true; source.loopStart = 0; source.loopEnd = L.duration;
    source.connect(track.gain); source.start(when, Math.max(0, offset || 0) % L.duration); track.source = source;
  }
  async function play() {
    if (!L.tracks.length || !L.duration) { notify('Record or load a layer first.', true); return; }
    await ensureContext();
    if (L.playing) { stop(); return; }
    L.phase = L.ctx.currentTime + .06; L.playing = true;
    L.tracks.forEach(function (track) { startSource(track, L.phase, 0); });
    $('loopPlay').textContent = '■ Stop'; $('loopPlay').classList.add('on'); setStatus('Playing ' + L.tracks.length + ' synchronized layer' + (L.tracks.length === 1 ? '' : 's') + '.');
    animate();
  }
  function stop() {
    L.tracks.forEach(stopSource); L.playing = false; cancelAnimationFrame(L.raf);
    $('loopPlay').textContent = '▶ Play'; $('loopPlay').classList.remove('on'); $('loopClock').textContent = '0:00.0'; $('loopProgress').style.width = '0%';
    document.querySelectorAll('.loop-wave i').forEach(function (line) { line.style.left = '0%'; });
  }
  function phaseAt(time) { if (!L.duration || !L.playing) return 0; return ((time - L.phase) % L.duration + L.duration) % L.duration; }
  function animate() {
    if (!L.playing) return;
    var phase = phaseAt(L.ctx.currentTime), percent = phase / L.duration * 100;
    $('loopClock').textContent = fmt(phase); $('loopProgress').style.width = percent + '%';
    document.querySelectorAll('.loop-wave i').forEach(function (line) { line.style.left = percent + '%'; });
    L.raf = requestAnimationFrame(animate);
  }
  function nextBoundary(extra, acceptRecent) {
    extra = extra || 0;
    var now = L.ctx.currentTime, first = L.phase + extra;
    if (now < first - .03) return first;
    var previous = first + Math.floor((now - first) / L.duration) * L.duration;
    if (acceptRecent && now - previous < .15) return previous;
    return first + Math.ceil((now - first + .03) / L.duration) * L.duration;
  }

  function exactBuffer(input, duration, latencyMs, placement, takeLength) {
    var sr = L.ctx.sampleRate, length = Math.round(duration * sr), output = L.ctx.createBuffer(2, length, sr);
    var shift = Math.round((Number(latencyMs) || 0) * sr / 1000), at = Math.round((placement || 0) * sr);
    var wanted = Math.min(length - at, Math.round((takeLength == null ? duration : takeLength) * sr));
    for (var channel = 0; channel < 2; channel++) {
      var source = input.getChannelData(Math.min(channel, input.numberOfChannels - 1)), target = output.getChannelData(channel);
      for (var i = 0; i < wanted; i++) { var from = i + shift; if (from >= 0 && from < source.length && at + i < target.length) target[at + i] = source[from]; }
    }
    return output;
  }
  async function decodeBlob(blob) { return L.ctx.decodeAudioData(await blob.arrayBuffer()); }
  function recorderOptions() {
    var types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
    var type = types.find(function (value) { return window.MediaRecorder && MediaRecorder.isTypeSupported(value); });
    return type ? { mimeType:type, audioBitsPerSecond:256000 } : {};
  }
  function cancelPendingRecording(discard) {
    var rec = L.recording; if (!rec) return;
    rec.discard = !!discard;
    if (rec.timer) { clearTimeout(rec.timer); L.recording = null; recordingUI(); if (!L.comping) releaseMic(); return; }
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  }
  async function capture(config) {
    await ensureContext(); await ensureMic();
    var chunks = [], rec = { owner:config.owner, timer:null, stopTimer:null, recorder:null, discard:false };
    L.recording = rec; recordingUI();
    function begin() {
      if (L.recording !== rec || rec.discard) return;
      var recorder = rec.recorder = new MediaRecorder(L.stream, recorderOptions());
      recorder.ondataavailable = function (event) { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = function (event) { notify('Recording failed: ' + (event.error && event.error.message || 'microphone error'), true); };
      recorder.onstop = async function () {
        if (rec.stopTimer) clearTimeout(rec.stopTimer);
        if (L.recording === rec) L.recording = null; recordingUI();
        if (rec.discard || !chunks.length) { if (!L.comping) releaseMic(); return; }
        if (config.afterStop) config.afterStop();
        try { await config.done(await decodeBlob(new Blob(chunks, { type:recorder.mimeType || 'audio/webm' }))); }
        catch (error) { notify('Could not read that recording: ' + error.message, true); }
        if (!L.comping && !L.recording) releaseMic();
      };
      recorder.start(100);
      if (config.length) rec.stopTimer = setTimeout(function () { if (recorder.state !== 'inactive') recorder.stop(); }, config.length * 1000);
      recordingUI(); setStatus(config.activeText || 'Recording…');
    }
    var delay = Math.max(0, ((config.startAt || L.ctx.currentTime) - L.ctx.currentTime) * 1000);
    if (delay > 20) { rec.timer = setTimeout(function () { rec.timer = null; begin(); }, delay); setStatus(config.armedText || 'Armed for the next loop boundary…'); }
    else begin();
  }
  function recordingUI() {
    var record = L.recording && L.recording.owner === 'overdub', comp = L.comping;
    $('loopRecord').textContent = record ? '■ Stop & keep' : '● Record layer'; $('loopRecord').classList.toggle('recording', !!record); $('loopRecord').disabled = !!comp;
    $('loopComp').textContent = comp ? '■ Stop takes' : 'Record takes'; $('loopComp').classList.toggle('recording', comp); $('loopComp').disabled = !!record;
  }
  async function recordLayer() {
    if (L.recording && L.recording.owner === 'overdub') { cancelPendingRecording(false); return; }
    if (L.tracks.length >= 8) { notify('This session already has 8 layers.', true); return; }
    try {
      await ensureContext();
      var first = !L.duration, fixed = $('loopLengthMode').value === 'clock';
      if (first && fixed) { var requestedLength = loopSeconds(); if (requestedLength > 180) throw new Error('That clock is longer than the 3-minute session limit. Use fewer bars or a faster BPM.'); setDuration(requestedLength); }
      if (first && !fixed) {
        await capture({ owner:'overdub', activeText:'Recording the first layer. Press Stop & keep when the loop should end.', done:async function (raw) {
          if (raw.duration < .25) throw new Error('The first layer is too short.');
          if (raw.duration > 180) throw new Error('A Looper session can be up to 3 minutes. Stop the first take sooner.');
          setDuration(raw.duration); var beats = clamp($('loopBars').value,1,32) * clamp($('loopMeter').value,1,12);
          $('loopBpm').value = clamp(beats * 60 / L.duration, 30, 240).toFixed(1);
          addTrack(makeTrack(exactBuffer(raw, L.duration, $('loopLatency').value, 0, L.duration), 'Layer 1', 'recorded'));
          setStatus('First layer set the master loop to ' + fmt(L.duration) + '.');
        }}); return;
      }
      if (L.tracks.length && !L.playing) await play();
      var startAt = L.tracks.length ? nextBoundary(0) : L.ctx.currentTime + .08;
      await capture({ owner:'overdub', startAt:startAt, length:L.duration, armedText:'Armed. Recording starts at the next loop boundary.',
        activeText:'Overdubbing one quantized loop cycle…', done:async function (raw) {
          addTrack(makeTrack(exactBuffer(raw, L.duration, $('loopLatency').value, 0, L.duration), 'Layer ' + (L.tracks.length + 1), 'recorded'));
          setStatus('Layer aligned to the ' + fmt(L.duration) + ' master loop.');
        }});
    } catch (error) { L.recording = null; recordingUI(); releaseMic(); if (!L.tracks.length) clearDuration(); notify('Microphone could not start: ' + error.message, true); }
  }

  function compRange() {
    var start = clamp($('compStart').value, 0, Math.max(0, L.duration - .05));
    var end = clamp($('compEnd').value || L.duration, start + .05, L.duration);
    $('compStart').value = start.toFixed(2); $('compEnd').value = end.toFixed(2); return { start:start, end:end, length:end-start };
  }
  async function scheduleCompPass() {
    if (!L.comping) return;
    var range = compRange(), startAt = nextBoundary(range.start, true), passNumber = ++L.takeSerial;
    await capture({ owner:'comp', startAt:startAt, length:range.length, armedText:'Take ' + passNumber + ' armed for ' + fmt(range.start) + '–' + fmt(range.end) + '.',
      activeText:'Recording take ' + passNumber + '…', afterStop:function () {
        if (L.comping) scheduleCompPass().catch(compError);
      }, done:async function (raw) {
        var take = { id:'take-' + passNumber, name:'Take ' + passNumber, range:range,
          buffer:exactBuffer(raw, L.duration, $('loopLatency').value, range.start, range.length) };
        L.takes.push(take); renderTakes(); setStatus(take.name + ' saved separately.');
      }});
  }
  function compError(error) { L.comping = false; L.recording = null; recordingUI(); releaseMic(); notify('Take recording stopped: ' + error.message, true); }
  async function toggleComp() {
    if (L.comping) { L.comping = false; cancelPendingRecording(false); recordingUI(); setStatus('Take comping stopped.'); if (!L.recording) releaseMic(); return; }
    if (!L.duration || !L.tracks.length) { notify('Create the first loop layer before recording takes.', true); return; }
    try { await ensureContext(); await ensureMic(); if (!L.playing) await play(); L.comping = true; recordingUI(); await scheduleCompPass(); }
    catch (error) { compError(error); }
  }

  function makeTrack(buffer, name, kind) { return { id:'loop-' + (++L.serial), name:name, kind:kind || 'audio', buffer:buffer, mute:false, solo:false, volume:1, pan:0, source:null, gain:null, panner:null }; }
  function insertTrack(track, index) {
    index = clamp(index == null ? L.tracks.length : index, 0, L.tracks.length); L.tracks.splice(index, 0, track);
    if (L.ctx) attachNodes(track);
    if (L.playing) startSource(track, L.ctx.currentTime + .02, phaseAt(L.ctx.currentTime + .02));
    renderState();
  }
  function removeTrack(index) {
    var track = L.tracks[index]; if (!track) return null; stopSource(track);
    if (track.gain) try { track.gain.disconnect(); } catch (error) {}
    if (track.panner) try { track.panner.disconnect(); } catch (error) {}
    track.gain = null; track.panner = null;
    L.tracks.splice(index, 1); renderState(); return track;
  }
  function remember(action) { L.history.push(action); if (L.history.length > 30) L.history.shift(); L.future = []; renderHistory(); }
  function addTrack(track, index, noHistory) { if (L.tracks.length >= 8) { notify('This session already has 8 layers.', true); return false; } insertTrack(track, index); if (!noHistory) remember({ kind:'add', track:track, index:L.tracks.indexOf(track) }); return true; }
  function deleteTrack(index, noHistory) { var track = removeTrack(index); if (track && !noHistory) remember({ kind:'delete', track:track, index:index }); return track; }
  function undo() {
    var action = L.history.pop(); if (!action) return;
    if (action.kind === 'add') removeTrack(L.tracks.indexOf(action.track)); else insertTrack(action.track, action.index);
    L.future.push(action); renderHistory();
  }
  function redo() {
    var action = L.future.pop(); if (!action) return;
    if (action.kind === 'add') insertTrack(action.track, action.index); else removeTrack(L.tracks.indexOf(action.track));
    L.history.push(action); renderHistory();
  }
  function renderHistory() { $('loopUndo').disabled = !L.history.length; $('loopRedo').disabled = !L.future.length; }

  function renderState() { renderTracks(); renderTakes(); renderHistory(); $('loopTrackCount').textContent = L.tracks.length + ' / 8 layers'; }
  function renderTracks() {
    var root = $('loopTracks');
    if (!L.tracks.length) { root.innerHTML = '<p class="loop-empty">Record a layer or load the selected file.</p>'; return; }
    var anySolo = L.tracks.some(function (track) { return track.solo; });
    root.innerHTML = L.tracks.map(function (track, index) {
      var quiet = track.mute || (anySolo && !track.solo);
      return '<div class="loop-track' + (quiet ? ' muted' : '') + '" data-track="' + index + '"><span class="loop-track-number">' + (index + 1) + '</span>' +
        '<div class="loop-track-name"><input value="' + esc(track.name) + '" maxlength="60" data-track-name><span>' + esc(track.kind) + ' · ' + fmt(L.duration) + '</span></div>' +
        '<div class="loop-wave"><canvas></canvas><i></i></div>' +
        '<div class="loop-mix-controls"><label>Level <input type="range" min="0" max="125" value="' + Math.round(track.volume*100) + '" data-level></label><label>Pan <input type="range" min="-100" max="100" value="' + Math.round(track.pan*100) + '" data-pan></label></div>' +
        '<div class="loop-track-actions"><button type="button" class="btn small loop-toggle' + (track.mute ? ' on' : '') + '" data-loop-action="mute" title="Mute">M</button><button type="button" class="btn small loop-toggle solo' + (track.solo ? ' on' : '') + '" data-loop-action="solo" title="Solo">S</button><button type="button" class="btn small loop-stem-export" data-loop-action="export">Export</button><button type="button" class="btn small ghost danger" data-loop-action="delete" title="Delete layer">×</button></div></div>';
    }).join('');
    requestAnimationFrame(function () { root.querySelectorAll('.loop-track').forEach(function (row) { drawWave(row.querySelector('canvas'), L.tracks[Number(row.dataset.track)].buffer); }); });
  }
  function drawWave(canvas, buffer) {
    var ratio = window.devicePixelRatio || 1, width = Math.max(80, canvas.clientWidth), height = Math.max(30, canvas.clientHeight);
    canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio); var ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
    ctx.clearRect(0,0,width,height); ctx.strokeStyle = 'rgba(200,187,170,.62)'; ctx.lineWidth = 1; ctx.beginPath();
    var data = buffer.getChannelData(0), step = Math.max(1, Math.floor(data.length/width));
    for (var x=0;x<width;x++) { var low=1, high=-1, begin=x*step, end=Math.min(data.length,begin+step); for(var i=begin;i<end;i++){if(data[i]<low)low=data[i];if(data[i]>high)high=data[i];} ctx.moveTo(x,(1+low)*height/2);ctx.lineTo(x,(1+high)*height/2); }
    ctx.stroke();
  }
  function renderTakes() {
    $('loopTakes').innerHTML = L.takes.length ? L.takes.map(function (take, index) { return '<div class="loop-take" data-take="' + index + '"><span>' + esc(take.name) + ' · ' + fmt(take.range.start) + '–' + fmt(take.range.end) + '</span><button type="button" class="btn small primary" data-take-action="add">Add to mixer</button><button type="button" class="btn small ghost" data-take-action="delete">Delete</button></div>'; }).join('') : '<p>No takes recorded yet.</p>';
  }

  async function loadSelected() {
    if (L.tracks.length >= 8) { notify('This session already has 8 layers.', true); return; }
    var file = studio.currentFile(); if (!file || file.kind === 'image' || (file.kind === 'video' && !file.has_audio)) { notify('Select a sound file or a video with sound first.', true); return; }
    try {
      await ensureContext(); setStatus('Loading ' + file.name + '…');
      var response = await fetch('/media/' + file.id); if (!response.ok) throw new Error('Could not read the selected file.');
      var decoded = await L.ctx.decodeAudioData(await response.arrayBuffer());
      if (!L.duration) { var requested = $('loopLengthMode').value === 'clock' ? loopSeconds() : decoded.duration; if (requested > 180) throw new Error('That file is longer than the 3-minute session limit. Set a shorter BPM/bar loop or trim it first.'); setDuration(requested); }
      addTrack(makeTrack(exactBuffer(decoded,L.duration,0,0,L.duration), file.name, 'library audio'));
      setStatus('Loaded and fitted exactly to the master loop.');
    } catch (error) { notify(error.message, true); }
  }

  async function renderOffline(tracks, honorMixer) {
    if (!L.duration) throw new Error('There is no loop to export.');
    var sr = L.ctx ? L.ctx.sampleRate : 44100, offline = new OfflineAudioContext(2, Math.round(L.duration*sr), sr);
    var anySolo = L.tracks.some(function (track) { return track.solo; });
    tracks.forEach(function (track) {
      var source = offline.createBufferSource(); source.buffer = track.buffer;
      var gain = offline.createGain(), pan = offline.createStereoPanner ? offline.createStereoPanner() : null;
      var audible = !honorMixer || (!track.mute && (!anySolo || track.solo)); gain.gain.value = audible ? track.volume : 0;
      if (pan) { pan.pan.value = track.pan; source.connect(gain); gain.connect(pan); pan.connect(offline.destination); }
      else { source.connect(gain); gain.connect(offline.destination); }
      source.start(0);
    });
    return offline.startRendering();
  }
  function wavBlob(buffer) {
    var channels=2, length=buffer.length, out=new ArrayBuffer(44+length*channels*2), view=new DataView(out), offset=0;
    function text(value){for(var i=0;i<value.length;i++)view.setUint8(offset++,value.charCodeAt(i));} function u16(value){view.setUint16(offset,value,true);offset+=2;} function u32(value){view.setUint32(offset,value,true);offset+=4;}
    text('RIFF');u32(36+length*channels*2);text('WAVE');text('fmt ');u32(16);u16(1);u16(channels);u32(buffer.sampleRate);u32(buffer.sampleRate*channels*2);u16(channels*2);u16(16);text('data');u32(length*channels*2);
    var left=buffer.getChannelData(0),right=buffer.getChannelData(Math.min(1,buffer.numberOfChannels-1));
    for(var n=0;n<length;n++){var values=[left[n],right[n]];for(var c=0;c<2;c++){var sample=Math.max(-1,Math.min(1,values[c]));view.setInt16(offset,sample<0?sample*32768:sample*32767,true);offset+=2;}}
    return new Blob([out],{type:'audio/wav'});
  }
  async function saveAudio(buffer, name, format, target) {
    var wav=wavBlob(buffer), response;
    if(format==='wav') response=new Response(wav,{status:200,headers:{'Content-Type':'audio/wav'}});
    else {var form=new FormData();form.append('file',wav,name+'.wav');form.append('name',name);response=await fetch('/api/looper/encode/mp3',{method:'POST',body:form});}
    await studio.saveResponse(response,target); return true;
  }
  async function exportMaster() {
    var button=$('loopExportMaster'); if(!L.tracks.length){notify('Add at least one layer first.',true);return;}
    var format=$('loopExportFormat').value,target;
    try{target=await studio.chooseSaveTarget('Looper master.'+format);if(!target)return;button.disabled=true;button.textContent='Rendering…';await ensureContext();if(await saveAudio(await renderOffline(L.tracks,true),'Looper master',format,target))notify('Master loop saved.');}
    catch(error){notify('Export failed: '+error.message,true);}finally{button.disabled=false;button.textContent='Export master mix';}
  }
  async function exportTrack(index) {
    var track=L.tracks[index];if(!track)return;
    var format=$('loopExportFormat').value,target;
    try{target=await studio.chooseSaveTarget(track.name+'.'+format);if(!target)return;await ensureContext();if(await saveAudio(await renderOffline([track],false),track.name,format,target))notify('Stem saved.');}catch(error){notify('Stem export failed: '+error.message,true);}
  }

  async function addAiLayer() {
    if(!L.tracks.length||!L.duration){notify('Create a loop before adding an instrument.',true);return;}
    if(L.tracks.length>=8){notify('This session already has 8 layers.',true);return;}
    var button=$('loopAiAdd'),prompt=$('loopAiPrompt').value.trim();if(!prompt){notify('Describe the instrument you want.',true);return;}
    try{
      button.disabled=true;button.textContent='Analysing mix…';await ensureContext();var mix=wavBlob(await renderOffline(L.tracks,true)),form=new FormData();
      form.append('file',mix,'loop-mix.wav');form.append('prompt',prompt);form.append('duration',L.duration);form.append('bpm',$('loopBpm').value);
      var response=await fetch('/api/looper/ai-stem',{method:'POST',body:form}),body=await response.json();if(!response.ok)throw new Error(body.error||'Instrument generation failed.');
      button.textContent='Loading stem…';var audio=await fetch('/media/'+body.file.id),decoded=await L.ctx.decodeAudioData(await audio.arrayBuffer());
      addTrack(makeTrack(exactBuffer(decoded,L.duration,0,0,L.duration),'AI · '+prompt,'AI '+body.provider));
      $('loopBpm').value=body.analysis.bpm;$('loopAnalysis').textContent=body.analysis.bpm+' BPM · '+body.analysis.key+' · '+body.analysis.chords.join(' – ');
      studio.refreshLibrary();notify('AI instrument added as a synchronized layer.');
    }catch(error){notify(error.message,true);}finally{button.disabled=false;button.textContent='Add AI instrument';}
  }

  function newSession() {
    if((L.tracks.length||L.takes.length)&&!confirm('Clear every Looper layer and take? Export anything you want to keep first.'))return;
    if(L.recording)cancelPendingRecording(true);L.comping=false;stop();releaseMic();
    L.tracks.forEach(function(track){if(track.gain)try{track.gain.disconnect();}catch(error){}});L.tracks=[];L.takes=[];L.history=[];L.future=[];L.takeSerial=0;clearDuration();recordingUI();renderState();setStatus('Set the clock, then record the first layer or load the selected file.');$('loopAnalysis').textContent='';
  }

  $('loopPlay').addEventListener('click',play);$('loopRecord').addEventListener('click',recordLayer);$('loopComp').addEventListener('click',toggleComp);
  $('loopUndo').addEventListener('click',undo);$('loopRedo').addEventListener('click',redo);$('loopLoadSelected').addEventListener('click',loadSelected);$('loopNew').addEventListener('click',newSession);$('loopAiAdd').addEventListener('click',addAiLayer);$('loopExportMaster').addEventListener('click',exportMaster);
  $('loopTracks').addEventListener('input',function(event){var row=event.target.closest('[data-track]');if(!row)return;var track=L.tracks[Number(row.dataset.track)];if(!track)return;if(event.target.matches('[data-level]'))track.volume=Number(event.target.value)/100;if(event.target.matches('[data-pan]'))track.pan=Number(event.target.value)/100;if(event.target.matches('[data-track-name]'))track.name=event.target.value;updateTrackNodes(track);});
  $('loopTracks').addEventListener('click',function(event){var action=event.target.closest('[data-loop-action]'),row=event.target.closest('[data-track]');if(!action||!row)return;var index=Number(row.dataset.track),track=L.tracks[index];if(action.dataset.loopAction==='mute')track.mute=!track.mute;if(action.dataset.loopAction==='solo')track.solo=!track.solo;if(action.dataset.loopAction==='delete'){deleteTrack(index);return;}if(action.dataset.loopAction==='export'){exportTrack(index);return;}updateMixer();});
  $('loopTakes').addEventListener('click',function(event){var action=event.target.closest('[data-take-action]'),row=event.target.closest('[data-take]');if(!action||!row)return;var index=Number(row.dataset.take),take=L.takes[index];if(action.dataset.takeAction==='add'){if(addTrack(makeTrack(take.buffer,take.name+' comp','comp segment')))notify(take.name+' added to the mixer.');}else{L.takes.splice(index,1);renderTakes();}});
  window.addEventListener('resize',function(){document.querySelectorAll('.loop-track').forEach(function(row){drawWave(row.querySelector('canvas'),L.tracks[Number(row.dataset.track)].buffer);});});
  window.addEventListener('beforeunload',function(){releaseMic();});
  renderState();recordingUI();
})();
