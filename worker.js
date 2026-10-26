import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

let transcriber = null;
let loadedModel = null;

async function hasWebGPU() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(model) {
  if (transcriber && loadedModel === model) return;
  await transcriber?.dispose?.();
  transcriber = null;

  const progress_callback = (p) => self.postMessage({ type: 'progress', ...p });
  const wasm = { device: 'wasm', dtype: 'q8', progress_callback };
  let device = 'wasm';

  if (await hasWebGPU()) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      device = 'webgpu';
    } catch (err) {
      console.warn('WebGPU failed, falling back to WASM', err);
    }
  }
  transcriber ??= await pipeline('automatic-speech-recognition', model, wasm);
  loadedModel = model;
  self.postMessage({ type: 'ready', device });
}

self.onmessage = async ({ data }) => {
  try {
    await load(data.model);
    self.postMessage({ type: 'status', message: 'Transcribing…' });
    const options = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
    if (data.language) Object.assign(options, { language: data.language, task: 'transcribe' });
    const out = await transcriber(data.audio, options);
    self.postMessage({ type: 'result', chunks: out.chunks ?? [], text: out.text });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
