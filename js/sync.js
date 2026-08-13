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
  let client = null;
  let channel = null;
  let pushTimer = null;
  let lastRemoteTs = 0;

  const cfg = () => {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) ?? {}; }
    catch { return {}; }
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

  async function ensureClient() {
    if (client) return client;
    const { createClient } = await loadSupabase();
    const { url, key } = cfg();
    client = createClient(url, key);
    let { data: { session } } = await client.auth.getSession();
    if (!session) {
      const { data, error } = await client.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    // owner_id fica salvo na config — o link público usa mesmo offline
    if (session?.user?.id && cfg().ownerId !== session.user.id) {
      saveCfg({ ...cfg(), ownerId: session.user.id });
    }
    return client;
  }

  const ownerId = () => cfg().ownerId ?? null;

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
        { event: '*', schema: 'public', table: 'event_snapshots', filter: `id=eq.${SNAP_ID}` },
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
    if (!enabled()) return;
    setStatus('Conectando…', false);
    try {
      await ensureClient();
      const { data, error } = await client.from('event_snapshots')
        .select('data, updated_at').eq('id', SNAP_ID).maybeSingle();
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
    if (!enabled() || !client) return;
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
        setStatus('Offline — mudanças guardadas localmente', false);
      }
    }, 800);
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
    if (!enabled()) return;
    await ensureClient();
    await client.storage.from('logos').remove([path]);
  }

  return { start, push, cfg, saveCfg, enabled, ownerId, uploadLogo, removeLogo };
})();
