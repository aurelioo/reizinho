/* =============================================================
   Repo — camada de persistência local-first (IndexedDB).

   Contrato estável documentado em docs/persistence.md:
   a UI chama Repo.*, o Repo muta o snapshot em memória (DB/GROUPS)
   e persiste no IndexedDB (debounced). O SyncedRepo (Supabase)
   implementará este mesmo contrato adicionando outbox + realtime.
   ============================================================= */

const Repo = (() => {
  const DB_NAME = 'reizinho';
  const STORE = 'state';
  const KEY = 'current';
  let idb = null;
  let persistTimer = null;

  /* ---------- infra ---------- */

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function persistNow() {
    if (!idb) return;
    const data = JSON.parse(JSON.stringify({ db: DB, groups: GROUPS }));
    idb.transaction(STORE, 'readwrite').objectStore(STORE).put(data, KEY);
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 150);
    // espelho opcional na nuvem (js/sync.js)
    if (typeof Sync !== 'undefined') Sync.push();
  }

  /* Hidrata DB/GROUPS do IndexedDB. true = havia estado salvo. */
  async function hydrate() {
    try {
      idb = await open();
      const saved = await new Promise(resolve => {
        const req = idb.transaction(STORE).objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (saved?.db) {
        Object.assign(DB, saved.db);
        GROUPS = saved.groups ?? [];
        return true;
      }
    } catch (e) {
      console.warn('Repo: IndexedDB indisponível, rodando só em memória.', e);
    }
    return false;
  }

  /* Apaga o estado salvo e recarrega (volta ao seed do data.js) */
  function wipe() {
    if (!idb) { location.reload(); return; }
    const req = idb.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY);
    req.onsuccess = () => location.reload();
    req.onerror = () => location.reload();
  }

  /* ---------- evento / setup ---------- */

  function saveEvent(patch) { Object.assign(DB.event, patch); persist(); }
  function saveSetup(patch) { Object.assign(DB.setup, patch); persist(); }

  function addSeason(s) { (DB.seasons ??= []).push(s); persist(); }
  function updateSeason(id, patch) {
    const s = (DB.seasons ?? []).find(x => x.id === id);
    if (s) { Object.assign(s, patch); persist(); }
  }
  function deleteSeason(id) { DB.seasons = (DB.seasons ?? []).filter(x => x.id !== id); persist(); }
  function addSeasonStage(seasonId, stage) {
    const s = (DB.seasons ?? []).find(x => x.id === seasonId);
    if (s) { s.stages.push(stage); persist(); }
  }
  function popSeasonStage(seasonId) {
    const s = (DB.seasons ?? []).find(x => x.id === seasonId);
    if (s) { s.stages.pop(); persist(); }
  }

  function addSponsor(s) { (DB.sponsors ??= []).push(s); persist(); }
  function removeSponsor(id) { DB.sponsors = (DB.sponsors ?? []).filter(x => x.id !== id); persist(); }

  function saveTemplate(t) { DB.templates.push(t); persist(); }
  function deleteTemplate(id) { DB.templates = DB.templates.filter(x => x.id !== id); persist(); }

  function addCourt(name) {
    DB.courts.push({ id: Math.max(0, ...DB.courts.map(c => c.id)) + 1, name });
    persist();
  }
  function removeCourt(id) { DB.courts = DB.courts.filter(c => c.id !== id); persist(); }

  /* ---------- atletas ---------- */

  function addAthlete(name, group = null, present = true) {
    DB.players.push({
      id: Math.max(0, ...DB.players.map(p => p.id)) + 1,
      name, group, present,
    });
    persist();
  }

  function importAthletes(names) {
    let next = Math.max(0, ...DB.players.map(p => p.id)) + 1;
    for (const name of names) {
      DB.players.push({ id: next++, name, group: null, present: false });
    }
    persist();
  }

  function setPresence(id, present) {
    const p = DB.players.find(x => x.id === id);
    if (p) { p.present = present; persist(); }
  }

  function setWithdrawn(id, withdrawn) {
    const p = DB.players.find(x => x.id === id);
    if (p) { p.withdrawn = withdrawn; persist(); }
  }

  function deleteAllAthletes() {
    DB.players = [];
    DB.games = [];
    DB.tiebreaks = [];
    GROUPS = [];
    DB.setup.courtsConfirmed = false;
    DB.event.created = false;
    persist();
  }

  /* ---------- sorteio / chaves (transacionais no futuro sync) ---------- */

  /* groups: [{ letter, members: [playerRef, ...] }] */
  function applyDraw(groups) {
    DB.players.forEach(p => p.group = null);
    groups.forEach(g => g.members.forEach(p => p.group = g.letter));
    GROUPS = groups.map(g => g.letter);
    DB.tiebreaks = [];

    // Rodízio reizinho + ordem de chamada intercalada entre grupos
    const rot = [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]];
    DB.games = [];
    for (let r = 1; r <= 3; r++) {
      for (const g of groups) {
        const ids = g.members.map(p => p.id);
        const [a, b, c, d] = rot[r - 1].map(ix => ids[ix]);
        DB.games.push({
          id: `${g.letter}${r}`, group: g.letter, round: r,
          teamA: [a, b], teamB: [c, d],
          scoreA: null, scoreB: null, status: 'queued',
        });
      }
    }
    persist();
  }

  function addKnockoutMatches(matches) { DB.games.push(...matches); persist(); }

  /* Nova etapa da temporada: atletas zerados (a lista varia por etapa —
     importa de novo), jogos/desempates limpos; quadras e temporada continuam */
  function startNewStage() {
    DB.players = [];
    DB.games = [];
    DB.tiebreaks = [];
    GROUPS = [];
    DB.event.stageClosed = false;
    DB.event.edition = '';
    DB.event.date = '';
    persist();
  }

  function resetScores() {
    DB.games = DB.games.filter(g => g.phase !== 'ko');
    for (const g of DB.games) {
      g.status = 'queued';
      g.scoreA = null;
      g.scoreB = null;
      delete g.courtId;
      delete g.elapsedMin;
      delete g.wo;
      delete g.offCourt;
    }
    DB.tiebreaks = [];
    persist();
  }

  /* ---------- operação de jogo ---------- */

  function callGame(id, courtId) {
    const g = DB.games.find(x => x.id === id);
    if (!g) return;
    // Quadra ocupada: o jogo atual "desce" e fica aguardando placar
    const occ = DB.games.find(x =>
      x.status === 'playing' && x.courtId === courtId && !x.offCourt);
    if (occ) occ.offCourt = true;
    g.status = 'playing';
    g.courtId = courtId;
    g.scoreA = 0;
    g.scoreB = 0;
    g.elapsedMin = 0;
    persist();
  }

  /* Placar lançado errado / no jogo errado: apaga e volta pra fila */
  function clearScore(id) {
    const g = DB.games.find(x => x.id === id);
    if (!g) return;
    g.status = 'queued';
    g.scoreA = null;
    g.scoreB = null;
    delete g.courtId;
    delete g.elapsedMin;
    delete g.offCourt;
    delete g.wo;
    persist();
  }

  function saveScore(id, scoreA, scoreB) {
    const g = DB.games.find(x => x.id === id);
    if (!g) return;
    g.scoreA = scoreA;
    g.scoreB = scoreB;
    g.status = 'done';
    persist();
  }

  function setTiebreakWinner(id, athleteId) {
    const tb = DB.tiebreaks.find(t => t.id === id);
    if (tb) { tb.winnerId = athleteId; persist(); }
  }

  /* Desempate não ocupa quadra cadastrada — joga na que estiver livre */
  function callTiebreak(id) {
    const tb = DB.tiebreaks.find(t => t.id === id);
    if (tb) { tb.called = true; persist(); }
  }

  function uncallTiebreak(id) {
    const tb = DB.tiebreaks.find(t => t.id === id);
    if (tb) { tb.called = false; persist(); }
  }

  /* Chamado sem querer: volta pra fila e libera a quadra */
  function uncallGame(id) {
    const g = DB.games.find(x => x.id === id);
    if (!g || g.status !== 'playing') return;
    g.status = 'queued';
    g.scoreA = null;
    g.scoreB = null;
    delete g.courtId;
    delete g.elapsedMin;
    delete g.offCourt;
    persist();
  }

  return {
    hydrate, persist, wipe,
    saveEvent, saveSetup,
    saveTemplate, deleteTemplate,
    addSponsor, removeSponsor,
    addSeason, updateSeason, deleteSeason, addSeasonStage, popSeasonStage,
    addCourt, removeCourt,
    addAthlete, importAthletes, setPresence, setWithdrawn, deleteAllAthletes,
    applyDraw, addKnockoutMatches, resetScores, startNewStage,
    callGame, saveScore, clearScore, setTiebreakWinner, callTiebreak, uncallTiebreak, uncallGame,
  };
})();
