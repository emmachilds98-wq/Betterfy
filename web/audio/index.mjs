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
export { dspSoundVM, dspShown, bpmShown, DSP_UI_DEFAULT, BPM_UI_DEFAULT, DSP_UI_KEY } from './dsp-view.mjs';
export { measureWindows, needsDsp, DSP_VERSION } from '../../core/audio/dsp/combine.mjs';
export { LABEL_TYPES, AGREE_MIN, REVIEW_MIN, REVIEW_SIZE, LABELS_UI_KEY, CHECKS_KEY, readingsOf, checksFor, withVerdict, agreement,
  labelsShown, labelSoundVM, mergeSoundVM, withProfileEnergy, reviewSample, reviewVM, reviewHTML, seenOf } from './labels-view.mjs';
export { readDeepSettings, writeDeepSettings, deepListenAllowed, DEEP_SETTINGS_KEY, DEFAULT_DEEP_SETTINGS, DEEP_EARS, DEEP_TEXT, MAEST_MIN_MEMORY_GB } from './deep-settings.mjs';
export { readTable, clapIndex, clapHeard, findPrompt, suggestPrompts, soundsLike, nameGroup, libraryMean,
  confirmName, confirmedName, CLAP_SEARCH, CLAP_SEARCH_VERSION } from '../../core/audio/clap-search.mjs';
