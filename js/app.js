/* Render + interações do mockup. Tudo em memória; cada ação re-renderiza. */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- consultas sobre o "banco" ---------- */

const playerById = id => DB.players.find(p => p.id === id);
const nameOf = id => playerById(id)?.name ?? '?';
const groupGames = g => DB.games.filter(x => x.group === g);
const groupDone = g => groupGames(g).every(x => x.status === 'done');
const doneGames = () => DB.games.filter(g => g.status === 'done');
const playingGames = () => DB.games.filter(g => g.status === 'playing');
const queuedGames = () => DB.games.filter(g => g.status === 'queued');
/* Ocupante ativo da quadra (jogo "descido" da quadra aguardando placar não conta) */
const courtOccupant = courtId =>
  playingGames().find(g => g.courtId === courtId && !g.offCourt);
const freeCourts = () => DB.courts.filter(c => !courtOccupant(c.id));
const allGroupsDone = () => GROUPS.every(groupDone);
const koGames = () => DB.games.filter(g => g.phase === 'ko');
const groupPhaseGames = () => DB.games.filter(g => !g.phase);
const koBuilt = () => koGames().length > 0;
const tbPending = () => DB.tiebreaks.some(t => t.winnerId == null);

function winnerOf(m) {
  if (!m || m.status !== 'done') return null;
  if (m.bye) return m.teamA;
  return m.scoreA > m.scoreB ? m.teamA : m.teamB;
}
function loserOf(m) {
  if (!m || m.status !== 'done' || m.bye) return null;
  return m.scoreA > m.scoreB ? m.teamB : m.teamA;
}

/* Propaga vencedores/perdedores pros confrontos seguintes do mata-mata */
function ensureKO() {
  const byId = id => DB.games.find(x => x.id === id);
  for (const m of koGames()) {
    if (!m.srcA || m.status === 'playing' || m.status === 'done') continue;
    m.teamA = m.srcA.take === 'winner' ? winnerOf(byId(m.srcA.id)) : loserOf(byId(m.srcA.id));
    m.teamB = m.srcB.take === 'winner' ? winnerOf(byId(m.srcB.id)) : loserOf(byId(m.srcB.id));
    m.status = m.teamA && m.teamB ? 'queued' : 'waiting';
  }
}

/* Nome de atleta clicável — abre o modal dele */
const nameLink = id =>
  `<span class="p-link" data-action="open-athlete" data-player="${id}">${esc(nameOf(id))}</span>`;

/* Botão de desfazer chamada com tooltip (title não propaga no wa-button) */
function undoBtnHtml(uid, attrs) {
  uid = uid.replace(/[^\w-]/g, '-'); // ids de desempate têm ":" — inválido em seletor
  return `<wa-button size="s" appearance="plain" class="undo-call" id="${uid}" ${attrs}>
      <wa-icon name="rotate-left"></wa-icon></wa-button>
    <wa-tooltip for="${uid}">Desfazer</wa-tooltip>`;
}

function teamHtml(ids) {
  return ids.map(nameLink).join(' & ');
}

/* dupla com um nome por linha (card "Próximo a chamar") */
function teamLinesHtml(ids) {
  return ids.map(nameLink).join('<br>');
}

/* Jogo concluído: vencedora pill verde, perdedora pill vermelha */
function teamPill(ids, result) {
  return result
    ? `<span class="team-pill ${result}">${teamHtml(ids)}</span>`
    : teamHtml(ids);
}

/* Vencedor de desempate fica na frente dentro do empate */
function tbCompare(aId, bId, group) {
  const tb = DB.tiebreaks.find(t =>
    t.group === group && t.winnerId != null &&
    t.players.includes(aId) && t.players.includes(bId));
  if (!tb) return 0;
  return tb.winnerId === aId ? -1 : tb.winnerId === bId ? 1 : 0;
}

function standings(group) {
  const rows = DB.players.filter(p => p.group === group)
    .map(p => ({ p, played: 0, wins: 0, saldo: 0, gamesWon: 0 }));
  const by = Object.fromEntries(rows.map(r => [r.p.id, r]));
  for (const g of groupGames(group)) {
    if (g.status !== 'done') continue;
    const winA = g.scoreA > g.scoreB;
    for (const id of g.teamA) {
      const r = by[id]; if (!r) continue;
      r.played++; r.gamesWon += g.scoreA; r.saldo += g.scoreA - g.scoreB; if (winA) r.wins++;
    }
    for (const id of g.teamB) {
      const r = by[id]; if (!r) continue;
      r.played++; r.gamesWon += g.scoreB; r.saldo += g.scoreB - g.scoreA; if (!winA) r.wins++;
    }
  }
  return rows.sort((a, b) =>
    b.wins - a.wins || b.saldo - a.saldo ||
    tbCompare(a.p.id, b.p.id, group) ||
    b.gamesWon - a.gamesWon ||
    a.p.name.localeCompare(b.p.name));
}

/* Detecta empates que exigem desempate quando o grupo fecha:
   1º/2º, 2º/3º, ou os 3 últimos empatados (critério: vitórias + saldo) */
function ensureTiebreaks() {
  const keep = [];
  for (const g of GROUPS) {
    if (!groupGames(g).length || !groupDone(g)) continue;
    const rows = standings(g);
    if (!rows.length) continue;
    const key = r => `${r.wins}|${r.saldo}`;
    const clusters = [[rows[0]]];
    for (let i = 1; i < rows.length; i++) {
      if (key(rows[i]) === key(clusters.at(-1)[0])) clusters.at(-1).push(rows[i]);
      else clusters.push([rows[i]]);
    }
    let start = 0;
    for (const c of clusters) {
      let type = null;
      if (c.length === 2 && start === 0) type = '1º e 2º';
      else if (c.length === 2 && start === 1) type = '2º e 3º';
      else if (c.length === 3 && start === 1) type = 'últimos 3';
      if (type) {
        const ids = c.map(r => r.p.id).sort((a, b) => a - b);
        const sig = `${g}:${ids.join('-')}`;
        keep.push(DB.tiebreaks.find(t => t.sig === sig) ??
          { id: `TB-${sig}`, sig, group: g, type, players: ids, winnerId: null });
      }
      start += c.length;
    }
  }
  DB.tiebreaks = keep;
}

/* Classificação ignorando quem desistiu — o próximo melhor sobe */
const eligibleStandings = g => standings(g).filter(r => !r.p.withdrawn);

function playerStatus(p) {
  if (p.withdrawn) return { label: 'Desistiu', variant: 'danger', icon: 'user-injured' };
  if (!p.present) return { label: 'Ausente', variant: 'neutral', icon: 'user-slash' };
  const inGame = playingGames().find(g => g.teamA?.includes(p.id) || g.teamB?.includes(p.id));
  if (inGame) {
    const court = DB.courts.find(c => c.id === inGame.courtId);
    return { label: `Em quadra · ${court.name}`, variant: 'brand', icon: 'volleyball' };
  }
  if (!p.group) return { label: 'Sem grupo', variant: 'neutral', icon: 'shuffle' };
  if (!groupDone(p.group)) return { label: 'Aguardando', variant: 'warning', icon: 'clock' };
  const pos = standings(p.group).findIndex(r => r.p.id === p.id);
  return pos < 2
    ? { label: 'Classificado', variant: 'success', icon: 'circle-check' }
    : { label: 'Eliminado', variant: 'neutral', icon: 'xmark' };
}

/* ---------- Templates de configurações ---------- */

const FORMAT_LABELS = {
  reizinho: 'Reizinho — grupos de 4, rodízio de duplas, pontuação individual',
  super8: 'Super 8 — todos contra todos, parceiros rotativos',
  'dupla-fixa': 'Dupla fixa — grupos + mata-mata por duplas',
};

const currentTemplate = () =>
  DB.templates.find(t => t.id === DB.event.templateId) ?? DB.templates[0];

function tplSummaryHtml(t) {
  return `
    <span class="tpl-format">${FORMAT_LABELS[t.format] ?? t.format}</span>
    <ul class="tpl-rules">
      <li>Disputa de 3º lugar: <strong>${t.thirdPlaceMatch ? 'sim' : 'não'}</strong></li>
      <li>Melhores 3ºs: <strong>${t.bestThirds === 'group' ? 'melhor colocação no grupo' : 'por desempenho geral'}</strong></li>
      <li>Desempate: <strong>${esc(t.tiebreak)}</strong></li>
      <li>Jogo até <strong>${t.gamesPerMatch} games</strong></li>
    </ul>`;
}

/* Picker de template no modal do evento (cards, não select) */
function renderTplPicker() {
  const sel = Number($('#dlg-event').dataset.tpl) || DB.templates[0]?.id;
  $('#tpl-picker').innerHTML = DB.templates.map(t => `
    <div class="tpl-card ${t.id === sel ? 'selected' : ''}" data-action="pick-template" data-tpl="${t.id}">
      <div class="tpl-head">
        <strong>${esc(t.name)}</strong>
        ${t.id === sel ? '<wa-icon name="circle-check"></wa-icon>' : ''}
      </div>
      ${tplSummaryHtml(t)}
    </div>`).join('');
}

/* ---------- temporadas ---------- */

const eventSeason = () => (DB.seasons ?? []).find(s => s.id === DB.event.seasonId) ?? null;

/* Pontos da etapa atual por atleta (melhor resultado alcançado).
   Escada: participação < mata-mata < 4º < 3º < vice < campeão.
   3º/4º vêm da disputa de 3º lugar; sem ela, semifinalistas perdedores levam o 4º. */
function computeStagePoints(season) {
  const pts = season.points;
  const third = pts.third ?? pts.semi ?? 0;   // fallback pra temporadas antigas
  const fourth = pts.fourth ?? pts.semi ?? 0;
  const res = {};
  for (const p of DB.players.filter(x => x.present && !x.withdrawn)) {
    res[p.name] = pts.participation;
  }
  const lift = (ids, val) => ids?.forEach(id => {
    const n = nameOf(id);
    if (res[n] !== undefined) res[n] = Math.max(res[n], val);
  });
  const ko = koGames();
  for (const m of ko) { lift(m.teamA, pts.knockout); lift(m.teamB, pts.knockout); }
  // semifinalistas: base 4º (quem avança é elevado pela final)
  for (const m of ko.filter(x => x.roundSize === 4 && x.id !== 'KO-3P')) {
    lift(m.teamA, fourth); lift(m.teamB, fourth);
  }
  // disputa de 3º define quem leva o 3º lugar
  const tp = ko.find(m => m.id === 'KO-3P');
  if (tp?.status === 'done') lift(winnerOf(tp), third);
  const final = ko.find(m => m.id === 'KO-2-0');
  if (final) {
    lift(final.teamA, pts.final); lift(final.teamB, pts.final);
    lift(winnerOf(final), pts.champion);
  }
  return res;
}

function closeStage() {
  const season = eventSeason();
  const final = DB.games.find(m => m.id === 'KO-2-0');
  if (!season || DB.event.stageClosed || final?.status !== 'done') return;
  Repo.addSeasonStage(season.id, {
    n: season.stages.length + 1,
    name: DB.event.edition || `${season.stages.length + 1}ª Etapa`,
    date: DB.event.date || '',
    points: computeStagePoints(season),
  });
  Repo.saveEvent({ stageClosed: true });
  renderAll();
  showView('season');
  // consolidou: já abre a impressão (paisagem) pra gerar o PDF da pontuação
  setTimeout(printLandscape, 400);
}

/* Linhas da pontuação no formato da planilha oficial:
   Ranking · Atleta · Pontuação · Nº Etapas · % · Vitórias · Finalista · pontos por etapa */
function seasonRows(s) {
  const names = new Set();
  s.stages.forEach(st => Object.keys(st.points).forEach(n => names.add(n)));
  return [...names].map(name => {
    const per = s.stages.map(st => st.points[name] ?? 0);
    const total = per.reduce((a, b) => a + b, 0);
    const played = per.filter(p => p > 0).length;
    return {
      name, per, total, played,
      pct: played ? Math.round(total / (played * s.points.champion) * 100) : 0,
      wins: per.filter(p => p === s.points.champion).length,
      finals: per.filter(p => p >= s.points.final).length,
    };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function stageHeadLabel(st) {
  const d = st.date ? new Date(`${st.date}T12:00:00`) : null;
  const dm = d && !Number.isNaN(d.getTime())
    ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(d)
    : '';
  return dm ? `${st.n}ª - ${dm}` : `${st.n}ª`;
}

function seasonTableHtml(s) {
  const rows = seasonRows(s);
  const stageHead = s.stages.map(st =>
    `<th class="num" title="${esc(st.name)}">${stageHeadLabel(st)}</th>`).join('');
  const cols = 8 + s.stages.length;
  const cutRow = label => `
    <tr class="cut-row"><td colspan="${cols}"><span>✂ ${label}</span></td></tr>`;

  return `
    <table class="data-table season-table">
      <thead><tr>
        <th class="num">Ranking</th><th>Nome Atleta</th>
        <th class="num">Pontuação</th><th class="num">Nº de Etapas</th><th class="num">%</th>
        <th class="num">Nº Vitórias</th><th class="num">Nº Finalista</th>
        ${stageHead}
      </tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr class="${i < 8 ? 'in-super8' : ''}">
          <td class="num">${i + 1}</td>
          <td>${esc(r.name)}</td>
          <td class="num"><strong>${r.total}</strong></td>
          <td class="num">${r.played}</td>
          <td class="num">${r.pct}%</td>
          <td class="num">${r.wins}</td>
          <td class="num">${r.finals}</td>
          ${r.per.map(p => `<td class="num">${p || '<span class="muted">0</span>'}</td>`).join('')}
        </tr>
        ${i === 7 && rows.length > 8 ? cutRow('Corte Super 8') : ''}
        ${s.super16 && i === 15 && rows.length > 16 ? cutRow('Corte Super 16') : ''}`).join('')}
      </tbody>
    </table>`;
}

function renderSeasonView() {
  const host = $('#season-host');
  const seasons = DB.seasons ?? [];
  if (!seasons.length) {
    host.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon"><wa-icon name="ranking-star"></wa-icon></span>
        <h3>Nenhuma temporada criada</h3>
        <p class="muted">Crie uma temporada em Configurações e vincule as etapas a ela.</p>
        <wa-button variant="brand" data-action="nav" data-view="settings">
          <wa-icon slot="start" name="gear"></wa-icon> Ir para Configurações
        </wa-button>
      </div>`;
    return;
  }
  const s = eventSeason() ?? seasons[0];
  const head = `
    <div class="season-head">
      <span class="chip">${esc(s.name)}</span>
      <span class="muted">${s.stages.length} etapa${s.stages.length !== 1 ? 's' : ''} somada${s.stages.length !== 1 ? 's' : ''}
        · Top 8 joga o Super 8${s.super16 ? ' · Top 16 joga o Super 16' : ''}</span>
    </div>`;
  host.innerHTML = s.stages.length
    ? `${head}<div class="panel table-wrap">${seasonTableHtml(s)}</div>`
    : `${head}<div class="panel"><p class="muted center" style="padding:1.25rem 0">
        Nenhuma etapa somada ainda — ao final de cada etapa, use "Encerrar etapa" no Mission Control.</p></div>`;
}

/* Simula todos os placares pendentes da etapa atual: grupos, desempates
   e mata-mata até a final. Depois é só "Encerrar etapa" no Mission Control. */
function simulateStageScores() {
  if (!DB.games.length) { alert('Sorteie os grupos primeiro.'); return; }
  if (!confirm('Preencher todos os placares pendentes com resultados simulados?')) return;
  const g4 = DB.event.gamesPerMatch ?? 4;
  const loser = () => Math.floor(Math.random() * g4);
  const play = g => {
    const aWins = Math.random() < 0.5;
    g.scoreA = aWins ? g4 : loser();
    g.scoreB = aWins ? loser() : g4;
    g.status = 'done';
    delete g.offCourt;
  };
  for (const g of groupPhaseGames()) if (g.status !== 'done') play(g);
  ensureTiebreaks();
  for (const tb of DB.tiebreaks) if (tb.winnerId == null) tb.winnerId = tb.players[0];
  if (!koBuilt() && allGroupsDone() && !tbPending()) buildKnockout();
  for (let guard = 0; guard < 10; guard++) {
    ensureKO();
    const pending = koGames().filter(m => !m.bye && m.status === 'queued');
    if (!pending.length) break;
    pending.forEach(play);
  }
  ensureKO();
  Repo.persist();
  renderAll();
  showView('games');
}

/* Etapa demo: soma uma etapa simulada (atletas reais) pra testar a Pontuação.
   Segundo clique remove a última etapa demo. */
function toggleDemoStage() {
  const seasons = DB.seasons ?? [];
  const season = eventSeason() ?? seasons[0];
  if (!season) { alert('Crie uma temporada primeiro.'); return; }
  const last = season.stages.at(-1);
  if (last?.demo) {
    Repo.popSeasonStage(season.id);
    renderAll();
    return;
  }
  const pts = season.points;
  const ladder = [
    pts.champion, pts.champion,
    pts.final, pts.final,
    pts.third ?? pts.semi ?? 0, pts.third ?? pts.semi ?? 0,
    pts.fourth ?? pts.semi ?? 0, pts.fourth ?? pts.semi ?? 0,
    ...Array(8).fill(pts.knockout),
  ];
  let names = DB.players.filter(p => !p.withdrawn).map(p => p.name);
  if (names.length < 16) {
    const mocks = ['Rafa','Duda','Marina','Tico','Carlão','Bia','Pedrão','Lud',
      'Nando','Carol','Zé','Paty','Gui','Fê','Marcão','Nina'];
    names = [...names, ...mocks.slice(0, 16 - names.length)];
  }
  const shuffled = [...names].sort(() => Math.random() - 0.5);
  const points = {};
  shuffled.forEach((n, i) => { points[n] = ladder[i] ?? pts.participation; });
  Repo.addSeasonStage(season.id, {
    n: season.stages.length + 1,
    name: `${season.stages.length + 1}ª Etapa (demo)`,
    date: new Date().toISOString().slice(0, 10),
    demo: true,
    points,
  });
  renderAll();
  showView('season');
}

function renderSeasonSettings() {
  $('#season-list').innerHTML = (DB.seasons ?? []).map(s => `
    <div class="sponsor-row">
      <span><strong>${esc(s.name)}</strong>${s.level && s.level !== 'livre'
        ? ` <wa-tag size="s" variant="brand">${s.level === 'iniciante' ? 'Iniciante' : `Nível ${s.level}`}</wa-tag>` : ''}
        <small class="muted"> · ${s.stages.length} etapa${s.stages.length !== 1 ? 's' : ''}
        · ${[s.points.participation, s.points.knockout, s.points.fourth ?? s.points.semi, s.points.third ?? s.points.semi, s.points.final, s.points.champion].join('/')} pts${s.super16 ? ' · Super 16' : ''}</small></span>
      <span>
        <wa-button size="s" appearance="plain" title="Editar temporada e patrocinadores"
          data-action="open-season-modal" data-season="${s.id}">
          <wa-icon name="pen"></wa-icon>
        </wa-button>
      </span>
      <wa-button size="s" appearance="plain" variant="danger" title="${s.stages.length ? 'Temporada com etapas — não dá pra excluir' : 'Excluir'}"
        data-action="season-delete" data-season="${s.id}" ${s.stages.length ? 'disabled' : ''}>
        <wa-icon name="trash"></wa-icon>
      </wa-button>
    </div>`).join('') ||
    '<p class="muted center" style="padding:.75rem 0">Nenhuma temporada — crie a primeira.</p>';
}

/* Modal unificado: dados da temporada + pontuação + patrocinadores.
   Sem data-season = criar; com = editar. */
function openSeasonModal(seasonId = null) {
  const dlg = $('#dlg-season');
  const s = seasonId ? (DB.seasons ?? []).find(x => x.id === seasonId) : null;
  dlg.dataset.season = s ? s.id : '';
  $('#se-name').value = s?.name ?? '';
  $('#se-level').value = s?.level ?? 'livre';
  $('#se-p-part').value = s?.points.participation ?? 250;
  $('#se-p-ko').value = s?.points.knockout ?? 400;
  $('#se-p-fourth').value = s?.points.fourth ?? s?.points.semi ?? 500;
  $('#se-p-third').value = s?.points.third ?? s?.points.semi ?? 550;
  $('#se-p-final').value = s?.points.final ?? 750;
  $('#se-p-champ').value = s?.points.champion ?? 1000;
  $('#se-s16').checked = !!s?.super16;
  $('#se-error').hidden = true;
  $('#sp-status').textContent = '';
  renderSponsorList();
  dlg.open = true;
}

function saveSeasonModal() {
  const name = ($('#se-name').value || '').trim();
  if (!name) { $('#se-error').hidden = false; return; }
  const patch = {
    name,
    level: $('#se-level').value || 'livre',
    super16: $('#se-s16').checked,
    points: {
      participation: parseInt($('#se-p-part').value, 10) || 0,
      knockout: parseInt($('#se-p-ko').value, 10) || 0,
      fourth: parseInt($('#se-p-fourth').value, 10) || 0,
      third: parseInt($('#se-p-third').value, 10) || 0,
      final: parseInt($('#se-p-final').value, 10) || 0,
      champion: parseInt($('#se-p-champ').value, 10) || 0,
    },
  };
  const id = Number($('#dlg-season').dataset.season);
  if (id) Repo.updateSeason(id, patch);
  else Repo.addSeason({ id: Date.now(), stages: [], ...patch });
  $('#dlg-season').open = false;
  renderAll();
}

/* ---------- patrocinadores / apoiadores ---------- */

function sponsorsByCategory() {
  const cats = [];
  for (const s of DB.sponsors ?? []) {
    let c = cats.find(x => x.name === s.category);
    if (!c) cats.push(c = { name: s.category, items: [] });
    c.items.push(s);
  }
  return cats;
}

function renderSponsorsFooter() {
  const el = $('#sponsors-footer');
  const cats = sponsorsByCategory();
  el.hidden = !cats.length;
  el.innerHTML = cats.map(c => `
    <div class="sp-cat">
      <span class="sp-cat-name">${esc(c.name)}</span>
      <div class="sp-logos">${c.items.map(s =>
        `<img src="${esc(s.url)}" alt="${esc(c.name)}" loading="lazy">`).join('')}</div>
    </div>`).join('');
}

function renderSponsorList() {
  $('#sponsor-list').innerHTML = (DB.sponsors ?? []).map(s => `
    <div class="sponsor-row">
      <img src="${esc(s.url)}" alt="">
      <span class="chip">${esc(s.category)}</span>
      <wa-button size="s" appearance="plain" variant="danger" title="Remover"
        data-action="sponsor-remove" data-sponsor="${s.id}">
        <wa-icon name="trash"></wa-icon>
      </wa-button>
    </div>`).join('') ||
    '<p class="muted center" style="padding:.75rem 0">Nenhuma logo enviada.</p>';
}

/* Sub-menu das Configurações (segundo sidebar) */
function showSettingsTab(tab) {
  document.querySelectorAll('#settings-nav .snav-item')
    .forEach(a => a.classList.toggle('active', a.dataset.stab === tab));
  document.querySelectorAll('.spanel')
    .forEach(p => p.hidden = p.dataset.spanel !== tab);
}

function renderSettings() {
  $('#dark-toggle').checked = document.documentElement.classList.contains('wa-dark');
  const email = Sync.userEmail();
  $('#auth-status').textContent = email
    ? `Conectado como ${email}`
    : 'Sem login — modo offline deste navegador.';
  $('#btn-signout').hidden = !email;
  const acc = DB.account ?? {};
  $('#account-summary').textContent = acc.name
    ? `${acc.name} — ${acc.city}/${acc.uf}`
    : 'Cadastro incompleto.';

  $('#tpl-list').innerHTML = DB.templates.map(t => {
    const inUse = DB.event.created && DB.event.templateId === t.id;
    return `
      <div class="tpl-card static">
        <div class="tpl-head">
          <strong>${esc(t.name)}</strong>
          <span class="tpl-head-actions">
            ${inUse ? '<wa-tag size="s" variant="brand">Em uso</wa-tag>' : ''}
            <wa-button size="s" appearance="plain" variant="danger" title="${inUse ? 'Template em uso no evento atual' : 'Excluir template'}"
              data-action="delete-template" data-tpl="${t.id}" ${inUse ? 'disabled' : ''}>
              <wa-icon name="trash"></wa-icon>
            </wa-button>
          </span>
        </div>
        ${tplSummaryHtml(t)}
      </div>`;
  }).join('') || '<p class="muted">Nenhum template — crie o primeiro.</p>';
}

function saveTemplate() {
  const name = ($('#tpl-name').value || '').trim();
  if (!name) { $('#tpl-error').hidden = false; return; }
  Repo.saveTemplate({
    id: Math.max(0, ...DB.templates.map(t => t.id)) + 1,
    name,
    format: $('#tpl-format').value,
    bestThirds: $('#tpl-thirds').value,
    tiebreak: ($('#tpl-tiebreak').value || '').trim() || 'Vitórias → saldo de games',
    gamesPerMatch: parseInt($('#tpl-games').value, 10) || 4,
    thirdPlaceMatch: $('#tpl-3p').checked,
  });
  $('#dlg-template').open = false;
  renderAll();
}

/* Empty state compartilhado do setup: sem evento → criar; sem atletas → importar; sem sorteio → sortear */
function setupEmptyState() {
  if (!DB.event.created) {
    return `
      <div class="empty-state">
        <span class="empty-icon"><wa-icon name="calendar-plus"></wa-icon></span>
        <h3>Nenhuma etapa criada</h3>
        <p class="muted">Crie a etapa (vinculada à temporada) pra começar.</p>
        <wa-button variant="brand" size="l" data-action="open-event">
          <wa-icon slot="start" name="calendar-plus"></wa-icon> Criar Etapa
        </wa-button>
      </div>`;
  }
  if (!DB.players.length) {
    return `
      <div class="empty-state">
        <span class="empty-icon"><wa-icon name="users"></wa-icon></span>
        <h3>Nenhum atleta cadastrado</h3>
        <p class="muted">Importe a lista de inscritos para começar o evento.</p>
        <wa-button variant="brand" size="l" data-action="open-import">
          <wa-icon slot="start" name="file-import"></wa-icon> Importar Lista de Atletas
        </wa-button>
      </div>`;
  }
  if (!DB.games.length) {
    return `
      <div class="empty-state">
        <span class="empty-icon"><wa-icon name="shuffle"></wa-icon></span>
        <h3>Grupos ainda não sorteados</h3>
        <p class="muted">${DB.players.length} atletas cadastrados — sorteie os grupos para gerar os jogos.</p>
        <wa-button variant="brand" size="l" data-action="sortear">
          <wa-icon slot="start" name="shuffle"></wa-icon> Sortear Grupos
        </wa-button>
      </div>`;
  }
  return null;
}

/* ---------- Jogos (lista sequencial) ---------- */

function gameScoreCell(g) {
  // Estado da linha vem da cor (verde concluído, azul em quadra) — sem badges
  if (g.status === 'done') return `<span class="result-score">${g.wo ? 'W.O.' : `${g.scoreA} × ${g.scoreB}`}</span>`;
  // em quadra sem game fechado ainda: vs (0×0 não informa nada)
  if (g.status === 'playing' && (g.scoreA || g.scoreB)) {
    return `<span class="result-score live">${g.scoreA} × ${g.scoreB}</span>`;
  }
  return '<span class="muted">vs</span>';
}

function gameActionCell(g, isNext) {
  if (g.status === 'playing') {
    return `<wa-button size="s" variant="success" data-action="open-score" data-game="${g.id}">
      <wa-icon slot="start" name="circle-check"></wa-icon> Registrar placar</wa-button>`;
  }
  if (g.status === 'queued') {
    // Chamadas só liberam depois do setup completo (quadras confirmadas)
    if (!DB.setup.courtsConfirmed) return '';
    // Sem quadra livre também dá pra chamar — modal pede a quadra
    const court = freeCourts()[0];
    const label = `<wa-icon slot="start" name="bullhorn"></wa-icon>
      <span class="btn-stack">Chamar<small>${court ? esc(court.name) : 'escolher quadra'}</small></span>`;
    return isNext
      ? `<wa-button size="s" variant="brand" data-action="call-game" data-game="${g.id}">${label}</wa-button>`
      : `<wa-button size="s" appearance="plain" data-action="call-game" data-game="${g.id}">${label}</wa-button>`;
  }
  return `<wa-button size="s" appearance="plain" title="Editar placar" data-action="open-score" data-game="${g.id}">
    <wa-icon name="pen"></wa-icon></wa-button>`;
}

function koSrcText(m, side) {
  const src = side === 'A' ? m.srcA : m.srcB;
  if (!src) return '—';
  const ref = DB.games.find(x => x.id === src.id);
  return `${src.take === 'winner' ? 'Vencedor' : 'Perdedor'} ${ref?.label ?? ''}`;
}

function gameItemHtml(g, seq, chip, isNext) {
  const done = g.status === 'done';
  const resA = done ? (g.scoreA > g.scoreB ? 'win' : 'lose') : '';
  const resB = done ? (g.scoreB > g.scoreA ? 'win' : 'lose') : '';
  const tA = g.teamA ? teamPill(g.teamA, resA) : `<span class="muted">${koSrcText(g, 'A')}</span>`;
  const tB = g.teamB ? teamPill(g.teamB, resB) : `<span class="muted">${koSrcText(g, 'B')}</span>`;
  const undo = g.status === 'playing' ? undoBtnHtml(`undo-g-${g.id}`, `data-action="uncall-game" data-game="${g.id}"`) : '';
  return `
    <div class="game-item ${g.status}">
      <span class="game-seq">${undo}#${seq}</span>
      ${chip}
      <span class="game-team right">${tA}</span>
      <span class="game-score">${gameScoreCell(g)}</span>
      <span class="game-team">${tB}</span>
      <span class="game-action">${g.status === 'waiting' ? '' : gameActionCell(g, isNext)}</span>
    </div>`;
}

/* Bloco de jogos com divisor "Próximos" entre já jogados e fila */
function gameRowsHtml(rows, withTiebreaks) {
  const isUpcoming = r => r.g.status === 'queued' || r.g.status === 'waiting';
  const played = rows.filter(r => !isUpcoming(r)).map(r => r.html).join('');
  const upcoming = rows.filter(isUpcoming).map(r => r.html).join('');
  const tb = withTiebreaks ? tiebreaksHtml() : '';
  let html = played + tb;
  if ((played || tb) && upcoming) {
    html += '<div class="games-divider"><span class="games-divider-badge"><wa-icon name="bullhorn"></wa-icon> Próximos</span></div>';
  }
  return html + upcoming;
}

function renderGamesList() {
  $('#ko-games-section').hidden = !koBuilt();
  const empty = setupEmptyState();
  if (empty) { $('#games-list').innerHTML = empty; return; }

  const nextId = queuedGames()[0]?.id;
  let seq = 0;
  const groupRows = groupPhaseGames().map(g => ({
    g,
    html: gameItemHtml(g, ++seq, `<span class="chip chip-g">Grupo ${g.group} · R${g.round}</span>`, g.id === nextId),
  }));
  const koRows = koGames().filter(m => !m.bye).map(m => ({
    g: m,
    html: gameItemHtml(m, ++seq, `<span class="chip chip-g">${koRoundLabel(m)}</span>`, m.id === nextId),
  }));

  if (!koBuilt()) {
    $('#games-list').innerHTML = gameRowsHtml(groupRows, true);
    return;
  }

  // Mata-mata montado: abas separando as fases
  const host = $('#games-list');
  const cur = host.querySelector('wa-tab-group')?.active;
  const active = cur === 'grupos' ? 'grupos' : 'ko';
  host.innerHTML = `
    <wa-tab-group active="${active}" class="games-tabs">
      <wa-tab panel="grupos">Fase de Grupos</wa-tab>
      <wa-tab panel="ko">Mata-mata</wa-tab>
      <wa-tab-panel name="grupos">${gameRowsHtml(groupRows, true)}</wa-tab-panel>
      <wa-tab-panel name="ko">
        <div class="ko-tab-bar">
          <wa-button size="s" variant="brand" data-action="nav" data-view="bracket">
            <wa-icon slot="start" name="diagram-project"></wa-icon> Ver chaveamento
          </wa-button>
        </div>
        ${gameRowsHtml(koRows, false)}
      </wa-tab-panel>
    </wa-tab-group>`;

  // Mesma listagem do mata-mata na view do chaveamento
  $('#ko-games-list').innerHTML = gameRowsHtml(koRows, false);
}

function tiebreaksHtml() {
  if (!DB.tiebreaks.length) return '';
  return '<div class="game-sep"><wa-icon name="scale-balanced"></wa-icon> Desempates (simples)</div>' +
    DB.tiebreaks.map((tb, i) => {
      const resolved = tb.winnerId != null;
      const players = tb.players.map(id => {
        if (!resolved) return nameLink(id);
        return `<span class="team-pill ${id === tb.winnerId ? 'win' : 'lose'}">${nameLink(id)}</span>`;
      }).join('<span class="muted tb-vs">vs</span>');
      const action = resolved
        ? `<wa-button size="s" appearance="plain" title="Editar desempate" data-action="open-winner" data-tb="${tb.id}">
            <wa-icon name="pen"></wa-icon></wa-button>`
        : tb.called
          ? `<wa-button size="s" variant="brand" appearance="outlined" data-action="open-winner" data-tb="${tb.id}">
              <wa-icon slot="start" name="crown"></wa-icon> Informar vencedor</wa-button>`
          : `<wa-button size="s" variant="brand" data-action="call-tiebreak" data-tb="${tb.id}">
              <wa-icon slot="start" name="bullhorn"></wa-icon> Chamar</wa-button>`;
      const tbUndo = tb.called && !resolved
        ? undoBtnHtml(`undo-d-${tb.id}`, `data-action="uncall-tiebreak" data-tb="${tb.id}"`)
        : '';
      return `
        <div class="game-item tiebreak ${resolved ? 'done' : ''} ${tb.called && !resolved ? 'playing' : ''}">
          <span class="game-seq">${tbUndo}D${i + 1}</span>
          <span class="chip chip-g">Grupo ${tb.group}</span>
          <wa-tag size="s" variant="${resolved ? 'neutral' : 'warning'}">${tb.type}${tb.called && !resolved ? ' · em quadra' : ''}</wa-tag>
          <span class="tb-players">${players}</span>
          <span class="game-action">${action}</span>
        </div>`;
    }).join('');
}

function openWinnerDialog(tbId) {
  const tb = DB.tiebreaks.find(t => t.id === tbId);
  if (!tb) return;
  $('#winner-context').innerHTML = `
    <span class="chip chip-g">Grupo ${tb.group}</span>
    <wa-tag size="s" variant="warning">Desempate ${tb.type}</wa-tag>`;
  $('#winner-options').innerHTML = tb.players.map(id => `
    <wa-button appearance="${tb.winnerId === id ? 'accent' : 'outlined'}" variant="${tb.winnerId === id ? 'brand' : 'neutral'}"
      data-action="set-winner" data-tb="${tb.id}" data-player="${id}">
      <wa-icon slot="start" name="crown"></wa-icon> ${esc(nameOf(id))}
    </wa-button>`).join('');
  $('#dlg-winner').open = true;
}

/* ---------- Atletas ---------- */

function refreshGroupFilter() {
  const sel = $('#player-group-filter');
  const key = GROUPS.join('');
  if (sel.dataset.groups === key) return;
  sel.dataset.groups = key;
  const cur = sel.value;
  sel.innerHTML = '<wa-option value="all">Todos os grupos</wa-option>' +
    GROUPS.map(g => `<wa-option value="${g}">Grupo ${g}</wa-option>`).join('');
  sel.value = GROUPS.includes(cur) ? cur : 'all';
}

/* 3ºs que entram na chave (melhores 3ºs) — só eles levam bronze */
function qualifiedThirdIds() {
  if (!GROUPS.length) return new Set();
  const { usedThirds } = koEntries();
  return new Set(bestThirds().slice(0, usedThirds).map(r => r.p.id));
}

let playersSort = { key: null, dir: 1 };

function renderPlayers() {
  const empty = !DB.players.length;
  $('#players-empty').hidden = !empty;
  if (empty) $('#players-empty').innerHTML = setupEmptyState() ?? '';
  $('#players-toolbar').hidden = empty;
  $('#players-table-panel').hidden = empty;
  $('#view-players .head-actions').hidden = empty;
  if (empty) return;
  refreshGroupFilter();
  const q = ($('#player-search').value || '').toLowerCase();
  const gf = $('#player-group-filter').value || 'all';
  const bronzeIds = qualifiedThirdIds();
  const list = DB.players
    .filter(p => (gf === 'all' || p.group === gf) && p.name.toLowerCase().includes(q))
    .map(p => ({
      p,
      st: p.group ? standings(p.group).find(r => r.p.id === p.id) : null,
      pos: p.group ? standings(p.group).findIndex(r => r.p.id === p.id) + 1 : 0,
    }));

  if (playersSort.key) {
    const sortVal = r => ({
      present: r.p.present ? 1 : 0,
      name: r.p.name,
      group: r.p.group ?? '~',
      played: r.st?.played ?? 0,
      wins: r.st?.wins ?? 0,
      saldo: r.st?.saldo ?? 0,
      pos: r.pos || 99,
    })[playersSort.key];
    list.sort((a, b) => {
      const va = sortVal(a), vb = sortVal(b);
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * playersSort.dir;
    });
  }
  $$('#players-table-panel th[data-sort]').forEach(th => {
    th.classList.toggle('sorted-asc', th.dataset.sort === playersSort.key && playersSort.dir === 1);
    th.classList.toggle('sorted-desc', th.dataset.sort === playersSort.key && playersSort.dir === -1);
  });

  const rows = list.map(({ p, st, pos }) => {
      // classificado: top 2 com grupo fechado, ou melhor 3º com todos os grupos fechados
      const qualified = !p.withdrawn && p.group && (
        (groupDone(p.group) && pos > 0 && pos <= 2) ||
        (allGroupsDone() && bronzeIds.has(p.id))
      );
      return `
        <tr class="${p.present ? '' : 'absent'}${p.withdrawn ? ' withdrawn' : ''}">
          <td><wa-checkbox class="present-check" data-player="${p.id}" ${p.present ? 'checked' : ''}
            title="Presença"></wa-checkbox></td>
          <td><span class="player-chip" data-action="open-athlete" data-player="${p.id}"><span class="avatar g${p.group ?? ''}">${esc(p.name[0])}</span>${
            qualified
              ? `<strong>${esc(p.name)}</strong><wa-icon class="qual-check" name="circle-check" title="Classificado"></wa-icon>`
              : esc(p.name)
          }</span></td>
          <td>${p.group ? `<span class="chip chip-g">Grupo ${p.group}</span>` : '<span class="muted">—</span>'}</td>
          <td class="num">${st?.played ?? 0}</td>
          <td class="num">${st?.wins ?? 0}</td>
          <td class="num">${(st?.saldo ?? 0) > 0 ? '+' : ''}${st?.saldo ?? 0}</td>
          <td class="num">${(() => {
            if (!pos) return '<span class="muted">—</span>';
            const medal = pos === 1 ? 'gold' : pos === 2 ? 'silver'
              : pos === 3 && bronzeIds.has(p.id) ? 'bronze' : '';
            return medal ? `<span class="pos-badge ${medal}">${pos}º</span>` : `${pos}º`;
          })()}</td>
        </tr>`;
    });
  $('#players-tbody').innerHTML = rows.join('') ||
    '<tr><td colspan="7" class="muted center">Nenhum atleta encontrado.</td></tr>';
}

/* Aceita lista "suja" (ex: copiada do WhatsApp): numeração, bullets,
   caracteres invisíveis (word-joiner, zero-width) e espaços duplicados */
const cleanImportLine = s => s
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')             // zero-width / word-joiner (WhatsApp)
  .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u20E3]/gu, '')  // emojis
  .replace(/\u00A0/g, ' ')                                   // nbsp
  .replace(/^\s*[\u2022*]*\s*\d*\s*[.)\-\u2013\u2014:]?\s*/, '')  // "12." "3)" "- " "\u2022 "
  .replace(/\s+/g, ' ')
  .trim();

const parseImportNames = () =>
  ($('#import-names').value || '').split('\n').map(cleanImportLine).filter(Boolean);

function updateImportCount() {
  const n = parseImportNames().length;
  $('#import-count').textContent = n
    ? `${n} nome${n > 1 ? 's' : ''} pronto${n > 1 ? 's' : ''} para importar.`
    : 'Nenhum nome ainda.';
  $('#import-btn-label').textContent = n ? `Importar ${n}` : 'Importar';
  $('#import-submit').disabled = !n;
}

function importPlayers() {
  const names = parseImportNames();
  if (!names.length) { $('#import-error').hidden = false; return; }
  // Importados começam ausentes — presença é marcada na chegada
  Repo.importAthletes(names);
  $('#dlg-import').open = false;
  $('#import-names').value = '';
  $('#import-error').hidden = true;
  updateImportCount();
  renderAll();
  openDrawModal();
}

function deleteAllPlayers() {
  if (!confirm('Apagar TODOS os atletas, grupos e jogos? (fluxo de teste)')) return;
  Repo.deleteAllAthletes();
  renderAll();
}

/* ---------- sorteio (modal com animação) ---------- */

// Sorteia os presentes; sem ninguém marcado, sorteia todos os cadastrados
function drawPool() {
  const active = DB.players.filter(p => !p.withdrawn);
  const marked = active.filter(p => p.present);
  return { pool: marked.length ? marked : active, src: marked.length ? 'presentes' : 'cadastrados' };
}

function computeDraw() {
  const { pool } = drawPool();
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const letters = 'ABCDEFGHIJKL';
  const groups = [];
  for (let i = 0; i < shuffled.length / 4; i++) {
    groups.push({ letter: letters[i], members: shuffled.slice(i * 4, i * 4 + 4) });
  }
  return { groups, names: pool.map(p => p.name) };
}

function applyDraw(groups) {
  Repo.applyDraw(groups);
  renderAll();
}

function openDrawModal() {
  const { pool, src } = drawPool();
  const ok = pool.length >= 4 && pool.length % 4 === 0;
  $('#draw-summary').textContent = ok
    ? `${pool.length} atletas ${src} → ${pool.length / 4} grupo${pool.length > 4 ? 's' : ''} de 4.`
    : '';
  $('#draw-error').textContent = ok ? '' : `${pool.length} atletas ${src} — o sorteio precisa de múltiplo de 4.`;
  $('#draw-names').textContent = pool.map(p => p.name).join(', ');
  $('#draw-error').hidden = ok;
  $('#draw-btn').disabled = !ok;
  $('#draw-btn').hidden = false;
  $('#draw-next').hidden = true;
  $('#draw-names').hidden = false;
  $('#draw-grid').innerHTML = '';
  $('#dlg-draw').open = true;
}

let drawTimer = null;

function runDraw() {
  const hasResults = DB.games.some(g => g.status !== 'queued');
  if (hasResults && !confirm('Sortear novamente apaga jogos e placares atuais. Continuar?')) return;
  const { groups, names } = computeDraw();
  $('#draw-btn').disabled = true;

  const renderTick = final => {
    const shuffled = final ? null : [...names].sort(() => Math.random() - 0.5);
    $('#draw-grid').innerHTML = groups.map((g, gi) => `
      <div class="draw-group ${final ? 'settled' : ''}">
        <div class="draw-group-head">GRUPO ${g.letter}</div>
        ${g.members.map((p, i) => `
          <div class="draw-slot">${esc(final ? p.name : shuffled[gi * 4 + i])}</div>`).join('')}
      </div>`).join('');
  };

  $('#draw-names').hidden = true;
  let tick = 0;
  renderTick(false);
  drawTimer = setInterval(() => {
    tick++;
    if (tick < 14) { renderTick(false); return; }
    clearInterval(drawTimer);
    drawTimer = null;
    renderTick(true);
    // Resultado fica na tela — "Próximo" leva pro resumo de copiar
    applyDraw(groups);
    $('#draw-btn').hidden = true;
    $('#draw-btn').disabled = false;
    $('#draw-next').hidden = false;
  }, 90);
}

/* ---------- resumo dos grupos (compartilhar) ---------- */

/* Link público do placar — GitHub Pages (repo aurelioo/reizinho-placar).
   Configurável em Configurações se hospedar em outro lugar. */
const DEFAULT_PLACAR_URL = 'https://liga.rcode.pro/';

function placarLink() {
  const base = (Sync.cfg().placarUrl || '').trim() || DEFAULT_PLACAR_URL;
  const slug = (DB.slug || '').trim();
  if (slug) return base.replace(/index\.html$/, '').replace(/\/*$/, '/') + slug;
  const owner = Sync.ownerId();
  return owner ? `${base}${base.includes('?') ? '&' : '?'}e=${owner}` : base;
}

function buildGroupsText() {
  const text = GROUPS.map(g => {
    const names = DB.players.filter(p => p.group === g).map(p => p.name);
    return `GRUPO ${g}\n${names.join(', ')}`;
  }).join('\n\n');
  const link = placarLink();
  return link ? `${text}\n\n📺 Acompanhe ao vivo: ${link}` : text;
}

function openGroupsSummary() {
  const ta = $('#groups-summary-text');
  ta.value = buildGroupsText();
  ta.rows = Math.min(20, ta.value.split('\n').length + 1);
  $('#copy-groups-label').textContent = 'Copiar';
  $('#dlg-groups-summary').open = true;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

async function copyGroupsText() {
  await copyText(buildGroupsText());
  const label = $('#copy-groups-label');
  label.textContent = 'Copiado ✓';
  setTimeout(() => { label.textContent = 'Copiar'; }, 1500);
}

/* ---------- Grupos & Jogos ---------- */

function gameRow(g) {
  let right;
  if (g.status === 'done') {
    right = `<span class="result-score">${g.wo ? 'W.O.' : `${g.scoreA} × ${g.scoreB}`}</span>`;
  } else if (g.status === 'playing') {
    const court = DB.courts.find(c => c.id === g.courtId);
    right = `<wa-tag size="s" variant="brand"><wa-icon name="baseball"></wa-icon>&nbsp;${court.name} · ${g.scoreA}×${g.scoreB}</wa-tag>`;
  } else {
    right = '';
  }
  const done = g.status === 'done';
  const resA = done ? (g.scoreA > g.scoreB ? 'win' : 'lose') : '';
  const resB = done ? (g.scoreB > g.scoreA ? 'win' : 'lose') : '';
  return `
    <div class="game-row">
      <span class="round-tag">R${g.round}</span>
      <span class="result-team">${teamPill(g.teamA, resA)}</span>
      <span class="muted">vs</span>
      <span class="result-team">${teamPill(g.teamB, resB)}</span>
      <span class="game-right">${right}</span>
    </div>`;
}

function groupBlock(g) {
  const table = standings(g).map((r, i) => `
    <tr class="${i < 2 ? 'qualify' : ''}">
      <td class="num">${i + 1}º</td>
      <td><span class="player-chip" data-action="open-athlete" data-player="${r.p.id}"><span class="avatar g${g}">${esc(r.p.name[0])}</span>${esc(r.p.name)}</span></td>
      <td class="num">${r.played}</td>
      <td class="num"><strong>${r.wins}</strong></td>
      <td class="num">${r.saldo > 0 ? '+' : ''}${r.saldo}</td>
      <td class="num">${r.gamesWon}</td>
    </tr>`).join('');
  return `
    <div class="group-grid">
      <div class="panel">
        <h4 class="panel-title"><wa-icon name="ranking-star"></wa-icon> Classificação</h4>
        <table class="data-table compact">
          <thead><tr><th></th><th>Atleta</th><th class="num">J</th><th class="num">V</th><th class="num">Saldo</th><th class="num">G</th></tr></thead>
          <tbody>${table}</tbody>
        </table>
      </div>
      <div class="panel">
        <h4 class="panel-title"><wa-icon name="list-ol"></wa-icon> Rodadas</h4>
        ${groupGames(g).map(gameRow).join('')}
      </div>
    </div>`;
}

function renderGroups() {
  const host = $('#groups-host');
  $('#btn-copy-groups').hidden = !GROUPS.length;
  if (!GROUPS.length) {
    host.innerHTML = setupEmptyState() ?? '';
    return;
  }
  const current = host.querySelector('wa-tab-group')?.active;
  const active = current && (current === 'all' || GROUPS.includes(current)) ? current : 'all';
  host.innerHTML = `
    <wa-tab-group active="${active}">
      <wa-tab panel="all">Todos</wa-tab>
      ${GROUPS.map(g => `<wa-tab panel="${g}">Grupo ${g}</wa-tab>`).join('')}
      <wa-tab-panel name="all">
        <div class="group-stack">
          ${GROUPS.map(g => `
            <section class="group-section">
              <header class="group-section-head">
                <span class="chip chip-g">Grupo ${g}</span>
                ${groupDone(g) ? '<wa-tag size="s" variant="success">Concluído</wa-tag>' : ''}
              </header>
              ${groupBlock(g)}
            </section>`).join('')}
        </div>
      </wa-tab-panel>
      ${GROUPS.map(g => `<wa-tab-panel name="${g}"><div class="group-panel">${groupBlock(g)}</div></wa-tab-panel>`).join('')}
    </wa-tab-group>`;
}

/* ---------- Quadras ---------- */

function renderCourtsView() {
  $('#courts-list').innerHTML = DB.courts.map(c => {
    const game = courtOccupant(c.id);
    const status = game
      ? `<wa-tag size="s" variant="brand"><wa-icon name="baseball"></wa-icon>&nbsp;Em jogo · ${esc(game.teamA.map(nameOf).join(' & '))} vs ${esc(game.teamB.map(nameOf).join(' & '))}</wa-tag>`
      : '<wa-tag size="s" variant="success">Livre</wa-tag>';
    return `
      <div class="court-row">
        <span class="court-name"><wa-icon name="baseball"></wa-icon> ${esc(c.name)}</span>
        ${status}
        <wa-button size="s" appearance="plain" variant="danger" title="${game ? 'Quadra em uso — encerre o jogo antes de remover' : 'Remover quadra'}"
          data-action="remove-court" data-court="${c.id}" ${game ? 'disabled' : ''}>
          <wa-icon name="trash"></wa-icon>
        </wa-button>
      </div>`;
  }).join('') || '<p class="muted center" style="padding:1rem 0">Nenhuma quadra cadastrada — adicione a primeira acima.</p>';
}

/* Modal de quadras (fluxo de setup, pós-sorteio) */
function renderCourtsDialog() {
  const list = $('#dlg-courts-list');
  list.innerHTML = DB.courts.map(c => {
    const game = courtOccupant(c.id);
    return `
      <div class="court-row">
        <span class="court-name"><wa-icon name="baseball"></wa-icon> ${esc(c.name)}</span>
        ${game ? '<wa-tag size="s" variant="brand">Em jogo</wa-tag>' : '<span></span>'}
        <wa-button size="s" appearance="plain" variant="danger" title="Remover quadra"
          data-action="remove-court" data-court="${c.id}" ${game ? 'disabled' : ''}>
          <wa-icon name="trash"></wa-icon>
        </wa-button>
      </div>`;
  }).join('') || '<p class="muted center" style="padding:.75rem 0">Nenhuma quadra — adicione a primeira acima.</p>';
  $('#dlg-courts-confirm').disabled = !DB.courts.length;
}

function openCourtsModal() {
  renderCourtsDialog();
  $('#dlg-courts').open = true;
}

function dlgAddCourt() {
  const input = $('#dlg-court-name');
  const name = (input.value || '').trim();
  if (!name) return;
  Repo.addCourt(name);
  input.value = '';
  renderAll();
}

function addCourt() {
  const input = $('#court-name');
  const name = (input.value || '').trim();
  if (!name) return;
  Repo.addCourt(name);
  input.value = '';
  renderAll();
}

/* ---------- Mata-mata ---------- */

const nextPow2 = n => { let p = 1; while (p < n) p *= 2; return p; };

const KO_ABBR = { 16: 'O', 8: 'Q', 4: 'SF', 2: 'F' };
const KO_ROUND_NAMES = { 16: 'Oitavas', 8: 'Quartas', 4: 'Semifinais', 2: 'Final' };

function koRoundLabel(m) {
  if (m.id === 'KO-3P') return '3º lugar';
  if (m.roundSize === 2) return 'Final';
  return `${KO_ROUND_NAMES[m.roundSize] ?? `Rodada de ${m.roundSize}`} · ${m.label}`;
}

/* Duplas do mata-mata: melhores com melhores — 1ºs ranqueados por performance
   geral formam duplas entre si, depois os 2ºs, e melhores 3ºs completam a chave */
function koEntries() {
  const target = nextPow2(GROUPS.length);
  const need = target * 2;
  const byPerf = (a, b) => b.wins - a.wins || b.saldo - a.saldo || b.gamesWon - a.gamesWon;
  const firsts = GROUPS.map(g => eligibleStandings(g)[0]).filter(Boolean).sort(byPerf);
  const seconds = GROUPS.map(g => eligibleStandings(g)[1]).filter(Boolean).sort(byPerf);
  const thirds = bestThirds();
  const pool = [
    ...firsts.map((r, i) => ({ r, label: `${i + 1}º melhor 1º` })),
    ...seconds.map((r, i) => ({ r, label: `${i + 1}º melhor 2º` })),
  ];
  let usedThirds = 0;
  while (pool.length < need && usedThirds < thirds.length) {
    pool.push({ r: thirds[usedThirds], label: `${usedThirds + 1}º melhor 3º` });
    usedThirds++;
  }
  const entries = [];
  for (let i = 0; i + 1 < pool.length && entries.length < target; i += 2) {
    entries.push({ pair: [pool[i], pool[i + 1]] });
  }
  const byes = target - entries.length;
  while (entries.length < target) entries.push({ bye: true });
  return { entries, target, usedThirds, byes };
}

/* Gera os jogos do mata-mata (com bye e disputa de 3º) a partir dos grupos fechados */
function buildKnockout() {
  const { entries, target } = koEntries();
  entries.forEach(e => { if (e.pair) e.team = e.pair.map(x => x.r.p.id); });

  const matches = [];
  for (let i = 0; i < target / 2; i++) {
    const a = entries[i], b = entries[target - 1 - i];
    const bye = !!(a.bye || b.bye);
    matches.push({
      id: `KO-${target}-${i}`, phase: 'ko', roundSize: target, slot: i,
      label: target === 2 ? 'Final' : `${KO_ABBR[target] ?? 'R'}${i + 1}`,
      group: null, round: null, bye,
      teamA: a.team ?? b.team ?? null, teamB: bye ? null : b.team,
      scoreA: null, scoreB: null,
      status: bye ? 'done' : 'queued',
    });
  }
  for (let size = target / 2; size >= 2; size /= 2) {
    for (let i = 0; i < size / 2; i++) {
      matches.push({
        id: `KO-${size}-${i}`, phase: 'ko', roundSize: size, slot: i,
        label: size === 2 ? 'Final' : `${KO_ABBR[size] ?? 'R'}${i + 1}`,
        group: null, round: null,
        teamA: null, teamB: null, scoreA: null, scoreB: null, status: 'waiting',
        srcA: { id: `KO-${size * 2}-${i * 2}`, take: 'winner' },
        srcB: { id: `KO-${size * 2}-${i * 2 + 1}`, take: 'winner' },
      });
    }
  }
  // Disputa de 3º lugar conforme o template do evento
  if (target >= 4 && (currentTemplate()?.thirdPlaceMatch ?? true)) {
    matches.push({
      id: 'KO-3P', phase: 'ko', roundSize: 2, slot: 0, label: '3º lugar',
      group: null, round: null,
      teamA: null, teamB: null, scoreA: null, scoreB: null, status: 'waiting',
      srcA: { id: 'KO-4-0', take: 'loser' },
      srcB: { id: 'KO-4-1', take: 'loser' },
    });
  }
  // ordem de chamada: rodadas em sequência, 3º lugar antes da final
  matches.sort((a, b) =>
    b.roundSize - a.roundSize ||
    (a.id === 'KO-3P' ? -1 : b.id === 'KO-3P' ? 1 : 0) ||
    a.slot - b.slot);
  Repo.addKnockoutMatches(matches);
  ensureKO();
  Repo.persist();
}

/* 3ºs colocados de todos os grupos, ranqueados por performance geral */
function bestThirds() {
  return GROUPS.map(g => eligibleStandings(g)[2]).filter(Boolean)
    .sort((a, b) => b.wins - a.wins || b.saldo - a.saldo || b.gamesWon - a.gamesWon);
}

function koTeamRow(m, side) {
  const team = side === 'A' ? m.teamA : m.teamB;
  const score = side === 'A' ? m.scoreA : m.scoreB;
  if (!team) {
    const lbl = m.bye && side === 'B' ? 'Bye — avança direto' : koSrcText(m, side);
    return `<div class="mc-team tbd">${lbl}</div>`;
  }
  let cls = '', right = '';
  if (m.status === 'done' && !m.bye) {
    cls = winnerOf(m) === team ? 'win' : 'lose';
    right = `<span class="mc-score">${score}</span>`;
  } else if (m.status === 'playing') {
    right = `<span class="mc-score">${score}</span>`;
  }
  return `<div class="mc-team ${cls}"><span class="mc-names">${teamHtml(team)}</span>${right}</div>`;
}

function koMatchCard(m) {
  let tag = '';
  if (m.status === 'playing') {
    const c = DB.courts.find(x => x.id === m.courtId);
    tag = `<span class="mc-note live"><wa-icon name="baseball"></wa-icon> ${c?.name ?? ''}</span>`;
  } else if (m.bye) {
    tag = '<span class="mc-note">bye</span>';
  } else if (m.wo) {
    tag = '<span class="mc-note">W.O.</span>';
  }
  return `
    <div class="match-card ${m.status}${m.id === 'KO-3P' ? ' mc-third' : ''}">
      <div class="mc-head"><span>${m.label}</span>${tag}</div>
      ${koTeamRow(m, 'A')}${koTeamRow(m, 'B')}
    </div>`;
}

function projTeamRow(entry) {
  if (!entry) return '<div class="mc-team tbd">—</div>';
  if (entry.bye) return '<div class="mc-team tbd">Bye — avança direto</div>';
  // Ranking geral só resolve com todos os grupos fechados
  if (allGroupsDone()) {
    return `<div class="mc-team"><span class="mc-names">${teamHtml(entry.pair.map(x => x.r.p.id))}</span></div>`;
  }
  return `<div class="mc-team tbd">${entry.pair.map(x => x.label).join(' + ')}</div>`;
}

/* Colunas do chaveamento com linhas de ligação (pares → próxima rodada).
   3º lugar fica na coluna do campeão pra não quebrar a sequência das linhas. */
function bracketColumns(rounds, championHtml, thirdHtml) {
  return rounds.map((r, ri) => {
    let body;
    if (r.matches.length === 1) {
      body = r.matches[0];
    } else {
      const pairs = [];
      for (let i = 0; i < r.matches.length; i += 2) {
        pairs.push(`<div class="bracket-pair">${r.matches[i]}${r.matches[i + 1] ?? ''}</div>`);
      }
      body = pairs.join('');
    }
    return `<div class="round ${ri ? 'has-in' : ''}"><h4>${r.name}</h4><div class="round-body">${body}</div></div>`;
  }).join('') + `
    <div class="round">
      <h4>Campeão</h4>
      <div class="round-body">
        ${championHtml}
        ${thirdHtml ? `<div class="third-block"><h4 class="third-title">3º lugar</h4>${thirdHtml}</div>` : ''}
      </div>
    </div>`;
}

function renderBracket() {
  const n = GROUPS.length;
  const host = $('#bracket');
  if (n < 2) {
    host.innerHTML = setupEmptyState() ??
      '<p class="muted">Chaveamento disponível após o sorteio dos grupos.</p>';
    return;
  }

  // Mata-mata montado: chave real, com placares e propagação
  if (koBuilt()) {
    const ko = koGames();
    const sizes = [...new Set(ko.filter(m => m.id !== 'KO-3P').map(m => m.roundSize))].sort((a, b) => b - a);
    const rounds = sizes.map(size => ({
      name: KO_ROUND_NAMES[size] ?? `Rodada de ${size}`,
      matches: ko.filter(m => m.roundSize === size && m.id !== 'KO-3P')
        .sort((a, b) => a.slot - b.slot).map(koMatchCard),
    }));
    const third = ko.find(m => m.id === 'KO-3P');
    const thirdHtml = third ? koMatchCard(third) : '';
    const champs = winnerOf(ko.find(m => m.id === 'KO-2-0'));
    const championHtml = champs
      ? `<div class="champion crowned"><wa-icon name="crown"></wa-icon><span>${teamHtml(champs)}</span></div>`
      : '<div class="champion"><wa-icon name="crown"></wa-icon><span>A definir</span></div>';
    host.innerHTML = bracketColumns(rounds, championHtml, thirdHtml);
    return;
  }

  // Projeção enquanto os grupos rodam
  const { entries, target } = koEntries();

  const rounds = [];
  rounds.push({
    name: KO_ROUND_NAMES[target] ?? `Rodada de ${target}`,
    matches: Array.from({ length: target / 2 }, (_, i) => `
      <div class="match-card">
        <div class="mc-head"><span>${KO_ABBR[target] ?? 'R'}${i + 1}</span></div>
        ${projTeamRow(entries[i])}${projTeamRow(entries[target - 1 - i])}
      </div>`),
  });
  for (let size = target / 2; size >= 2; size /= 2) {
    const prev = KO_ABBR[size * 2] ?? `R${size * 2}`;
    rounds.push({
      name: KO_ROUND_NAMES[size] ?? `Rodada de ${size}`,
      matches: Array.from({ length: size / 2 }, (_, i) => `
        <div class="match-card">
          <div class="mc-head"><span>${size === 2 ? 'Final' : `${KO_ABBR[size] ?? 'R'}${i + 1}`}</span></div>
          <div class="mc-team tbd">Vencedor ${prev}${i * 2 + 1}</div>
          <div class="mc-team tbd">Vencedor ${prev}${i * 2 + 2}</div>
        </div>`),
    });
  }
  const thirdHtml = target >= 4 ? `
    <div class="match-card mc-third">
      <div class="mc-head"><span>3º lugar</span></div>
      <div class="mc-team tbd">Perdedor SF1</div>
      <div class="mc-team tbd">Perdedor SF2</div>
    </div>` : '';
  host.innerHTML = bracketColumns(rounds,
    '<div class="champion"><wa-icon name="crown"></wa-icon><span>A definir</span></div>', thirdHtml);
}

/* ---------- Mission Control ---------- */

function setupStage() {
  if (!DB.event.created) return 'event';
  if (!DB.players.length) return 'athletes';
  if (!DB.games.length) return 'draw';
  if (!DB.setup.courtsConfirmed) return 'courts';
  return 'live';
}

/* Pontuação cresce uma coluna por etapa — imprime em paisagem */
function printLandscape() {
  const st = document.createElement('style');
  st.textContent = '@page { size: A4 landscape; }';
  document.head.appendChild(st);
  const cleanup = () => { st.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function openEventModal() {
  $('#ev-name').value = DB.event.name ?? '';
  $('#ev-edition').value = DB.event.edition ?? '';
  $('#ev-date').value = DB.event.date ?? '';
  $('#ev-season').innerHTML = '<wa-option value="">Sem temporada</wa-option>' +
    (DB.seasons ?? []).map(s => `<wa-option value="${s.id}">${esc(s.name)}</wa-option>`).join('');
  // padrão: temporada do evento atual; senão a última criada
  const lastSeason = (DB.seasons ?? []).at(-1);
  const selId = DB.event.seasonId ?? lastSeason?.id ?? '';
  $('#ev-season').value = String(selId);
  const s = (DB.seasons ?? []).find(x => x.id === Number(selId)) ?? null;
  $('#ev-name').hidden = !!s;
  if (s && !$('#ev-edition').value) $('#ev-edition').value = `${s.stages.length + 1}ª Etapa`;
  if (!$('#ev-date').value) $('#ev-date').value = new Date().toISOString().slice(0, 10);
  $('#dlg-event').dataset.tpl = DB.event.templateId ?? DB.templates[0]?.id;
  renderTplPicker();
  $('#ev-error').hidden = true;
  $('#dlg-event').open = true;
}

function eventDateFmt() {
  if (!DB.event.date) return '';
  const d = new Date(`${DB.event.date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' :
    new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

function renderMissionSetup(stage) {
  const nCourts = DB.courts.length;
  const steps = [
    {
      key: 'event', label: 'Criar etapa',
      desc: DB.event.created
        ? [DB.event.name, DB.event.edition].filter(Boolean).join(' · ')
        : 'Temporada, etapa e data',
      action: `<wa-button size="s" variant="brand" data-action="open-event">
        <wa-icon slot="start" name="calendar-plus"></wa-icon> Criar Etapa</wa-button>`,
    },
    {
      key: 'athletes', label: 'Cadastrar atletas',
      desc: DB.players.length
        ? `${DB.players.length} cadastrado${DB.players.length > 1 ? 's' : ''}`
        : 'Importe a lista de inscritos',
      action: `<wa-button size="s" variant="brand" data-action="setup-athletes">
        <wa-icon slot="start" name="file-import"></wa-icon> Cadastrar Atletas</wa-button>`,
    },
    {
      key: 'draw', label: 'Sortear grupos',
      desc: (() => {
        if (GROUPS.length) return `${GROUPS.length} grupos formados`;
        const marked = DB.players.filter(p => p.present).length;
        const n = marked || DB.players.length;
        const src = marked ? 'presentes' : 'cadastrados';
        if (!n) return 'Grupos de 4 atletas';
        return n % 4 === 0
          ? `${n} ${src} → ${n / 4} grupo${n > 4 ? 's' : ''} de 4 atletas`
          : `${n} ${src} — precisa de múltiplo de 4`;
      })(),
      action: `<wa-button size="s" variant="brand" data-action="sortear">
        <wa-icon slot="start" name="shuffle"></wa-icon> Sortear Grupos</wa-button>`,
    },
    {
      key: 'courts', label: 'Confirmar quadras',
      desc: nCourts
        ? `${nCourts} quadra${nCourts > 1 ? 's' : ''} à disposição`
        : 'Nenhuma quadra cadastrada',
      action: `
        ${nCourts ? `<wa-button size="s" variant="brand" data-action="confirm-courts">
          <wa-icon slot="start" name="circle-check"></wa-icon> Confirmar ${nCourts} quadra${nCourts > 1 ? 's' : ''}</wa-button>` : ''}
        <wa-button size="s" appearance="${nCourts ? 'plain' : 'outlined'}" data-action="nav" data-view="courts">
          <wa-icon slot="start" name="baseball"></wa-icon> Gerenciar quadras</wa-button>`,
    },
  ];
  const idx = steps.findIndex(s => s.key === stage);
  $('#mission-body').innerHTML = `
    <div class="m-section">
      <span class="m-label"><wa-icon name="flag-checkered"></wa-icon> Preparar evento</span>
      ${steps.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'pending';
        return `
          <div class="setup-step ${state}">
            <span class="step-badge">${state === 'done' ? '<wa-icon name="check"></wa-icon>' : i + 1}</span>
            <div class="step-body">
              <strong>${s.label}</strong>
              <span class="muted">${s.desc}</span>
              ${state === 'current' ? `<div class="step-action">${s.action}</div>` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderMission() {
  const stage = setupStage();
  // Durante o setup só o wizard aparece — sem event-card/badges
  $('.mission-head').hidden = stage !== 'live';
  $('.mission-status').hidden = stage !== 'live';
  if (stage !== 'live') { renderMissionSetup(stage); return; }
  const inKo = koBuilt();
  const pool = inKo ? koGames().filter(m => !m.bye) : groupPhaseGames();
  const phaseLabel = inKo ? 'Mata-mata' : 'Fase de grupos';
  const total = pool.length;
  const done = pool.filter(g => g.status === 'done').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  const next = queuedGames()[0];
  const court = freeCourts()[0];
  const final = DB.games.find(m => m.id === 'KO-2-0');

  // Campeão definido: só o card de campeões (com Encerrar etapa / Ver chaveamento)
  if (inKo && final?.status === 'done') {
    $('.mission-status').hidden = true;
    const third = DB.games.find(m => m.id === 'KO-3P');
    const season = eventSeason();
    $('#mission-body').innerHTML = `
      <div class="m-card next-card">
        <p class="champion-line"><wa-icon name="crown"></wa-icon>
          <strong>Campeões: ${teamHtml(winnerOf(final))}</strong></p>
        ${third?.status === 'done' ? `<p class="muted">3º lugar: ${teamHtml(winnerOf(third))}</p>` : ''}
        ${season && !DB.event.stageClosed ? `
          <wa-button size="s" variant="warning" data-action="close-stage">
            <wa-icon slot="start" name="ranking-star"></wa-icon> Encerrar etapa · somar pontos
          </wa-button>` : ''}
        ${DB.event.stageClosed ? '<p class="hint"><wa-icon name="circle-check"></wa-icon> Pontos somados à temporada</p>' : ''}
        <wa-button size="s" variant="brand" data-action="nav" data-view="bracket">
          <wa-icon slot="start" name="trophy"></wa-icon> Ver chaveamento
        </wa-button>
      </div>`;
    return;
  }

  // desempates chamados jogam na quadra que estiver livre — sem quadra fixa
  const tbNow = DB.tiebreaks.filter(t => t.called && t.winnerId == null).map(tb => `
    <div class="m-card">
      <div class="m-row">
        <span class="m-court-tag">
          ${undoBtnHtml(`undo-mtb-${tb.id}`, `data-action="uncall-tiebreak" data-tb="${tb.id}"`)}
          <wa-tag size="s" variant="warning">Desempate · Grupo ${tb.group}</wa-tag>
        </span>
      </div>
      <p class="tb-names">${tb.players.map(nameLink).join(' vs ')}</p>
      <wa-button size="s" variant="success" data-action="open-winner" data-tb="${tb.id}">
        <wa-icon slot="start" name="circle-check"></wa-icon> Quem venceu?
      </wa-button>
    </div>`).join('');

  const nowBlock = (playingGames().map(g => {
    const c = DB.courts.find(x => x.id === g.courtId);
    const tag = g.offCourt
      ? `<wa-tag size="s" variant="warning"><wa-icon name="hourglass-half"></wa-icon>&nbsp;${c.name} · placar pendente</wa-tag>`
      : `<wa-tag size="s" variant="brand">${c.name}</wa-tag>`;
    return `
      <div class="m-card">
        <div class="m-row">
          <span class="m-court-tag">
            ${undoBtnHtml(`undo-mg-${g.id}`, `data-action="uncall-game" data-game="${g.id}"`)}
            ${tag}
          </span>
          <span class="muted"><wa-icon name="clock"></wa-icon> ${g.elapsedMin} min</span>
        </div>
        <div class="m-match">
          <span>${teamLinesHtml(g.teamA)}</span>
          <strong>${g.scoreA || g.scoreB ? `${g.scoreA} × ${g.scoreB}` : 'vs'}</strong>
          <span>${teamLinesHtml(g.teamB)}</span>
        </div>
        <wa-button size="s" variant="success" data-action="open-score" data-game="${g.id}">
          <wa-icon slot="start" name="circle-check"></wa-icon> Registrar placar
        </wa-button>
      </div>`;
  }).join('') + tbNow) || '<p class="muted m-empty">Nenhum jogo em quadra.</p>';

  // desempate pendente destrava a classificação — vem antes na fila e não pede quadra
  const tbNext = DB.tiebreaks.find(t => !t.called && t.winnerId == null);

  let nextBlock;
  if (!total) {
    nextBlock = '<p class="muted m-empty">Cadastre atletas e sorteie os grupos para gerar os jogos.</p>';
  } else if (tbNext) {
    nextBlock = `
      <div class="m-card next-card">
        <div class="m-row">
          <span class="chip chip-g">Grupo ${tbNext.group} · Desempate</span>
          <wa-tag size="s" variant="warning">${tbNext.type}</wa-tag>
        </div>
        <p class="tb-names">${tbNext.players.map(nameLink).join('<br>')}</p>
        <wa-button size="s" variant="brand" data-action="call-tiebreak" data-tb="${tbNext.id}">
          <wa-icon slot="start" name="bullhorn"></wa-icon> Chamar — quadra que estiver livre
        </wa-button>
      </div>`;
  } else if (next) {
    const chip = next.phase === 'ko'
      ? `<span class="chip chip-g">${koRoundLabel(next)}</span>`
      : `<span class="chip chip-g">Grupo ${next.group} · R${next.round}</span>`;
    nextBlock = `
      <div class="m-card next-card">
        <div class="m-row">${chip}</div>
        <div class="m-match">
          <span>${teamLinesHtml(next.teamA)}</span>
          <strong>vs</strong>
          <span>${teamLinesHtml(next.teamB)}</span>
        </div>
        ${court
          ? `<wa-button size="s" variant="brand" data-action="call-game" data-game="${next.id}">
               <wa-icon slot="start" name="bullhorn"></wa-icon> Chamar para ${court.name}</wa-button>`
          : `<wa-button size="s" variant="brand" appearance="outlined" data-action="call-game" data-game="${next.id}">
               <wa-icon slot="start" name="bullhorn"></wa-icon> Chamar — escolher quadra</wa-button>`}
      </div>`;
  } else if (!inKo && allGroupsDone() && total) {
    const pending = DB.tiebreaks.filter(t => t.winnerId == null);
    nextBlock = pending.length ? `
      <div class="m-card next-card">
        <p><strong>Grupos encerrados — falta${pending.length > 1 ? 'm' : ''} ${pending.length} desempate${pending.length > 1 ? 's' : ''}.</strong></p>
        <wa-button size="s" variant="brand" data-action="nav" data-view="games">
          <wa-icon slot="start" name="scale-balanced"></wa-icon> Resolver desempates
        </wa-button>
      </div>` : `
      <div class="m-card next-card">
        <p><strong>Fase de grupos encerrada!</strong></p>
        <wa-button size="s" variant="brand" data-action="build-ko">
          <wa-icon slot="start" name="diagram-project"></wa-icon> Montar mata-mata
        </wa-button>
      </div>`;
  } else if (inKo && !playingGames().length && !next) {
    nextBlock = '<p class="muted m-empty">Aguardando definição dos próximos confrontos.</p>';
  } else {
    nextBlock = '<p class="muted m-empty">Sem jogos na fila.</p>';
  }

  $('#mission-body').innerHTML = `
    <div class="m-section">
      <div class="m-progress-head">
        <span class="m-label">${phaseLabel}</span>
        <span class="muted">${done}/${total} jogos</span>
      </div>
      <wa-progress-bar value="${pct}"></wa-progress-bar>
    </div>

    <div class="m-section">
      <span class="m-label"><wa-icon name="baseball"></wa-icon> Agora em quadra</span>
      ${nowBlock}
    </div>

    <div class="m-section">
      <span class="m-label"><wa-icon name="bullhorn"></wa-icon> Próximo a chamar</span>
      ${nextBlock}
      <wa-button size="s" appearance="plain" data-action="nav" data-view="courts">
        <wa-icon slot="start" name="plus"></wa-icon> Adicionar quadra
      </wa-button>
    </div>`;
}

/* ---------- Spotlight (busca com "/") ---------- */

const deaccent = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function openSpotlight() {
  $('#spotlight-input').value = '';
  renderSpotlightResults('');
  $('#dlg-spotlight').open = true;
}

function renderSpotlightResults(q) {
  const query = deaccent(q.trim());
  const matches = query
    ? DB.players.filter(p => deaccent(p.name).includes(query)).slice(0, 8)
    : [];
  $('#spotlight-results').innerHTML = matches.map(p => {
    const st = playerStatus(p);
    return `
      <div class="spotlight-item" data-action="open-athlete" data-player="${p.id}">
        <span class="avatar g${p.group ?? ''}">${esc(p.name[0])}</span>
        <span class="spotlight-name">${esc(p.name)}</span>
        ${p.group ? `<span class="chip chip-g">Grupo ${p.group}</span>` : '<span class="muted">sem grupo</span>'}
        <wa-tag size="s" variant="${st.variant}">${st.label}</wa-tag>
      </div>`;
  }).join('') || (query
    ? '<p class="muted center" style="padding:.75rem 0">Nenhum atleta encontrado.</p>' : '');
}

/* ---------- desistência / lesão ---------- */

function applyWithdrawalEffects(p) {
  const koStarted = koGames().some(m => (m.status === 'done' && !m.bye) || m.status === 'playing');
  if (koBuilt() && !koStarted) {
    // Chave ainda não começou: refaz o mata-mata — o próximo melhor sobe
    DB.games = DB.games.filter(g => g.phase !== 'ko');
    buildKnockout();
    return;
  }
  // Jogos pendentes do atleta viram W.O. (a outra dupla vence)
  for (const g of DB.games) {
    if (g.status !== 'queued' && g.status !== 'playing') continue;
    const inA = g.teamA?.includes(p.id);
    const inB = g.teamB?.includes(p.id);
    if (!inA && !inB) continue;
    g.status = 'done';
    g.wo = true;
    g.scoreA = inA ? 0 : DB.event.gamesPerMatch;
    g.scoreB = inB ? 0 : DB.event.gamesPerMatch;
  }
}

/* Zera resultados mantendo atletas, grupos e rodízio — mata-mata é desfeito */
function resetScores() {
  if (!confirm('Zerar todos os placares? Jogos voltam pra fila e o mata-mata é desfeito.')) return;
  Repo.resetScores();
  renderAll();
}

function toggleWithdrawal(pid) {
  const p = playerById(Number(pid));
  if (!p) return;
  if (!p.withdrawn) {
    if (!confirm(`Confirmar desistência/lesão de ${p.name}? Jogos pendentes viram W.O. e a chave é recalculada se ainda não começou.`)) return;
    Repo.setWithdrawn(p.id, true);
    applyWithdrawalEffects(p);
    Repo.persist(); // efeitos (W.O. / rebuild) mudaram jogos
  } else {
    Repo.setWithdrawn(p.id, false);
  }
  renderAll();
  openAthleteModal(p.id);
}

function athleteGameRow(g, pid) {
  const inA = g.teamA.includes(pid);
  const mates = (inA ? g.teamA : g.teamB).filter(x => x !== pid).map(nameLink).join(' & ');
  const opp = (inA ? g.teamB : g.teamA).map(nameLink).join(' & ');
  const my = inA ? g.scoreA : g.scoreB;
  const their = inA ? g.scoreB : g.scoreA;
  let right;
  if (g.status === 'done') {
    const won = my > their;
    right = `<span class="result-score">${my} × ${their}</span>
      <wa-tag size="s" variant="${won ? 'success' : 'danger'}">${won ? 'Vitória' : 'Derrota'}</wa-tag>
      <wa-button size="s" appearance="plain" title="Editar placar" data-action="open-score" data-game="${g.id}">
        <wa-icon name="pen"></wa-icon></wa-button>`;
  } else if (g.status === 'playing') {
    const court = DB.courts.find(c => c.id === g.courtId);
    right = `<wa-tag size="s" variant="brand"><wa-icon name="baseball"></wa-icon>&nbsp;${court.name}${my || their ? ` · ${my}×${their}` : ''}</wa-tag>
      <wa-button size="s" variant="success" data-action="open-score" data-game="${g.id}">
        <wa-icon slot="start" name="circle-check"></wa-icon> Placar</wa-button>`;
  } else {
    right = '<span class="muted">na fila</span>';
  }
  return `
    <div class="athlete-game">
      <span class="round-tag">${g.phase === 'ko' ? g.label : `R${g.round}`}</span>
      <span class="athlete-game-desc">com <strong>${mates}</strong> vs ${opp}</span>
      <span class="athlete-game-right">${right}</span>
    </div>`;
}

function openAthleteModal(pid) {
  const p = playerById(Number(pid));
  if (!p) return;
  const dlg = $('#dlg-athlete');
  dlg.dataset.player = p.id;
  const st = p.group ? standings(p.group).find(r => r.p.id === p.id) : null;
  const pos = p.group ? standings(p.group).findIndex(r => r.p.id === p.id) + 1 : null;
  const status = playerStatus(p);
  const games = DB.games.filter(g => g.teamA?.includes(p.id) || g.teamB?.includes(p.id));
  const tbs = DB.tiebreaks.filter(t => t.players.includes(p.id));
  $('#athlete-body').innerHTML = `
    <div class="athlete-head">
      <span class="avatar big g${p.group ?? ''}">${esc(p.name[0])}</span>
      <div class="athlete-id">
        <strong>${esc(p.name)}</strong>
        <div class="athlete-chips">
          ${p.group ? `<span class="chip chip-g">Grupo ${p.group}</span>` : '<span class="muted">Sem grupo</span>'}
          ${pos ? `<span class="chip">${pos}º do grupo</span>` : ''}
          <wa-tag size="s" variant="${status.variant}"><wa-icon name="${status.icon}"></wa-icon>&nbsp;${status.label}</wa-tag>
        </div>
      </div>
      <span class="athlete-present-wrap">
        <wa-checkbox class="athlete-present" data-player="${p.id}" ${p.present ? 'checked' : ''}>Presente</wa-checkbox>
        <kbd title="Atalho: P">P</kbd>
        ${p.withdrawn
          ? `<wa-button size="s" appearance="outlined" data-action="toggle-withdrawn" data-player="${p.id}">
              <wa-icon slot="start" name="rotate-left"></wa-icon> Reativar</wa-button>`
          : `<wa-button size="s" variant="danger" appearance="outlined" data-action="toggle-withdrawn" data-player="${p.id}">
              <wa-icon slot="start" name="user-injured"></wa-icon> Desistência</wa-button>`}
      </span>
    </div>

    <div class="athlete-stats">
      <div class="stat"><span class="stat-value">${st?.played ?? 0}</span><span class="stat-label">Jogos</span></div>
      <div class="stat"><span class="stat-value">${st?.wins ?? 0}</span><span class="stat-label">Vitórias</span></div>
      <div class="stat"><span class="stat-value">${(st?.saldo ?? 0) > 0 ? '+' : ''}${st?.saldo ?? 0}</span><span class="stat-label">Saldo</span></div>
      <div class="stat"><span class="stat-value">${st?.gamesWon ?? 0}</span><span class="stat-label">Games</span></div>
    </div>

    <h4 class="athlete-section"><wa-icon name="table-tennis-paddle-ball"></wa-icon> Jogos</h4>
    ${games.map(g => athleteGameRow(g, p.id)).join('') ||
      '<p class="muted">Nenhum jogo — aguardando sorteio.</p>'}

    ${tbs.length ? `
      <h4 class="athlete-section"><wa-icon name="scale-balanced"></wa-icon> Desempates</h4>
      ${tbs.map(tb => `
        <div class="athlete-game">
          <wa-tag size="s" variant="${tb.winnerId == null ? 'warning' : 'neutral'}">${tb.type}</wa-tag>
          <span class="athlete-game-desc">vs ${tb.players.filter(x => x !== p.id).map(nameLink).join(' e ')}</span>
          <span class="athlete-game-right">${
            tb.winnerId == null
              ? '<span class="muted">pendente</span>'
              : `<wa-tag size="s" variant="${tb.winnerId === p.id ? 'success' : 'danger'}">${tb.winnerId === p.id ? 'Venceu' : 'Perdeu'}</wa-tag>`
          }</span>
        </div>`).join('')}` : ''}
  `;
  const wasOpen = dlg.open;
  dlg.open = true;
  // Atleta com jogo em quadra: abre o lançador de placar direto (foco no 1º campo)
  if (!wasOpen) {
    const live = playingGames().find(g => g.teamA?.includes(p.id) || g.teamB?.includes(p.id));
    if (live) openScoreDialog(live.id);
  }
}

/* ---------- header + render geral ---------- */

function renderHeader() {
  $('#stage-badge').textContent = koBuilt() ? 'Mata-mata' : 'Fase de Grupos';
  const busy = DB.courts.filter(c => courtOccupant(c.id)).length;
  $('#courts-chip').innerHTML =
    `<wa-icon name="baseball"></wa-icon> ${busy}/${DB.courts.length} quadras em uso`;
  $('#event-card-title').textContent = DB.event.created ? DB.event.name : 'Sem evento';
  $('#event-card-sub').textContent = DB.event.created
    ? [DB.event.edition, eventDateFmt()].filter(Boolean).join(' · ')
    : 'Clique pra criar';
  $('#nav-new-stage').hidden = !DB.event.stageClosed;
  // cabeçalho de impressão: temporada como título, etapa/data como linha fina
  $('#print-title').textContent = eventSeason()?.name || DB.event.name || '';
  $('#print-sub').textContent = [DB.event.edition, eventDateFmt()].filter(Boolean).join(' · ');
}

function renderBrand() {
  const url = DB.brand?.url || '';
  const img = $('#brand-logo');
  if (url && img.src !== url) img.src = url;
  img.hidden = !url;
  $('#brand-logo-ph').hidden = !!url;
  $('.brand-remove').hidden = !url;
}

function renderAll() {
  ensureTiebreaks();
  ensureKO();
  Repo.persist(); // derivados (desempates/propagação de chave) também persistem
  renderBrand();
  renderHeader();
  renderGamesList();
  renderPlayers();
  renderGroups();
  renderCourtsView();
  renderCourtsDialog();
  renderSettings();
  renderSeasonSettings();
  renderSeasonView();
  renderSponsorList();
  renderSponsorsFooter();
  renderBracket();
  renderMission();
  updateProfileGate();
}

/* ---------- ações ---------- */

function showView(view) {
  $$('.view').forEach(v => v.hidden = v.id !== `view-${view}`);
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  history.replaceState(null, '', `#${view}`);
}

function openScoreDialog(gameId) {
  const g = DB.games.find(x => x.id === gameId);
  const dlg = $('#dlg-score');
  dlg.dataset.game = gameId;
  $('#score-context').innerHTML = `<span class="chip chip-g">${
    g.phase === 'ko' ? koRoundLabel(g) : `Grupo ${g.group} · Rodada ${g.round}`
  }</span>`;
  $('#score-team-a').textContent = g.teamA.map(nameOf).join(' & ');
  $('#score-team-b').textContent = g.teamB.map(nameOf).join(' & ');
  $('#score-a').value = g.scoreA ?? '';
  $('#score-b').value = g.scoreB ?? '';
  $('#score-a').placeholder = '';
  $('#score-b').placeholder = '';
  $('#score-error').hidden = true;
  $('#btn-clear-score').hidden = g.status !== 'done'; // só com placar já lançado
  dlg.open = true;
}

/* No focus, limpa o input e vira placeholder — digitar substitui direto,
   sem backspace. Sair sem digitar restaura o valor. */
const isScoreInput = el => el.id === 'score-a' || el.id === 'score-b';

document.addEventListener('focusin', e => {
  if (isScoreInput(e.target) && e.target.value !== '') {
    e.target.placeholder = e.target.value;
    e.target.value = '';
  }
  // Resumo dos grupos / link do atleta: focou, seleciona tudo pra copiar rápido
  if (e.target.id === 'groups-summary-text' || e.target.id === 'athlete-link-text') e.target.select();
});

document.addEventListener('focusout', e => {
  if (isScoreInput(e.target)) {
    if (e.target.value === '' && e.target.placeholder !== '') {
      e.target.value = e.target.placeholder;
    }
    e.target.placeholder = '';
  }
});

/* Safari nem sempre dispara blur ao clicar em botão — placeholder é o fallback */
const readScore = el => parseInt(el.value !== '' ? el.value : el.placeholder, 10);

function saveScore() {
  const dlg = $('#dlg-score');
  const g = DB.games.find(x => x.id === dlg.dataset.game);
  const a = readScore($('#score-a'));
  const b = readScore($('#score-b'));
  if (Number.isNaN(a) || Number.isNaN(b) || a === b) {
    $('#score-error').hidden = false;
    return;
  }
  Repo.saveScore(g.id, a, b);
  dlg.open = false;
  renderAll();
  // Modal do atleta aberto por baixo? Atualiza o conteúdo
  const athleteDlg = $('#dlg-athlete');
  if (athleteDlg.open) openAthleteModal(athleteDlg.dataset.player);
}

function startGameOn(g, courtId) {
  Repo.callGame(g.id, courtId);
  renderAll();
}

function callGame(gameId) {
  const g = DB.games.find(x => x.id === gameId);
  if (!g) return;
  const court = freeCourts()[0];
  if (court) { startGameOn(g, court.id); return; }
  openCourtPick(gameId);
}

function openCourtPick(gameId) {
  const g = DB.games.find(x => x.id === gameId);
  if (!g) return;
  $('#pick-matchup').innerHTML = `
    <div class="m-match">
      <span>${esc(g.teamA.map(nameOf).join(' & '))}</span><strong>vs</strong>
      <span>${esc(g.teamB.map(nameOf).join(' & '))}</span>
    </div>`;
  $('#pick-courts').innerHTML = DB.courts.map(c => `
      <wa-button appearance="outlined" class="pick-court-btn"
        data-action="pick-court" data-court="${c.id}" data-game="${g.id}">
        <wa-icon slot="start" name="baseball"></wa-icon> ${esc(c.name)}
        ${courtOccupant(c.id) ? '' : '<wa-tag slot="end" size="s" variant="success">Livre</wa-tag>'}
      </wa-button>`).join('');
  $('#dlg-court-pick').open = true;
}

function savePlayer() {
  const name = ($('#np-name').value || '').trim();
  if (!name) { $('#np-error').hidden = false; return; }
  Repo.addAthlete(name, $('#np-group').value);
  $('#dlg-player').open = false;
  $('#np-name').value = '';
  $('#np-error').hidden = true;
  renderAll();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.classList.contains('disabled')) return;
  const act = el.dataset.action;
  if (act === 'nav') showView(el.dataset.view);
  if (act === 'add-court') addCourt();
  if (act === 'remove-court') {
    Repo.removeCourt(Number(el.dataset.court));
    renderAll();
  }
  if (act === 'open-add-player') { $('#np-error').hidden = true; $('#dlg-player').open = true; }
  if (act === 'save-player') savePlayer();
  if (act === 'delete-all-players') deleteAllPlayers();
  if (act === 'reset-scores') resetScores();
  if (act === 'open-event') {
    if (!(DB.seasons ?? []).length && !DB.event.created) {
      if (confirm('Ainda não existe temporada. Criar a temporada primeiro? (recomendado — as etapas somam pontos nela)')) {
        openSeasonModal();
        return;
      }
    }
    openEventModal();
  }
  if (act === 'new-stage') {
    if (!confirm('Iniciar nova etapa? Atletas, jogos e grupos são zerados — importe a lista da etapa; a pontuação da temporada fica salva.')) return;
    Repo.startNewStage();
    renderAll();
    openEventModal();
  }
  if (act === 'pick-template') {
    $('#dlg-event').dataset.tpl = el.dataset.tpl;
    renderTplPicker();
  }
  if (act === 'open-template') {
    $('#tpl-name').value = '';
    $('#tpl-tiebreak').value = '';
    $('#tpl-games').value = 4;
    $('#tpl-error').hidden = true;
    $('#dlg-template').open = true;
  }
  if (act === 'save-template') saveTemplate();
  if (act === 'wipe-local') {
    if (confirm('Apagar todos os dados salvos neste navegador?')) Repo.wipe();
  }
  if (act === 'open-season-modal') openSeasonModal(el.dataset.season ? Number(el.dataset.season) : null);
  if (act === 'season-save') saveSeasonModal();
  if (act === 'season-delete') {
    Repo.deleteSeason(Number(el.dataset.season));
    renderAll();
  }
  if (act === 'close-stage') closeStage();
  if (act === 'demo-stage') toggleDemoStage();
  if (act === 'simulate-scores') simulateStageScores();
  if (act === 'print-season') { showView('season'); setTimeout(printLandscape, 100); }
  if (act === 'print-view') setTimeout(() => window.print(), 100);
  if (act === 'sponsor-upload') {
    (async () => {
      const fileInp = $('#sp-file');
      const file = fileInp.files?.[0];
      const category = ($('#sp-category').value || '').trim() || 'Apoio';
      const st = $('#sp-status');
      if (!file) { st.textContent = 'Escolha uma imagem.'; return; }
      if (!Sync.enabled()) { st.textContent = 'Ative a sincronização (Supabase) primeiro.'; return; }
      st.textContent = 'Enviando…';
      try {
        const { path, url } = await Sync.uploadLogo(file);
        Repo.addSponsor({ id: Date.now(), category, url, path });
        fileInp.value = '';
        st.textContent = 'Logo enviada ✓';
        renderAll();
      } catch (err) {
        st.textContent = `Erro: ${err.message ?? err}`;
      }
    })();
  }
  if (act === 'sponsor-remove') {
    const id = Number(el.dataset.sponsor);
    const s = (DB.sponsors ?? []).find(x => x.id === id);
    if (s?.path) Sync.removeLogo(s.path).catch(() => {});
    Repo.removeSponsor(id);
    renderAll();
  }
  if (act === 'sign-out') {
    if (confirm('Sair da conta? Os dados continuam na nuvem — este navegador volta pra tela de login.')) {
      Sync.signOut();
    }
  }
  if (act === 'set-password') {
    (async () => {
      const pass = $('#sb-pass').value;
      const st = $('#sync-status');
      if (pass.length < 6) { st.textContent = 'Senha precisa de pelo menos 6 caracteres.'; return; }
      try {
        await Sync.setPassword(pass);
        $('#sb-pass').value = '';
        st.textContent = 'Senha salva ✓';
      } catch (err) {
        st.textContent = `Erro: ${err.message ?? err}`;
      }
    })();
  }
  if (act === 'auth-signin') authAction('in');
  if (act === 'auth-signup') authAction('up');
  if (act === 'auth-magic') authAction('magic');
  if (act === 'auth-offline') $('#auth-gate').hidden = true;
  if (act === 'profile-save') saveProfile();
  if (act === 'edit-profile') {
    profileGateManual = true;
    fillProfileInputs();
    $('#pf-error').hidden = true;
    $('#pf-cancel').hidden = false;
    $('#profile-gate').hidden = false;
  }
  if (act === 'profile-cancel') {
    profileGateManual = false;
    $('#profile-gate').hidden = true;
  }
  if (act === 'settings-tab') showSettingsTab(el.dataset.stab);
  if (act === 'call-tiebreak') {
    Repo.callTiebreak(el.dataset.tb);
    renderAll();
  }
  if (act === 'uncall-tiebreak') {
    Repo.uncallTiebreak(el.dataset.tb);
    renderAll();
  }
  if (act === 'uncall-game') {
    Repo.uncallGame(el.dataset.game);
    renderAll();
  }
  if (act === 'clear-score') {
    Repo.clearScore($('#dlg-score').dataset.game);
    $('#dlg-score').open = false;
    renderAll();
  }
  if (act === 'delete-template') {
    Repo.deleteTemplate(Number(el.dataset.tpl));
    renderAll();
  }
  if (act === 'save-event') {
    // Com temporada vinculada, o nome do evento é o nome da temporada
    const season = (DB.seasons ?? []).find(s => s.id === Number($('#ev-season').value));
    const name = season ? season.name : ($('#ev-name').value || '').trim();
    if (!name) { $('#ev-error').hidden = false; return; }
    const isNew = !DB.event.created;
    Repo.saveEvent({
      name,
      edition: ($('#ev-edition').value || '').trim(),
      date: $('#ev-date').value || '',
      templateId: Number($('#dlg-event').dataset.tpl) || DB.templates[0]?.id,
      seasonId: Number($('#ev-season').value) || null,
      ...(isNew ? { stageClosed: false } : {}),
      created: true,
    });
    $('#dlg-event').open = false;
    renderAll();
    // Etapa salva sem atletas (nova etapa ou primeira): vai pra Atletas e abre a importação
    if (!DB.players.length) {
      showView('players');
      $('#import-error').hidden = true;
      updateImportCount();
      $('#dlg-import').open = true;
    }
  }
  if (act === 'setup-athletes') {
    showView('players');
    $('#import-error').hidden = true;
    updateImportCount();
    $('#dlg-import').open = true;
  }
  if (act === 'build-ko') {
    if (allGroupsDone() && !tbPending() && !koBuilt()) {
      buildKnockout();
      renderAll();
      showView('games');
    }
  }
  if (act === 'confirm-courts') {
    if (DB.courts.length) {
      Repo.saveSetup({ courtsConfirmed: true });
      renderAll();
      showView('games');
    }
  }
  if (act === 'open-import') {
    $('#import-error').hidden = true;
    updateImportCount();
    $('#dlg-import').open = true;
  }
  if (act === 'save-import') importPlayers();
  if (act === 'sortear') openDrawModal();
  if (act === 'run-draw') runDraw();
  if (act === 'draw-next') {
    $('#dlg-draw').open = false;
    openGroupsSummary();
  }
  if (act === 'dlg-add-court') dlgAddCourt();
  if (act === 'confirm-courts-start') {
    // Quadra digitada e não adicionada? Insere antes de confirmar
    if (($('#dlg-court-name').value || '').trim()) dlgAddCourt();
    if (DB.courts.length) {
      Repo.saveSetup({ courtsConfirmed: true });
      $('#dlg-courts').open = false;
      renderAll();
      showView('games');
    }
  }
  if (act === 'open-score') openScoreDialog(el.dataset.game);
  if (act === 'save-score') saveScore();
  if (act === 'open-spotlight') openSpotlight();
  if (act === 'toggle-mission') $('.mission').classList.toggle('open');
  if (act === 'upload-brand') $('#brand-file').click();
  if (act === 'remove-brand') {
    if (DB.brand?.path) Sync.removeLogo(DB.brand.path).catch(() => {});
    DB.brand = { url: '', path: '' };
    Repo.persist();
    renderAll();
  }
  if (act === 'copy-athlete-link') {
    $('#athlete-slug').value = DB.slug ?? '';
    setSlugInd($('#slug-ind'), '');
    $('#athlete-link-text').value = placarLink();
    $('#copy-link-label').textContent = 'Copiar link';
    $('#dlg-athlete-link').open = true;
  }
  if (act === 'copy-athlete-link-confirm') {
    copyText($('#athlete-link-text').value);
    const label = $('#copy-link-label');
    label.textContent = 'Copiado ✓';
    setTimeout(() => { label.textContent = 'Copiar link'; }, 1500);
  }
  if (act === 'toggle-withdrawn') toggleWithdrawal(el.dataset.player);
  if (act === 'open-athlete') {
    $('#dlg-spotlight').open = false;
    openAthleteModal(el.dataset.player);
  }
  if (act === 'open-groups-summary') openGroupsSummary();
  if (act === 'copy-groups') copyGroupsText();
  if (act === 'open-winner') openWinnerDialog(el.dataset.tb);
  if (act === 'set-winner') {
    const tb = DB.tiebreaks.find(t => t.id === el.dataset.tb);
    if (tb) {
      Repo.setTiebreakWinner(tb.id, Number(el.dataset.player));
      $('#dlg-winner').open = false;
      renderAll();
    }
  }
  if (act === 'call-game') callGame(el.dataset.game);
  if (act === 'pick-court') {
    const g = DB.games.find(x => x.id === el.dataset.game);
    if (g) {
      $('#dlg-court-pick').open = false;
      startGameOn(g, Number(el.dataset.court));
    }
  }
  if (act === 'close-dialog') { const d = e.target.closest('wa-dialog'); if (d) d.open = false; }
});

['input', 'change'].forEach(ev => {
  document.addEventListener(ev, e => {
    if (e.target.id === 'player-search' || e.target.id === 'player-group-filter') renderPlayers();
    if (e.target.id === 'import-names') updateImportCount();
    if (e.target.id === 'dlg-court-name') {
      $('#dlg-courts-confirm').disabled = !DB.courts.length && !(e.target.value || '').trim();
    }
    // escolheu temporada no modal do evento: etapa auto + nome vem da temporada
    if (e.target.id === 'ev-season') {
      const s = (DB.seasons ?? []).find(x => x.id === Number(e.target.value));
      $('#ev-name').hidden = !!s;
      if (s) $('#ev-edition').value = `${s.stages.length + 1}ª Etapa`;
    }
  });
});

/* ordenação da tabela de atletas: clique no header alterna asc/desc */
document.addEventListener('click', e => {
  const th = e.target.closest?.('#players-table-panel th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  playersSort = playersSort.key === key
    ? { key, dir: -playersSort.dir }
    : { key, dir: 1 };
  renderPlayers();
});

document.addEventListener('change', e => {
  if (e.target.id === 'dark-toggle') {
    document.documentElement.classList.toggle('wa-dark', e.target.checked);
    localStorage.setItem('reizinho.dark', e.target.checked ? '1' : '');
  }
  if (e.target.classList?.contains('present-check')) {
    const p = playerById(Number(e.target.dataset.player));
    if (p) { Repo.setPresence(p.id, e.target.checked); renderAll(); }
  }
  if (e.target.classList?.contains('athlete-present')) {
    const p = playerById(Number(e.target.dataset.player));
    if (p) { Repo.setPresence(p.id, e.target.checked); renderAll(); openAthleteModal(p.id); }
  }
});

/* Spotlight: "/" abre busca em qualquer tela */
document.addEventListener('keydown', e => {
  if (e.key === '/' ) {
    const t = e.composedPath()[0];
    if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
    e.preventDefault();
    openSpotlight();
  }
  if (e.key === 'Enter' && e.target.id === 'spotlight-input') {
    $('#spotlight-results .spotlight-item')?.click();
  }
  // Enter no modal do atleta sem ação pendente: fecha
  if (e.key === 'Enter' && $('#dlg-athlete').open &&
      !$('#dlg-score').open && !$('#dlg-winner').open) {
    const t = e.composedPath()[0];
    const tag = t?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'BUTTON' && tag !== 'WA-BUTTON' && !t?.isContentEditable) {
      $('#dlg-athlete').open = false;
    }
  }
  // P no modal do atleta: alterna presença
  if ((e.key === 'p' || e.key === 'P') && $('#dlg-athlete').open) {
    const t = e.composedPath()[0];
    if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
    const p = playerById(Number($('#dlg-athlete').dataset.player));
    if (p) {
      Repo.setPresence(p.id, !p.present);
      renderAll();
      openAthleteModal(p.id);
    }
  }
});

let slugCheckTimer = null;

/* Indicador compacto no fim do input de slug: '' | checking | ok | bad */
function setSlugInd(el, state) {
  el.className = `slug-ind${state === 'ok' ? ' ok' : state === 'bad' ? ' bad' : ''}`;
  el.textContent = { checking: '…', ok: '✓', bad: '✕' }[state] ?? '';
}

document.addEventListener('input', e => {
  if (e.target.id === 'spotlight-input') renderSpotlightResults(e.target.value);
  if (e.target.id === 'pf-slug') {
    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (v !== e.target.value) e.target.value = v;
    clearTimeout(slugCheckTimer);
    const ind = $('#pf-slug-ind');
    if (!v) { setSlugInd(ind, ''); return; }
    setSlugInd(ind, 'checking');
    slugCheckTimer = setTimeout(async () => {
      try {
        const taken = await Sync.slugTaken(v);
        if (v !== $('#pf-slug').value) return;
        setSlugInd(ind, taken ? 'bad' : 'ok');
      } catch {
        setSlugInd(ind, '');
      }
    }, 450);
  }
  if (e.target.id === 'pf-cep') {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
    e.target.value = digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
    if (digits.length === 8) fetchCep(digits);
  }
  if (e.target.id === 'athlete-slug') {
    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (v !== e.target.value) e.target.value = v;
    clearTimeout(slugCheckTimer);
    const ind = $('#slug-ind');
    if (!v) {
      DB.slug = '';
      Repo.persist();
      $('#athlete-link-text').value = placarLink();
      setSlugInd(ind, '');
      return;
    }
    setSlugInd(ind, 'checking');
    slugCheckTimer = setTimeout(async () => {
      let taken = false;
      try {
        taken = await Sync.slugTaken(v);
        if (v !== $('#athlete-slug').value) return; // usuário continuou digitando
        setSlugInd(ind, taken ? 'bad' : 'ok');
      } catch {
        // offline: salva mesmo assim — o unique index do banco barra duplicado
        setSlugInd(ind, '');
      }
      if (taken) return; // não salva
      DB.slug = v;
      Repo.persist();
      $('#athlete-link-text').value = placarLink();
    }, 450);
  }
});

$('#dlg-spotlight').addEventListener('wa-after-show', () => $('#spotlight-input').focus());

/* Logo da conta: Storage (sync ativo) ou data URL local */
$('#brand-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let brand;
  try {
    const old = DB.brand?.path;
    const up = await Sync.uploadLogo(file);
    brand = { url: up.url, path: up.path };
    if (old) Sync.removeLogo(old).catch(() => {});
  } catch {
    // sem internet/Storage: guarda local como data URL (sincroniza no snapshot)
    brand = await new Promise(res => {
      const r = new FileReader();
      r.onload = () => res({ url: r.result, path: '' });
      r.onerror = () => res(null);
      r.readAsDataURL(file);
    });
    if (!brand) { alert('Não deu pra ler o arquivo da logo.'); return; }
  }
  DB.brand = brand;
  Repo.persist();
  renderAll();
});

/* Cancelou o sorteio no meio da animação: para o timer */
$('#dlg-draw').addEventListener('wa-hide', () => {
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; $('#draw-btn').disabled = false; }
});

/* Sequência de setup: fechou o resumo dos grupos → confirma quadras */
$('#dlg-groups-summary').addEventListener('wa-after-hide', () => {
  if (DB.games.length && !DB.setup.courtsConfirmed) openCourtsModal();
});

/* Registrar placar: foco direto no 1º campo; digito avança pro 2º; 2º digito salva */
$('#dlg-score').addEventListener('wa-after-show', () => $('#score-a').focus());

document.addEventListener('input', e => {
  if (e.target.id === 'score-a' && e.target.value.length === 1) {
    $('#score-b').focus();
  }
  if (e.target.id === 'score-b' && e.target.value.length === 1) {
    saveScore();
  }
});

/* relógio dos jogos em andamento */
setInterval(() => {
  let changed = false;
  for (const g of playingGames()) { g.elapsedMin++; changed = true; }
  if (changed) { renderGamesList(); renderMission(); Repo.persist(); }
}, 60_000);

/* ---------- perfil da conta (gate obrigatório) ---------- */

let profileGateManual = false;

function profileComplete() {
  const a = DB.account ?? {};
  return !!(a.name && a.cep && DB.slug);
}

function fillProfileInputs() {
  const a = DB.account ?? {};
  $('#pf-name').value = a.name ?? '';
  $('#pf-slug').value = DB.slug ?? '';
  setSlugInd($('#pf-slug-ind'), '');
  $('#pf-cep').value = a.cep ? `${a.cep.slice(0, 5)}-${a.cep.slice(5)}` : '';
  $('#pf-address').value = a.address ?? '';
  $('#pf-city').value = a.city ?? '';
  $('#pf-uf').value = a.uf ?? '';
}

/* Mostra o gate sempre que há login sem cadastro completo — não fecha até salvar */
function updateProfileGate() {
  const gate = $('#profile-gate');
  const mustShow = Sync.hasUser() && !profileComplete() && $('#auth-gate').hidden;
  if (mustShow) {
    if (gate.hidden) fillProfileInputs();
    $('#pf-cancel').hidden = true;
    gate.hidden = false;
  } else if (!profileGateManual) {
    gate.hidden = true;
  }
}

async function fetchCep(cep) {
  const err = $('#pf-error');
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const d = await r.json();
    if (d.erro) {
      err.textContent = 'CEP não encontrado — confira ou preencha o endereço na mão.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    $('#pf-address').value = [d.logradouro, d.bairro].filter(Boolean).join(', ');
    $('#pf-city').value = d.localidade ?? '';
    $('#pf-uf').value = d.uf ?? '';
  } catch {
    err.textContent = 'Não deu pra consultar o CEP — preencha o endereço na mão.';
    err.hidden = false;
  }
}

async function saveProfile() {
  const name = $('#pf-name').value.trim();
  const slug = $('#pf-slug').value.trim();
  const cep = $('#pf-cep').value.replace(/\D/g, '');
  const city = $('#pf-city').value.trim();
  const uf = $('#pf-uf').value.trim().toUpperCase();
  const address = $('#pf-address').value.trim();
  const err = $('#pf-error');
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  err.hidden = true;
  if (!name) return fail('Informe o nome.');
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return fail('Escolha o endereço do placar — mínimo 2 caracteres.');
  if (cep.length !== 8) return fail('CEP inválido — são 8 dígitos.');
  if (!city || !uf) return fail('Cidade e estado não preenchidos — confira o CEP.');
  if (slug !== DB.slug) {
    try {
      if (await Sync.slugTaken(slug)) return fail(`"${slug}" já está em uso por outra conta — escolha outro.`);
    } catch { /* offline: o unique index do banco barra duplicado no sync */ }
  }
  DB.slug = slug;
  DB.account = { name, cep, city, uf, address };
  profileGateManual = false;
  Repo.persist();
  renderAll();
}

/* ---------- auth (gate de login) ---------- */

function authError(msg) {
  const el = $('#auth-error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function authAction(kind) {
  const email = ($('#auth-email').value || '').trim();
  const pass = $('#auth-pass').value;
  authError('');
  if (!email.includes('@')) { authError('Informe um email válido.'); return; }
  if (kind !== 'magic' && pass.length < 6) { authError('Senha precisa de pelo menos 6 caracteres.'); return; }
  try {
    if (kind === 'in') {
      await Sync.signInPassword(email, pass);
      location.reload();
    } else if (kind === 'up') {
      const session = await Sync.signUp(email, pass);
      if (session) location.reload();
      else authError('Conta criada! Confirme o email que enviamos antes de entrar.');
    } else {
      await Sync.sendMagicLink(email);
      authError(`Link enviado pra ${email} — abra neste dispositivo.`);
    }
  } catch (err) {
    authError(err.message ?? String(err));
  }
}

/* Boot: hidrata do IndexedDB; sem estado salvo, começa zerado.
   Auth obrigatório: sem sessão, o gate cobre o app (com escape offline). */
if (localStorage.getItem('reizinho.dark')) document.documentElement.classList.add('wa-dark');

// Offline-first: cacheia app + CDNs na primeira visita (só em http/https)
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async () => {
  await Repo.hydrate();
  renderAll();
  try {
    const user = await Sync.init();
    if (user && !user.is_anonymous) {
      Sync.start();
    } else {
      $('#auth-gate').hidden = false;
    }
  } catch (e) {
    // CDN/rede fora: local-first continua — gate com opção offline
    console.warn('Auth indisponível:', e);
    $('#auth-gate').hidden = false;
    $('#auth-offline').hidden = false;
  }
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'court-name') addCourt();
  if (e.key === 'Enter' && e.target.id === 'dlg-court-name') dlgAddCourt();
  if (e.key === 'Enter' && (e.target.id === 'auth-pass' || e.target.id === 'auth-email')) authAction('in');
});

const initialView = location.hash.slice(1);
if (['games', 'players', 'groups', 'courts', 'bracket', 'season', 'settings'].includes(initialView)) showView(initialView);

setTimeout(() => {
  Repo.callGame('KO-8-0', 1);
  Repo.saveScore('KO-8-0', 4, 2);
  renderAll();
}, 1500);
