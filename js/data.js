/* Estado inicial (zerado). A persistência real fica no IndexedDB via js/repo.js;
   este objeto é só o shape do banco + templates padrão do produto.
   Formato reizinho: grupos de 4, rodízio de duplas (3 rodadas),
   pontuação individual — vitórias + saldo de games. */

const DB = {
  /* Slug público da conta — link do atleta vira liga.rcode.pro/<slug> */
  slug: '',

  /* Logo da conta (topo do menu) — Storage se sync ativo, senão data URL */
  brand: { url: '', path: '' },

  /* Templates de configurações de torneio (gerenciados em Configurações) */
  templates: [
    {
      id: 1, name: 'Reizinho Clássico', format: 'reizinho',
      thirdPlaceMatch: true, bestThirds: 'performance',
      tiebreak: 'Vitórias → saldo de games → games ganhos → simples',
      gamesPerMatch: 4,
    },
    {
      id: 2, name: 'Super 8', format: 'super8',
      thirdPlaceMatch: false, bestThirds: 'performance',
      tiebreak: 'Vitórias → saldo de games',
      gamesPerMatch: 6,
    },
    {
      id: 3, name: 'Dupla Fixa', format: 'dupla-fixa',
      thirdPlaceMatch: true, bestThirds: 'group',
      tiebreak: 'Vitórias → confronto direto → saldo de games',
      gamesPerMatch: 6,
    },
  ],

  event: {
    created: false,
    name: '',
    venue: '',
    edition: '',
    date: '',
    templateId: 1,
    gamesPerMatch: 4, // jogo vai até 4 games
  },

  setup: {
    courtsConfirmed: false,
  },

  courts: [],
  players: [],
  games: [],
  tiebreaks: [],

  /* Logos de patrocinadores/apoiadores: { id, category, url, path } */
  sponsors: [],

  /* Temporadas: pontos acumulados por etapa definem quem joga o Super 8.
     { id, name, super16, points: { participation, knockout, semi, final, champion },
       stages: [{ n, name, date, points: { [nomeAtleta]: pts } }] } */
  seasons: [],
};

/* Mutável: o sorteio redefine os grupos */
let GROUPS = [];
