import { normalizeWords, buildCues, formatTime, toSrt } from './srt.js';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), dropText: $('dropText'), player: $('player'),
  model: $('model'), language: $('language'), transcribe: $('transcribe'),
  progressWrap: $('progressWrap'), progress: $('progress'), status: $('status'),
  maxChars: $('maxChars'), maxCharsOut: $('maxCharsOut'), maxLines: $('maxLines'),
  sentenceBreak: $('sentenceBreak'), pauseBreak: $('pauseBreak'), pauseSec: $('pauseSec'),
  stats: $('stats'), download: $('download'), sampleNote: $('sampleNote'), cues: $('cues'),
};

const SAMPLE = `Welcome to the subtitle preview. Drag the slider above to change the maximum line length, and watch how the words reflow without ever being split in half. Shorter lines are easier to read on small screens, while longer lines suit widescreen video. When you are happy with the layout, transcribe your audio and download the finished file.`;

function sampleWords() {
  let t = 0.5;
  return SAMPLE.split(/\s+/).map((text) => {
    const start = t;
    const end = start + 0.12 + text.length * 0.045;
    t = end + (/[.!?]$/.test(text) ? 0.6 : 0.08);
    return { text, start, end };
  });
}

let words = sampleWords();
let isSample = true;
let cues = [];
let audioFile = null;
let worker = null;

function settings() {
  return {
    maxChars: Number(els.maxChars.value),
    maxLines: Number(els.maxLines.value),
    sentenceBreak: els.sentenceBreak.checked,
    pauseSplit: els.pauseBreak.checked ? Number(els.pauseSec.value) || 0 : 0,
  };
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function render() {
  const opts = settings();
  els.maxCharsOut.textContent = opts.maxChars;
  els.cues.style.setProperty('--max', opts.maxChars);
  cues = buildCues(words, opts);
  activeIdx = -1;

  const longest = Math.max(0, ...cues.flatMap((c) => c.lines.map((l) => l.length)));
  const over = cues.reduce((n, c) => n + c.lines.filter((l) => l.length > opts.maxChars).length, 0);
  els.stats.textContent = `${cues.length} subtitles · longest line ${longest} chars` +
    (over ? ` · ${over} single word${over > 1 ? 's' : ''} longer than the limit` : '');

  els.cues.innerHTML = cues.map((c, i) => `
    <li class="cue" data-i="${i}">
      <span class="idx">${i + 1}</span>
      <span class="time">${formatTime(c.start)} → ${formatTime(c.end)}</span>
      <div class="lines">${c.lines.map((l) => `
        <div class="line${l.length > opts.maxChars ? ' over' : ''}">
          <span class="box">${escapeHtml(l)}</span>
          <span class="count">${l.length}/${opts.maxChars}</span>
        </div>`).join('')}
      </div>
    </li>`).join('');

  els.sampleNote.hidden = !isSample;
  els.download.disabled = isSample || !cues.length;
}

function setFile(file) {
  if (!file) return;
  if (!/\.(wav|mp3)$/i.test(file.name) && !/audio\/(wav|x-wav|mpeg|mp3)/.test(file.type)) {
    alert('Please choose a .wav or .mp3 file.');
    return;
  }
  audioFile = file;
  els.dropText.textContent = `${file.name} (${(file.size / 1e6).toFixed(1)} MB)`;
  els.player.src = URL.createObjectURL(file);
  els.player.hidden = false;
  els.transcribe.disabled = false;
}

async function decodeAudio(file) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const mono = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buf.numberOfChannels;
    }
    return mono;
  } finally {
    ctx.close();
  }
}

function setStatus(message, value) {
  els.progressWrap.hidden = false;
  els.status.textContent = message;
  if (value == null) els.progress.removeAttribute('value');
  else els.progress.value = value;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const files = new Map();
  let device = '';
  let startedAt = 0;
  let timer = null;

  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'progress':
        if (data.status === 'progress' && data.total) {
          files.set(data.file, [data.loaded, data.total]);
          let loaded = 0, total = 0;
          for (const [l, t] of files.values()) { loaded += l; total += t; }
          setStatus(`Downloading model… ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`, (loaded / total) * 100);
        }
        break;
      case 'ready':
        device = data.device === 'webgpu' ? 'GPU' : 'CPU';
        break;
      case 'status':
        startedAt = performance.now();
        clearInterval(timer);
        timer = setInterval(() => {
          const secs = Math.round((performance.now() - startedAt) / 1000);
          setStatus(`${data.message} (${device || 'CPU'}, ${secs}s)`);
        }, 500);
        setStatus(`${data.message} (${device || 'CPU'})`);
        break;
      case 'result':
        clearInterval(timer);
        words = normalizeWords(data.chunks);
        isSample = false;
        setStatus(words.length ? `Done: ${words.length} words transcribed.` : 'No speech detected.', 100);
        els.transcribe.disabled = false;
        render();
        break;
      case 'error':
        clearInterval(timer);
        setStatus(`Error: ${data.message}`, 0);
        els.transcribe.disabled = false;
        break;
    }
  };
  return worker;
}

async function transcribe() {
  if (!audioFile) return;
  els.transcribe.disabled = true;
  try {
    setStatus('Decoding audio…');
    const audio = await decodeAudio(audioFile);
    setStatus('Loading model…');
    getWorker().postMessage({ audio, model: els.model.value, language: els.language.value }, [audio.buffer]);
  } catch (err) {
    setStatus(`Could not read audio: ${err.message}`, 0);
    els.transcribe.disabled = false;
  }
}

function download() {
  const blob = new Blob([toSrt(cues)], { type: 'application/x-subrip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (audioFile?.name.replace(/\.[^.]+$/, '') || 'subtitles') + '.srt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

els.file.addEventListener('change', () => setFile(els.file.files[0]));
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  setFile(e.dataTransfer.files[0]);
});
els.transcribe.addEventListener('click', transcribe);
els.download.addEventListener('click', download);
for (const el of [els.maxChars, els.maxLines, els.sentenceBreak, els.pauseBreak, els.pauseSec]) {
  el.addEventListener('input', render);
}

els.cues.addEventListener('click', (e) => {
  const li = e.target.closest('.cue');
  if (!li || isSample || !els.player.src) return;
  els.player.currentTime = cues[li.dataset.i].start;
  els.player.play();
});

let activeIdx = -1;
els.player.addEventListener('timeupdate', () => {
  if (isSample) return;
  const t = els.player.currentTime;
  const idx = cues.findIndex((c) => t >= c.start && t < c.end);
  if (idx === activeIdx) return;
  els.cues.querySelector('.cue.active')?.classList.remove('active');
  activeIdx = idx;
  const li = idx >= 0 && els.cues.children[idx];
  if (li) {
    li.classList.add('active');
    li.scrollIntoView({ block: 'nearest' });
  }
});

render();
