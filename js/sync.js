/* =============================================================
   Sync — espelho opcional no Supabase (v1: snapshot inteiro).

   Local-first continua valendo: IndexedDB é a fonte de verdade
   do dispositivo; isto aqui só empurra/recebe o snapshot.
   Config fica em localStorage (fora do snapshot, por dispositivo).
   Requer db/sync-snapshot.sql aplicado + Anonymous sign-in ativo.
   ============================================================= */

const Sync = (() => {
  const CFG_KEY = 'reizinho.supabase';
  const SNAP_ID = 'default';
  // Projeto padrão — multi-tenant: cada conta (auth) enxerga só o próprio snapshot (RLS)
  const DEFAULT_URL = 'https://cjtzftkhtmpziyxyyqcx.supabase.co';
  const DEFAULT_KEY = 'sb_publishable_m7jjJExliY3NASa6jFIizw_Y0m6bYjH';
  let client = null;
  let channel = null;
  let pushTimer = null;
  let lastRemoteTs = 0;

  const cfg = () => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CFG_KEY)) ?? {}; } catch {}
    return {
      enabled: true, ...saved,
      url: saved.url || DEFAULT_URL,
      key: saved.key || DEFAULT_KEY,
    };
  };
  const saveCfg = c => localStorage.setItem(CFG_KEY, JSON.stringify(c));
  const enabled = () => { const c = cfg(); return !!(c.enabled && c.url && c.key); };

  function setStatus(text, ok) {
    const el = document.querySelector('#sync-status');
    if (el) { el.textContent = text; el.classList.toggle('sync-ok', !!ok); }
  }

  /* Web: import dinâmico do CDN. Extension (MV3/CSP): bundle local em window.supabase. */
  async function loadSupabase() {
    if (globalThis.supabase?.createClient) return globalThis.supabase;
    return import('https://esm.sh/@supabase/supabase-js@2');
  }

  let userCache = null;

  function rememberUser(session) {
    userCache = session?.user ?? null;
    if (!userCache?.id) return;
    const prev = cfg().ownerId;
    if (prev && prev !== userCache.id) {
      // conta trocou neste navegador: estado local é de outra conta — limpa e recarrega
      saveCfg({ ...cfg(), ownerId: userCache.id });
      Repo.wipe();
      return;
    }
    // owner_id fica salvo na config — o link público usa mesmo offline
    if (prev !== userCache.id) saveCfg({ ...cfg(), ownerId: userCache.id });
  }

  async function ensureClient() {
    if (client) return client;
    const { createClient } = await loadSupabase();
    const { url, key } = cfg();
    client = createClient(url, key);
    client.auth.onAuthStateChange((_ev, session) => {
      rememberUser(session);
      if (typeof renderAll === 'function') renderAll();
    });
    const { data: { session } } = await client.auth.getSession();
    rememberUser(session);
    return client;
  }

  /* Boot do auth: conecta e devolve o usuário da sessão (ou null) */
  async function init() {
    await ensureClient();
    return userCache;
  }

  async function signUp(email, password) {
    await ensureClient();
    const { data, error } = await client.auth.signUp({
      email, password,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    return data.session; // null = projeto exige confirmação de email
  }

  async function signInPassword(email, password) {
    await ensureClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async function setPassword(password) {
    await ensureClient();
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
  }

  const ownerId = () => cfg().ownerId ?? null;
  const hasUser = () => !!userCache && !userCache.is_anonymous;
  const userEmail = () => (userCache && !userCache.is_anonymous) ? userCache.email : null;

  /* Magic link: organizador loga com email — mesmo usuário em todos os
     dispositivos = mesmos dados. Requer host http(s) (Pages), não file://. */
  async function sendMagicLink(email) {
    await ensureClient();
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  }

  async function signOut() {
    await ensureClient();
    await client.auth.signOut();
    saveCfg({ ...cfg(), ownerId: null });
    Repo.wipe(); // dados ficam na nuvem; este navegador volta pra tela de login
  }

  function applyRemote(snapshot) {
    Object.assign(DB, snapshot.db);
    GROUPS = snapshot.groups ?? [];
    Repo.persist();
    renderAll();
  }

  function subscribe() {
    channel?.unsubscribe();
    channel = client.channel('event-snapshots')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'event_snapshots', filter: `owner_id=eq.${cfg().ownerId}` },
        payload => {
          const ts = Date.parse(payload.new?.updated_at ?? 0);
          if (ts <= lastRemoteTs) return; // eco do próprio push
          lastRemoteTs = ts;
          applyRemote(payload.new.data);
          setStatus(`Atualizado de outro dispositivo · ${new Date().toLocaleTimeString()}`, true);
        })
      .subscribe();
  }

  /* Conecta, resolve boot (remoto existente vence) e assina realtime */
  async function start() {
    setStatus('Conectando…', false);
    try {
      await ensureClient();
      if (!hasUser()) return;
      const { data, error } = await client.from('event_snapshots')
        .select('data, updated_at')
        .eq('owner_id', cfg().ownerId).eq('id', SNAP_ID).maybeSingle();
      if (error) throw error;
      if (data) {
        lastRemoteTs = Date.parse(data.updated_at);
        applyRemote(data.data);
      } else {
        push();
      }
      subscribe();
      setStatus('Conectado', true);
    } catch (e) {
      console.warn('Sync:', e);
      setStatus(`Erro: ${e.message ?? e}`, false);
    }
  }

  /* Empurra o snapshot atual (debounced) — chamado pelo Repo.persist */
  function push() {
    if (!client || !hasUser()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        const data = JSON.parse(JSON.stringify({ db: DB, groups: GROUPS }));
        const { data: row, error } = await client.from('event_snapshots')
          .upsert({ id: SNAP_ID, data, is_public: true })
          .select('updated_at').single();
        if (error) throw error;
        lastRemoteTs = Date.parse(row.updated_at);
        setStatus(`Sincronizado · ${new Date().toLocaleTimeString()}`, true);
      } catch (e) {
        if (e?.code === '23505') {
          setStatus('Endereço do link já em uso por outra conta — troque em Link do Atleta', false);
        } else {
          setStatus('Offline — mudanças guardadas localmente', false);
        }
      }
    }, 800);
  }

  /* Slug já usado por OUTRA conta? (snapshots são públicos pra leitura) */
  async function slugTaken(slug) {
    await ensureClient();
    let q = client.from('event_snapshots')
      .select('owner_id').eq('data->db->>slug', slug).limit(1);
    if (cfg().ownerId) q = q.neq('owner_id', cfg().ownerId);
    const { data, error } = await q;
    if (error) throw error;
    return data.length > 0;
  }

  /* ---------- logos (Storage) ---------- */

  async function uploadLogo(file) {
    await ensureClient();
    const safe = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `${cfg().ownerId}/${Date.now()}-${safe}`;
    const { error } = await client.storage.from('logos').upload(path, file);
    if (error) throw error;
    const { data } = client.storage.from('logos').getPublicUrl(path);
    return { path, url: data.publicUrl };
  }

  async function removeLogo(path) {
    await ensureClient();
    await client.storage.from('logos').remove([path]);
  }

  return {
    start, push, cfg, saveCfg, enabled, ownerId,
    uploadLogo, removeLogo,
    init, hasUser, signUp, signInPassword, setPassword, slugTaken,
    sendMagicLink, signOut, userEmail,
  };
})();
