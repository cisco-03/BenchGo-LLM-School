# Convention — Nommage des rapports exportés

## Schéma

```
Export-Rapports/<AAAA-MM-JJ locale>/<ÉCOLE>/[<CLASSE>/]rapport_v3_<modeleCourt>_<profil>[_tierN]_<HH-MM-SS>.md
```

## Détail des parties

| Partie | Source | Exemple |
|---|---|---|
| `<AAAA-MM-JJ locale>` | Date locale du run (`runner.js`) | `2026-07-10` |
| `<ÉCOLE>` | `PROFILES[profil].ecole` | `Primaire`, `College-Lycee` |
| `<CLASSE>` | `CLASSE_NAMES[profil][tier]` (uniquement si `tierArg ≠ all`) | `Classe-1-CP` |
| `<modeleCourt>` | `shortenModelName(modelName)` — nom de modèle dédoublonné | `empero-ai_qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m` |
| `<profil>` | `profileArg` en minuscules | `light`, `standard` |
| `_tierN` | présent uniquement si `tierArg ≠ all` | `_tier1` |
| `<HH-MM-SS>` | Heure locale du run (séparateurs `-`, pas `:`) | `08-24-20` |

## Exemple complet

```
Export-Rapports/2026-07-10/Primaire/Classe-1-CP/rapport_v3_empero-ai_qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m_light_tier1_08-24-20.md
```

## `shortenModelName()` — règle de raccourcissement

LM Studio renvoie un identifiant style HuggingFace `org/repo/fichier.gguf` où le nom de base du
modèle est souvent répété (dans le repo ET dans le nom de fichier). La fonction :

1. Découpe en segments sur `/` ou `\`.
2. Retire l'extension `.gguf` et le suffixe de dépôt `-gguf` (convention HF).
3. Supprime un segment s'il est un préfixe — aligné sur un séparateur (`-` ou `_`) — d'un segment
   plus précis qui le suit.

Cas représentatifs :

| Entrée (nom renvoyé par LM Studio) | Sortie |
|---|---|
| `empero-ai/qwythos-9b-claude-mythos-5-1m-gguf/qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m.gguf` | `empero-ai_qwythos-9b-claude-mythos-5-1m-mtp-q4_k_m` |
| `deepseek/deepseek-r1-distill-qwen-14b` | `deepseek-r1-distill-qwen-14b` |
| `mistralai/ministral-3-14b-reasoning` | `mistralai_ministral-3-14b-reasoning` |
| `gpt-4o` | `gpt-4o` |
| `null` / vide | `modele_inconnu` |

## Règles à respecter

- Le nom **complet** du modèle est conservé dans l'en-tête H1 du rapport
  (`# Rapport d'Évaluation V3 — <nomComplet>`), jamais dans le nom de fichier.
- L'heure est **locale** (cohérente avec la date du dossier et l'en-tête du rapport) afin d'éviter
  un décalage d'un jour près de minuit.
- Le nom de fichier référence l'**heure**, l'en-tête du rapport référence le **fichier de log**
  (`**Log :** <basename>`) — les deux permettent de retrouver un run parmi beaucoup d'autres.
- Ne pas renommer les rapports existants à postériori : la convention s'applique aux runs futurs.
