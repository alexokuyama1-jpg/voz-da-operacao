/* ============================================================
   db.js — Camada de acesso a dados
   ------------------------------------------------------------
   Funciona em dois modos, decididos automaticamente:

   • ONLINE  — config.js preenchido → Supabase (PostgreSQL).
               Dados compartilhados entre todos os dispositivos.
   • OFFLINE — config.js em branco  → localStorage.
               Só o navegador atual. Bom para testar.

   O restante do sistema não sabe em qual modo está: a API
   pública (select / insert / update / remove / rpc / auth)
   é idêntica nos dois casos.
   ============================================================ */
'use strict';

const DB = (function () {

  const KEY = 'voz_operacao_db_v2';
  const cfg = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG : { url: '', anonKey: '' };
  const ONLINE = !!(cfg.url && cfg.anonKey);

  const TABLES = [
    'profiles', 'employees', 'candidates', 'elections', 'votes',
    'occurrences', 'survey_rounds', 'survey_responses', 'survey_participations',
    'log_themes', 'survey_theme_versions', 'notify_emails',
    'qr_codes', 'exclusion_log', 'app_settings',
  ];

  let sb = null;      // cliente Supabase
  let session = null; // sessão autenticada
  let profile = null; // perfil do gestor logado

  /* ==========================================================
     MODO OFFLINE — localStorage
     ========================================================== */
  let cache = null;

  function seed() {
    const themes = [
      { id: 'st1', label: 'Segurança',          icon: '🛡️', questions: ['Como você avalia as condições de segurança no seu local de trabalho?', 'Os EPIs fornecidos são adequados para as atividades realizadas?', 'Os treinamentos de segurança são realizados com frequência adequada?', 'Os riscos de acidentes são devidamente controlados?', 'A empresa atua preventivamente na redução de riscos?'] },
      { id: 'st2', label: 'Estrutura',          icon: '🏢', questions: ['Como você avalia as condições físicas do ambiente de trabalho?', 'Os equipamentos e ferramentas são adequados para o trabalho?', 'A manutenção das instalações é satisfatória?', 'O espaço oferece conforto e ergonomia adequados?', 'A limpeza e organização do ambiente são satisfatórias?'] },
      { id: 'st3', label: 'Liderança',          icon: '👥', questions: ['Como você avalia a comunicação da sua liderança imediata?', 'Sua liderança reconhece e valoriza o seu trabalho?', 'A liderança trata todos com respeito e equidade?', 'Você recebe feedbacks construtivos sobre seu desempenho?', 'A liderança apoia seu desenvolvimento profissional?'] },
      { id: 'st4', label: 'Remuneração',        icon: '💰', questions: ['Como você avalia seu salário em relação ao mercado?', 'Os benefícios oferecidos atendem suas necessidades?', 'A política de remuneração é transparente e justa?', 'Existe oportunidade de crescimento salarial?', 'A empresa realiza reajustes salariais de forma satisfatória?'] },
      { id: 'st5', label: 'Escala de Trabalho', icon: '📅', questions: ['Como você avalia sua jornada e carga horária de trabalho?', 'A distribuição de folgas e descansos é justa?', 'Você tem equilíbrio entre trabalho e vida pessoal?', 'As escalas são divulgadas com antecedência suficiente?', 'As horas extras são compensadas de forma justa?'] },
    ];
    return {
      profiles: [
        { id: 'u0', matricula: 'admin', name: 'Administrador',     password: 'lactalis2025', role: 'admin',       cd: 'TODOS',       email: 'admin@br.lactalis.com',      active: true },
        { id: 'u1', matricula: '10001', name: 'Julio César',       password: 'muda@2025',    role: 'gerente',     cd: 'TODOS',       email: 'julio.woellner@br.lactalis.com',      active: true },
        { id: 'u2', matricula: '10002', name: 'Anderson Rafael',   password: 'muda@2025',    role: 'coordenador', cd: 'CD Carambeí', email: 'anderson.moreira@br.lactalis.com',   active: true },
        { id: 'u3', matricula: '10003', name: 'Alexsander Hortiz', password: 'muda@2025',    role: 'coordenador', cd: 'CD Carambeí', email: 'alexsander.hortiz@br.lactalis.com', active: true },
        { id: 'u4', matricula: '10004', name: 'William Moreira',   password: 'muda@2025',    role: 'coordenador', cd: 'CD Londrina', email: 'william.moreira@br.lactalis.com',    active: true },
        { id: 'u5', matricula: '10005', name: 'Aliffer Almeida',   password: 'muda@2025',    role: 'supervisor',  cd: 'CD Carambeí', email: 'aliffer.almeida@br.lactalis.com',    active: true },
        { id: 'u6', matricula: '10006', name: 'Marcos Vinícius',   password: 'muda@2025',    role: 'supervisor',  cd: 'CD Carambeí', email: 'marcos.vinicius@br.lactalis.com',     active: true },
        { id: 'u7', matricula: '10007', name: 'Renata Prado',      password: 'muda@2025',    role: 'supervisor',  cd: 'CD Curitiba', email: 'renata.prado@br.lactalis.com',     active: true },
        { id: 'u8', matricula: '10008', name: 'Diego Ramos',       password: 'muda@2025',    role: 'supervisor',  cd: 'CD Londrina', email: 'diego.ramos@br.lactalis.com',      active: true },
      ],
      employees: [
        { id: 'e1', matricula: '20001', name: 'Ana Souza',     cd: 'CD Carambeí', shift: '1º Turno', sector: 'Expedição',   job_title: 'Conferente',               admission_date: '2019-03-11', active: true },
        { id: 'e2', matricula: '20002', name: 'Carlos Lima',   cd: 'CD Carambeí', shift: '2º Turno', sector: 'Recebimento', job_title: 'Operador de Empilhadeira', admission_date: '2021-07-05', active: true },
        { id: 'e3', matricula: '20003', name: 'Fernanda Reis', cd: 'CD Carambeí', shift: '3º Turno', sector: 'Câmara Fria', job_title: 'Auxiliar de Logística',    admission_date: '2020-01-20', active: true },
        { id: 'e4', matricula: '20004', name: 'Marcos Dias',   cd: 'CD Carambeí', shift: '1º Turno', sector: 'Separação',   job_title: 'Separador',                admission_date: '2022-09-12', active: true },
        { id: 'e5', matricula: '20005', name: 'Juliana Melo',  cd: 'CD Carambeí', shift: '2º Turno', sector: 'Expedição',   job_title: 'Conferente',               admission_date: '2023-02-06', active: true },
        { id: 'e6', matricula: '20006', name: 'Rafael Torres', cd: 'CD Curitiba', shift: '1º Turno', sector: 'Expedição',   job_title: 'Separador',                admission_date: '2018-11-26', active: true },
        { id: 'e7', matricula: '20007', name: 'Patrícia Nunes',cd: 'CD Curitiba', shift: '2º Turno', sector: 'Separação',   job_title: 'Auxiliar de Logística',    admission_date: '2021-04-19', active: true },
        { id: 'e8', matricula: '20008', name: 'Bruno Castro',  cd: 'CD Londrina', shift: '1º Turno', sector: 'Recebimento', job_title: 'Operador de Empilhadeira', admission_date: '2020-08-03', active: true },
        { id: 'e9', matricula: '20009', name: 'Simone Alves',  cd: 'CD Londrina', shift: '2º Turno', sector: 'Câmara Fria', job_title: 'Conferente',               admission_date: '2022-05-16', active: true },
      ],
      log_themes: [
        { id: 't1',  label: 'Limpeza',       icon: '🧹', cd: 'CD Carambeí', supervisor_id: 'u5', criticality: 'baixa', active: true },
        { id: 't2',  label: 'Organização',   icon: '📦', cd: 'CD Carambeí', supervisor_id: 'u5', criticality: 'baixa', active: true },
        { id: 't3',  label: 'Equipamentos',  icon: '🔧', cd: 'CD Carambeí', supervisor_id: 'u6', criticality: 'alta',  active: true },
        { id: 't4',  label: 'Segurança',     icon: '🛡️', cd: 'CD Carambeí', supervisor_id: 'u6', criticality: 'alta',  active: true },
        { id: 't5',  label: 'Manutenção',    icon: '🔨', cd: 'CD Carambeí', supervisor_id: 'u6', criticality: 'alta',  active: true },
        { id: 't6',  label: 'Comunicação',   icon: '📢', cd: 'CD Carambeí', supervisor_id: 'u5', criticality: 'media', active: true },
        { id: 't7',  label: 'Abastecimento', icon: '🚛', cd: 'CD Carambeí', supervisor_id: 'u5', criticality: 'media', active: true },
        { id: 't8',  label: 'Limpeza',       icon: '🧹', cd: 'CD Curitiba', supervisor_id: 'u7', criticality: 'baixa', active: true },
        { id: 't9',  label: 'Equipamentos',  icon: '🔧', cd: 'CD Curitiba', supervisor_id: 'u7', criticality: 'alta',  active: true },
        { id: 't10', label: 'Segurança',     icon: '🛡️', cd: 'CD Curitiba', supervisor_id: 'u7', criticality: 'alta',  active: true },
        { id: 't11', label: 'Limpeza',       icon: '🧹', cd: 'CD Londrina', supervisor_id: 'u8', criticality: 'baixa', active: true },
        { id: 't12', label: 'Equipamentos',  icon: '🔧', cd: 'CD Londrina', supervisor_id: 'u8', criticality: 'alta',  active: true },
        { id: 't13', label: 'Segurança',     icon: '🛡️', cd: 'CD Londrina', supervisor_id: 'u8', criticality: 'alta',  active: true },
      ],
      survey_theme_versions: [
        { id: 'v1', version: 1, created_at: Date.now(), description: 'Versão inicial · 5 temas · 25 perguntas', themes, is_current: true }
      ],
      notify_emails: [
        { id: 'n1', name: 'Coordenação Carambeí', address: 'coordenacao.carambei@br.lactalis.com', cd: 'CD Carambeí', on_new: true, on_warning: true, on_expired: true },
      ],
      candidates: [], elections: [], votes: [], occurrences: [],
      survey_rounds: [], survey_responses: [], survey_participations: [],
      qr_codes: [], exclusion_log: [],
      app_settings: [{ id: 'app', base_url: '' }],
    };
  }

  function load() {
    if (cache) return cache;
    try {
      const raw = localStorage.getItem(KEY);
      cache = raw ? JSON.parse(raw) : seed();
    } catch (e) { cache = seed(); }
    TABLES.forEach(t => { if (!Array.isArray(cache[t])) cache[t] = []; });
    return cache;
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(cache)); }
    catch (e) { console.warn('Falha ao salvar localmente', e); }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const matches = (row, f) => !f || Object.keys(f).every(k => row[k] === f[k]);
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ==========================================================
     MODO ONLINE — Supabase
     ========================================================== */
  async function loadSupabaseSdk() {
    if (window.supabase && window.supabase.createClient) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Não foi possível carregar a biblioteca do Supabase.'));
      document.head.appendChild(s);
    });
  }

  function mapError(e) {
    const msg = (e && (e.message || e.error_description || e)) + '';
    const dict = {
      MATRICULA_INVALIDA:  'Matrícula não encontrada ou inativa.',
      TEMA_INVALIDO:       'Tema inválido.',
      TEMA_DE_OUTRO_CD:    'Este tema não pertence ao seu CD.',
      CRITICIDADE_INVALIDA:'Criticidade inválida.',
      TEXTO_CURTO:         'Preencha assunto e descrição com mais detalhes.',
      CANDIDATO_INVALIDO:  'Candidato inválido.',
      ELEICAO_FECHADA:     'A eleição não está aberta.',
      ELEICAO_DE_OUTRO_CD: 'Esta eleição é de outro CD.',
      JA_VOTOU:            'Esta matrícula já votou nesta eleição.',
      RODADA_FECHADA:      'A rodada de pesquisa não está aberta.',
      RODADA_DE_OUTRO_CD:  'Esta rodada é de outro CD.',
      JA_PARTICIPOU:       'Esta matrícula já participou desta rodada.',
      SUGESTAO_CURTA:      'A sugestão precisa de ao menos 20 caracteres.',
      SEM_PERMISSAO:       'Você não tem permissão para esta ação.',
      JA_CANCELOU_UMA_VEZ: 'Este colaborador já teve um voto cancelado nesta eleição.',
      MOTIVO_CURTO:        'Descreva o motivo com ao menos 10 caracteres.',
      MATRICULA_EM_USO:    'Já existe um gestor com esta matrícula.',
      EMAIL_EM_USO:        'Este e-mail já está em uso por outro gestor.',
      EMAIL_INVALIDO:      'E-mail inválido.',
      SENHA_CURTA:         'A senha precisa de ao menos 6 caracteres.',
      NAO_PODE_REMOVER_A_SI:'Você não pode remover o próprio usuário.',
      VOTO_NAO_ENCONTRADO: 'Voto não encontrado.',
      VOTO_NAO_VALIDO:     'Este voto já foi cancelado ou anulado.',
    };
    for (const k in dict) if (msg.includes(k)) return dict[k];
    if (msg.includes('Invalid login')) return 'E-mail ou senha incorretos.';
    if (msg.includes('duplicate key')) return 'Registro duplicado.';
    if (/row-level security|permission denied/i.test(msg)) return 'Sem permissão para esta operação.';
    return msg;
  }

  function ok(res) {
    if (res.error) throw new Error(mapError(res.error));
    return res.data;
  }
  // Leituras bloqueadas por RLS não devem quebrar a tela:
  // devolvem lista vazia e seguem.
  function soft(res) {
    if (res.error) {
      if (/permission denied|row-level security/i.test(res.error.message || '')) return [];
      console.warn('[DB]', res.error.message);
      return [];
    }
    return res.data || [];
  }

  /* ==========================================================
     API PÚBLICA
     ========================================================== */
  const DOMAIN = '@br.lactalis.com';

  return {
    get online() { return ONLINE; },
    get domain() { return DOMAIN; },

    /* 'julio' → 'julio@br.lactalis.com' · já com @ mantém como está */
    normalizeEmail(v) {
      const t = String(v || '').trim().toLowerCase();
      if (!t) return '';
      return t.includes('@') ? t : t + DOMAIN;
    },
    get profile() { return profile; },
    get session() { return session; },

    async ready() {
      if (!ONLINE) { load(); return { online: false }; }
      await loadSupabaseSdk();
      sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      const { data } = await sb.auth.getSession();
      session = data ? data.session : null;
      if (session) {
        const p = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
        profile = p.data || null;
      }
      return { online: true };
    },

    /* ---------- Autenticação ---------- */
    /* Login por e-mail corporativo. Se a pessoa digitar só a parte
       antes do @, completamos com o domínio padrão da empresa. */
    async signIn(login, password) {
      const email = DB.normalizeEmail(login);
      if (!ONLINE) {
        const u = load().profiles.find(x =>
          (String(x.email || '').toLowerCase() === email ||
           x.matricula === String(login).trim()) &&
          x.password === password && x.active !== false);
        if (!u) throw new Error('E-mail ou senha incorretos.');
        profile = clone(u);
        return profile;
      }
      const r = await sb.auth.signInWithPassword({ email, password });
      if (r.error) throw new Error(mapError(r.error));
      session = r.data.session;
      const p = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (p.error || !p.data) { await sb.auth.signOut(); throw new Error('Perfil não encontrado.'); }
      if (p.data.active === false) { await sb.auth.signOut(); throw new Error('Usuário inativo.'); }
      profile = p.data;
      return profile;
    },

    async signOut() {
      profile = null;
      if (ONLINE && sb) { await sb.auth.signOut(); session = null; }
    },

    /* ---------- CRUD ---------- */
    async select(table, filter) {
      if (!ONLINE) {
        const db = load();
        return (db[table] || []).filter(r => matches(r, filter)).map(clone);
      }
      let q = sb.from(table).select('*');
      if (filter) Object.keys(filter).forEach(k => { q = q.eq(k, filter[k]); });
      return soft(await q);
    },

    async find(table, filter) {
      const rows = await this.select(table, filter);
      return rows[0] || null;
    },

    async insert(table, row) {
      if (!ONLINE) {
        const db = load();
        if (!db[table]) db[table] = [];
        const rec = Object.assign({ id: uid(), created_at: Date.now() }, row);
        db[table].push(rec); persist();
        return clone(rec);
      }
      return ok(await sb.from(table).insert(row).select().single());
    },

    async update(table, id, patch) {
      if (!ONLINE) {
        const db = load();
        const rec = (db[table] || []).find(r => r.id === id);
        if (!rec) return null;
        Object.assign(rec, patch); persist();
        return clone(rec);
      }
      return ok(await sb.from(table).update(patch).eq('id', id).select().maybeSingle());
    },

    async remove(table, id) {
      if (!ONLINE) {
        const db = load();
        const i = (db[table] || []).findIndex(r => r.id === id);
        if (i === -1) return false;
        db[table].splice(i, 1); persist();
        return true;
      }
      const r = await sb.from(table).delete().eq('id', id);
      if (r.error) throw new Error(mapError(r.error));
      return true;
    },

    async replaceAll(table, rows) {
      if (!ONLINE) {
        load()[table] = clone(rows); persist();
        return true;
      }
      const keep = rows.filter(r => r.id && !String(r.id).startsWith('new_')).map(r => r.id);
      const existing = soft(await sb.from(table).select('id'));
      const toDelete = existing.map(r => r.id).filter(id => !keep.includes(id));
      if (toDelete.length) {
        const d = await sb.from(table).delete().in('id', toDelete);
        if (d.error) throw new Error(mapError(d.error));
      }
      for (const r of rows) {
        const row = Object.assign({}, r);
        delete row.created_at;
        if (!row.id || String(row.id).startsWith('new_')) {
          delete row.id;
          const i = await sb.from(table).insert(row);
          if (i.error) throw new Error(mapError(i.error));
        } else {
          const id = row.id; delete row.id;
          const u = await sb.from(table).update(row).eq('id', id);
          if (u.error) throw new Error(mapError(u.error));
        }
      }
      return true;
    },

    /* ---------- Funções do servidor (RPC) ---------- */
    async rpc(fn, args) {
      if (!ONLINE) return null;   // no modo offline o app usa os caminhos locais
      const r = await sb.rpc(fn, args || {});
      if (r.error) throw new Error(mapError(r.error));
      return r.data;
    },

    /* ---------- Views de votação (sigilo do voto) ---------- */
    async voteTally(electionId) {
      if (!ONLINE) {
        const t = {};
        load().votes.filter(v => v.election_id === electionId && v.status === 'valid')
          .forEach(v => { t[v.candidate_id] = (t[v.candidate_id] || 0) + 1; });
        return t;
      }
      const rows = soft(await sb.from('v_vote_tally').select('*').eq('election_id', electionId));
      const t = {};
      rows.forEach(r => { t[r.candidate_id] = r.votes; });
      return t;
    },

    async voteParticipation(electionId) {
      if (!ONLINE) {
        return load().votes.filter(v => v.election_id === electionId)
          .map(v => { const c = clone(v); delete c.candidate_id; return c; });
      }
      return soft(await sb.from('v_vote_participation').select('*').eq('election_id', electionId));
    },

    /* ---------- Backup ---------- */
    async exportJSON() {
      if (!ONLINE) return JSON.stringify(load(), null, 2);
      const out = {};
      for (const t of TABLES) {
        if (t === 'votes') { out[t] = await this.voteParticipation(null).catch(() => []); continue; }
        out[t] = await this.select(t);
      }
      return JSON.stringify(out, null, 2);
    },

    async importJSON(json) {
      if (ONLINE) throw new Error('A restauração de backup só está disponível no modo offline.');
      cache = JSON.parse(json);
      TABLES.forEach(t => { if (!Array.isArray(cache[t])) cache[t] = []; });
      persist();
      return true;
    },

    async reset() {
      if (ONLINE) throw new Error('Para zerar o banco online, execute novamente os scripts SQL no Supabase.');
      cache = seed(); persist();
      return true;
    },
  };
})();
