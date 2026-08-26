/** Interface : dépôt du PDF, aperçu, synchronisation, réglages. */

import * as pdfjs from './vendor/pdf.min.mjs';
import { extraire, listerPersonnes, ErreurPDF } from './parse.js';
import { TableCodes, ErreurCodes } from './codes.js';
import * as gcal from './gcal.js';
import * as store from './store.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const LIBELLES_GENRE = {
  creer: 'à créer', mettreAJour: 'à mettre à jour',
  supprimer: 'à supprimer', inchange: 'inchangé',
};

let config = store.charger();
let donneesPdf = null;      // Uint8Array du PDF courant
let nomPdf = '';
let planning = null;
let actions = null;

// ------------------------------------------------------------------ affichage

function message(texte, type = '') {
  const el = $('message');
  el.textContent = texte;
  el.className = `encart ${type}`.trim();
  el.hidden = !texte;
}

function majEtatCompte() {
  const el = $('etatCompte');
  if (gcal.connecte()) { el.textContent = 'connecté'; el.dataset.etat = 'connecte'; }
  else { el.textContent = 'non connecté'; el.dataset.etat = 'hors'; }
}

function majAlerteReglages() {
  const manque = store.incomplet(config);
  $('alerteReglages').hidden = manque.length === 0;
  $('alerteDetail').textContent = manque.length ? ` Il manque : ${manque.join(', ')}.` : '';
  return manque.length === 0;
}

const formatJour = (iso) => {
  const [a, m, j] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return `${JOURS[d.getUTCDay()]} ${String(j).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
};

function table() {
  return new TableCodes({ codes: config.codes, postes: config.postes });
}

function afficherPlanning() {
  const t = table();
  const corps = $('tablePlanning').querySelector('tbody');
  corps.replaceChildren();

  for (const jour of planning.jours) {
    const tr = document.createElement('tr');
    let detail;
    let creneau = null;
    try { creneau = t.resoudre(jour.code); } catch (e) { detail = e.message; }

    if (detail) tr.className = 'probleme';
    else if (!creneau) { tr.className = 'probleme'; detail = 'code non défini'; }
    else if (creneau.off) { tr.className = 'repos'; detail = creneau.libelle || 'non travaillé'; }
    else {
      detail = `${creneau.debut} – ${creneau.fin}${creneau.lendemain ? ' (J+1)' : ''}`;
      if (creneau.libelle) detail += ` — ${creneau.libelle}`;
    }

    for (const [texte, cls] of [[formatJour(jour.date), ''], [jour.code, 'code'], [detail, '']]) {
      const td = document.createElement('td');
      td.textContent = texte;
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    corps.appendChild(tr);
  }

  $('titrePlanning').textContent = planning.personne;
  $('sousTitrePlanning').textContent =
    `du ${formatJour(planning.debut)} au ${formatJour(planning.fin)}` +
    (planning.edition ? ` · édition du ${planning.edition}` : '');

  const { aCompleter, inconnus } = t.diagnostic(planning.jours.map((j) => j.code));
  const bloque = aCompleter.length + inconnus.length > 0;
  const el = $('codesManquants');
  el.hidden = !bloque;
  if (bloque) {
    el.textContent =
      `Synchronisation impossible : ${[...aCompleter, ...inconnus].join(', ')} ` +
      `${aCompleter.length + inconnus.length > 1 ? 'ne sont pas définis' : "n'est pas défini"}. ` +
      `Complète la table des codes dans les réglages.`;
  }
  $('btnApercu').disabled = bloque;
  $('resultat').hidden = false;
  $('plan').hidden = true;
}

function afficherPlan(liste, titre) {
  const conteneur = $('planListe');
  conteneur.replaceChildren();
  const aFaire = liste.filter((a) => a.genre !== 'inchange');

  if (!aFaire.length) {
    const p = document.createElement('p');
    p.className = 'discret';
    p.textContent = 'Agenda déjà à jour, rien à faire.';
    conteneur.appendChild(p);
  }

  for (const genre of ['creer', 'mettreAJour', 'supprimer', 'inchange']) {
    const groupe = liste.filter((a) => a.genre === genre);
    if (!groupe.length) continue;
    const div = document.createElement('div');
    div.className = 'groupe';
    div.dataset.genre = genre;
    const h = document.createElement('h4');
    h.textContent = `${LIBELLES_GENRE[genre]} (${groupe.length})`;
    div.appendChild(h);
    const ul = document.createElement('ul');
    for (const a of groupe) {
      const li = document.createElement('li');
      li.textContent = `${formatJour(a.date)} · ${a.code} · ${a.resume}`;
      ul.appendChild(li);
    }
    div.append(ul);
    conteneur.appendChild(div);
  }

  $('plan').querySelector('h3').textContent = titre;
  $('btnAppliquer').disabled = !aFaire.length;
  $('btnAppliquer').textContent = aFaire.length ? `Appliquer (${aFaire.length})` : 'Rien à appliquer';
  $('plan').hidden = false;
  $('progression').hidden = true;
}

// --------------------------------------------------------------------- PDF

async function chargerPdf(fichier) {
  message('Lecture du PDF…');
  try {
    donneesPdf = new Uint8Array(await fichier.arrayBuffer());
    nomPdf = fichier.name || 'planning.pdf';

    const noms = await listerPersonnes(donneesPdf.slice(), pdfjs);
    const liste = $('listePersonnes');
    liste.replaceChildren();
    for (const n of noms) {
      const o = document.createElement('option');
      o.value = n;
      liste.appendChild(o);
    }
    $('aidePersonne').textContent = `${noms.length} noms trouvés dans le PDF chargé.`;

    if (!config.personne) {
      message(`${noms.length} noms trouvés. Choisis le tien dans les réglages.`, 'avertissement');
      ouvrirReglages();
      return;
    }
    planning = await extraire(donneesPdf.slice(), config.personne, pdfjs);
    message('');
    afficherPlanning();
  } catch (e) {
    planning = null;
    $('resultat').hidden = true;
    message(e instanceof ErreurPDF || e instanceof ErreurCodes
      ? e.message : `Lecture impossible : ${e.message}`, 'erreur');
  }
}

// ------------------------------------------------------------- autorisation

async function assurerConnexion() {
  if (gcal.connecte()) return true;
  if (!config.clientId) {
    message("Renseigne l'identifiant client OAuth dans les réglages.", 'avertissement');
    ouvrirReglages();
    return false;
  }
  try {
    message('Autorisation Google…');
    await gcal.autoriser(config.clientId, { silencieux: true });
    majEtatCompte();
    message('');
    return true;
  } catch (e) {
    majEtatCompte();
    message(e.message, 'erreur');
    return false;
  }
}

// ------------------------------------------------------------------ réglages

function ligneEditeur(champs, valeurs, onSuppr) {
  const tr = document.createElement('tr');
  for (const champ of champs) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = champ.type || 'text';
    if (champ.type === 'checkbox') input.checked = !!valeurs[champ.cle];
    else input.value = valeurs[champ.cle] ?? '';
    if (champ.placeholder) input.placeholder = champ.placeholder;
    input.dataset.cle = champ.cle;
    td.appendChild(input);
    tr.appendChild(td);
  }
  const td = document.createElement('td');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icone';
  b.textContent = '✕';
  b.title = 'Supprimer cette ligne';
  b.addEventListener('click', () => { tr.remove(); onSuppr?.(); });
  td.appendChild(b);
  tr.appendChild(td);
  return tr;
}

const CHAMPS_POSTE = [
  { cle: 'chiffre', placeholder: '1' }, { cle: 'debut', placeholder: '04:00' },
  { cle: 'fin', placeholder: '12:00' }, { cle: 'libelle', placeholder: 'Matin' },
];
const CHAMPS_CODE = [
  { cle: 'code', placeholder: 'ABC' }, { cle: 'debut', placeholder: '08:00' },
  { cle: 'fin', placeholder: '17:00' }, { cle: 'off', type: 'checkbox' },
  { cle: 'libelle', placeholder: 'Formation' },
];

function remplirEditeurs() {
  const p = $('corpsPostes');
  p.replaceChildren();
  for (const [chiffre, v] of Object.entries(config.postes).sort()) {
    p.appendChild(ligneEditeur(CHAMPS_POSTE, { chiffre, ...v }));
  }
  const c = $('corpsCodes');
  c.replaceChildren();
  for (const [code, v] of Object.entries(config.codes).sort()) {
    c.appendChild(ligneEditeur(CHAMPS_CODE, { code, ...v }));
  }
}

function lireEditeurs() {
  const lire = (tbody) => [...tbody.querySelectorAll('tr')].map((tr) => {
    const o = {};
    for (const i of tr.querySelectorAll('input')) {
      o[i.dataset.cle] = i.type === 'checkbox' ? i.checked : i.value.trim();
    }
    return o;
  });

  const postes = {};
  for (const l of lire($('corpsPostes'))) {
    if (!l.chiffre) continue;
    if (!/^\d$/.test(l.chiffre)) throw new ErreurCodes(
      `Règle de poste « ${l.chiffre} » : attendu un chiffre unique.`);
    postes[l.chiffre] = { debut: l.debut, fin: l.fin, ...(l.libelle ? { libelle: l.libelle } : {}) };
  }

  const codes = {};
  for (const l of lire($('corpsCodes'))) {
    if (!l.code) continue;
    codes[l.code] = l.off
      ? { off: true, ...(l.libelle ? { libelle: l.libelle } : {}) }
      : { debut: l.debut, fin: l.fin, ...(l.libelle ? { libelle: l.libelle } : {}) };
  }
  // Validation immédiate : mieux vaut refuser d'enregistrer qu'échouer plus tard.
  const t = new TableCodes({ codes, postes });
  for (const code of Object.keys(codes)) if (!codes[code].todo) t.resoudre(code);
  for (const d of Object.keys(postes)) t.resoudre(`0${d}`);
  return { postes, codes };
}

function ouvrirReglages() {
  $('rClientId').value = config.clientId;
  $('rPersonne').value = config.personne;
  $('rTag').value = config.tag;
  $('rFuseau').value = config.fuseau;
  $('rJoursOff').checked = config.joursOffEnJourneeEntiere;
  $('rHeritage').value = config.heritagePrefixe;

  const sel = $('rCouleur');
  sel.replaceChildren();
  for (const [id, nom] of Object.entries(store.COULEURS)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = `${id} — ${nom}`;
    o.selected = String(config.couleur) === id;
    sel.appendChild(o);
  }

  const cal = $('rCalendrier');
  if (config.calendarId && !cal.querySelector(`option[value="${CSS.escape(config.calendarId)}"]`)) {
    const o = document.createElement('option');
    o.value = config.calendarId;
    o.textContent = config.calendarNom || config.calendarId;
    cal.appendChild(o);
  }
  cal.value = config.calendarId;

  remplirEditeurs();
  $('messageReglages').textContent = '';
  $('reglages').showModal();
}

async function enregistrerReglages() {
  const { postes, codes } = lireEditeurs();
  const cal = $('rCalendrier');
  config = store.enregistrer({
    ...config,
    clientId: $('rClientId').value.trim(),
    personne: $('rPersonne').value.trim().toUpperCase(),
    calendarId: cal.value,
    calendarNom: cal.selectedOptions[0]?.textContent || '',
    tag: $('rTag').value.trim(),
    couleur: $('rCouleur').value,
    fuseau: $('rFuseau').value.trim() || config.fuseau,
    joursOffEnJourneeEntiere: $('rJoursOff').checked,
    heritagePrefixe: $('rHeritage').value.trim(),
    postes, codes,
  });
  majAlerteReglages();
  store.rendrePersistant();
  await reanalyser();
}

/** Ré-extrait la ligne depuis le PDF déjà en mémoire (nom ou codes modifiés). */
async function reanalyser() {
  if (!donneesPdf || !config.personne) return;
  try {
    planning = await extraire(donneesPdf.slice(), config.personne, pdfjs);
    message('');
    afficherPlanning();
  } catch (e) {
    planning = null;
    $('resultat').hidden = true;
    message(e.message, 'erreur');
  }
}

// -------------------------------------------------------------- synthèse

/** Synthèse en texte brut, alignée, prête à coller dans un message. */
function syntheseTexte() {
  const t = table();
  const lignes = planning.jours.map((jour) => {
    let creneau = null;
    try { creneau = t.resoudre(jour.code); } catch { /* signalé dans le tableau */ }
    let detail;
    if (!creneau) detail = '(code non défini)';
    else if (creneau.off) detail = creneau.libelle || 'repos';
    else {
      detail = `${creneau.debut}-${creneau.fin}${creneau.lendemain ? ' (J+1)' : ''}`;
      if (creneau.libelle) detail += `  ${creneau.libelle}`;
    }
    return [formatJour(jour.date), jour.code, detail];
  });

  const largeur = [0, 1].map((i) => Math.max(...lignes.map((l) => l[i].length)));
  const corps = lignes
    .map((l) => `${l[0].padEnd(largeur[0])}  ${l[1].padEnd(largeur[1])}  ${l[2]}`.trimEnd())
    .join('\n');

  const entete = `${planning.personne} — du ${formatJour(planning.debut)} ` +
    `au ${formatJour(planning.fin)}` +
    (planning.edition ? ` (édition du ${planning.edition})` : '');
  return `${entete}\n${corps}`;
}

async function copierSynthese(bouton) {
  const texte = syntheseTexte();
  const initial = bouton.textContent;
  try {
    await navigator.clipboard.writeText(texte);
    bouton.textContent = 'Copié ✓';
  } catch {
    // Presse-papiers refusé (contexte non sécurisé, permission) : on propose
    // une sélection manuelle plutôt que d'échouer sans recours.
    const zone = document.createElement('textarea');
    zone.value = texte;
    zone.setAttribute('readonly', '');
    zone.className = 'synthese-repli';
    bouton.after(zone);
    zone.select();
    bouton.textContent = 'Copie manuelle';
    setTimeout(() => zone.remove(), 30000);
  }
  setTimeout(() => { bouton.textContent = initial; }, 2500);
}

// -------------------------------------------------------------- branchements

function brancher() {
  const zone = $('zoneDepot');
  const input = $('fichier');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) chargerPdf(input.files[0]);
    input.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('survol'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('survol'); });
  }
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) chargerPdf(f);
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  $('btnCopier').addEventListener('click', (e) => copierSynthese(e.currentTarget));

  $('btnFermer').addEventListener('click', () => {
    planning = null; donneesPdf = null;
    $('resultat').hidden = true; message('');
  });

  $('btnApercu').addEventListener('click', async () => {
    if (!await assurerConnexion()) return;
    try {
      message('Lecture de l’agenda…');
      actions = await gcal.preparer(planning, config, table(), nomPdf);
      message('');
      afficherPlan(actions, 'Synchronisation');
    } catch (e) { message(e.message, 'erreur'); }
  });

  $('btnRevert').addEventListener('click', async () => {
    if (!await assurerConnexion()) return;
    try {
      message('Lecture de l’agenda…');
      actions = await gcal.preparerRevert(planning, config);
      message('');
      afficherPlan(actions, 'Annulation de cet import');
    } catch (e) { message(e.message, 'erreur'); }
  });

  $('btnAnnulerPlan').addEventListener('click', () => { $('plan').hidden = true; });

  $('btnAppliquer').addEventListener('click', async () => {
    const aFaire = actions.filter((a) => a.genre !== 'inchange');
    if (!aFaire.length) return;
    if (!await assurerConnexion()) return;
    const barre = $('progression');
    barre.hidden = false; barre.value = 0; barre.max = aFaire.length;
    $('btnAppliquer').disabled = true;
    try {
      await gcal.appliquer(actions, config, (n) => { barre.value = n; });
      message(`${aFaire.length} événement(s) traité(s).`, 'succes');
      $('plan').hidden = true;
    } catch (e) {
      message(`Interrompu : ${e.message}`, 'erreur');
    } finally {
      $('btnAppliquer').disabled = false;
      barre.hidden = true;
      majEtatCompte();
    }
  });

  $('btnReglages').addEventListener('click', ouvrirReglages);
  $('btnOuvrirReglages').addEventListener('click', ouvrirReglages);

  // La validation a lieu AVANT la fermeture : un réglage invalide laisse la
  // boîte ouverte avec les saisies intactes, plutôt que de les perdre.
  $('btnEnregistrer').addEventListener('click', async () => {
    try {
      await enregistrerReglages();
      $('reglages').close('enregistre');
    } catch (err) {
      $('messageReglages').textContent = err.message;
    }
  });

  $('btnAjoutPoste').addEventListener('click', () =>
    $('corpsPostes').appendChild(ligneEditeur(CHAMPS_POSTE, {})));
  $('btnAjoutCode').addEventListener('click', () =>
    $('corpsCodes').appendChild(ligneEditeur(CHAMPS_CODE, {})));

  $('btnConnecter').addEventListener('click', async () => {
    const id = $('rClientId').value.trim();
    if (!id) { $('messageReglages').textContent = "Renseigne l'identifiant client."; return; }
    try {
      await gcal.autoriser(id);
      config = store.enregistrer({ ...config, clientId: id });
      $('messageReglages').textContent = 'Connecté.';
      majEtatCompte();
    } catch (e) { $('messageReglages').textContent = e.message; }
  });

  $('btnDeconnecter').addEventListener('click', () => {
    gcal.oublierJeton();
    majEtatCompte();
    $('messageReglages').textContent = 'Déconnecté.';
  });

  $('btnChargerAgendas').addEventListener('click', async () => {
    const id = $('rClientId').value.trim();
    if (!gcal.connecte()) {
      try { await gcal.autoriser(id, { silencieux: true }); majEtatCompte(); }
      catch (e) { $('messageReglages').textContent = e.message; return; }
    }
    try {
      const agendas = await gcal.listerAgendas();
      const sel = $('rCalendrier');
      sel.replaceChildren();
      const vide = document.createElement('option');
      vide.value = ''; vide.textContent = '— non choisi —';
      sel.appendChild(vide);
      for (const a of agendas) {
        const o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.summary || a.id;
        if (!gcal.inscriptible(a)) { o.textContent += ' (lecture seule)'; o.disabled = true; }
        sel.appendChild(o);
      }
      sel.value = config.calendarId;
      $('messageReglages').textContent = `${agendas.length} agendas.`;
    } catch (e) { $('messageReglages').textContent = e.message; }
  });

  $('btnExporter').addEventListener('click', () => {
    const blob = new Blob([store.exporter(config)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pdf2agenda-reglages.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('btnImporter').addEventListener('click', () => $('fichierImport').click());
  $('fichierImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      config = store.importer(await f.text());
      remplirEditeurs();
      $('reglages').close('rien');
      ouvrirReglages();
      $('messageReglages').textContent = 'Réglages importés.';
      majAlerteReglages();
    } catch (err) { $('messageReglages').textContent = `Import impossible : ${err.message}`; }
    e.target.value = '';
  });

  $('btnReset').addEventListener('click', () => {
    if (!confirm('Effacer tous les réglages de cet appareil ?')) return;
    store.effacer();
    config = store.charger();
    gcal.oublierJeton();
    $('reglages').close('rien');
    majAlerteReglages();
    majEtatCompte();
    message('Réglages effacés.', 'avertissement');
  });
}

// ------------------------------------------------------------------ démarrage

brancher();
majEtatCompte();
majAlerteReglages();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// PDF reçu via le partage Android : le service worker l'a mis de côté.
(async () => {
  if (!new URLSearchParams(location.search).has('partage')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('pdf2agenda-partage');
    const r = await cache.match('fichier');
    if (!r) return;
    await cache.delete('fichier');
    const blob = await r.blob();
    await chargerPdf(new File([blob], r.headers.get('x-nom') || 'planning.pdf',
                              { type: 'application/pdf' }));
  } catch { /* le partage a échoué : l'utilisateur peut déposer le PDF à la main */ }
})();
