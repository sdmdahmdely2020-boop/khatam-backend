# Khatam — Backend réel

Backend Node.js/Express complet pour la plateforme Khatam (documents Bac Série C, Mauritanie) : comptes élèves/professeurs, upload et vente de documents, paiement mobile (Bankily/Masrivi/Sedad), visionneuse sécurisée avec filigrane serveur, liaison de compte à un seul appareil, déblocage par publicité, likes et classement "Boost" des professeurs, portefeuille et retraits, correction IA (stub).

Ce backend est **fonctionnel et testé de bout en bout** (voir `npm run test:api`). Il n'est pas un mock : les mots de passe sont hashés, les sessions sont de vrais JWT, la base est une vraie base SQL, les documents ne sont jamais servis en clair. Les seules parties volontairement simulées sont expliquées ci-dessous, avec le plan exact pour les rendre réelles.

## 1. Démarrage rapide

```bash
npm install
npm run seed      # crée 2 professeurs, 2 élèves et 7 documents de démonstration
npm start          # démarre le serveur sur http://localhost:4000
# dans un autre terminal :
npm run test:api   # rejoue un scénario complet (inscription, paiement, filigrane, boost...)
```

> Le fichier `.npmrc` du projet désactive les scripts d'installation (`ignore-scripts=true`). C'est volontaire : `better-sqlite3` embarque déjà un binaire précompilé pour les plateformes courantes (Linux, macOS, Windows), et aucune autre dépendance n'a besoin d'étape de compilation — désactiver ces scripts évite une tentative de recompilation inutile qui échoue sur les réseaux restreints. Si vous ajoutez plus tard un paquet qui a réellement besoin d'un script d'installation, retirez cette ligne du `.npmrc`.

Comptes de démonstration créés par `npm run seed` (mot de passe : `demo1234`) :

| Rôle | Téléphone | Nom |
|---|---|---|
| Professeur | 22200000001 | Pr. Sidi Mohamed L. |
| Professeur | 22200000002 | Pr. Aichetou B. |
| Élève | 22211111111 | Mariem El Houssein |
| Élève | 22211111112 | Mohamed Vall K. |

## 2. Architecture

```
src/
  app.js            assemblage Express (routes, middlewares, erreurs)
  server.js          point d'entrée (npm start)
  lib/
    db.js            connexion SQLite + création du schéma
    id.js             générateur d'identifiants
    upload.js         configuration Multer (upload PDF, 25 Mo max)
    access.js         règle "l'utilisateur a-t-il le droit de voir ce document ?"
    payments.js       interface commune Bankily / Masrivi / Sedad (voir §4)
    watermark.js      filigrane PDF appliqué à la volée (voir §5)
  middleware/
    auth.js            vérification JWT + vérification de l'appareil lié (voir §6)
  routes/
    auth.js             inscription / connexion / déliaison d'appareil
    documents.js         catalogue, upload, filtres, tri boost/likes
    payments.js           initiation de paiement + webhook de confirmation
    access.js              visionneuse sécurisée, déblocage pub, favoris
    professors.js           profil public, likes, activation du Boost
    wallet.js                solde, historique des ventes, retraits
    ai.js                    correction IA (stub, voir §7)
scripts/
  seed.js             données de démonstration
  test-api.js          test de bout en bout contre le serveur démarré
docs/
  data-model.prisma    schéma de données documenté (référence — voir §3)
```

Base de données : **SQLite** via `better-sqlite3` (fichier `khatam.db`, créé automatiquement). Aucune installation de serveur de base de données requise pour développer ou faire une démo. Le fichier `docs/data-model.prisma` documente le même schéma au format Prisma, plus lisible, à utiliser si vous migrez vers PostgreSQL (voir §8).

## 3. Modèle de données (résumé)

`users` (élèves, professeurs — un seul rôle par compte), `documents` (matière, série, année, type, prix, drapeaux `free`/`adUnlock`/`aiGrading`), `purchases` (statut pending/confirmed/failed), `ad_unlocks`, `favorites`, `likes` (élève → professeur), `withdrawals`, `ai_submissions`. Détail complet dans `docs/data-model.prisma`.

## 4. Paiement — Bankily / Masrivi / Sedad

**Réalité importante à connaître avant de facturer de vrais utilisateurs :** Bankily, Masrivi et Sedad n'ont pas d'API publique en libre-service. Pour encaisser de vrais paiements, il faut signer un **contrat marchand** avec l'opérateur (Attijariwafa Bank Mauritanie pour Bankily, BCM pour Masrivi, etc.), qui fournit alors des identifiants d'API et la documentation technique de son système de "push" de paiement (l'élève reçoit une notification sur son téléphone et confirme).

`src/lib/payments.js` définit l'interface que devra respecter cette intégration (`initiatePayment`, `verifyWebhookSignature`) et une route de webhook déjà prête (`POST /api/payments/webhook/:provider`) — c'est l'URL que l'opérateur appellera pour confirmer un paiement. Aujourd'hui, cette route peut aussi être appelée manuellement pour simuler une confirmation (voir `scripts/test-api.js`), ce qui permet à tout le reste du produit (déblocage, portefeuille professeur) de fonctionner immédiatement.

**Pour brancher un vrai opérateur** : implémenter l'appel réel dans `initiatePayment()`, faire vérifier la signature du webhook dans `verifyWebhookSignature()`, et communiquer l'URL de webhook à l'opérateur.

## 5. Confidentialité des documents — ce qui est réellement possible

Aucune plateforme web (pas même Netflix, Spotify ou les banques) ne peut techniquement empêcher une capture d'écran ou un enregistrement vidéo sur l'appareil de l'utilisateur — c'est une limite matérielle/OS, pas une limite de ce backend. Ce qui **est** réellement implémenté et efficace :

- Le fichier original n'est **jamais** envoyé au client. La route `GET /api/documents/:id/view` vérifie d'abord les droits d'accès, puis génère à la volée une copie du PDF avec un **filigrane tuilé** (nom complet + téléphone + date/heure de consultation) et la sert en `inline` (pas de téléchargement).
- Toute fuite est donc traçable jusqu'au compte qui a consulté le document — un dissuasif réel, utilisé par les vraies plateformes d'examens payants.
- Pour aller plus loin en production : limiter le zoom/impression côté frontend (mesure cosmétique), et surtout mettre en place une **détection d'abus côté serveur** (ex. alerte si un même document est vu un nombre anormal de fois par des comptes différents créés le même jour).

## 6. Un compte = un seul téléphone

Ceci **est réellement appliqué côté serveur**, pas seulement côté interface :

- Au premier `POST /api/auth/login`, l'appareil (identifiant envoyé par le client dans `deviceId`) est enregistré sur le compte.
- Toute requête authentifiée doit envoyer cet identifiant dans l'en-tête `X-Device-Id`. S'il ne correspond pas à celui enregistré, le serveur répond `409 DEVICE_MISMATCH` — y compris pour un `login` depuis un autre téléphone.
- `POST /api/auth/device/release` permet de délier un compte (ex. l'utilisateur a changé de téléphone).

**Limite actuelle, à corriger avant production :** cette route de déliaison ne demande que le mot de passe. N'importe qui connaissant le mot de passe peut donc changer l'appareil lié. En production, il faut ajouter une **vérification par code OTP envoyé par SMS** au numéro du compte avant d'autoriser le changement d'appareil (ex. via un fournisseur SMS local ou Twilio). C'est la seule pièce manquante pour que cette protection soit robuste ; l'architecture est déjà prête à l'accueillir.

Aussi : `deviceId` doit être un identifiant stable généré par l'application mobile/web (ex. stocké en stockage sécurisé natif si vous construisez une app mobile — bien plus fiable qu'un identifiant navigateur, qui peut être réinitialisé).

## 7. Correction IA — état actuel

`POST /api/documents/:id/ai-grade` est un **stub** : il attribue une note heuristique simple (basée sur la longueur de la réponse) pour que le workflow complet (soumission, historique, affichage) soit démontrable. La vraie fonctionnalité demande :

1. Extraire le texte de la correction officielle du PDF du professeur.
2. Appeler un vrai modèle de langage (ex. l'API Claude d'Anthropic) avec un prompt qui compare la réponse de l'élève à cette correction et justifie une note.
3. Une clé API et un prompt affiné par matière (les mathématiques et la philosophie ne se corrigent pas de la même façon).

L'endroit exact où brancher cet appel est indiqué par un commentaire dans `src/routes/ai.js`.

## 8. Passer en production

- **Base de données** : SQLite convient pour démarrer et pour une charge modérée. Pour scaler (plusieurs serveurs, forte charge), migrer vers PostgreSQL — le schéma est déjà documenté dans `docs/data-model.prisma` au format Prisma ; réintroduire Prisma (`npm install prisma @prisma/client`) et pointer `DATABASE_URL` vers votre instance PostgreSQL managée (Render, Railway, Supabase...) fonctionne directement avec ce schéma. *(Note : Prisma télécharge des binaires depuis `binaries.prisma.sh` à l'installation — cela a échoué dans cet environnement de développement sandboxé pour cette raison ce backend utilise SQLite/better-sqlite3, qui n'a pas cette dépendance réseau ; en dehors de ce sandbox, Prisma + PostgreSQL s'installera normalement.)*
- **Stockage des fichiers** : actuellement sur disque local (`uploads/documents/`). Sur un hébergeur sans disque persistant (ex. Render en plan gratuit), utiliser un stockage objet (S3, Backblaze B2, ou équivalent) — remplacer `src/lib/upload.js` en conséquence.
- **Hébergement** : Render ou Railway conviennent bien pour ce type d'API Node.js (voir leur documentation pour déployer un service Node avec variables d'environnement).
- **Variables d'environnement** : copier `.env.example` en `.env` et renseigner `JWT_SECRET` (long secret aléatoire, jamais celui du dépôt) avant toute mise en ligne publique.
- **CORS** : `app.use(cors())` autorise actuellement toutes les origines, pratique en développement. En production, restreindre à l'origine réelle du frontend.

## 9. Connecter le prototype visuel existant

Le prototype HTML (application Khatam publiée précédemment) utilise `localStorage` pour tout simuler côté navigateur. Pour le brancher sur ce vrai backend, remplacer chaque simulation par un appel `fetch` vers ces routes, par exemple :

- Connexion → `POST /api/auth/login`, stocker le `token` reçu et l'envoyer dans `Authorization: Bearer <token>` sur chaque requête suivante, plus `X-Device-Id` (un identifiant généré une fois et gardé en stockage local de l'appareil).
- Catalogue → `GET /api/documents?serie=C`.
- Déblocage payant → `POST /api/payments/initiate` puis sonder `GET /api/payments/:id/status` en attendant la confirmation.
- Visionneuse sécurisée → afficher `GET /api/documents/:id/view` dans une balise `<iframe>` ou un lecteur PDF intégré.

## 10. Référence rapide des routes

```
POST   /api/auth/signup
POST   /api/auth/login
POST   /api/auth/device/release

GET    /api/documents
GET    /api/documents/:id
POST   /api/documents                  (professeur, multipart "file")
PATCH  /api/documents/:id              (professeur, propriétaire)
DELETE /api/documents/:id              (professeur, propriétaire)

GET    /api/documents/:id/view         (visionneuse sécurisée filigranée)
POST   /api/documents/:id/ad-unlock
POST   /api/documents/:id/favorite
GET    /api/favorites

POST   /api/payments/initiate
GET    /api/payments/:id/status
POST   /api/payments/webhook/:provider

GET    /api/professors/:id
POST   /api/professors/:id/like
POST   /api/professors/me/boost

GET    /api/wallet
POST   /api/wallet/withdraw

POST   /api/documents/:id/ai-grade
GET    /api/ai/history
```

Toutes les routes protégées attendent `Authorization: Bearer <token>` et, sauf mention contraire, `X-Device-Id: <identifiant de l'appareil>`.
