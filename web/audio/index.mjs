// What the page's lazy audio bundle (docs/audio.js) exposes as `BetterfyAudio`.
// One namespace so the template reaches core/audio through a single name.
export { openAudioStore, AUDIO_DB, AUDIO_STORE } from './store.mjs';
export { readAudioSettings, writeAudioSettings, defaultAudioSettings, connectionVerdict, scopeIds, SCOPES, DEFAULT_AUDIO_SETTINGS, AUDIO_SETTINGS_KEY } from './settings.mjs';
export { createAudioController, createWorkerEar, listenVM, profileVM, styleName, MISS_TEXT, DSP_FILL_PER_RUN } from './controller.mjs';
export { audioQueue } from '../../core/audio/queue.mjs';
export { lookup, fetchPreview } from '../../core/audio/fetch.mjs';
export { decodeTo16k } from '../../core/audio/decode.mjs';
export { analyseOne } from '../../core/audio/worker.js';
export { MISS, validRecord, isCurrent, RECORD_VERSION, MODEL } from '../../core/audio/record.mjs';
export { MEL_VERSION } from '../../core/audio/mel.mjs';
export { HEADS, summariseHeads } from '../../core/audio/heads.mjs';
export { dspSoundVM, dspShown, bpmShown, keyShown, DSP_UI_DEFAULT, BPM_UI_DEFAULT, KEY_UI_DEFAULT, KEY_MIN_CONF, DSP_UI_KEY } from './dsp-view.mjs';
export { measureWindows, needsDsp, DSP_VERSION } from '../../core/audio/dsp/combine.mjs';
export { LABEL_TYPES, AGREE_MIN, REVIEW_MIN, REVIEW_SIZE, LABELS_UI_KEY, CHECKS_KEY, readingsOf, checksFor, withVerdict, agreement,
  labelsShown, labelSoundVM, mergeSoundVM, withProfileEnergy, reviewSample, reviewVM, reviewHTML, seenOf,
  askFor, askText, askHTML, askProgress, ASK_SESSION_KEY } from './labels-view.mjs';
export { readDeepSettings, writeDeepSettings, deepListenAllowed, DEEP_SETTINGS_KEY, DEFAULT_DEEP_SETTINGS, DEEP_EARS, DEEP_TEXT, MAEST_MIN_MEMORY_GB } from './deep-settings.mjs';
export { readTable, clapIndex, clapHeard, findPrompt, suggestPrompts, soundsLike, nameGroup, libraryMean,
  confirmName, confirmedName, CLAP_SEARCH, CLAP_SEARCH_VERSION } from '../../core/audio/clap-search.mjs';
export { createMaestRunner, createWorkerMaest, maestStatusText, chosenEar, scoreArms, maestScoreText, MAEST_PER_RUN,
         nearInUse, nearScoreText, NEAR_SETTING } from './maest-run.mjs';
export { MAEST_FILE, MAEST_LABELS_FILE, needsMaest } from '../../core/audio/maest.mjs';
export { needsBeatsFlagged, withBeats, BEAT_MODEL_FILE, BEATS_FILL_PER_RUN } from '../../core/audio/dsp/beats.mjs';
export { needsKeyNet, KEYNET_MODEL_FILE, KEYNET_FILL_PER_RUN, KEYNET_VERSION } from '../../core/audio/dsp/keynet.mjs';
export { createTimer, timeDeps, summariseTimings, timingLine, timingReportLines, deviceClass, STAGES as TIMING_STAGES } from '../../core/audio/timing.mjs';
export { hearingFunnel, funnelText, funnelStages, funnelLines, FUNNEL_INSTEAD } from '../../core/audio/funnel.mjs';
export { decodeTo48k, needsClap, CLAP_MODEL_FILE, CLAP_FILL_PER_RUN } from '../../core/audio/clap.mjs';
