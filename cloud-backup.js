// cloud-backup.js — Backup cloud optionnel avec chiffrement AES-256-GCM.
//
// Plan §5 (Intégration / Automatisation) : chiffrement AES-256-GCM des carnets
// de scores (.carnet/) et rapports avant upload S3-compatible. Utilise le
// module crypto de Node.js (aucune dépendance externe).
//
// Le format chiffré est : [IV(12)][authTag(16)][ciphertext] encodé en base64.
// La clé est dérivée depuis une passphrase via PBKDF2 (210 000 itérations,
// SHA-256) avec un sel aléatoire de 16 octets stocké en clair dans l\\'en-tête
// du fichier de backup (le sel n\\'est pas secret, seule la passphrase l\\'est).
//
// Format du fichier de backup (.benchgo-backup) :
//   {"version":1,"algorithm":"aes-256-gcm","kdf":"pbkdf2-sha256","iterations":210000,
//    "salt":"<base64>","iv":"<base64>","authTag":"<base64>","data":"<base64>"}
//
// L\\'upload S3-compatible n\\'est pas implémenté ici (nécessite un endpoint et
// des credentials) — on fournit seulement encrypt()/decrypt() et un helper
// encryptFile() qui chiffre un fichier et renvoie son contenu base64 prêt à
// uploader. L\\'utilisateur fournit l\\'endpoint S3 via --backup-endpoint et les
// credentials via env vars, puis un script d\\'upload minimal peut être branché.
//
// Tout est journalisé pour diagnostic : chaque opération (dérivation clé,
// chiffrement, déchiffrement, succès/échec) est tracée.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const KDF = 'pbkdf2-sha256';
const ITERATIONS = 210000;
const KEY_LEN = 32;       // 256 bits
const IV_LEN = 12;        // 96 bits (recommandé pour GCM)
const SALT_LEN = 16;
const AUTH_TAG_LEN = 16;

// Dérive une clé 256 bits depuis une passphrase + sel via PBKDF2.
function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, ITERATIONS, KEY_LEN, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// Chiffre un buffer avec AES-256-GCM. Renvoie l\\'objet JSON du format backup.
async function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);
  logger.info('CloudBackup: clé dérivée (PBKDF2, ' + ITERATIONS + ' itérations, sel=' + salt.toString('hex').slice(0, 8) + '...)');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  logger.info('CloudBackup: chiffrement OK — ' + ciphertext.length + ' octets chiffrés (authTag=' + authTag.toString('hex').slice(0, 8) + '...)');
  return {
    version: 1,
    algorithm: ALGORITHM,
    kdf: KDF,
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

// Déchiffre un objet backup. Vérifie l\\'authTag (intégrité). Lance une erreur
// si la passphrase est incorrecte ou si les données ont été altérées.
async function decrypt(backupObj, passphrase) {
  if (!backupObj || backupObj.algorithm !== ALGORITHM) {
    throw new Error('Algorithme non supporté : ' + (backupObj && backupObj.algorithm));
  }
  const salt = Buffer.from(backupObj.salt, 'base64');
  const iv = Buffer.from(backupObj.iv, 'base64');
  const authTag = Buffer.from(backupObj.authTag, 'base64');
  const ciphertext = Buffer.from(backupObj.data, 'base64');
  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    logger.info('CloudBackup: déchiffrement OK — ' + plaintext.length + ' octets');
    return plaintext;
  } catch (e) {
    logger.error('CloudBackup: échec déchiffrement — passphrase incorrect ou données altérées (' + e.message + ')');
    throw new Error('Déchiffrement échoué : passphrase incorrecte ou données altérées');
  }
}

// Chiffre un fichier et renvoie l\\'objet backup (JSON). Utile pour uploader
// ensuite vers S3. Ne modifie pas le fichier original.
async function encryptFile(filePath, passphrase) {
  const plaintext = fs.readFileSync(filePath);
  logger.info('CloudBackup: chiffrement fichier — ' + filePath + ' (' + plaintext.length + ' octets)');
  return encrypt(plaintext, passphrase);
}

// Déchiffre un objet backup et écrit le contenu dans un fichier.
async function decryptToFile(backupObj, passphrase, outputPath) {
  const plaintext = await decrypt(backupObj, passphrase);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, plaintext);
  logger.info('CloudBackup: fichier déchiffré écrit — ' + outputPath);
}

// Chiffre tous les fichiers d\\'un dossier (ex: .carnet/) en un seul objet
// backup multi-fichiers : { files: { "name": <backupObj>, ... } }.
async function encryptDirectory(dirPath, passphrase) {
  if (!fs.existsSync(dirPath)) {
    logger.warn('CloudBackup: dossier introuvable — ' + dirPath);
    return null;
  }
  const files = fs.readdirSync(dirPath).filter(f => !f.startsWith('.') && fs.statSync(path.join(dirPath, f)).isFile());
  const result = { version: 1, type: 'directory', files: {} };
  for (const f of files) {
    result.files[f] = await encryptFile(path.join(dirPath, f), passphrase);
  }
  logger.info('CloudBackup: dossier chiffré — ' + files.length + ' fichier(s) depuis ' + dirPath);
  return result;
}

module.exports = {
  encrypt,
  decrypt,
  encryptFile,
  decryptToFile,
  encryptDirectory,
  deriveKey,
  ALGORITHM,
  ITERATIONS
};