# Camada de persistência — design

Objetivo: tirar o estado de memória (`DB` em `js/data.js`) e persistir
**local-first** (IndexedDB) com **sync opcional pro Supabase** (`db/schema.sql`).
O evento nunca depende de internet; Supabase entra como espelho/realtime.

```
┌──────────────┐   mutações    ┌─────────────┐   flush (online)   ┌──────────────┐
│  UI (app.js) │ ─────────────▶│  Repo (API) │ ──────────────────▶│   Supabase   │
│  renderAll() │◀───────────── │  IndexedDB  │◀────────────────── │  (Postgres + │
└──────────────┘   snapshot    │  + outbox   │  realtime/merge    │   Realtime)  │
                               └─────────────┘                    └──────────────┘
```

## Regras

1. **IndexedDB é a fonte de verdade do dispositivo.** Toda mutação grava local
   primeiro e enfileira no *outbox*. UI re-renderiza na hora (como hoje).
2. **Sync worker** (no service worker da extension) drena o outbox quando há
   rede: upsert por linha no Supabase. Falhou → mantém na fila, retry com backoff.
3. **Merge**: last-write-wins por linha usando `updated_at` (servidor ganha em
   empate). Suficiente pro domínio — cada jogo é editado por um organizador
   de cada vez.
4. **Realtime** (opcional): assinar `games`/`athletes` do evento; mudanças
   remotas aplicam no IndexedDB e disparam `renderAll()`. É o que habilita
   telão de placar e segundo dispositivo.
5. **Leitura pública**: RLS já permite `select` anônimo em eventos
   `is_public` — uma página web estática com a `anon key` mostra placar ao
   vivo sem login.

## Contrato do repositório

Uma interface, três implementações possíveis:
`MemoryRepo` (mock atual), `LocalRepo` (IndexedDB), `SyncedRepo` (LocalRepo + outbox).
A UI só conhece `Repo` — as funções de `app.js` (`saveScore`, `callGame`,
`applyDraw`...) passam a delegar pra cá.

```js
const Repo = {
  /* boot: hidrata o objeto DB inteiro de uma vez */
  async loadEvent(eventId),            // → { event, templates, athletes, courts, games, tiebreaks }

  /* evento / setup */
  async saveEvent(patch),              // nome, etapa, data, templateId, courtsConfirmed, stage
  async saveTemplate(t), async deleteTemplate(id),
  async addCourt(name), async removeCourt(id),

  /* atletas */
  async importAthletes(names),         // bulk insert, present=false
  async setPresence(id, present),
  async setWithdrawn(id, withdrawn),   // + efeitos (W.O. / rebuild) calculados no domínio
  async deleteAllAthletes(),           // cascade: games, tiebreaks

  /* sorteio e chaves — transacionais (tudo ou nada) */
  async applyDraw({ athletesPatch, games }),   // grupos + rodízio
  async buildKnockout(matches),                // insere jogos phase='ko'
  async resetScores(),                         // zera grupos, apaga KO

  /* operação de jogo */
  async callGame(id, courtId),         // status=playing, called_at=now
  async saveScore(id, scoreA, scoreB), // status=done, finished_at=now
  async setTiebreakWinner(id, athleteId),

  /* sync (só SyncedRepo) */
  async flushOutbox(),                 // drena fila → Supabase
  subscribe(eventId, onRemoteChange),  // realtime → aplica local + renderAll
};
```

### O que muda no `app.js`

Quase nada estrutural — as funções existentes viram *casca* que chama o Repo
e depois `renderAll()`:

```js
async function saveScore() {
  ...validação igual...
  await Repo.saveScore(g.id, a, b);   // antes: mutava DB direto
  renderAll();                        // continua lendo do snapshot local
}
```

Derivados (standings, ensureTiebreaks, ensureKO, seeds) **continuam puros em
memória** — são cálculo, não estado. Só resultados brutos persistem.

## Mapeamento mock → tabelas

| Hoje (`DB.*`)        | Tabela      | Observações                                   |
|----------------------|-------------|-----------------------------------------------|
| `event`              | `events`    | `created` → linha existe; `stage` explícito    |
| `templates[]`        | `templates` | por usuário (reuso entre eventos)              |
| `players[]`          | `athletes`  | `group` → `group_letter`; ids viram uuid       |
| `courts[]`           | `courts`    |                                                |
| `games[]` (grupos)   | `games`     | `phase='groups'`, `sort_order` = ordem chamada |
| `games[]` (KO)       | `games`     | `phase='ko'`, `ko_*`, `ko_src_a/b` em jsonb    |
| `tiebreaks[]`        | `tiebreaks` | `signature` = dedupe (grupo+ids)               |
| `elapsedMin`         | —           | derivado: `now() - called_at`                  |

## Extension (MV3)

- `supabase-js` **bundled via npm** (CSP proíbe CDN); Web Awesome idem.
- `host_permissions: ["https://<projeto>.supabase.co/*"]`.
- Auth do organizador: magic link (abre tab), sessão no `chrome.storage.local`.
- Sync worker roda no service worker com `chrome.alarms` (MV3 mata timers).

## Ordem de implementação sugerida

1. `LocalRepo` (IndexedDB via Dexie) + hidratação no boot — app funciona 100% offline.
2. Rodar `db/schema.sql` no Supabase + auth do organizador.
3. `SyncedRepo`: outbox + flush + realtime.
4. Página pública de placar (anon key, só leitura, realtime).
