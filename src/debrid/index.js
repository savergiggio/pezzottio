const { getConfig } = require('../config');
const realdebrid = require('./realdebrid');
const torbox = require('./torbox');
const alldebrid = require('./alldebrid');

// Lista di TUTTI i provider configurati. L'utente può avere RD, TB, AD o tutti e tre.
function activeProviders() {
  const c = getConfig();
  const out = [];
  if (c.torboxKey) out.push(torbox);
  if (c.realdebridKey) out.push(realdebrid);
  if (c.alldebridKey) out.push(alldebrid);
  return out;
}

// Backward compat — alcuni call site usano ancora "il" provider attivo.
function activeProvider() {
  return activeProviders()[0] || null;
}

module.exports = { activeProvider, activeProviders };
