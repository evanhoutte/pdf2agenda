# pdf2agenda

Reporte une ligne d'un planning PDF tabulaire vers Google Agenda, sous forme de
créneaux horaires. Fonctionne dans le navigateur, sur ordinateur comme sur
Android : **le PDF ne quitte jamais l'appareil**, seuls les événements créés
partent chez Google.

## Ce dépôt ne contient aucune donnée

Ni nom, ni agenda, ni table de codes, ni PDF. Tout cela vit dans le
`localStorage` de ton navigateur et s'exporte en JSON quand tu veux le
transporter. Le dépôt peut donc être public sans risque.

La seule valeur propre à toi est l'**identifiant client OAuth**, saisi dans les
réglages et stocké localement lui aussi. Il est public par conception dans une
application web — c'est la liste des origines JavaScript autorisées qui le
protège. **Ne mets jamais un *client secret* dans une application web** ; le
flux navigateur n'en utilise pas.

## Mise en place

### 1. Publier la page

N'importe quel hébergeur statique en HTTPS. `https://` est obligatoire :
l'autorisation Google et le service worker le réclament.

- **Cloudflare Pages** ou **Netlify** — déploient depuis un dépôt **privé**
  en offre gratuite. Recommandé.
- **GitHub Pages** — impose un dépôt public en offre gratuite.

Aucune étape de compilation : le dossier est servi tel quel.

Pour essayer avant de publier :

```bash
python3 -m http.server 8765
```

puis `http://localhost:8765`. Google accepte `http://localhost` comme origine
autorisée — ajoute-la à ton client OAuth le temps des essais.

### 2. Créer l'identifiant OAuth

1. [console.cloud.google.com](https://console.cloud.google.com) → crée un projet.
2. **APIs et services → Bibliothèque** : active *Google Calendar API*.
3. **Écran de consentement OAuth** : type **Externe**, puis ajoute ton adresse
   dans **Utilisateurs de test**.
4. **Identifiants → Créer des identifiants → ID client OAuth**, type
   **Application Web**. Dans *Origines JavaScript autorisées*, mets l'URL de ta
   page (`https://…`, sans barre oblique finale).
5. Copie l'identifiant client dans les réglages de l'application.

Un client de type *Application de bureau* ne convient pas ici.

### 3. Régler l'application

Ouvre ⚙, puis dans l'ordre :

1. colle l'identifiant client, **Se connecter** ;
2. **Charger mes agendas**, choisis la destination ;
3. dépose un PDF : la liste des noms qu'il contient alimente le champ
   *Personne*, ce qui évite les fautes de frappe ;
4. renseigne la **règle des postes** et les **codes particuliers** ;
5. **Enregistrer**.

Sur Android, « Ajouter à l'écran d'accueil » installe l'application : elle
s'ouvre en plein écran, et tu peux **partager un PDF directement depuis ta
messagerie vers pdf2agenda**.

## Table des codes

**Règle des postes** — s'applique aux codes « 3 chiffres + suffixe facultatif »
(`601`, `121D`, `422B`, `603MB`, `902FD`, `601D*`). C'est le **troisième
chiffre** qui détermine le créneau ; les deux premiers et le suffixe de variante
— quelle que soit sa longueur — n'ont aucune incidence horaire. Un `*` final est
ignoré. Un code qui ne suit pas cette forme (`D01`, `F03`, quatre chiffres…)
n'est jamais interprété : il bloque la synchronisation.

**Codes particuliers** — priment sur la règle. Coche *repos* pour un jour non
travaillé (aucun événement créé, sauf si tu actives les journées entières).

Une heure de fin antérieure à l'heure de début signifie que le créneau passe
minuit : `20:00 → 04:00` crée un événement se terminant le lendemain matin.

Un code que ni la règle ni la table ne couvrent **bloque la synchronisation** et
s'affiche en clair. Sur un planning de travail posté, un créneau manquant en
silence serait pire qu'une erreur visible.

## Synchronisation

Les événements posés portent des propriétés privées, invisibles dans
l'interface Google. C'est cette marque — pas le titre, pas la date — qui sert à
les retrouver : **tes événements personnels ne sont jamais touchés**, même le
même jour.

Reposer le même PDF corrigé ne crée donc pas de doublons : l'application compare
l'agenda au PDF et ne crée, modifie ou supprime que ce qui a changé. La
comparaison est strictement bornée à la période du PDF, pour ne pas confondre
les créneaux d'une quinzaine voisine avec des orphelins.

**Annuler cet import** retire les créneaux posés sur la période du PDF, et eux
seuls.

Si une version antérieure du programme a déjà posé des créneaux, renseigne son
**préfixe de marque** dans les réglages : ses événements seront repris en place
au lieu d'être dupliqués. Laisse le champ vide si c'est sans objet.

## Réglages : sauvegarde et transfert

Le `localStorage` est propre à un navigateur **et** à un appareil : la
configuration du PC n'est pas celle du téléphone. **Exporter…** produit un JSON
à réimporter sur l'autre appareil. Il contient tes réglages — garde-le hors de
tout dépôt.

L'identifiant client n'est pas inclus dans l'export : il dépend de l'origine
autorisée, donc de l'hébergement.

Le jeton d'accès Google, lui, **n'est jamais écrit sur le disque**. Il reste en
mémoire et dure environ une heure : un accès au stockage du navigateur ne donne
aucun accès à ton agenda. En contrepartie, il faut cliquer sur *Se connecter* à
chaque session.

## Vérification

```bash
node test.mjs
```

Rejoue la synchronisation contre un faux serveur Google : agenda vide, déjà à
jour, créneau modifié, jour passé en repos, période voisine préservée, migration
depuis la version Python, annulation, code inconnu rejeté. Aucun accès réseau,
aucun compte requis.

## Fichiers

| | |
|---|---|
| `parse.js` | PDF → ligne de planning, par position des colonnes |
| `codes.js` | code → créneau horaire |
| `gcal.js` | autorisation et synchronisation Google Agenda |
| `store.js` | configuration locale, export/import |
| `app.js` | interface |
| `sw.js` | hors ligne et réception d'un PDF partagé |
| `vendor/` | pdf.js 4.10.38, embarqué (aucun CDN) |
