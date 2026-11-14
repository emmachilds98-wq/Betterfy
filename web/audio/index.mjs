// What the page's lazy audio bundle (docs/audio.js) exposes as `BetterfyAudio`.
// One namespace so the template reaches core/audio through a single name.
export { openAudioStore, AUDIO_DB, AUDIO_STORE } from './store.mjs';
export { readAudioSettings, writeAudioSettings, connectionVerdict, scopeIds, SCOPES, DEFAULT_AUDIO_SETTINGS, AUDIO_SETTINGS_KEY } from './settings.mjs';
export { createAudioController, createWorkerEar, listenVM, profileVM, styleName, MISS_TEXT, DSP_FILL_PER_RUN } from './controller.mjs';
export { audioQueue } from '../../core/audio/queue.mjs';
export { lookup, fetchPreview } from '../../core/audio/fetch.mjs';
export { decodeTo16k } from '../../core/audio/decode.mjs';
export { analyseOne } from '../../core/audio/worker.js';
export { MISS, validRecord, isCurrent, RECORD_VERSION, MODEL } from '../../core/audio/record.mjs';
export { MEL_VERSION } from '../../core/audio/mel.mjs';
export { HEADS, summariseHeads } from '../../core/audio/heads.mjs';
export { dspSoundVM, dspShown, DSP_UI_DEFAULT, DSP_UI_KEY } from './dsp-view.mjs';
export { measureWindows, needsDsp, DSP_VERSION } from '../../core/audio/dsp/combine.mjs';
