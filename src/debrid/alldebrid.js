// All-Debrid integration
// L'API AD non ha più /magnet/instant (rimosso).
// Il check di cache si fa via POST /magnet/upload con magnets[] batch:
//   - ready:true  → già in cache AD → mostriamo lo stream
//   - ready:false → non in cache   → eliminiamo il magnet dalla coda AD
// La risoluzione effettiva (al click play) usa uploadMagnet + status loop.
const fetch = require('node-fetch');
const { getConfig } = require('../config');
const { findFileForEpisode } = require('../parse');

const BASE = 'https://api.alldebrid.com/v4';
const AGENT = 'pezzottio';
const TIMEOUT = 12000;

function authHeaders() {
  const key = getConfig().alldebridKey;
  return {
    'Authorization': `Bearer ${key}`,
    'User-Agent': AGENT,
  };
}

function getKey() {
  return getConfig().alldebridKey;
}

// Elimina un magnet dalla coda AD (fire-and-forget, no await necessario).
async function deleteMagnet(id) {
  try {
    const key = getKey();
    await fetch(`${BASE}/magnet/delete?agent=${AGENT}&apikey=${key}&id=${id}`, {
      method: 'POST',
      timeout: 5000,
    });
  } catch (_) { /* ignora */ }
}

// Batch check cached usando POST /magnet/upload con array magnets[].
// La risposta include ready:true per quelli già in cache, ready:false per gli altri.
// I non-cached vengono subito eliminati dalla coda AD per non sporcarla.
// Limite: max 30 magnets attivi su AD. Dividiamo in chunk da 20.
async function checkCachedBatch(hashes) {
  const map = new Map();
  if (!hashes.length) return map;
  const key = getKey();
  if (!key) return map;

  // Batch da 20 per non superare il limite AD
  const CHUNK = 20;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    try {
      const body = new URLSearchParams();
      chunk.forEach(h => body.append('magnets[]', h));

      const res = await fetch(`${BASE}/magnet/upload?agent=${AGENT}&apikey=${key}`, {
        method: 'POST',
        body,
        timeout: TIMEOUT,
      });

      if (!res.ok) {
        console.error(`[AD] upload batch HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();

      if (json?.status !== 'success') {
        const errCode = json?.error?.code || json?.error?.message || JSON.stringify(json?.error);
        console.error('[AD] upload batch error:', errCode);
        continue;
      }

      const magnets = json?.data?.magnets || [];
      const ready = magnets.filter(r => r.ready && r.hash);
      const notReady = magnets.filter(r => !r.ready && r.id && !r.error);

      console.log(`[AD] batch ${i / CHUNK + 1}: ${chunk.length} hashes → ${ready.length} cached`);

      // Segna i cached
      for (const r of ready) {
        map.set(String(r.hash).toLowerCase(), { files: [], name: r.name || '' });
      }

      // Elimina i non-cached dalla coda AD (fire-and-forget)
      for (const r of notReady) {
        deleteMagnet(r.id);
      }
    } catch (e) {
      console.error('[AD] checkCachedBatch chunk error:', e.message);
    }
  }

  return map;
}

async function getMylistMap() {
  return new Map();
}

// Carica un singolo magnet su AD e attende che diventi Ready.
// Usato solo al momento del click play (getStreamUrl).
async function uploadMagnet(magnet) {
  const key = getKey();
  const body = new URLSearchParams();
  body.append('magnets[]', magnet);
  const res = await fetch(`${BASE}/magnet/upload?agent=${AGENT}&apikey=${key}`, {
    method: 'POST',
    body,
    timeout: TIMEOUT,
  });
  const json = await res.json();
  if (json?.status === 'success' && json.data?.magnets?.[0] && !json.data.magnets[0].error) {
    return json.data.magnets[0];
  }
  throw new Error(`AD upload failed: ${JSON.stringify(json?.error || json)}`);
}

async function getMagnetStatus(id) {
  const key = getKey();
  // v4.1 endpoint per lo status
  const res = await fetch(`${BASE}.1/magnet/status?agent=${AGENT}&apikey=${key}&id=${id}`, {
    timeout: TIMEOUT,
  });
  const json = await res.json();
  if (json?.status === 'success') {
    // magnets può essere array o oggetto singolo
    const magnets = json.data?.magnets;
    if (Array.isArray(magnets)) return magnets[0] || null;
    return magnets || null;
  }
  return null;
}

async function unlockLink(link) {
  const key = getKey();
  const body = new URLSearchParams();
  body.append('link', link);
  const res = await fetch(`${BASE}/link/unlock?agent=${AGENT}&apikey=${key}`, {
    method: 'POST',
    body,
    timeout: TIMEOUT,
  });
  const json = await res.json();
  if (json?.status === 'success' && json.data?.link) {
    return json.data.link;
  }
  return null;
}

// Ottieni la lista file di un magnet pronto.
// POST /magnet/files con id[]=ID
// Risposta: data.magnets[].files → struttura ad albero {n, s, l, e[]}
async function getMagnetFiles(id) {
  const key = getKey();
  const body = new URLSearchParams();
  body.append('id[]', String(id));
  const res = await fetch(`${BASE}/magnet/files?agent=${AGENT}&apikey=${key}`, {
    method: 'POST',
    body,
    timeout: TIMEOUT,
  });
  const json = await res.json();
  if (json?.status === 'success') {
    const magnets = json?.data?.magnets || [];
    if (magnets.length && magnets[0].files) return magnets[0].files;
  }
  console.error('[AD] getMagnetFiles error:', JSON.stringify(json?.error || json));
  return [];
}

// Appiattisce la struttura ad albero dei file AD in una lista piatta.
// Ogni nodo può essere {n, s, l} (file) oppure {n, e:[...]} (cartella).
function flattenFiles(nodes, prefix) {
  const result = [];
  for (const node of nodes || []) {
    const name = prefix ? `${prefix}/${node.n}` : node.n;
    if (node.l) {
      // È un file con link diretto
      result.push({ filename: node.n, fullPath: name, link: node.l, size: node.s || 0 });
    } else if (node.e && Array.isArray(node.e)) {
      // È una cartella — ricorsione
      result.push(...flattenFiles(node.e, name));
    }
  }
  return result;
}

function pickBestFile(files, season, episode) {
  if (!files || !files.length) return null;
  const videoRe = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i;
  const videos = files.filter(f => videoRe.test(f.filename || ''));
  if (!videos.length) return null;

  if (season && episode) {
    const mapped = videos.map(f => ({ ...f, name: f.filename, short_name: f.filename }));
    const match = findFileForEpisode(mapped, season, episode);
    if (match) return match;
  }

  return videos.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

async function getStreamUrl(infoHash, magnet, season, episode) {
  if (!getKey()) return null;
  const magnetUri = magnet || `magnet:?xt=urn:btih:${infoHash}`;
  try {
    const up = await uploadMagnet(magnetUri);
    if (!up || !up.id) {
      console.error('[AD] upload returned no id:', JSON.stringify(up));
      return null;
    }
    console.log(`[AD] uploaded id=${up.id} ready=${up.ready} name="${up.name || ''}"`);

    // Attendi che il magnet sia Ready (statusCode=4)
    let status = await getMagnetStatus(up.id);
    console.log(`[AD] status id=${up.id} statusCode=${status?.statusCode} status=${status?.status}`);

    let attempts = 0;
    while (status && status.statusCode !== 4 && attempts < 10) {
      if (status.statusCode === -1) {
        console.error(`[AD] magnet ${up.id} in error state`);
        deleteMagnet(up.id);
        return null;
      }
      await new Promise(r => setTimeout(r, 1500));
      status = await getMagnetStatus(up.id);
      console.log(`[AD] poll ${attempts + 1}: statusCode=${status?.statusCode}`);
      attempts++;
    }

    if (!status || status.statusCode !== 4) {
      console.log(`[AD] not ready after ${attempts} polls (statusCode=${status?.statusCode})`);
      return null;
    }

    // Scarica lista file tramite /magnet/files
    const rawFiles = await getMagnetFiles(up.id);
    const files = flattenFiles(rawFiles);
    console.log(`[AD] files count=${files.length}:`, files.map(f => f.filename).join(', ').slice(0, 200));

    if (!files.length) {
      console.log('[AD] no files returned');
      return null;
    }

    const file = pickBestFile(files, season, episode);
    if (!file || !file.link) {
      console.log('[AD] no matching file found, first file:', files[0]?.filename);
      return null;
    }

    console.log(`[AD] unlocking: ${file.filename} → ${file.link.slice(0, 60)}`);
    const unlocked = await unlockLink(file.link);
    if (!unlocked) console.error('[AD] unlock returned null');
    return unlocked;
  } catch (e) {
    console.error('[AD] getStreamUrl error:', e.message);
    return null;
  }
}


module.exports = { name: 'AD', getStreamUrl, checkCachedBatch, getMylistMap };
