/* ---------- your data: every key this page writes, and why (BUILD-6 F7) ----------
 * The one list of what Betterfy keeps on this device and in Firestore. The
 * Settings sheet's "Your data" section is drawn from it, "Wipe this device"
 * clears what it names, and test/datakeys.test.mjs scans web/ and core/ for
 * storage writes and fails on any key that is not listed here. So a new key
 * means a new row below, with a reason a listener can read.
 *
 *   where   'local'      localStorage (and sessionStorage for bf_verifier)
 *           'idb'        a key in the IndexedDB database "betterfy", store "kv"
 *           'idb-db'     a whole IndexedDB database (and its object stores)
 *           'firestore'  a Firestore document path; {x} is any one segment
 *   key     the exact key, or with `prefix: true` the start of a family of keys
 *   keep    survives "Wipe this device" (only the theme does)
 *   readOnly  read but never written by the page (a flag set by hand); still wiped
 *
 * Plain data, no logic: tests load this file on its own. */
const DATA_KEYS = [
  // --- signing in to Spotify ---
  { where:'local', key:'bf_tok', group:'Signing in', why:'Your Spotify sign-in (an access token and the refresh token that renews it), so you stay signed in on this device.' },
  { where:'local', key:'bf_verifier', group:'Signing in', why:'A one-time code used for a few seconds while Spotify sends you back after signing in. Also held in sessionStorage.' },
  { where:'local', key:'bf_code_used', group:'Signing in', why:'The last sign-in code already exchanged, so a reload of the return page does not try to use it twice.' },
  { where:'local', key:'bf_autoconnect', group:'Signing in', why:'Remembers that you signed in here, so the next visit reconnects without a tap.' },
  { where:'local', key:'bf_client_id', group:'Signing in', why:'Your own Spotify app\'s client ID, only if you set one up under "use your own Spotify app".' },
  { where:'local', key:'bf_setup', group:'Signing in', why:'Keeps the "use your own Spotify app" panel open once you have opened it.' },
  { where:'local', key:'bf_gap', group:'Signing in', why:'How far apart to space requests to Spotify, learned from its rate limits, so the next visit starts at a safe pace.' },
  { where:'local', key:'bf_ratelimit_streak', group:'Signing in', why:'How many visits in a row hit Spotify\'s rate limit, to know when to suggest your own Spotify app.' },
  { where:'local', key:'__bf_probe', group:'Signing in', why:'A test write made and removed at once on load, to find out whether this browser allows storage at all.' },

  // --- your library and what you did with it ---
  { where:'idb', key:'library', group:'Your library', why:'A copy of your playlists and liked songs as read from Spotify (track ids, names, artists, ISRCs, cover links, dates added), so the app opens without re-reading everything.' },
  { where:'idb', key:'part:', prefix:true, group:'Your library', why:'Pieces of a library read that was interrupted, so the next try resumes instead of starting again. Dropped once a read completes, or after a day.' },
  { where:'idb', key:'actions', group:'Your library', why:'History: every change Betterfy made to your Spotify playlists, with what is needed to undo it.' },
  { where:'idb', key:'offline_queue', group:'Your library', why:'Decisions you made with no connection (filings, removals, unlikes), kept until the page is next open and online and then sent to Spotify once each. Empty the rest of the time. The page itself is kept for offline use in the browser\'s cache under "betterfy-shell-<build>".' },
  { where:'idb', key:'feedback', group:'Your library', why:'Tracks you skipped or turned down for a playlist, and filings you accepted, so the same suggestion is not made again.' },
  { where:'idb', key:'listening_raw', group:'Your library', why:'Your top artists and recently played tracks from Spotify, used to put what you actually play first.' },
  { where:'local', key:'bf_axes', group:'Your library', why:'What kind of playlist each one is (genre, mood, occasion...), as you set it.' },
  { where:'local', key:'bf_allsongs', group:'Your library', why:'The id of the "all songs" playlist Betterfy keeps for you, so it updates that one instead of making another.' },
  { where:'local', key:'bf_shuf_', prefix:true, group:'Your library', why:'Per source playlist: which playlist its spaced shuffle was written to, so re-shuffling replaces it rather than adding a second.' },
  { where:'local', key:'bf_mix_', prefix:true, group:'Your library', why:'Per source playlist: which playlist its DJ-order mix was written to, for the same reason.' },
  { where:'local', key:'bf_shuf_mode', group:'Your library', why:'The shuffle mode you last picked.' },
  { where:'local', key:'bf_shuf_flow', group:'Your library', why:'Whether shuffle should follow sound flow, as you last set it.' },
  { where:'local', key:'bf_shuf_redisc', group:'Your library', why:'Whether shuffle should mix in rediscoveries, as you last set it.' },
  { where:'local', key:'bf_disc_mem', group:'Your library', why:'Discover\'s memory: artist names you passed on (never offered again) and ones you liked or added from it (extra seeds).' },
  { where:'local', key:'bf_disc_auto', group:'Your library', why:'When Discover last looked for new music by itself, so it does that at most once a day.' },
  { where:'idb', key:'disc:picks', group:'Your library', why:'Discover\'s last picks (track names, artists, cover links and where each would fit), so it opens on them after a reload. Replaced by each new look.' },
  { where:'local', key:'bf_analysed', group:'Your library', why:'That this account\'s first analysis has run (it starts by itself on the first load).' },
  { where:'local', key:'bf_digest_seen', group:'Your library', why:'What File\'s "since you last opened" card saw last time (when, which misfits, new genres, each playlist\'s version), so it can say what is new.' },
  { where:'local', key:'bf_digest_measure', group:'Your library', why:'How often that card was shown, expanded or dismissed. Counts only, kept here and never sent.' },
  { where:'local', key:'bf_engscore', group:'Your library', why:'The headline of the last Score run (right first time, top three, how many tracks), for Library\'s "How well it knows you" card.' },
  { where:'local', key:'bf_fill', group:'Your library', why:'This account\'s own "Fill this playlist" score from the last Score run, which decides whether Fill is shown.' },
  { where:'local', key:'bf_teach', group:'Your library', why:'This account\'s own teach-queue measurement from the last Score run (the engine\'s score on your filed tracks before and after 20 simulated answers), which decides whether File shows the teach questions.' },
  { where:'local', key:'bf_tidy_sprint', group:'Your library', why:'Your last 20 Tidy sprints: how many tracks you decided, how fast, and how many moves you kept. Counts only, kept here and never sent.' },
  { where:'local', key:'bf_hidden_auto', group:'Your library', why:'When Tidy last checked a batch of your songs against Spotify search by itself, so it does that at most once a day.' },
  { where:'local', key:'bf_mergesplit', group:'Your library', why:'Which merge and split offers (twin playlists, playlists that are two genres) were shown, dismissed or made, and when. Counts only, kept here and never sent.' },
  { where:'local', key:'bf_onb_done', group:'Your library', why:'That you have finished the first-run steps on File.' },

  // --- release radar (Discover) ---
  { where:'idb', key:'radar:artist:', prefix:true, group:'Release radar', why:'Per artist in your library: when the radar last asked Spotify about their releases and the date of their newest, so it only asks again when one is due.' },
  { where:'idb', key:'radar:release:', prefix:true, group:'Release radar', why:'Each release the radar found by an artist in your library (name, date, cover link, track list where it was read), with whether you own it and whether it is a reissue.' },
  { where:'local', key:'bf_radar', group:'Release radar', why:'"off" once you pressed Stop on the radar, so it does not start by itself again on this device until you press Start.' },
  { where:'idb', key:'radar:index', group:'Release radar', why:'How far the radar\'s last read got, so a stopped read picks up where it stopped.' },
  { where:'idb', key:'radar:dismissed', group:'Release radar', why:'Releases you dismissed or filed from the radar, so they stay out of it.' },

  // --- genre data ---
  { where:'idb', key:'tags_extra', group:'Genre data', why:'Genre tags fetched for artists in your library that the shipped table does not cover (Last.fm, Wikidata, Discogs).' },
  { where:'idb', key:'tag_corrections', group:'Genre data', why:'Tags you corrected by hand for an artist.' },
  { where:'idb', key:'bridge-raw', group:'Genre data', why:'Similar-artist lists fetched from Deezer, ListenBrainz and Wikidata for the artists in your library.' },
  { where:'local', key:'bf_lfm', group:'Genre data', why:'Your own Last.fm API key, if you added one.' },
  { where:'local', key:'bf_discogs', group:'Genre data', why:'Your Discogs personal access token, if you added one.' },
  { where:'local', key:'bf_bridge_off', group:'Genre data', why:'Set when you turn similar-artist bridges off in How it picks.' },
  { where:'local', key:'bf_bridge_gate', group:'Genre data', why:'What your last Score run said about similar artists, so File uses them only if they helped your picks.' },

  // --- the engine ---
  { where:'idb', key:'engine-space-g', group:'Engine', why:'The engine\'s map of your library (how near each track sits to each playlist), so it does not rebuild on every visit.' },
  { where:'idb', key:'engine-calibration', group:'Engine', why:'How sure the engine\'s picks turned out to be on your own playlists, used for the confidence words.' },
  { where:'idb', key:'engine-blend', group:'Engine', why:'How File blends tag picks with the engine, from your Score run.' },
  { where:'idb', key:'engine-weights', group:'Engine', why:'The engine weights fitted to your library by a Score run.' },
  { where:'idb', key:'engine-tune', group:'Engine', why:'Tuning you saved from How it picks › Tune.' },
  { where:'local', key:'bf_weak', group:'Engine', why:'Which of your genre playlists your last Score run found it understands least, why, and what would help, for Library\'s advice and so listening hears those first.' },
  { where:'local', key:'bf_run_history', group:'Engine', why:'Your last Score runs (each one\'s full report, the text Copy results gives) and how each listening run ended, first ear and Deep listen, so the Engine screen\'s Past runs can copy any of them later.' },
  { where:'local', key:'bf_autoscore', group:'Engine', why:'When Score + Tune last ran (by itself or by hand), how many tracks listening had heard then, and whether it finished, so it runs again by itself after listening or in a week.' },

  // --- listening to your music ---
  { where:'idb-db', key:'betterfy-audio', stores:['audio_v1'], group:'Listening', why:'What Listening heard: one record per track (a sound fingerprint, tempo, key). Never the audio itself or the preview link.' },
  { where:'idb', key:'cluster_names', group:'Listening', why:'Names you gave to groups of tracks that sound alike.' },
  { where:'idb', key:'labelchecks', group:'Listening', why:'Your answers when checking mood, voice and energy labels.' },
  { where:'local', key:'bf_audio', group:'Listening', why:'Listening settings: on or off, and which tracks to listen to.' },
  { where:'local', key:'bf_audio_deep', group:'Listening', why:'Deep listen settings.' },
  { where:'local', key:'bf_audio_wifi_ok', group:'Listening', why:'That you said yes to listening on a metered connection.' },
  { where:'local', key:'bf_sound_nudge', group:'Listening', why:'That you dismissed the "listen to my music" suggestion on File.' },
  { where:'local', key:'bf_audio_labels', readOnly:true, group:'Listening', why:'Whether mood, voice and energy labels are shown (read only; set by hand for testing).' },
  { where:'local', key:'bf_audio_dsp', readOnly:true, group:'Listening', why:'Whether tempo and key readings are shown (read only; set by hand for testing).' },

  // --- the database itself ---
  { where:'idb-db', key:'betterfy', stores:['kv'], group:'Your library', why:'The database that holds every "betterfy" key above.' },

  // --- sync between your devices (only once you link a device) ---
  { where:'local', key:'bf_sync_auth', group:'Sync', why:'An anonymous Firebase sign-in for this device (no email, no name, nothing tied to your Spotify account), only once you link devices.' },
  { where:'local', key:'bf_sync_group', group:'Sync', why:'A random id for your group of linked devices, only once you link devices.' },
  { where:'firestore', key:'syncGroups/{group}/members/{device}', group:'Sync', why:'An empty document saying this device belongs to your sync group.' },
  { where:'firestore', key:'syncGroups/{group}/state/{doc}', group:'Sync', why:'Your skips and rejections (feedback), tag corrections (corrections), playlist types (axes) and sound-group names (clusterNames), so your linked devices agree. Readable only by devices in the group.' },
  { where:'firestore', key:'linkCodes/{code}', group:'Sync', why:'A six-digit code you asked for to link another device. Expires after ten minutes and is deleted when used.' },

  // --- the shared tag table ---
  { where:'local', key:'bf_tagshare_secret', group:'Shared tags', why:'A random number made on this device and never sent. Each tag you share carries a code worked out from it and the artist, so the shared table can count two different listeners agreeing, without those codes linking your shares to each other or to you.' },
  { where:'firestore', key:'tagContributions/{artistAndCode}', group:'Shared tags', why:'When a Last.fm fetch finds tags for an artist the shipped table lacks: that artist\'s Spotify id, a code that is different for every artist (see bf_tagshare_secret), and up to ten tags. No account, playlist or listening data, nothing that says who sent it. A tag joins the shared table only once two listeners have sent it.' },

  // --- the look ---
  { where:'local', key:'betterfy-theme', keep:true, group:'Look', why:'Your colour, density and filter settings. Kept by "Wipe this device".' },
];

/** Who outside this device hears from the page, and what they are sent. */
const DATA_SERVICES = [
  { name:'Spotify', what:'Your sign-in. The page reads your profile, playlists, liked songs, top artists, recently played and playback; it writes to your playlists and liked songs only when you tap (every write is in History).' },
  { name:'Last.fm', what:'Artist names, to fetch their genre tags and similar artists, with the shared key or your own.' },
  { name:'Wikidata', what:'Spotify artist ids, in batches, to find genres and MusicBrainz ids. No key.' },
  { name:'ListenBrainz', what:'MusicBrainz artist ids, for similar artists. No key.' },
  { name:'Deezer', what:'Track ISRCs, to find related artists and, when Listening is on, the 30-second previews it listens to on this device. No key.' },
  { name:'Discogs', what:'Artist names and your token, only if you saved a Discogs token.' },
  { name:'Firestore (shared tags)', what:'An artist\'s Spotify id and tags, when you fetched tags the shipped table lacks. Nothing about you.' },
  { name:'Firestore (sync)', what:'Only if you link devices: your feedback, tag corrections, playlist types and sound-group names, under a random group id.' },
  { name:'Google reCAPTCHA', what:'Only when the shared tag table has App Check switched on: the reCAPTCHA check that proves a tag contribution comes from this page.' },
  { name:'jsDelivr', what:'Nothing about you: the page downloads the listening runtime from it when Listening is on.' },
  { name:'MusicBrainz', what:'Nothing from this page. Only the command-line tools (npm run enrich) call it.' },
];
