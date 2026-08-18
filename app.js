/* ============================================================
   VOZ DA OPERAÇÃO — app.js
   Toda persistência passa por DB (db.js).
   ============================================================ */
'use strict';

/* ══════════ CONSTANTES ══════════ */
const H = 3600000, DAY = 86400000;
const CDS = ['CD Carambeí', 'CD Curitiba', 'CD Londrina'];
const CRIT = {
  baixa: { label: 'Baixa', hours: 48, icon: '🟢', badge: 'badge-green',  color: 'var(--green)' },
  media: { label: 'Média', hours: 72, icon: '🟡', badge: 'badge-orange', color: 'var(--orange)' },
  alta:  { label: 'Alta',  hours: 96, icon: '🔴', badge: 'badge-red',    color: 'var(--red)' },
};
const SCALE = ['Excelente', 'Bom', 'Regular', 'Ruim', 'Péssimo'];
const SCALE_VAL = [5, 4, 3, 2, 1];
const ROLE_LABEL = { gerente: 'Gerente', coordenador: 'Coordenador', supervisor: 'Supervisor', admin: 'Administrador' };
const SHIFTS = ['1º Turno', '2º Turno', '3º Turno'];

/* ══════════ CACHE EM MEMÓRIA ══════════ */
const M = {
  profiles: [], employees: [], candidates: [], elections: [], votes: [],
  occurrences: [], survey_rounds: [], survey_responses: [], survey_participations: [],
  log_themes: [], survey_theme_versions: [], notify_emails: [],
  qr_codes: [], exclusion_log: [], settings: {},
  tallies: {}, participation: {},
};

/* ══════════ ESTADO DE SESSÃO ══════════ */
const S = {
  page: 'home',
  cd: CDS[0],
  dashCd: 'TODOS',
  pontosCd: null,
  user: null,
  filter: 'todos',
  timer: null,
  // wizard ponto
  pEmp: null, pTheme: null, pCrit: null,
  // wizard pesquisa
  sSel: [], sActive: [], sStep: 0, sAnswers: {}, sRound: null, sEmp: null,
  // wizard voto
  vEmp: null, vCand: null, vElection: null,
  // pendências de modal
  conn: { online: false, error: null },
  _tratarId: null, _exclId: null, _cancelVoteId: null,
  _editUser: null, _editEmp: null,
  // rascunhos de edição
  draftLogThemes: null, draftSurvThemes: null,
};

/* ══════════ HELPERS ══════════ */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const byId = (arr, id) => arr.find(x => x.id === id) || null;
const uniq = a => [...new Set(a)];

const elapsed = o => Date.now() - o.created_at;
const remaining = o => (o.sla_hours * H) - elapsed(o);

function fmtTimer(ms) {
  if (ms <= 0) return '00:00:00';
  return pad(Math.floor(ms / H)) + ':' + pad(Math.floor((ms % H) / 60000)) + ':' + pad(Math.floor((ms % 60000) / 1000));
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ', ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateISO(iso) {
  if (!iso) return '—';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso);
}
function fmtDateFull(ts) {
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function quarterLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}·T${Math.floor(d.getMonth() / 3) + 1}`;
}

function toast(msg, type = 'green') {
  const t = $('toast');
  const c = { green: '#0e7a45', orange: '#c47800', red: '#c01c1c', blue: '#0f5bbf' };
  t.style.background = c[type] || c.green;
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = 'none'; }, 3300);
}
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function confirmAction(title, msg, onOk) {
  $('cfm-title').innerHTML = esc(title) + ' <button class="modal-close" onclick="closeModal(\'modal-confirm\')">✕</button>';
  $('cfm-msg').textContent = msg;
  const btn = $('cfm-ok');
  btn.onclick = () => { closeModal('modal-confirm'); onOk(); };
  openModal('modal-confirm');
}

function countChar(inputId, hintId, max, min, btnId) {
  const v = $(inputId).value;
  const el = $(hintId);
  el.textContent = v.length + ' / ' + max;
  const ok = v.trim().length >= (min || 0);
  el.className = 'char-hint ' + (ok ? 'ok' : 'warn');
  if (btnId) $(btnId).disabled = !ok;
}

function fillSelect(id, options, selected) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = options.map(o => {
    const val = typeof o === 'string' ? o : o.value;
    const lbl = typeof o === 'string' ? o : o.label;
    return `<option value="${esc(val)}" ${val === selected ? 'selected' : ''}>${esc(lbl)}</option>`;
  }).join('');
}

/* ══════════ CARGA ══════════ */
async function loadAll() {
  const t = ['profiles', 'employees', 'candidates', 'elections', 'votes', 'occurrences',
    'survey_rounds', 'survey_responses', 'survey_participations', 'log_themes', 'survey_theme_versions',
    'notify_emails', 'qr_codes', 'exclusion_log'];
  for (const k of t) M[k] = await DB.select(k);
  const st = await DB.select('app_settings');
  M.settings = st[0] || {};
  await refreshVoteCache();
}

/* ══════════ CONSULTAS DE DOMÍNIO ══════════ */
const currentThemes  = cd => M.log_themes.filter(t => t.cd === cd && t.active !== false);
const currentVersion = () => M.survey_theme_versions.find(v => v.is_current) || M.survey_theme_versions[M.survey_theme_versions.length - 1];
const openElection   = cd => M.elections.find(e => e.cd === cd && e.status === 'open') || null;
const openRound      = cd => M.survey_rounds.find(r => r.cd === cd && r.status === 'open') || null;
const employeeByMat  = (mat, cd) => M.employees.find(e => e.matricula === String(mat).trim() && e.active !== false && (!cd || e.cd === cd)) || null;

/* Busca a matrícula. Online usa a função lookup_employee() do banco,
   que devolve uma linha por vez — a base de colaboradores nunca é
   exposta para visitantes anônimos. */
async function lookupEmployee(mat, cd) {
  if (!DB.online) return employeeByMat(mat, cd);
  try {
    const r = await DB.rpc('lookup_employee', { p_matricula: String(mat).trim(), p_cd: cd || null });
    return (r && r.length) ? r[0] : null;
  } catch (e) { return null; }
}
async function alreadyVoted(electionId, mat) {
  if (!DB.online) {
    return !!M.votes.find(x => x.election_id === electionId && x.voter_matricula === mat && x.status === 'valid');
  }
  return !!(await DB.rpc('has_voted', { p_election: electionId, p_matricula: mat }));
}
async function alreadyParticipated(roundId, mat) {
  if (!DB.online) {
    return !!M.survey_participations.find(p => p.round_id === roundId && p.matricula === mat);
  }
  return !!(await DB.rpc('has_participated', { p_round: roundId, p_matricula: mat }));
}
const validVotes     = eid => (M.participation && M.participation[eid]
  ? M.participation[eid].filter(v => v.status === 'valid')
  : M.votes.filter(v => v.election_id === eid && v.status === 'valid'));
const candidatesOf   = eid => M.candidates.filter(c => c.election_id === eid);

/* Apuração e participação vêm de views que NUNCA trazem juntas
   o eleitor e o candidato. M.tallies e M.participation são
   preenchidos por refreshVoteCache(). */
function tallyFor(eid) {
  if (M.tallies && M.tallies[eid]) return M.tallies[eid];
  const t = {};
  validVotes(eid).forEach(v => { t[v.candidate_id] = (t[v.candidate_id] || 0) + 1; });
  return t;
}
function participationOf(eid) {
  if (M.participation && M.participation[eid]) return M.participation[eid];
  return M.votes.filter(v => v.election_id === eid);
}
function electedOf(cd) {
  const closed = M.elections.filter(e => e.cd === cd && e.status === 'closed').sort((a, b) => b.closed_at - a.closed_at)[0];
  return closed ? (closed.winners || []) : [];
}
function scopeCds() {
  if (!S.user) return CDS;
  if (S.user.cd === 'TODOS' || S.user.role === 'admin' || S.user.role === 'gerente') return CDS;
  return [S.user.cd];
}
function dashCds() {
  return S.dashCd === 'TODOS' ? scopeCds() : [S.dashCd];
}
function visibleOccurrences() {
  let list = M.occurrences.filter(o => dashCds().includes(o.cd));
  if (S.user && S.user.role === 'supervisor') list = list.filter(o => o.supervisor_id === S.user.id);
  return list;
}
function pontosOccurrences() {
  const cd = S.pontosCd || S.cd;
  let list = M.occurrences.filter(o => o.cd === cd);
  if (S.user && S.user.role === 'supervisor') list = list.filter(o => o.supervisor_id === S.user.id);
  return list;
}
const canTreat = o => S.user && (S.user.role === 'admin' || (S.user.role === 'supervisor' && o.supervisor_id === S.user.id));
const isAdmin  = () => S.user && S.user.role === 'admin';

/* ══════════ NAVEGAÇÃO ══════════ */
function goPage(id) {
  S.page = id;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
  $('page-' + id).classList.add('active');
  const nl = $('nl-' + id); if (nl) nl.classList.add('active');
  if (id === 'home') renderHome();
  if (id === 'registrar') renderCanal();
  if (id === 'pontos') renderPontos();
  if (id === 'gestor' && S.user) renderDash();
  refreshBanner();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════ HOME ══════════ */
function renderHome() {
  paintConnLabel();
  $('home-cd-picker').innerHTML = CDS.map(cd =>
    `<button class="cd-chip ${cd === S.cd ? 'active' : ''}" onclick="setCd('${esc(cd)}')">${esc(cd)}</button>`).join('');
  renderStatusCards();
  renderSpokespeople();
  renderHomeHistory();
}
function setCd(cd) {
  S.cd = cd;
  S.pontosCd = cd;
  renderHome();
}

function renderStatusCards() {
  const el = openElection(S.cd), rd = openRound(S.cd);
  const emps = M.employees.filter(e => e.cd === S.cd && e.active !== false).length;
  const open = M.occurrences.filter(o => o.cd === S.cd && o.status === 'open').length;
  const cards = [];

  if (el) {
    const voted = validVotes(el.id).length;
    cards.push(`<div class="status-card open"><div class="sc-icon">🗳️</div><div>
      <div class="sc-title">Eleição aberta</div>
      <div class="sc-sub">${voted} de ${emps} já votaram</div></div></div>`);
  } else {
    cards.push(`<div class="status-card closed"><div class="sc-icon">🗳️</div><div>
      <div class="sc-title">Eleição encerrada</div>
      <div class="sc-sub">Aguardando próxima rodada</div></div></div>`);
  }

  if (rd) {
    const days = Math.max(0, Math.ceil((rd.ends_at - Date.now()) / DAY));
    const n = M.survey_responses.filter(r => r.round_id === rd.id).length;
    cards.push(`<div class="status-card ${days <= 7 ? 'warn' : 'open'}"><div class="sc-icon">📝</div><div>
      <div class="sc-title">Pesquisa aberta · ${days} dia${days !== 1 ? 's' : ''}</div>
      <div class="sc-sub">${n} resposta${n !== 1 ? 's' : ''} recebida${n !== 1 ? 's' : ''}</div></div></div>`);
  } else {
    const last = M.survey_rounds.filter(r => r.cd === S.cd && r.status === 'closed').sort((a, b) => b.closed_at - a.closed_at)[0];
    const nextIn = last ? Math.max(0, Math.ceil((last.closed_at + 90 * DAY - Date.now()) / DAY)) : null;
    cards.push(`<div class="status-card closed"><div class="sc-icon">📝</div><div>
      <div class="sc-title">Pesquisa fechada</div>
      <div class="sc-sub">${nextIn !== null ? 'Próxima em ~' + nextIn + ' dias' : 'Aguardando abertura'}</div></div></div>`);
  }

  cards.push(`<div class="status-card ${open > 0 ? 'warn' : ''}"><div class="sc-icon">⚡</div><div>
    <div class="sc-title">${open} ponto${open !== 1 ? 's' : ''} em aberto</div>
    <div class="sc-sub">${esc(S.cd)}</div></div></div>`);

  $('home-status-cards').innerHTML = cards.join('');
}

function renderSpokespeople() {
  const el = openElection(S.cd);
  const grid = $('vp-grid'), badge = $('vp-election-badge'), sub = $('vp-sub');

  if (el) {
    const cands = candidatesOf(el.id), tally = tallyFor(el.id);
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    const max = Math.max(...Object.values(tally), 1);
    badge.innerHTML = `<span class="badge badge-green">🟢 Eleição em andamento</span>`;
    sub.textContent = 'Candidatos concorrendo nesta eleição';
    grid.innerHTML = cands.length ? cands.map(c => {
      const v = tally[c.id] || 0;
      return `<div class="vp-card">
        <div class="vp-avatar">${esc(initials(c.name))}</div>
        <div style="flex:1;min-width:0">
          <div class="vp-name">${esc(c.name)}</div>
          <div class="vp-meta">${esc(c.shift)} · ${esc(c.sector || '')}</div>
          <div class="vp-stat-row"><div class="vp-votes">🗳️ ${v} voto${v !== 1 ? 's' : ''}</div>
            <div class="vp-pct">${total ? Math.round(v / total * 100) : 0}%</div></div>
          <div class="vote-bar"><div class="vote-bar-fill" style="width:${Math.round(v / max * 100)}%"></div></div>
        </div></div>`;
    }).join('') : emptyBox('🙋', 'Nenhum candidato cadastrado', 'O gestor precisa adicionar candidatos à eleição.');
    return;
  }

  const winners = electedOf(S.cd);
  badge.innerHTML = '';
  sub.textContent = 'Representantes eleitos pela operação';
  grid.innerHTML = winners.length ? winners.map(w =>
    `<div class="vp-card elected">
      <div class="vp-avatar">${esc(initials(w.name))}</div>
      <div style="flex:1;min-width:0">
        <div class="vp-name">${esc(w.name)} <span class="badge badge-blue">🎙️ Porta-Voz</span></div>
        <div class="vp-meta">${esc(w.shift)} · ${esc(w.sector || '')}</div>
        <div class="vp-votes">🗳️ ${w.votes} voto${w.votes !== 1 ? 's' : ''}</div>
      </div></div>`).join('')
    : emptyBox('🎙️', 'Nenhum porta-voz eleito ainda', 'Assim que uma eleição for encerrada, os eleitos aparecem aqui.');
}

function emptyBox(icon, title, sub) {
  return `<div class="empty-state" style="grid-column:1/-1"><div class="ei">${icon}</div>
    <h4>${esc(title)}</h4><p class="text-muted">${esc(sub)}</p></div>`;
}

function renderHomeHistory() {
  const hist = M.elections.filter(e => e.cd === S.cd && e.status === 'closed').sort((a, b) => b.closed_at - a.closed_at);
  const strip = $('home-hist-strip');
  if (!hist.length) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  $('home-history').innerHTML = hist.slice(0, 4).map(e => `
    <div class="hist-card">
      <div class="hist-head">
        <div><div class="hist-title">${esc(e.title)}</div>
        <div class="hist-meta">${fmtDateFull(e.created_at)} a ${fmtDateFull(e.closed_at)} · ${e.total_votes || 0} votos</div></div>
      </div>
      ${(e.winners || []).map(w => `<div class="winner-row">
        <span class="winner-medal">🏆</span>
        <div><div class="winner-name">${esc(w.name)}</div>
        <div class="winner-meta">${esc(w.shift)} · ${w.votes} voto${w.votes !== 1 ? 's' : ''}</div></div>
      </div>`).join('')}
    </div>`).join('');
}

/* ══════════ REGISTRAR — canal ══════════ */
function renderCanal() {
  $('wiz-canal').classList.remove('hidden');
  ['wiz-ponto', 'wiz-pesquisa', 'wiz-voto'].forEach(i => $(i).classList.add('hidden'));
  $('wiz-canal-cd').textContent = S.cd;
  const rd = openRound(S.cd), el = openElection(S.cd);
  $('cc-survey-desc').textContent = rd
    ? `Rodada ${rd.title} aberta — ${Math.max(0, Math.ceil((rd.ends_at - Date.now()) / DAY))} dias restantes. 100% anônima.`
    : 'Nenhuma rodada aberta no momento.';
  $('cc-vote-desc').textContent = el
    ? `${el.title} — eleja o representante do seu turno.`
    : 'Nenhuma eleição aberta no momento.';
}
function backToCanal() { renderCanal(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function startCanal(c) {
  ['wiz-canal', 'wiz-ponto', 'wiz-pesquisa', 'wiz-voto'].forEach(i => $(i).classList.add('hidden'));
  if (c === 'ponto') startPonto();
  if (c === 'pesquisa') startPesquisaFlow();
  if (c === 'voto') startVotoFlow();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════ PONTO DE ATENÇÃO ══════════ */
function startPonto() {
  $('wiz-ponto').classList.remove('hidden');
  S.pEmp = null; S.pTheme = null; S.pCrit = null;
  ['pp-1', 'pp-2', 'pp-3', 'pp-4', 'pp-5', 'pp-ok'].forEach(i => $(i).classList.add('hidden'));
  $('pp-1').classList.remove('hidden');
  ['pp-matricula', 'pp-subject', 'pp-local', 'pp-desc'].forEach(i => $(i).value = '');
  $('pp-emp-card').classList.add('hidden');
  $('pp1-next').disabled = true; $('pp2-next').disabled = true; $('pp3-next').disabled = true;
  $('pp-desc-cnt').textContent = '0 / 300';
  $('pp-mat-hint').textContent = 'Digite sua matrícula';
  $('pp-mat-hint').className = 'field-hint';
  $('pp-matricula').className = 'form-input';
  document.querySelectorAll('.crit-tile').forEach(t => t.classList.remove('sel'));
  setPontoProgress(1);
}

async function checkPontoMat() {
  const v = $('pp-matricula').value.trim();
  const card = $('pp-emp-card'), hint = $('pp-mat-hint'), inp = $('pp-matricula');
  if (v.length < 3) {
    card.classList.add('hidden'); $('pp1-next').disabled = true;
    hint.textContent = 'Digite sua matrícula'; hint.className = 'field-hint';
    inp.className = 'form-input'; S.pEmp = null; return;
  }
  const emp = await lookupEmployee(v, S.cd);
  if (!emp) {
    const other = await lookupEmployee(v, null);
    card.classList.remove('hidden'); card.className = 'emp-card err';
    card.innerHTML = `<div class="emp-avatar">✕</div><div>
      <div class="emp-name">Matrícula não encontrada</div>
      <div class="emp-meta">${other ? 'Esta matrícula pertence ao ' + esc(other.cd) + '. Troque o CD na tela inicial.' : 'Procure a supervisão para cadastro.'}</div></div>`;
    hint.textContent = ''; inp.className = 'form-input err';
    $('pp1-next').disabled = true; S.pEmp = null; return;
  }
  S.pEmp = emp;
  card.classList.remove('hidden'); card.className = 'emp-card';
  card.innerHTML = `<div class="emp-avatar">${esc(initials(emp.name))}</div><div>
    <div class="emp-name">${esc(emp.name)}</div>
    <div class="emp-meta">${esc(emp.shift)} · ${esc(emp.sector)} · ${esc(emp.cd)}</div></div>`;
  hint.textContent = '✓ Identificado'; hint.className = 'field-hint ok';
  inp.className = 'form-input ok';
  $('pp1-next').disabled = false;
}

function setPontoProgress(cur) {
  [0, 1, 2, 3, 4].forEach(i => {
    const el = $('pstep-' + i);
    el.className = 'wiz-step' + (i < cur - 1 ? ' done' : i === cur - 1 ? ' active' : '');
    el.querySelector('.wiz-num').textContent = i < cur - 1 ? '✓' : (i + 1);
  });
}

function pontoStep(n) {
  ['pp-1', 'pp-2', 'pp-3', 'pp-4', 'pp-5', 'pp-ok'].forEach(i => $(i).classList.add('hidden'));
  setPontoProgress(n);
  if (n === 2) renderPontoThemes();
  if (n === 4) {
    const t = byId(M.log_themes, S.pTheme), c = CRIT[S.pCrit];
    const sup = t ? byId(M.profiles, t.supervisor_id) : null;
    $('pp4-badges').innerHTML =
      `<span class="badge badge-blue">${t ? t.icon : ''} ${esc(t ? t.label : '')}</span>` +
      `<span class="badge ${c.badge}">${c.icon} ${c.label} · ${c.hours}h</span>` +
      (sup ? `<span class="badge badge-gray">👤 ${esc(sup.name)}</span>` : '');
  }
  if (n === 5) {
    const t = byId(M.log_themes, S.pTheme), c = CRIT[S.pCrit];
    const sup = t ? byId(M.profiles, t.supervisor_id) : null;
    $('pp5-author').textContent = `${S.pEmp.name} (${S.pEmp.matricula})`;
    $('pp5-tema').textContent = `${t.icon} ${t.label}`;
    $('pp5-crit').textContent = `${c.icon} ${c.label} — prazo de ${c.hours} horas`;
    $('pp5-sup').textContent = sup ? `${sup.name} (${ROLE_LABEL[sup.role]})` : 'Não definido';
    $('pp5-subject').textContent = $('pp-subject').value.trim();
    $('pp5-desc').textContent = $('pp-desc').value.trim();
  }
  $('pp-' + n).classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPontoThemes() {
  const themes = currentThemes(S.cd);
  const g = $('log-theme-grid');
  if (!themes.length) {
    g.innerHTML = emptyBox('📋', 'Nenhum tema cadastrado', 'O administrador precisa cadastrar temas para este CD.');
    return;
  }
  g.innerHTML = themes.map(t => {
    const sup = byId(M.profiles, t.supervisor_id);
    return `<div class="theme-tile ${S.pTheme === t.id ? 'sel' : ''}" onclick="selLogTheme('${t.id}')">
      <div class="tt-icon">${t.icon}</div><div class="tt-name">${esc(t.label)}</div>
      <div class="tt-sup">${sup ? esc(sup.name.split(' ')[0]) : 'sem supervisor'}</div></div>`;
  }).join('');
}
function selLogTheme(id) { S.pTheme = id; renderPontoThemes(); $('pp2-next').disabled = false; }
function selCrit(c) {
  S.pCrit = c;
  document.querySelectorAll('.crit-tile').forEach(t => t.classList.remove('sel'));
  $('crit-' + c).classList.add('sel');
  $('pp3-next').disabled = false;
}

async function submitPonto() {
  const subj = $('pp-subject').value.trim(), desc = $('pp-desc').value.trim(), local = $('pp-local').value.trim();
  if (subj.length < 5) { toast('Descreva o assunto (mín. 5 caracteres).', 'orange'); pontoStep(4); return; }
  if (desc.length < 10) { toast('Detalhe o ponto (mín. 10 caracteres).', 'orange'); pontoStep(4); return; }
  const t = byId(M.log_themes, S.pTheme), c = CRIT[S.pCrit];
  let rec;
  try {
    if (DB.online) {
      // O servidor valida matrícula, tema e criticidade e define o supervisor.
      await DB.rpc('register_occurrence', {
        p_matricula: S.pEmp.matricula, p_theme: S.pTheme, p_criticality: S.pCrit,
        p_title: subj, p_description: desc, p_location: local,
      });
      rec = { cd: S.cd, title: subj };
    } else {
      rec = await DB.insert('occurrences', {
        cd: S.cd, theme_id: S.pTheme, title: subj, description: desc, location: local,
        author_matricula: S.pEmp.matricula, author_name: S.pEmp.name,
        author_shift: S.pEmp.shift, author_sector: S.pEmp.sector,
        criticality: S.pCrit, sla_hours: c.hours, supervisor_id: t.supervisor_id,
        status: 'open', resolved_at: null, resolved_by: null, resolution_note: null,
      });
      M.occurrences.push(rec);
    }
  } catch (e) { toast(e.message, 'red'); return; }
  notifyStub('on_new', rec);
  const sup = byId(M.profiles, t.supervisor_id);
  $('pp-ok-msg').innerHTML = `Prazo de <strong>${c.hours} horas</strong> iniciado.` +
    (sup ? ` Encaminhado para <strong>${esc(sup.name)}</strong>.` : '');
  ['pp-1', 'pp-2', 'pp-3', 'pp-4', 'pp-5'].forEach(i => $(i).classList.add('hidden'));
  $('pp-ok').classList.remove('hidden');
  refreshBanner();
}

function notifyStub(evt, occ) {
  const dest = M.notify_emails.filter(e => e[evt] && (e.cd === occ.cd || e.cd === 'TODOS'));
  if (dest.length) console.log('[NOTIFICAÇÃO]', evt, '→', dest.map(d => d.address).join(', '), '|', occ.title);
}

/* ══════════ PESQUISA ══════════ */
function startPesquisaFlow() {
  $('wiz-pesquisa').classList.remove('hidden');
  const rd = openRound(S.cd);
  ['surv-closed', 'surv-id', 'surv-0', 'surv-q', 'surv-sug', 'surv-ok'].forEach(i => $(i).classList.add('hidden'));
  $('prog-pesquisa').innerHTML = '';
  if (!rd) { $('surv-closed').classList.remove('hidden'); return; }
  S.sRound = rd; S.sSel = []; S.sActive = []; S.sStep = 0; S.sAnswers = {}; S.sEmp = null;
  $('sug-input').value = ''; $('sug-char').textContent = '0 / 150';
  $('sv-matricula').value = ''; $('sv-emp-card').classList.add('hidden');
  $('sv1-next').disabled = true;
  $('sv-mat-hint').textContent = 'Digite sua matrícula'; $('sv-mat-hint').className = 'field-hint';
  $('sv-matricula').className = 'form-input';
  renderSurvThemeGrid();
  $('surv-id').classList.remove('hidden');
  buildSurvProgress();
}

async function checkSurvMat() {
  const v = $('sv-matricula').value.trim();
  const card = $('sv-emp-card'), hint = $('sv-mat-hint'), inp = $('sv-matricula');
  const fail = (title, msg) => {
    card.classList.remove('hidden'); card.className = 'emp-card err';
    card.innerHTML = `<div class="emp-avatar">✕</div><div><div class="emp-name">${esc(title)}</div>
      <div class="emp-meta">${esc(msg)}</div></div>`;
    hint.textContent = ''; inp.className = 'form-input err';
    $('sv1-next').disabled = true; S.sEmp = null;
  };
  if (v.length < 3) {
    card.classList.add('hidden'); $('sv1-next').disabled = true;
    hint.textContent = 'Digite sua matrícula'; hint.className = 'field-hint';
    inp.className = 'form-input'; S.sEmp = null; return;
  }
  const emp = await lookupEmployee(v, S.cd);
  if (!emp) { fail('Matrícula não encontrada', 'Procure a supervisão para verificar seu cadastro.'); return; }
  const already = await alreadyParticipated(S.sRound.id, emp.matricula);
  if (already) { fail('Você já participou desta rodada', 'Cada colaborador responde uma vez por rodada. Obrigado pela participação!'); return; }
  S.sEmp = emp;
  card.classList.remove('hidden'); card.className = 'emp-card';
  card.innerHTML = `<div class="emp-avatar">${esc(initials(emp.name))}</div><div>
    <div class="emp-name">${esc(emp.name)}</div>
    <div class="emp-meta">${esc(emp.job_title || emp.sector)} · ${esc(emp.shift)}</div></div>`;
  hint.textContent = '✓ Identificado'; hint.className = 'field-hint ok';
  inp.className = 'form-input ok';
  $('sv1-next').disabled = false;
}
function survThemes() {
  const v = M.survey_theme_versions.find(x => x.version === S.sRound.theme_version) || currentVersion();
  return v ? v.themes : [];
}
function renderSurvThemeGrid() {
  $('surv-theme-grid').innerHTML = survThemes().map(t =>
    `<div class="theme-tile ${S.sSel.includes(t.id) ? 'sel' : ''}" onclick="toggleSurvTheme('${t.id}')">
      <div class="tt-icon">${t.icon}</div><div class="tt-name">${esc(t.label)}</div>
      <div class="tt-sup">${(t.questions || []).length} perguntas</div></div>`).join('');
  $('surv-start-btn').disabled = S.sSel.length === 0;
}
function toggleSurvTheme(id) {
  const i = S.sSel.indexOf(id);
  i === -1 ? S.sSel.push(id) : S.sSel.splice(i, 1);
  renderSurvThemeGrid();
}
function buildSurvProgress() {
  const steps = [{ label: 'Temas' }, ...S.sActive.map(t => ({ label: t.label })), { label: 'Sugestão' }];
  $('prog-pesquisa').innerHTML = steps.map((s, i) =>
    `<div class="wiz-step ${i < S.sStep ? 'done' : i === S.sStep ? 'active' : ''}">
      <div class="wiz-num">${i < S.sStep ? '✓' : i + 1}</div>
      <div class="wiz-label">${esc(s.label)}</div></div>`).join('');
}
function startPesquisa() {
  S.sActive = survThemes().filter(t => S.sSel.includes(t.id));
  S.sStep = 1; buildSurvProgress(); renderSurvQ(); showSurvStep('surv-q');
}
function renderSurvQ() {
  const t = S.sActive[S.sStep - 1];
  $('surv-q-icon').textContent = t.icon;
  $('surv-q-sub').textContent = `Tema ${S.sStep} de ${S.sActive.length}`;
  $('surv-q-title').textContent = t.label;
  $('surv-questions').innerHTML = (t.questions || []).map((q, qi) =>
    `<div class="card q-card">
      <div class="q-num">Pergunta ${qi + 1} de ${t.questions.length}</div>
      <div class="q-text">${esc(q)}</div>
      <div class="scale-row">${SCALE.map((sc, si) =>
        `<button class="scale-btn ${S.sAnswers[t.id + '_' + qi] === si ? 's' + si : ''}" onclick="setAns('${t.id}',${qi},${si})">${sc}</button>`).join('')}</div>
    </div>`).join('');
}
function setAns(tid, qi, si) { S.sAnswers[tid + '_' + qi] = si; renderSurvQ(); }
function survNext() {
  S.sStep++; buildSurvProgress();
  if (S.sStep > S.sActive.length) showSurvStep('surv-sug');
  else { renderSurvQ(); showSurvStep('surv-q'); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function survBack() {
  if (S.sStep <= 1) { S.sStep = 0; buildSurvProgress(); showSurvStep('surv-0'); return; }
  S.sStep--; buildSurvProgress();
  if (S.sStep === 0) showSurvStep('surv-0');
  else { renderSurvQ(); showSurvStep('surv-q'); }
}
function showSurvStep(id) {
  ['surv-closed', 'surv-id', 'surv-0', 'surv-q', 'surv-sug', 'surv-ok'].forEach(i => $(i).classList.add('hidden'));
  $(id).classList.remove('hidden');
}
function updateSugChar() {
  const v = $('sug-input').value, el = $('sug-char');
  el.textContent = v.length + ' / 150';
  el.className = 'char-hint ' + (v.trim().length < 20 ? 'warn' : 'ok');
  $('surv-submit').disabled = v.trim().length < 20;
}
async function submitPesquisa() {
  const suggestion = $('sug-input').value.trim();
  try {
    if (DB.online) {
      // Uma única chamada grava participação e resposta em tabelas
      // separadas, sem devolver nada que ligue as duas.
      await DB.rpc('submit_survey', {
        p_matricula: S.sEmp.matricula, p_round: S.sRound.id,
        p_answers: S.sAnswers, p_suggestion: suggestion,
      });
      M.survey_participations = await DB.select('survey_participations');
    } else {
      const part = await DB.insert('survey_participations', {
        round_id: S.sRound.id, cd: S.cd,
        matricula: S.sEmp.matricula, name: S.sEmp.name,
        shift: S.sEmp.shift, job_title: S.sEmp.job_title || '',
      });
      M.survey_participations.push(part);
      const rec = await DB.insert('survey_responses', {
        round_id: S.sRound.id, cd: S.cd, version: S.sRound.theme_version,
        answers: JSON.parse(JSON.stringify(S.sAnswers)), suggestion,
      });
      M.survey_responses.push(rec);
    }
  } catch (e) { toast(e.message, 'red'); return; }
  showSurvStep('surv-ok');
}

/* ══════════ VOTAÇÃO ══════════ */
function startVotoFlow() {
  $('wiz-voto').classList.remove('hidden');
  const el = openElection(S.cd);
  ['voto-closed', 'voto-1', 'voto-2', 'voto-3', 'voto-ok'].forEach(i => $(i).classList.add('hidden'));
  if (!el) { $('voto-closed').classList.remove('hidden'); $('voto-header-sub').textContent = S.cd; return; }
  S.vElection = el; S.vEmp = null; S.vCand = null;
  $('voto-header-sub').textContent = `${el.title} · ${S.cd}`;
  $('vt-matricula').value = ''; $('vt-emp-card').classList.add('hidden');
  $('vt1-next').disabled = true;
  $('vt-mat-hint').textContent = 'Digite sua matrícula'; $('vt-mat-hint').className = 'field-hint';
  $('vt-matricula').className = 'form-input';
  $('voto-1').classList.remove('hidden');
}

async function checkVoteMat() {
  const v = $('vt-matricula').value.trim();
  const card = $('vt-emp-card'), hint = $('vt-mat-hint'), inp = $('vt-matricula');
  const fail = (title, msg) => {
    card.classList.remove('hidden'); card.className = 'emp-card err';
    card.innerHTML = `<div class="emp-avatar">✕</div><div><div class="emp-name">${esc(title)}</div>
      <div class="emp-meta">${esc(msg)}</div></div>`;
    hint.textContent = ''; inp.className = 'form-input err';
    $('vt1-next').disabled = true; S.vEmp = null;
  };
  if (v.length < 3) {
    card.classList.add('hidden'); $('vt1-next').disabled = true;
    hint.textContent = 'Digite sua matrícula'; hint.className = 'field-hint';
    inp.className = 'form-input'; S.vEmp = null; return;
  }
  const emp = await lookupEmployee(v, S.cd);
  if (!emp) { fail('Matrícula não encontrada', 'Procure a supervisão para verificar seu cadastro.'); return; }
  const already = await alreadyVoted(S.vElection.id, emp.matricula);
  if (already) { fail('Você já votou nesta eleição', 'Em caso de erro, procure o administrador — o voto pode ser liberado uma única vez.'); return; }
  S.vEmp = emp;
  card.classList.remove('hidden'); card.className = 'emp-card';
  card.innerHTML = `<div class="emp-avatar">${esc(initials(emp.name))}</div><div>
    <div class="emp-name">${esc(emp.name)}</div>
    <div class="emp-meta">${esc(emp.shift)} · ${esc(emp.sector)}</div></div>`;
  hint.textContent = '✓ Identificado'; hint.className = 'field-hint ok';
  inp.className = 'form-input ok';
  $('vt1-next').disabled = false;
}

function votoStep(n) {
  ['voto-1', 'voto-2', 'voto-3', 'voto-ok'].forEach(i => $(i).classList.add('hidden'));
  if (n === 2) {
    const cands = candidatesOf(S.vElection.id);
    $('vt-candidates').innerHTML = cands.length ? cands.map(c =>
      `<button class="cand-pick" onclick="pickCand('${c.id}')">
        <div class="cand-avatar">${esc(initials(c.name))}</div>
        <div><div class="cand-name">${esc(c.name)}</div>
        <div class="cand-meta">${esc(c.shift)} · ${esc(c.sector || '')}</div></div>
        <div class="cand-arrow">›</div></button>`).join('')
      : emptyBox('🙋', 'Nenhum candidato', 'Procure a supervisão.');
  }
  if (n === 3) {
    const c = byId(M.candidates, S.vCand);
    $('vt-confirm-box').innerHTML = `<div class="vote-modal-avatar">${esc(initials(c.name))}</div>
      <div><div class="vote-modal-name">${esc(c.name)}</div>
      <div class="vote-modal-meta">${esc(c.shift)} · ${esc(c.sector || '')}</div></div>`;
  }
  $('voto-' + n).classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function pickCand(id) { S.vCand = id; votoStep(3); }

async function confirmVote() {
  try {
    if (DB.online) {
      // O vínculo eleitor→candidato nunca trafega de volta: a função
      // grava o voto no servidor e não devolve o candidato escolhido.
      await DB.rpc('cast_vote', { p_matricula: S.vEmp.matricula, p_candidate: S.vCand });
      await refreshVoteCache();
    } else {
      const dup = M.votes.find(x => x.election_id === S.vElection.id
        && x.voter_matricula === S.vEmp.matricula && x.status === 'valid');
      if (dup) { toast('Esta matrícula já votou.', 'orange'); backToCanal(); return; }
      const rec = await DB.insert('votes', {
        election_id: S.vElection.id, cd: S.cd,
        voter_matricula: S.vEmp.matricula, voter_name: S.vEmp.name, voter_shift: S.vEmp.shift,
        candidate_id: S.vCand, status: 'valid',
        cancelled_at: null, cancelled_by: null, cancel_reason: null,
      });
      M.votes.push(rec);
    }
  } catch (e) { toast(e.message, 'red'); return; }
  ['voto-1', 'voto-2', 'voto-3'].forEach(i => $(i).classList.add('hidden'));
  $('voto-ok').classList.remove('hidden');
}

/* Recarrega apuração e participação a partir das views seguras. */
async function refreshVoteCache() {
  const els = uniq(M.elections.map(e => e.id));
  M.tallies = {}; M.participation = {};
  for (const id of els) {
    M.tallies[id] = await DB.voteTally(id);
    M.participation[id] = await DB.voteParticipation(id);
  }
}

/* ══════════ PONTOS ══════════ */
function renderPontos(f) {
  if (f) S.filter = f;
  if (!S.pontosCd) S.pontosCd = S.cd;
  const cds = S.user ? scopeCds() : CDS;
  fillSelect('pontos-cd', cds, S.pontosCd);
  $('pontos-sub').textContent = S.user
    ? (S.user.role === 'supervisor' ? 'Apenas os pontos sob sua responsabilidade' : `${ROLE_LABEL[S.user.role]} · acompanhamento`)
    : 'Acompanhamento dos registros e prazos';
  renderOccKpis(); renderOccList();
}
function onPontosCdChange() { S.pontosCd = $('pontos-cd').value; renderPontos(); }
function filterOcc(f, btn) {
  document.querySelectorAll('#page-pontos .pill-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); renderPontos(f);
}
function renderOccKpis() {
  const l = pontosOccurrences();
  const open = l.filter(o => o.status === 'open').length;
  const exp = l.filter(o => o.status === 'open' && remaining(o) <= 0).length;
  const done = l.filter(o => o.status === 'done').length;
  $('occ-kpis').innerHTML = `
    <div class="occ-kpi"><div class="kv" style="color:var(--blue2)">${l.length}</div><div class="kl">Total</div></div>
    <div class="occ-kpi"><div class="kv" style="color:var(--blue2)">${open}</div><div class="kl">Em aberto</div></div>
    <div class="occ-kpi"><div class="kv" style="color:var(--red)">${exp}</div><div class="kl">⚠️ Vencidos</div></div>
    <div class="occ-kpi"><div class="kv" style="color:var(--green)">${done}</div><div class="kl">✓ Tratados</div></div>`;
}
function renderOccList() {
  if (S.timer) clearInterval(S.timer);
  let l = [...pontosOccurrences()].sort((a, b) => b.created_at - a.created_at);
  if (S.filter === 'aberto') l = l.filter(o => o.status === 'open');
  if (S.filter === 'vencido') l = l.filter(o => o.status === 'open' && remaining(o) <= 0);
  if (S.filter === 'tratado') l = l.filter(o => o.status === 'done');
  $('occ-count').textContent = l.length + ' registro' + (l.length !== 1 ? 's' : '');

  if (!l.length) {
    $('occ-list').innerHTML = emptyBox(S.filter === 'tratado' ? '✅' : '📋',
      'Nenhum ponto ' + (S.filter === 'tratado' ? 'tratado' : S.filter === 'vencido' ? 'vencido' : S.filter === 'aberto' ? 'em aberto' : 'registrado'),
      S.filter === 'todos' ? 'Registre um novo ponto de atenção para começar.' : 'Nenhum ponto nesta categoria.');
    return;
  }

  $('occ-list').innerHTML = l.map(o => {
    const t = byId(M.log_themes, o.theme_id) || { icon: '📋', label: '—' };
    const c = CRIT[o.criticality] || CRIT.baixa;
    const sup = byId(M.profiles, o.supervisor_id);
    const rem = remaining(o);
    let tc, tt;
    if (o.status === 'done') { tc = 't-done'; tt = '✓ Tratado'; }
    else if (rem <= 0) { tc = 't-expired'; tt = '⚠️ VENCIDO!'; }
    else if (rem < 12 * H) { tc = 't-warn'; tt = '⏰ ' + fmtTimer(rem); }
    else { tc = 't-ok'; tt = '⏱ ' + fmtTimer(rem); }
    const cc = o.status === 'done' ? 'c-done' : rem <= 0 ? 'c-expired' : rem < 12 * H ? 'c-warn' : 'c-open';
    const note = o.status === 'done' && o.resolution_note;
    return `<div class="occ-wrap">
      <div class="occ-card ${cc} ${note ? 'has-note' : ''}" id="card-${o.id}">
        <div class="occ-inner">
          <div class="occ-icon">${t.icon}</div>
          <div class="occ-body">
            <div class="occ-theme-label"><span>${esc(t.label)}</span>
              <span class="badge ${c.badge}">${c.icon} ${c.label} · ${c.hours}h</span></div>
            <div class="occ-title">${esc(o.title)}</div>
            <div class="occ-desc">${esc(o.description)}</div>
            <div class="occ-meta">
              <span class="occ-author">🙋 ${esc(o.author_name)} (${esc(o.author_matricula)})</span>
              ${o.location ? `<span class="occ-place">📍 ${esc(o.location)}</span>` : ''}
              ${sup ? `<span class="occ-sup">👤 ${esc(sup.name)}</span>` : ''}
              <span class="occ-date">📅 ${fmtDate(o.created_at)}</span>
              <span class="occ-timer ${tc}" id="timer-${o.id}">${tt}</span>
            </div>
          </div>
        </div>
        <div class="occ-actions">
          ${o.status === 'open'
            ? (canTreat(o) ? `<button class="btn-tratar" onclick="openTratar('${o.id}')">✓ Tratar</button>`
                           : `<span class="badge badge-gray">Aguardando</span>`)
            : `<span class="badge badge-green">✓ Concluído</span>`}
        </div>
      </div>
      ${note ? `<div class="occ-resolution"><strong>Devolutiva:</strong> ${esc(o.resolution_note)}
        <br><em>${esc(o.resolved_by)} · ${fmtDate(o.resolved_at)}</em></div>` : ''}
    </div>`;
  }).join('');
  startTimers();
}
function startTimers() {
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(() => {
    M.occurrences.forEach(o => {
      if (o.status !== 'open') return;
      const el = $('timer-' + o.id), card = $('card-' + o.id);
      if (!el) return;
      const rem = remaining(o);
      const note = '';
      if (rem <= 0) { el.className = 'occ-timer t-expired'; el.textContent = '⚠️ VENCIDO!'; if (card) card.className = 'occ-card c-expired' + note; refreshBanner(); }
      else if (rem < 12 * H) { el.className = 'occ-timer t-warn'; el.textContent = '⏰ ' + fmtTimer(rem); if (card) card.className = 'occ-card c-warn' + note; }
      else { el.className = 'occ-timer t-ok'; el.textContent = '⏱ ' + fmtTimer(rem); }
    });
  }, 1000);
}
function openTratar(id) {
  const o = byId(M.occurrences, id); if (!o) return;
  S._tratarId = id;
  const t = byId(M.log_themes, o.theme_id) || { icon: '📋', label: '—' };
  const c = CRIT[o.criticality] || CRIT.baixa;
  $('tratar-preview').innerHTML = `<div class="cb-label">${esc(t.label)} · ${c.icon} ${c.label}</div>
    <div style="font-weight:700;color:var(--blue);margin:3px 0">${esc(o.title)}</div>
    <div style="font-size:.85rem;color:var(--text2)">${esc(o.description)}</div>`;
  $('tratar-note').value = ''; $('tratar-char').textContent = '0 / 300'; $('tratar-btn').disabled = true;
  openModal('modal-tratar');
  setTimeout(() => $('tratar-note').focus(), 100);
}
async function confirmTratar() {
  const note = $('tratar-note').value.trim();
  if (note.length < 10) return;
  const patch = { status: 'done', resolved_at: Date.now(), resolved_by: S.user ? S.user.name : 'Supervisor', resolution_note: note };
  await DB.update('occurrences', S._tratarId, patch);
  Object.assign(byId(M.occurrences, S._tratarId), patch);
  closeModal('modal-tratar'); renderPontos(); refreshBanner();
  if (S.user) renderDash();
  toast('Ponto tratado e devolutiva registrada!', 'green');
}
function refreshBanner() {
  const l = S.user ? visibleOccurrences() : M.occurrences.filter(o => o.cd === S.cd);
  const exp = l.filter(o => o.status === 'open' && remaining(o) <= 0).length;
  const warn = l.filter(o => o.status === 'open' && remaining(o) > 0 && remaining(o) < 12 * H).length;
  const b = $('attn-banner');
  if (exp > 0) {
    $('attn-text').textContent = `${exp} ponto${exp > 1 ? 's' : ''} de atenção vencido${exp > 1 ? 's' : ''}`;
    $('attn-cnt').textContent = exp;
    b.style.display = 'flex';
  } else b.style.display = 'none';
  $('nav-dot').className = 'nav-dot' + ((exp + warn) > 0 ? ' show' : '');
}

/* ══════════ LOGIN ══════════ */
async function doLogin() {
  const m = $('l-user').value.trim(), p = $('l-pass').value;
  const err = $('l-err');
  if (!m || !p) { err.textContent = 'Informe matrícula e senha.'; err.classList.remove('hidden'); return; }
  const btn = document.querySelector('#gestor-login .btn-primary');
  btn.disabled = true; btn.textContent = 'Entrando...';
  try {
    const u = await DB.signIn(m, p);
    S.user = u;
    S.dashCd = u.cd === 'TODOS' ? 'TODOS' : u.cd;
    err.classList.add('hidden');
    $('l-user').value = ''; $('l-pass').value = '';
    await loadAll();
    $('gestor-login').classList.add('hidden');
    $('gestor-dash').classList.remove('hidden');
    $('nav-user').classList.remove('hidden');
    $('nav-user-av').textContent = initials(u.name);
    $('nav-user-nm').textContent = u.name.split(' ')[0];
    $('nav-user-rl').textContent = ROLE_LABEL[u.role];
    $('dash-user-info').textContent = `${u.name} · ${ROLE_LABEL[u.role]} · ${u.cd}`;
    buildDashTabs(); renderDash(); refreshBanner();
    toast('Bem-vindo(a), ' + u.name.split(' ')[0] + '!', 'blue');
  } catch (e) {
    err.textContent = e.message || 'Não foi possível entrar.';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}
async function doLogout() {
  await DB.signOut();
  S.user = null;
  $('gestor-dash').classList.add('hidden');
  $('gestor-login').classList.remove('hidden');
  $('nav-user').classList.add('hidden');
  await loadAll();
  goPage('home');
}
function buildDashTabs() {
  const tabs = [
    { id: 'logistica',   label: '⚡ Logística',   roles: ['gerente', 'coordenador', 'supervisor', 'admin'] },
    { id: 'participacao',label: '✅ Participação', roles: ['gerente', 'coordenador', 'supervisor', 'admin'] },
    { id: 'pesquisa',    label: '📝 Resultados',  roles: ['admin'] },
    { id: 'votos',     label: '🗳️ Votação',      roles: ['gerente', 'coordenador', 'supervisor', 'admin'] },
    { id: 'eleicoes',  label: '🏆 Eleições',     roles: ['gerente', 'coordenador', 'admin'] },
    { id: 'rodadas',   label: '📅 Rodadas',      roles: ['gerente', 'coordenador', 'admin'] },
    { id: 'qrcode',    label: '📱 QR Codes',     roles: ['coordenador', 'admin'] },
    { id: 'config',    label: '⚙️ Configurações', roles: ['admin'] },
  ].filter(t => t.roles.includes(S.user.role));
  $('dash-tabs').innerHTML = tabs.map((t, i) =>
    `<button class="dash-tab ${i === 0 ? 'active' : ''}" onclick="showDashTab('${t.id}',this)">${t.label}</button>`).join('');
  document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'));
  if (tabs.length) $('dtab-' + tabs[0].id).classList.add('active');
  const cds = S.user.cd === 'TODOS' || S.user.role === 'admin' || S.user.role === 'gerente'
    ? [{ value: 'TODOS', label: 'Todos os CDs' }, ...CDS.map(c => ({ value: c, label: c }))]
    : [{ value: S.user.cd, label: S.user.cd }];
  fillSelect('dash-cd', cds, S.dashCd);
}
function showDashTab(id, btn) {
  document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.dash-tab').forEach(b => b.classList.remove('active'));
  $('dtab-' + id).classList.add('active'); btn.classList.add('active');
  renderDash();
}
function onDashCdChange() { S.dashCd = $('dash-cd').value; renderDash(); }
function renderDash() {
  if (!S.user) return;
  renderLogDash(); renderPartDash(); renderVoteDash();
  renderElections(); renderRounds();
  if (isAdmin()) { renderSurvDash(); renderConfig(); }
  if (['admin', 'coordenador'].includes(S.user.role)) renderQrTab();
}

/* ══════════ PARTICIPAÇÃO NA PESQUISA ══════════ */
function roundsInScope() {
  return M.survey_rounds.filter(r => dashCds().includes(r.cd)).sort((a, b) => a.created_at - b.created_at);
}
function currentRoundForDash() {
  const cds = dashCds();
  return M.survey_rounds.find(r => cds.includes(r.cd) && r.status === 'open')
      || roundsInScope().slice(-1)[0] || null;
}
function renderPartDash() {
  const rd = currentRoundForDash();
  const rounds = roundsInScope();
  const emps = M.employees.filter(e => dashCds().includes(e.cd) && e.active !== false);
  S._partRound = rd;

  if (!rd) {
    $('part-kpis').innerHTML = `<div class="kpi-card dark"><div class="kpi-val">0</div><div class="kpi-lbl">Nenhuma rodada</div></div>
      <div class="kpi-card light"><div class="kpi-val">${emps.length}</div><div class="kpi-lbl">Colaboradores ativos</div></div>`;
    ['part-turnout', 'part-history'].forEach(i => $(i).innerHTML = noData('Nenhuma rodada de pesquisa cadastrada ainda.'));
    $('part-tbody').innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text3)">Nenhuma rodada cadastrada.</td></tr>`;
    return;
  }

  const parts = M.survey_participations.filter(p => p.round_id === rd.id);
  const pct = emps.length ? Math.round(parts.length / emps.length * 100) : 0;
  const faltam = emps.length - parts.length;
  $('part-kpis').innerHTML = `
    <div class="kpi-card dark"><div class="kpi-val">${parts.length}</div><div class="kpi-lbl">Participaram</div></div>
    <div class="kpi-card light"><div class="kpi-val" style="color:var(--red)">${faltam}</div><div class="kpi-lbl">Faltam participar</div></div>
    <div class="kpi-card light"><div class="kpi-val">${emps.length}</div><div class="kpi-lbl">Colaboradores ativos</div></div>
    <div class="kpi-card light"><div class="kpi-val">${pct}%</div><div class="kpi-lbl">Adesão</div></div>
    <div class="kpi-card light"><div class="kpi-val sm">${rd.status === 'open' ? '🟢 Aberta' : '🔒 Encerrada'}</div><div class="kpi-lbl">${esc(rd.title)}</div></div>`;

  $('part-sub').textContent = `${esc(rd.title)} · ${rounds.length} rodada${rounds.length !== 1 ? 's' : ''} no histórico`;

  $('part-turnout').innerHTML = SHIFTS.map(sh => {
    const e = emps.filter(x => x.shift === sh);
    const p = parts.filter(x => x.shift === sh).length;
    return donut(e.length ? Math.round(p / e.length * 100) : 0, esc(sh), `${p} de ${e.length} participaram`);
  }).join('');

  $('part-history').innerHTML = rounds.length ? rounds.slice(-6).reverse().map(r => {
    const n = M.survey_participations.filter(p => p.round_id === r.id).length;
    const base = M.employees.filter(e => e.cd === r.cd && e.active !== false).length;
    const p = base ? Math.round(n / base * 100) : 0;
    return rankRow(r.status === 'open' ? '🟢' : '🔒', esc(r.title),
      `<span class="badge ${p >= 70 ? 'badge-green' : p >= 40 ? 'badge-orange' : 'badge-red'}">${p}%</span>`,
      p, `${n}/${base}`);
  }).join('') : noData('Sem histórico ainda.');

  renderPartTable();
}

function employeeHistory(emp) {
  const rounds = roundsInScope().filter(r => r.cd === emp.cd);
  const done = rounds.filter(r => M.survey_participations.some(p => p.round_id === r.id && p.matricula === emp.matricula)).length;
  return { done, total: rounds.length };
}

function renderPartTable() {
  const rd = S._partRound; if (!rd) return;
  const q = ($('part-search').value || '').toLowerCase().trim();
  const f = $('part-filter').value;
  const parts = M.survey_participations.filter(p => p.round_id === rd.id);
  let rows = M.employees.filter(e => dashCds().includes(e.cd) && e.active !== false).map(e => {
    const p = parts.find(x => x.matricula === e.matricula);
    return { emp: e, part: p, hist: employeeHistory(e) };
  });
  if (q) rows = rows.filter(r => r.emp.matricula.toLowerCase().includes(q)
    || r.emp.name.toLowerCase().includes(q)
    || (r.emp.job_title || '').toLowerCase().includes(q));
  if (f === 'fez') rows = rows.filter(r => r.part);
  if (f === 'falta') rows = rows.filter(r => !r.part);
  rows.sort((a, b) => (a.part ? 1 : 0) - (b.part ? 1 : 0) || a.emp.name.localeCompare(b.emp.name));

  $('part-tbody').innerHTML = rows.length ? rows.map(r => {
    const h = r.hist;
    const hp = h.total ? Math.round(h.done / h.total * 100) : 0;
    return `<tr>
      <td><strong>${esc(r.emp.matricula)}</strong></td>
      <td>${esc(r.emp.name)}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(r.emp.job_title || '—')}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(r.emp.shift)}</td>
      <td style="font-size:12px;color:var(--text3);white-space:nowrap">${r.emp.admission_date ? fmtDateISO(r.emp.admission_date) : '—'}</td>
      <td>${r.part ? '<span class="badge badge-green">✓ Sim</span>' : '<span class="badge badge-red">✗ Não</span>'}</td>
      <td><div style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;min-width:52px"><div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${hp}%"></div></div></div>
        <span style="font-size:12px;font-weight:700;color:${hp >= 70 ? 'var(--green)' : hp >= 40 ? 'var(--orange)' : 'var(--red)'};white-space:nowrap">${h.done}/${h.total}</span>
      </div></td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text3)">Nenhum colaborador encontrado.</td></tr>`;
}

function exportParticipacao() {
  const rd = S._partRound;
  if (!rd) { toast('Nenhuma rodada para exportar.', 'orange'); return; }
  const rounds = roundsInScope();
  const head = ['Matrícula', 'Nome', 'Função', 'Turno', 'Setor', 'CD', 'Admissão', 'Rodada atual', 'Participações', 'Total de rodadas', '% Histórico'];
  const rows = [head];
  M.employees.filter(e => dashCds().includes(e.cd) && e.active !== false)
    .sort((a, b) => a.cd.localeCompare(b.cd) || a.name.localeCompare(b.name))
    .forEach(e => {
      const p = M.survey_participations.some(x => x.round_id === rd.id && x.matricula === e.matricula);
      const h = employeeHistory(e);
      rows.push([e.matricula, e.name, e.job_title || '', e.shift, e.sector, e.cd,
        e.admission_date ? fmtDateISO(e.admission_date) : '',
        p ? 'Sim' : 'Não', h.done, h.total, h.total ? Math.round(h.done / h.total * 100) + '%' : '—']);
    });
  const csv = rows.map(r => r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'participacao-pesquisa-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  toast('Lista de participação exportada!', 'green');
}

/* ══════════ DASH LOGÍSTICA ══════════ */
function donut(pct, title, sub, extra) {
  const r = 28, c = 2 * Math.PI * r, f = (pct / 100) * c;
  return `<div class="donut-row">
    <svg width="66" height="66" viewBox="0 0 66 66" style="flex-shrink:0">
      <circle cx="33" cy="33" r="${r}" fill="none" stroke="#e4ecf7" stroke-width="7"/>
      <circle cx="33" cy="33" r="${r}" fill="none" stroke="#0f5bbf" stroke-width="7"
        stroke-dasharray="${f} ${c - f}" stroke-linecap="round" transform="rotate(-90 33 33)"/>
      <text x="33" y="38" text-anchor="middle" font-size="12" font-weight="700" fill="#04336b">${pct}%</text>
    </svg>
    <div class="donut-info"><div class="dn">${title}</div><div class="ds">${sub}</div>${extra || ''}</div></div>`;
}
function rankRow(n, name, badge, barPct, score) {
  return `<div class="rank-row"><div class="rank-num">${n}</div>
    <div class="rank-body"><div class="rank-name"><span>${name}</span>${badge || ''}</div>
    <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${barPct}%"></div></div></div>
    <div class="rank-score">${score}</div></div>`;
}
const noData = m => `<p class="text-muted" style="padding:.5rem 0">${m}</p>`;

function renderLogDash() {
  const l = visibleOccurrences();
  const total = l.length, done = l.filter(o => o.status === 'done').length;
  const open = l.filter(o => o.status === 'open').length;
  const exp = l.filter(o => o.status === 'open' && remaining(o) <= 0).length;
  const onTime = l.filter(o => o.status === 'done' && o.resolved_at - o.created_at <= o.sla_hours * H).length;
  $('log-kpis').innerHTML = `
    <div class="kpi-card dark"><div class="kpi-val">${total}</div><div class="kpi-lbl">Total de ocorrências</div></div>
    <div class="kpi-card light"><div class="kpi-val">${open}</div><div class="kpi-lbl">Em aberto</div></div>
    <div class="kpi-card light"><div class="kpi-val" style="color:var(--green)">${done}</div><div class="kpi-lbl">Tratadas</div></div>
    <div class="kpi-card light"><div class="kpi-val" style="color:var(--red)">${exp}</div><div class="kpi-lbl">Vencidas</div></div>
    <div class="kpi-card light"><div class="kpi-val">${done ? Math.round(onTime / done * 100) : 0}%</div><div class="kpi-lbl">Tratadas no prazo</div></div>`;

  const ids = uniq(l.map(o => o.theme_id));
  const stats = ids.map(id => {
    const t = byId(M.log_themes, id) || { icon: '📋', label: '—' };
    const all = l.filter(o => o.theme_id === id);
    const d = all.filter(o => o.status === 'done').length;
    const e = all.filter(o => o.status === 'open' && remaining(o) <= 0).length;
    return { icon: t.icon, label: t.label, total: all.length, done: d, expired: e, pct: all.length ? Math.round(d / all.length * 100) : 0 };
  }).sort((a, b) => b.total - a.total);

  if (!stats.length) {
    ['log-bar', 'log-donuts', 'log-rank', 'log-sup', 'log-crit'].forEach(i =>
      $(i).innerHTML = noData('Sem dados ainda. Os gráficos aparecem conforme os pontos são registrados.'));
    return;
  }
  const max = Math.max(...stats.map(s => s.total));
  $('log-bar').innerHTML = stats.map(s =>
    `<div class="bar-col"><div class="bar-val">${s.total}</div>
      <div class="bar-bg"><div class="bar-fill" style="height:${Math.round(s.total / max * 100)}%"></div></div>
      <div class="bar-lbl">${s.icon}<br>${esc(s.label)}</div></div>`).join('');
  $('log-donuts').innerHTML = stats.map(s => donut(s.pct, `${s.icon} ${esc(s.label)}`, `${s.done}/${s.total} tratados`,
    s.expired ? `<span class="badge badge-red" style="margin-top:3px">⚠️ ${s.expired} vencido${s.expired > 1 ? 's' : ''}</span>` : '')).join('');
  $('log-rank').innerHTML = stats.map((s, i) => rankRow(i + 1, `${s.icon} ${esc(s.label)}`,
    i === 0 ? '<span class="badge badge-red">Maior volume</span>' : s.pct >= 80 ? '<span class="badge badge-green">Controlado</span>' : '<span class="badge badge-orange">Atenção</span>',
    Math.round(s.total / max * 100), s.total)).join('');

  const sups = M.profiles.filter(u => u.role === 'supervisor').map(u => {
    const all = l.filter(o => o.supervisor_id === u.id);
    const d = all.filter(o => o.status === 'done').length;
    const e = all.filter(o => o.status === 'open' && remaining(o) <= 0).length;
    return { name: u.name, total: all.length, done: d, expired: e, pct: all.length ? Math.round(d / all.length * 100) : 0 };
  }).filter(s => s.total > 0).sort((a, b) => b.total - a.total);
  $('log-sup').innerHTML = sups.length ? sups.map((s, i) => rankRow(i + 1, `👤 ${esc(s.name)}`,
    s.expired ? `<span class="badge badge-red">${s.expired} vencido${s.expired > 1 ? 's' : ''}</span>`
      : s.pct >= 80 ? '<span class="badge badge-green">Em dia</span>' : '<span class="badge badge-orange">Atenção</span>',
    s.pct, s.done + '/' + s.total)).join('') : noData('Nenhum ponto atribuído aos supervisores ainda.');

  $('log-crit').innerHTML = Object.keys(CRIT).map(k => {
    const c = CRIT[k], all = l.filter(o => o.criticality === k);
    if (!all.length) return '';
    const d = all.filter(o => o.status === 'done').length;
    const e = all.filter(o => o.status === 'open' && remaining(o) <= 0).length;
    return `<div class="crit-stat-row">
      <div class="crit-dot" style="background:${c.badge === 'badge-green' ? 'var(--green-bg)' : c.badge === 'badge-orange' ? 'var(--orange-bg)' : 'var(--red-bg)'}">${c.icon}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;color:var(--blue)">${c.label} · ${c.hours}h</div>
        <div style="font-size:11.5px;color:var(--text3)">${all.length} registro${all.length !== 1 ? 's' : ''} · ${d} tratado${d !== 1 ? 's' : ''}${e ? ' · ' + e + ' vencido' + (e > 1 ? 's' : '') : ''}</div>
      </div>
      <div class="rank-score">${Math.round(d / all.length * 100)}%</div></div>`;
  }).join('') || noData('Sem dados.');
}

/* ══════════ DASH PESQUISA ══════════ */
function surveyStatsFor(responses, themes) {
  return themes.map(t => {
    let sum = 0, count = 0, pos = 0;
    responses.forEach(r => (t.questions || []).forEach((q, qi) => {
      const a = r.answers[t.id + '_' + qi];
      if (a !== undefined) { sum += SCALE_VAL[a]; count++; if (a <= 1) pos++; }
    }));
    const responders = responses.filter(r => (t.questions || []).some((q, qi) => r.answers[t.id + '_' + qi] !== undefined)).length;
    return { id: t.id, icon: t.icon, label: t.label, avg: count ? sum / count : 0, count, responders, sat: count ? Math.round(pos / count * 100) : 0 };
  }).filter(t => t.count > 0);
}
function renderSurvDash() {
  const cds = dashCds();
  const res = M.survey_responses.filter(r => cds.includes(r.cd));
  const ver = currentVersion();
  const stats = surveyStatsFor(res, ver ? ver.themes : []);
  if (!res.length || !stats.length) {
    $('surv-empty').classList.remove('hidden'); $('surv-charts').classList.add('hidden');
    $('surv-kpis').innerHTML = `<div class="kpi-card dark"><div class="kpi-val">0</div><div class="kpi-lbl">Respostas recebidas</div></div>
      <div class="kpi-card light"><div class="kpi-val">—</div><div class="kpi-lbl">Média geral</div></div>
      <div class="kpi-card light"><div class="kpi-val">—</div><div class="kpi-lbl">Satisfação geral</div></div>`;
    return;
  }
  $('surv-empty').classList.add('hidden'); $('surv-charts').classList.remove('hidden');
  const tc = stats.reduce((a, s) => a + s.count, 0);
  const avg = stats.reduce((a, s) => a + s.avg * s.count, 0) / tc;
  const sat = Math.round(stats.reduce((a, s) => a + s.sat * s.count, 0) / tc);
  const sorted = [...stats].sort((a, b) => b.avg - a.avg);
  const emps = M.employees.filter(e => cds.includes(e.cd) && e.active !== false).length;
  $('surv-kpis').innerHTML = `
    <div class="kpi-card dark"><div class="kpi-val">${res.length}</div><div class="kpi-lbl">Respostas recebidas</div></div>
    <div class="kpi-card light"><div class="kpi-val">${emps ? Math.round(res.length / emps * 100) : 0}%</div><div class="kpi-lbl">Adesão</div></div>
    <div class="kpi-card light"><div class="kpi-val">${avg.toFixed(1)}</div><div class="kpi-lbl">Média geral (1–5)</div></div>
    <div class="kpi-card light"><div class="kpi-val">${sat}%</div><div class="kpi-lbl">Satisfação geral</div></div>
    <div class="kpi-card light"><div class="kpi-val sm" style="color:var(--red)">${esc(sorted[sorted.length - 1].label)}</div><div class="kpi-lbl">Mais crítico</div></div>
    <div class="kpi-card light"><div class="kpi-val sm" style="color:var(--green)">${esc(sorted[0].label)}</div><div class="kpi-lbl">Mais positivo</div></div>`;

  $('surv-bar').innerHTML = stats.map(s =>
    `<div class="bar-col"><div class="bar-val">${s.avg.toFixed(1)}</div>
      <div class="bar-bg"><div class="bar-fill" style="height:${Math.round(s.avg / 5 * 100)}%"></div></div>
      <div class="bar-lbl">${s.icon}<br>${esc(s.label)}</div></div>`).join('');
  $('surv-donuts').innerHTML = stats.map(s => donut(s.sat, `${s.icon} ${esc(s.label)}`, `${s.responders} respondente${s.responders !== 1 ? 's' : ''}`)).join('');
  const maxAvg = Math.max(...sorted.map(s => s.avg));
  $('surv-rank').innerHTML = sorted.map((s, i) => rankRow(i + 1, `${s.icon} ${esc(s.label)}`,
    i === 0 ? '<span class="badge badge-green">Melhor</span>' : i === sorted.length - 1 ? '<span class="badge badge-red">Crítico</span>' : '<span class="badge badge-orange">Médio</span>',
    Math.round(s.avg / maxAvg * 100), s.avg.toFixed(1))).join('');

  // Evolução entre rodadas
  const rounds = M.survey_rounds.filter(r => cds.includes(r.cd)).sort((a, b) => a.created_at - b.created_at);
  if (rounds.length < 2) {
    $('surv-hist').innerHTML = noData('A comparação aparece a partir da segunda rodada concluída.');
  } else {
    const series = ver.themes.map(t => {
      const pts = rounds.map(rd => {
        const rr = res.filter(r => r.round_id === rd.id);
        const st = surveyStatsFor(rr, [t])[0];
        return st ? st.avg : null;
      });
      return { icon: t.icon, label: t.label, pts };
    }).filter(s => s.pts.some(p => p !== null));
    const w = 180, h = 44;
    $('surv-hist').innerHTML = series.map(s => {
      const valid = s.pts.map((p, i) => ({ p, i })).filter(x => x.p !== null);
      const poly = valid.map(x => `${(x.i / Math.max(1, s.pts.length - 1)) * w},${((5 - x.p) / 4) * h}`).join(' ');
      const dots = valid.map(x => `<circle cx="${(x.i / Math.max(1, s.pts.length - 1)) * w}" cy="${((5 - x.p) / 4) * h}" r="3.5" fill="#0f5bbf"/>`).join('');
      const last = valid[valid.length - 1];
      return `<div class="spark-row" style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div style="font-size:12.5px;font-weight:600;color:var(--blue);width:95px;flex-shrink:0">${s.icon} ${esc(s.label)}</div>
        <svg width="${w}" height="${h + 8}" style="flex:1">
          <polyline points="${poly}" fill="none" stroke="#3a8ee6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>
        <div style="font-size:12.5px;font-weight:700;color:var(--blue2);width:32px;text-align:right">${last.p.toFixed(1)}</div></div>`;
    }).join('');
  }

  const sugs = res.filter(r => r.suggestion).sort((a, b) => b.created_at - a.created_at);
  $('surv-feed').innerHTML = sugs.length ? sugs.slice(0, 15).map(r =>
    `<div class="sug-item"><div class="sug-dot"></div><div>
      <div class="sug-text">"${esc(r.suggestion)}"</div>
      <div class="sug-meta">${fmtDate(r.created_at)} · ${esc(r.cd)}</div></div></div>`).join('')
    : noData('Nenhuma sugestão registrada ainda.');
}

/* ══════════ DASH VOTAÇÃO ══════════ */
function activeElectionForDash() {
  const cds = dashCds();
  return M.elections.filter(e => cds.includes(e.cd) && e.status === 'open')[0]
      || M.elections.filter(e => cds.includes(e.cd)).sort((a, b) => b.created_at - a.created_at)[0] || null;
}
function renderVoteDash() {
  const el = activeElectionForDash();
  if (!el) {
    $('vote-kpis').innerHTML = `<div class="kpi-card dark"><div class="kpi-val">0</div><div class="kpi-lbl">Nenhuma eleição</div></div>`;
    ['vote-bar', 'vote-turnout'].forEach(i => $(i).innerHTML = noData('Nenhuma eleição cadastrada para este CD.'));
    $('vote-tbody').innerHTML = '';
    return;
  }
  const cands = candidatesOf(el.id), tally = tallyFor(el.id);
  const votes = validVotes(el.id);
  const emps = M.employees.filter(e => e.cd === el.cd && e.active !== false);
  const pct = emps.length ? Math.round(votes.length / emps.length * 100) : 0;
  $('vote-kpis').innerHTML = `
    <div class="kpi-card dark"><div class="kpi-val">${votes.length}</div><div class="kpi-lbl">Votos válidos</div></div>
    <div class="kpi-card light"><div class="kpi-val">${emps.length}</div><div class="kpi-lbl">Colaboradores aptos</div></div>
    <div class="kpi-card light"><div class="kpi-val">${pct}%</div><div class="kpi-lbl">Adesão</div></div>
    <div class="kpi-card light"><div class="kpi-val">${cands.length}</div><div class="kpi-lbl">Candidatos</div></div>
    <div class="kpi-card light"><div class="kpi-val sm">${el.status === 'open' ? '🟢 Aberta' : '🔒 Encerrada'}</div><div class="kpi-lbl">${esc(el.title)}</div></div>`;

  const max = Math.max(...Object.values(tally), 1);
  $('vote-bar').innerHTML = cands.length ? cands.map(c => {
    const v = tally[c.id] || 0;
    return `<div class="bar-col"><div class="bar-val">${v}</div>
      <div class="bar-bg"><div class="bar-fill" style="height:${Math.round(v / max * 100)}%"></div></div>
      <div class="bar-lbl">${esc(initials(c.name))}<br>${esc(c.name.split(' ')[0])}</div></div>`;
  }).join('') : noData('Nenhum candidato cadastrado.');

  $('vote-turnout').innerHTML = SHIFTS.map(sh => {
    const e = emps.filter(x => x.shift === sh);
    const v = votes.filter(x => x.voter_shift === sh).length;
    const p = e.length ? Math.round(v / e.length * 100) : 0;
    return donut(p, esc(sh), `${v} de ${e.length} votaram`);
  }).join('');

  S._voteElection = el;
  renderVoteTable();
}
function renderVoteTable() {
  const el = S._voteElection; if (!el) return;
  const q = ($('vote-search').value || '').toLowerCase().trim();
  const st = $('vote-status-filter').value;
  const votes = participationOf(el.id);
  const emps = M.employees.filter(e => e.cd === el.cd && e.active !== false);
  let rows = emps.map(e => {
    const v = votes.find(x => x.voter_matricula === e.matricula && x.status === 'valid');
    const cancelled = votes.find(x => x.voter_matricula === e.matricula && x.status === 'cancelled');
    return { emp: e, vote: v, cancelled: !!cancelled };
  });
  if (q) rows = rows.filter(r => r.emp.matricula.toLowerCase().includes(q) || r.emp.name.toLowerCase().includes(q));
  if (st === 'votou') rows = rows.filter(r => r.vote);
  if (st === 'falta') rows = rows.filter(r => !r.vote);
  rows.sort((a, b) => (b.vote ? b.vote.created_at : 0) - (a.vote ? a.vote.created_at : 0));

  $('vote-tbody').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td><strong>${esc(r.emp.matricula)}</strong></td>
      <td>${esc(r.emp.name)}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(r.emp.shift)}</td>
      <td>${r.vote ? '<span class="badge badge-green">✓ Votou</span>' : '<span class="badge badge-gray">Falta votar</span>'}
        ${r.cancelled ? '<span class="badge badge-orange" style="margin-left:4px">↩ Revotou</span>' : ''}</td>
      <td style="font-size:12px;color:var(--text3);white-space:nowrap">${r.vote ? fmtDate(r.vote.created_at) : '—'}</td>
      <td>${r.vote && isAdmin() && el.status === 'open' && !r.cancelled
        ? `<button class="btn-ghost" onclick="openCancelVote('${r.vote.id}')">↩️ Cancelar</button>` : ''}</td>
    </tr>`).join('')
    : `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text3)">Nenhum colaborador encontrado.</td></tr>`;
}
function openCancelVote(voteId) {
  const all = participationOf(S._voteElection ? S._voteElection.id : null);
  const v = all.find(x => x.id === voteId) || byId(M.votes, voteId); if (!v) return;
  const prev = all.find(x => x.voter_matricula === v.voter_matricula && x.status === 'cancelled');
  if (prev) { toast('Este colaborador já teve um voto cancelado nesta eleição.', 'orange'); return; }
  S._cancelVoteId = voteId;
  $('cv-preview').innerHTML = `<div class="cb-label">Colaborador</div>
    <div style="font-weight:700;color:var(--blue);margin:3px 0">${esc(v.voter_name)} (${esc(v.voter_matricula)})</div>
    <div style="font-size:.85rem;color:var(--text2)">${esc(v.voter_shift)} · votou em ${fmtDate(v.created_at)}</div>`;
  $('cv-reason').value = ''; $('cv-char').textContent = '0 / 200'; $('cv-btn').disabled = true;
  openModal('modal-cancel-vote');
  setTimeout(() => $('cv-reason').focus(), 100);
}
async function confirmCancelVote() {
  const reason = $('cv-reason').value.trim();
  if (reason.length < 10) return;
  try {
    if (DB.online) {
      await DB.rpc('cancel_vote', { p_vote: S._cancelVoteId, p_reason: reason });
      await refreshVoteCache();
    } else {
      const patch = { status: 'cancelled', cancelled_at: Date.now(), cancelled_by: S.user.name, cancel_reason: reason };
      await DB.update('votes', S._cancelVoteId, patch);
      Object.assign(byId(M.votes, S._cancelVoteId), patch);
    }
  } catch (e) { toast(e.message, 'red'); return; }
  closeModal('modal-cancel-vote'); renderVoteDash(); renderHome();
  toast('Voto cancelado. O colaborador já pode votar novamente.', 'orange');
}

/* ══════════ ELEIÇÕES ══════════ */
function renderElections() {
  const cd = S.dashCd === 'TODOS' ? scopeCds()[0] : S.dashCd;
  const el = openElection(cd);
  const admin = isAdmin();
  $('election-actions').innerHTML = !admin ? '' : (el
    ? `<button class="btn-ghost" onclick="openCandModal()">+ Candidato</button>
       <button class="btn-primary shrink sm danger" onclick="closeElection('${el.id}')">🔒 Encerrar eleição</button>`
    : `<button class="btn-primary shrink sm" onclick="createElection('${esc(cd)}')">+ Abrir eleição</button>`);

  if (!el) {
    $('election-current').innerHTML = `<div class="period-card"><div class="period-head">
      <div><div class="period-title">Nenhuma eleição aberta</div>
      <div class="period-meta">${esc(cd)}${admin ? ' · use o botão acima para abrir uma nova eleição' : ''}</div></div></div></div>`;
  } else {
    const cands = candidatesOf(el.id), tally = tallyFor(el.id);
    const votes = validVotes(el.id).length;
    const emps = M.employees.filter(e => e.cd === el.cd && e.active !== false).length;
    const days = Math.floor((Date.now() - el.created_at) / DAY);
    $('election-current').innerHTML = `<div class="period-card open">
      <div class="period-head">
        <div><div class="period-title">${esc(el.title)}</div>
        <div class="period-meta">${esc(el.cd)} · aberta há ${days} dia${days !== 1 ? 's' : ''} · desde ${fmtDateFull(el.created_at)}</div></div>
        <span class="badge badge-green">🟢 Em andamento</span>
      </div>
      <div class="countdown">
        <div class="cd-box"><div class="cd-num">${votes}</div><div class="cd-lbl">Votos</div></div>
        <div class="cd-box"><div class="cd-num">${emps}</div><div class="cd-lbl">Aptos</div></div>
        <div class="cd-box"><div class="cd-num">${emps ? Math.round(votes / emps * 100) : 0}%</div><div class="cd-lbl">Adesão</div></div>
        <div class="cd-box"><div class="cd-num">${cands.length}</div><div class="cd-lbl">Candidatos</div></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${emps ? Math.round(votes / emps * 100) : 0}%"></div></div>
      <div style="margin-top:1.25rem">
        ${cands.length ? cands.map(c => `<div class="list-item" style="margin-bottom:7px">
          <div class="list-avatar emp">${esc(initials(c.name))}</div>
          <div class="list-body"><div class="list-name">${esc(c.name)}</div>
          <div class="list-meta">${esc(c.shift)} · ${esc(c.sector || '')} · 🗳️ ${tally[c.id] || 0} voto${(tally[c.id] || 0) !== 1 ? 's' : ''}</div></div>
          ${admin ? `<button class="btn-ghost danger" onclick="openExclude('${c.id}')">🗑️</button>` : ''}
        </div>`).join('') : noData('Nenhum candidato cadastrado. Use "+ Candidato".')}
      </div>
    </div>`;
  }

  const hist = M.elections.filter(e => dashCds().includes(e.cd) && e.status === 'closed').sort((a, b) => b.closed_at - a.closed_at);
  $('election-history').innerHTML = hist.length ? hist.map(e => `
    <div class="hist-card">
      <div class="hist-head"><div><div class="hist-title">${esc(e.title)}</div>
        <div class="hist-meta">${esc(e.cd)} · ${fmtDateFull(e.created_at)} a ${fmtDateFull(e.closed_at)} · ${e.total_votes || 0} votos</div></div>
        <span class="badge badge-gray">🔒 Encerrada</span></div>
      ${(e.winners || []).map(w => `<div class="winner-row"><span class="winner-medal">🏆</span>
        <div><div class="winner-name">${esc(w.name)}</div>
        <div class="winner-meta">${esc(w.shift)} · ${w.votes} voto${w.votes !== 1 ? 's' : ''}</div></div></div>`).join('')}
    </div>`).join('') : noData('Nenhuma eleição encerrada ainda.');
}
async function createElection(cd) {
  const title = `Eleição ${quarterLabel(Date.now())}`;
  const rec = await DB.insert('elections', { cd, title, status: 'open', closed_at: null, winners: [], total_votes: 0 });
  M.elections.push(rec);
  renderElections(); renderVoteDash(); renderHome();
  toast('Eleição aberta! Agora cadastre os candidatos.', 'green');
}
function closeElection(id) {
  const el = byId(M.elections, id); if (!el) return;
  confirmAction('Encerrar eleição', 'Os votos serão apurados e os mais votados de cada turno serão registrados como porta-vozes. Esta ação não pode ser desfeita.', async () => {
    const cands = candidatesOf(id), tally = tallyFor(id);
    const winners = [];
    SHIFTS.forEach(sh => {
      const inShift = cands.filter(c => c.shift === sh).map(c => ({ ...c, votes: tally[c.id] || 0 }))
        .sort((a, b) => b.votes - a.votes);
      if (inShift.length && inShift[0].votes > 0) {
        winners.push({ id: inShift[0].id, name: inShift[0].name, shift: sh, sector: inShift[0].sector, votes: inShift[0].votes });
      }
    });
    if (DB.online) {
      await DB.rpc('close_election', { p_election: id });
      M.elections = await DB.select('elections');
      await refreshVoteCache();
    } else {
      const patch = { status: 'closed', closed_at: Date.now(), winners, total_votes: validVotes(id).length };
      await DB.update('elections', id, patch);
      Object.assign(el, patch);
    }
    renderElections(); renderVoteDash(); renderHome();
    toast(winners.length ? `Eleição encerrada! ${winners.length} porta-voz(es) eleito(s).` : 'Eleição encerrada sem votos.', 'green');
  });
}
function openCandModal() {
  const cd = S.dashCd === 'TODOS' ? scopeCds()[0] : S.dashCd;
  const el = openElection(cd); if (!el) return;
  const taken = candidatesOf(el.id).map(c => c.matricula);
  const opts = M.employees.filter(e => e.cd === cd && e.active !== false && !taken.includes(e.matricula))
    .map(e => ({ value: e.id, label: `${e.name} — ${e.shift} · ${e.sector}` }));
  if (!opts.length) { toast('Nenhum colaborador disponível para candidatura.', 'orange'); return; }
  fillSelect('cand-employee', opts);
  openModal('modal-candidate');
}
async function submitCandidate() {
  const cd = S.dashCd === 'TODOS' ? scopeCds()[0] : S.dashCd;
  const el = openElection(cd); if (!el) return;
  const emp = byId(M.employees, $('cand-employee').value); if (!emp) return;
  const rec = await DB.insert('candidates', {
    election_id: el.id, cd, matricula: emp.matricula, name: emp.name,
    shift: emp.shift, sector: emp.sector, employee_id: emp.id,
  });
  M.candidates.push(rec);
  closeModal('modal-candidate'); renderElections(); renderVoteDash(); renderHome();
  toast(emp.name + ' adicionado(a) como candidato!', 'green');
}
function openExclude(candId) {
  const c = byId(M.candidates, candId); if (!c) return;
  S._exclId = candId;
  const v = tallyFor(c.election_id)[candId] || 0;
  $('excl-preview').innerHTML = `<div class="vote-modal-avatar">${esc(initials(c.name))}</div>
    <div><div class="vote-modal-name">${esc(c.name)}</div>
    <div class="vote-modal-meta">${esc(c.shift)} · ${esc(c.sector || '')}</div>
    <div style="font-size:12px;color:var(--blue2);margin-top:4px">🗳️ ${v} voto${v !== 1 ? 's' : ''}</div></div>`;
  $('excl-reason').value = ''; $('excl-char').textContent = '0 / 200'; $('excl-btn').disabled = true;
  openModal('modal-excluir');
  setTimeout(() => $('excl-reason').focus(), 100);
}
async function confirmExclude() {
  const reason = $('excl-reason').value.trim();
  const c = byId(M.candidates, S._exclId);
  if (!c || reason.length < 10) return;
  const v = tallyFor(c.election_id)[c.id] || 0;
  const rec = await DB.insert('exclusion_log', {
    candidate_id: c.id, name: c.name, matricula: c.matricula, shift: c.shift,
    sector: c.sector, cd: c.cd, votes: v, reason,
    excluded_by: S.user.name, election_id: c.election_id,
  });
  M.exclusion_log.push(rec);
  // Os votos do candidato somem da apuração junto com ele:
  // online, a FK on delete cascade remove; offline, marcamos como anulados.
  if (!DB.online) {
    for (const vt of M.votes.filter(x => x.candidate_id === c.id && x.status === 'valid')) {
      await DB.update('votes', vt.id, { status: 'void', cancel_reason: 'Candidato excluído: ' + reason });
      vt.status = 'void';
    }
  }
  await DB.remove('candidates', c.id);
  if (DB.online) await refreshVoteCache();
  M.candidates = M.candidates.filter(x => x.id !== c.id);
  closeModal('modal-excluir'); renderElections(); renderVoteDash(); renderHome();
  toast(c.name + ' removido(a) da eleição.', 'orange');
}

/* ══════════ RODADAS DE PESQUISA ══════════ */
function renderRounds() {
  const cd = S.dashCd === 'TODOS' ? scopeCds()[0] : S.dashCd;
  const rd = openRound(cd);
  const admin = isAdmin();
  $('round-actions').innerHTML = !admin ? '' : (rd
    ? `<button class="btn-primary shrink sm danger" onclick="closeRound('${rd.id}')">🔒 Encerrar rodada</button>`
    : `<button class="btn-primary shrink sm" onclick="createRound('${esc(cd)}')">+ Abrir rodada</button>`);

  if (!rd) {
    const last = M.survey_rounds.filter(r => r.cd === cd && r.status === 'closed').sort((a, b) => b.closed_at - a.closed_at)[0];
    const nextIn = last ? Math.max(0, Math.ceil((last.closed_at + 90 * DAY - Date.now()) / DAY)) : null;
    $('round-current').innerHTML = `<div class="period-card"><div class="period-head">
      <div><div class="period-title">Nenhuma rodada aberta</div>
      <div class="period-meta">${esc(cd)}${nextIn !== null ? ' · próxima sugerida em ~' + nextIn + ' dias' : ''}</div></div></div>
      ${nextIn !== null ? `<div class="countdown"><div class="cd-box"><div class="cd-num">${nextIn}</div><div class="cd-lbl">Dias</div></div></div>` : ''}
    </div>`;
  } else {
    const days = Math.max(0, Math.ceil((rd.ends_at - Date.now()) / DAY));
    const total = Math.ceil((rd.ends_at - rd.created_at) / DAY);
    const pctTime = Math.min(100, Math.round((total - days) / total * 100));
    const n = M.survey_responses.filter(r => r.round_id === rd.id).length;
    const emps = M.employees.filter(e => e.cd === rd.cd && e.active !== false).length;
    $('round-current').innerHTML = `<div class="period-card open">
      <div class="period-head">
        <div><div class="period-title">${esc(rd.title)}</div>
        <div class="period-meta">${esc(rd.cd)} · versão de temas V${rd.theme_version} · aberta em ${fmtDateFull(rd.created_at)}</div></div>
        <span class="badge ${days <= 7 ? 'badge-orange' : 'badge-green'}">${days <= 7 ? '⏰ Encerrando' : '🟢 Aberta'}</span>
      </div>
      <div class="countdown">
        <div class="cd-box"><div class="cd-num">${days}</div><div class="cd-lbl">Dias restantes</div></div>
        <div class="cd-box"><div class="cd-num">${n}</div><div class="cd-lbl">Respostas</div></div>
        <div class="cd-box"><div class="cd-num">${emps}</div><div class="cd-lbl">Aptos</div></div>
        <div class="cd-box"><div class="cd-num">${emps ? Math.round(n / emps * 100) : 0}%</div><div class="cd-lbl">Adesão</div></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pctTime}%"></div></div>
      <div style="font-size:11.5px;color:var(--text3);margin-top:6px">Encerra em ${fmtDateFull(rd.ends_at)}</div>
    </div>`;
  }

  const hist = M.survey_rounds.filter(r => dashCds().includes(r.cd) && r.status === 'closed').sort((a, b) => b.closed_at - a.closed_at);
  $('round-history').innerHTML = hist.length ? hist.map(r => {
    const res = M.survey_responses.filter(x => x.round_id === r.id);
    const ver = M.survey_theme_versions.find(v => v.version === r.theme_version);
    const st = ver ? surveyStatsFor(res, ver.themes) : [];
    const avg = st.length ? st.reduce((a, s) => a + s.avg * s.count, 0) / st.reduce((a, s) => a + s.count, 0) : 0;
    return `<div class="hist-card">
      <div class="hist-head"><div><div class="hist-title">${esc(r.title)}</div>
        <div class="hist-meta">${esc(r.cd)} · ${fmtDateFull(r.created_at)} a ${fmtDateFull(r.closed_at)} · V${r.theme_version}</div></div>
        <div class="flex-gap"><span class="badge badge-blue">${res.length} resposta${res.length !== 1 ? 's' : ''}</span>
        ${avg ? `<span class="badge badge-green">Média ${avg.toFixed(1)}</span>` : ''}</div></div>
    </div>`;
  }).join('') : noData('Nenhuma rodada encerrada ainda.');
}
async function createRound(cd) {
  const ver = currentVersion();
  const rec = await DB.insert('survey_rounds', {
    cd, title: `Pesquisa ${quarterLabel(Date.now())}`, status: 'open',
    ends_at: Date.now() + 90 * DAY, closed_at: null, theme_version: ver ? ver.version : 1,
  });
  M.survey_rounds.push(rec);
  renderRounds(); renderHome();
  toast('Rodada de pesquisa aberta por 90 dias!', 'green');
}
function closeRound(id) {
  confirmAction('Encerrar rodada', 'A pesquisa deixará de aceitar respostas. Os resultados ficam preservados no histórico.', async () => {
    await DB.update('survey_rounds', id, { status: 'closed', closed_at: Date.now() });
    Object.assign(byId(M.survey_rounds, id), { status: 'closed', closed_at: Date.now() });
    renderRounds(); renderHome();
    toast('Rodada encerrada.', 'green');
  });
}

/* ══════════ QR CODES ══════════ */
function baseUrl() {
  return (M.settings.base_url || '').trim() || location.href.split('?')[0].split('#')[0];
}
async function saveBaseUrl() {
  M.settings.base_url = $('qr-base-url').value.trim();
  await DB.update('app_settings', 'app', { base_url: M.settings.base_url });
  renderQrList();
}
async function saveLogoUrl() {
  M.settings.logo_url = $('qr-logo-url').value.trim();
  try { await DB.update('app_settings', 'app', { logo_url: M.settings.logo_url }); }
  catch (e) { /* coluna pode não existir ainda — o cartaz usa o texto padrão */ }
}
function qrUrlFor(q) {
  let u = baseUrl();
  if (!u.endsWith('/') && !u.endsWith('.html')) u += '/';
  const p = new URLSearchParams();
  p.set('cd', q.cd);
  if (q.purpose && q.purpose !== 'menu') p.set('acao', q.purpose);
  if (q.sector) p.set('setor', q.sector);
  return u + '?' + p.toString();
}
function renderQrTab() {
  $('qr-base-url').value = M.settings.base_url || '';
  $('qr-logo-url').value = M.settings.logo_url || '';
  fillSelect('qr-cd', scopeCds());
  renderQrList();
  renderFlyerEditor();
}
function renderQrList() {
  const list = M.qr_codes.filter(q => scopeCds().includes(q.cd));
  const hasFlyer = !!(M.settings.flyer_image);
  const PURPOSE = { menu: '📋 Menu completo', ponto: '⚡ Ponto de atenção', pesquisa: '📝 Pesquisa', voto: '🗳️ Votação' };
  $('qr-list').innerHTML = list.length ? list.map(q => {
    const url = qrUrlFor(q);
    let svg = '';
    try { svg = QRCode.toSVG(url, { size: 168 }); }
    catch (e) { svg = '<div style="padding:2rem;color:var(--red);font-size:12px">URL muito longa</div>'; }
    return `<div class="qr-card">
      <button class="btn-icon del qr-del" onclick="removeQr('${q.id}')">🗑</button>
      <div class="qr-card-label">${esc(q.label)}</div>
      <div class="qr-card-meta">${esc(q.cd)}${q.sector ? ' · ' + esc(q.sector) : ''}<br>${PURPOSE[q.purpose] || q.purpose}</div>
      <div class="qr-img" id="qrimg-${q.id}">${svg}</div>
      <div class="qr-url">${esc(url)}</div>
      <div class="qr-actions">
        <button class="btn-ghost" onclick="downloadQr('${q.id}')">⬇️ PNG</button>
        <button class="btn-ghost" onclick="printQr('${q.id}')">🖨️ Padrão</button>
        ${hasFlyer ? `<button class="btn-ghost" onclick="printFlyer('${q.id}')">🖼️ Arte</button>
        <button class="btn-ghost" onclick="downloadFlyer('${q.id}')">⬇️ Arte PNG</button>` : ''}
      </div></div>`;
  }).join('') : emptyBox('📱', 'Nenhum QR Code criado', 'Clique em "+ Novo QR Code" para gerar o primeiro.');
}
function openQrModal() {
  fillSelect('qr-cd', scopeCds());
  $('qr-label').value = ''; $('qr-sector').value = ''; $('qr-purpose').value = 'menu';
  openModal('modal-qr');
}
async function submitQr() {
  const label = $('qr-label').value.trim();
  if (!label) { toast('Informe a identificação do cartaz.', 'orange'); return; }
  const rec = await DB.insert('qr_codes', {
    label, cd: $('qr-cd').value, purpose: $('qr-purpose').value, sector: $('qr-sector').value.trim(),
  });
  M.qr_codes.push(rec);
  closeModal('modal-qr'); renderQrList(); renderFlyerEditor();
  toast('QR Code gerado!', 'green');
}
async function removeQr(id) {
  await DB.remove('qr_codes', id);
  M.qr_codes = M.qr_codes.filter(q => q.id !== id);
  renderQrList();
}
function downloadQr(id) {
  const q = byId(M.qr_codes, id); if (!q) return;
  const cv = QRCode.toCanvas(qrUrlFor(q), { size: 900, margin: 4 });
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = 'qrcode-' + q.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png';
  a.click();
}
function printQr(id) {
  const q = byId(M.qr_codes, id); if (!q) return;
  const url = qrUrlFor(q);
  const svg = QRCode.toSVG(url, { size: 300, dark: '#0a2a6b' });
  const logo = (M.settings.logo_url || '').trim();

  const PURPOSE = {
    menu:     { call: 'FALA AÍ,<br>A GENTE ESCUTA!',        cta: 'ESCANEIE E PARTICIPE' },
    ponto:    { call: 'VIU ALGO<br>PARA MELHORAR?',          cta: 'ESCANEIE E REGISTRE' },
    pesquisa: { call: 'SUA OPINIÃO<br>IMPORTA!',             cta: 'ESCANEIE E RESPONDA' },
    voto:     { call: 'ESCOLHA QUEM<br>VAI TE REPRESENTAR!', cta: 'ESCANEIE E VOTE' },
  };
  const p = PURPOSE[q.purpose] || PURPOSE.menu;

  const BENEFITS = [
    { i: '💡', t: 'Compartilhe ideias, sugestões e melhorias' },
    { i: '👥', t: 'Ajuda a tornar nossa operação mais segura e ágil' },
    { i: '📈', t: 'Suas ideias viram ações que geram resultados reais' },
    { i: '🏆', t: 'Reconhecimento para quem contribui com o crescimento' },
  ];

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>${esc(q.label)}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; }

  .sheet {
    width: 210mm; height: 297mm; position: relative; overflow: hidden;
    background: #0d2f6b; color: #fff; display: flex; flex-direction: column;
  }
  /* ondas decorativas */
  .wave { position: absolute; border-radius: 50%; pointer-events: none; }
  .w1 { width: 340mm; height: 200mm; background: #10429b; top: -95mm; left: -70mm; }
  .w2 { width: 260mm; height: 150mm; background: rgba(255,255,255,.06); top: 118mm; left: -60mm; }

  /* topo */
  .top { position: relative; padding: 9mm 14mm 0; text-align: center; }
  .brand { font-size: 17pt; font-weight: 800; letter-spacing: 3px; }
  .brand small { display: block; font-size: 8pt; letter-spacing: 5px; opacity: .8; font-weight: 600; margin-top: 1mm; }
  .brand img { max-height: 15mm; max-width: 55mm; }

  .title { margin-top: 5mm; line-height: .82; }
  .title .l1 { font-size: 50pt; font-weight: 900; letter-spacing: -2px; }
  .title .l2 { font-size: 34pt; font-weight: 900; letter-spacing: -1px; }
  .title .l2 em { font-style: normal; font-size: 17pt; opacity: .85; margin-right: 3mm; }

  .tagline {
    margin-top: 4mm; font-size: 7pt; font-weight: 700;
    letter-spacing: 1.6px; opacity: .9; text-transform: uppercase;
  }

  /* balão de chamada */
  .bubble {
    position: relative; display: inline-block; margin-top: 5mm;
    background: #fff; color: #0d2f6b; border-radius: 8mm;
    padding: 4mm 10mm; font-size: 18pt; font-weight: 900; line-height: 1.05;
  }
  .bubble::after {
    content: ''; position: absolute; bottom: -4mm; left: 14mm;
    border-width: 4mm 4mm 0 0; border-style: solid; border-color: #fff transparent transparent transparent;
  }

  /* corpo branco */
  .body {
    position: relative; background: #fff; color: #0d2f6b;
    margin-top: 7mm; flex: 1; border-radius: 12mm 12mm 0 0;
    padding: 7mm 12mm 0; text-align: center;
  }
  .intro { font-size: 9.5pt; line-height: 1.45; max-width: 150mm; margin: 0 auto; }
  .intro b { color: #0b5fd4; }

  .sec-label {
    margin: 5.5mm 0 4mm; font-size: 9pt; font-weight: 900;
    letter-spacing: 1.2px; color: #0b5fd4;
  }
  .benefits { display: flex; gap: 5mm; justify-content: center; }
  .ben { flex: 1; }
  .ben .ic {
    width: 11.5mm; height: 11.5mm; margin: 0 auto 2mm; border-radius: 50%;
    background: #e8f0fc; display: flex; align-items: center; justify-content: center; font-size: 13pt;
  }
  .ben .tx { font-size: 7pt; line-height: 1.35; color: #2a4a7a; }

  /* bloco do QR */
  .qrbox {
    margin: 5.5mm auto 0; background: #0d2f6b; color: #fff;
    border-radius: 7mm; padding: 5mm 5mm 4.5mm; width: 100mm;
  }
  .qrbox .cta { font-size: 11pt; font-weight: 900; letter-spacing: .8px; margin-bottom: 3.5mm; }
  .qrframe { background: #fff; border-radius: 5mm; padding: 3mm; display: inline-block; line-height: 0; }
  .qrframe svg { width: 55mm; height: 55mm; display: block; }
  .qrhint { margin-top: 3mm; font-size: 7.5pt; opacity: .85; }
  .qrloc { margin-top: 2mm; font-size: 10.5pt; font-weight: 800; }

  /* rodapé */
  .closing {
    margin-top: 5mm; font-size: 15pt; font-weight: 900;
    line-height: 1.12; color: #0d2f6b;
  }
  .closing span { color: #0b5fd4; }
  .pills {
    margin-top: 4mm; padding: 3mm 0 4mm; border-top: .6mm solid #dce7f7;
    display: flex; justify-content: center; gap: 8mm;
    font-size: 7pt; font-weight: 800; letter-spacing: 1px; color: #7f9dc4;
  }
</style></head><body>
<div class="sheet">
  <div class="wave w1"></div>
  <div class="wave w2"></div>

  <div class="top">
    <div class="brand">
      ${logo ? `<img src="${esc(logo)}" alt="">` : `LACTALIS<small>BRASIL</small>`}
    </div>

    <div class="title">
      <div class="l1">VOZ</div>
      <div class="l2"><em>DA</em>OPERAÇÃO</div>
    </div>

    <div class="tagline">A sua voz transforma &nbsp;·&nbsp; A nossa operação evolui</div>

    <div class="bubble">${p.call}</div>
  </div>

  <div class="body">
    <div class="intro">
      O <b>Voz da Operação</b> é o canal que conecta você às mudanças
      que fazem a diferença todos os dias.
    </div>

    <div class="sec-label">QUANDO VOCÊ FALA, A GENTE AVANÇA</div>
    <div class="benefits">
      ${BENEFITS.map(b => `<div class="ben"><div class="ic">${b.i}</div><div class="tx">${b.t}</div></div>`).join('')}
    </div>

    <div class="qrbox">
      <div class="cta">${p.cta}</div>
      <div class="qrframe">${svg}</div>
      <div class="qrhint">Aponte a câmera do seu celular para o código</div>
      <div class="qrloc">${esc(q.cd)}${q.sector ? ' · ' + esc(q.sector) : ''}</div>
    </div>

    <div class="closing">SUA VOZ, <span>NOSSA FORÇA</span>,<br>GRANDES RESULTADOS!</div>

    <div class="pills">
      <span>SEGURANÇA</span><span>COLABORAÇÃO</span><span>AGILIDADE</span><span>RESULTADOS</span>
    </div>
  </div>
</div>
<script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
</body></html>`);
  w.document.close();
}

/* ══════════ CARTAZ PERSONALIZADO ══════════ */
/* A arte é reduzida no navegador antes de virar base64, para não
   pesar no banco. A posição do QR é guardada em porcentagem, então
   funciona igual em qualquer resolução de impressão. */

const FLYER_MAX_W = 1600;   // px — largura máxima salva
const FLYER_DEF   = { x: 50, y: 72, size: 22, box: true };

function flyerCfg() {
  const c = M.settings.flyer_config;
  const obj = (typeof c === 'string') ? (JSON.parse(c || '{}')) : (c || {});
  return Object.assign({}, FLYER_DEF, obj);
}

function onFlyerUpload(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('Envie um arquivo de imagem (JPG ou PNG).', 'orange'); return; }

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      const scale = Math.min(1, FLYER_MAX_W / img.naturalWidth);
      const cv = document.createElement('canvas');
      cv.width  = Math.round(img.naturalWidth  * scale);
      cv.height = Math.round(img.naturalHeight * scale);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);

      // JPEG comprime bem fotos; PNG preserva arte chapada com transparência
      const isPng = /png/i.test(file.type);
      const data = isPng ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);

      const kb = Math.round(data.length * 0.75 / 1024);
      if (kb > 3000) { toast('Arte muito pesada (' + kb + ' KB). Reduza a resolução e tente de novo.', 'orange'); return; }

      M.settings.flyer_image = data;
      if (!M.settings.flyer_config || !Object.keys(flyerCfg()).length) M.settings.flyer_config = FLYER_DEF;
      try {
        await DB.update('app_settings', 'app', { flyer_image: data });
      } catch (e) {
        toast('Rode o 08-flyer.sql no Supabase para salvar a arte.', 'orange');
      }
      renderFlyerEditor();
      renderQrList();
      toast('Arte enviada (' + kb + ' KB). Agora posicione o QR.', 'green');
    };
    img.onerror = () => toast('Não foi possível ler a imagem.', 'red');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function removeFlyer() {
  confirmAction('Remover arte', 'O cartaz personalizado será apagado e os QR Codes voltam a usar o cartaz padrão do sistema.', async () => {
    M.settings.flyer_image = '';
    try { await DB.update('app_settings', 'app', { flyer_image: '' }); } catch (e) {}
    renderFlyerEditor(); renderQrList();
    toast('Arte removida.', 'orange');
  });
}

function renderFlyerEditor() {
  const has = !!(M.settings.flyer_image);
  $('flyer-empty').classList.toggle('hidden', has);
  $('flyer-editor').classList.toggle('hidden', !has);
  $('flyer-remove').classList.toggle('hidden', !has);
  if (!has) return;

  const cfg = flyerCfg();
  $('flyer-img').src = M.settings.flyer_image;
  $('flyer-size').value = cfg.size;
  $('flyer-size-val').textContent = cfg.size;
  $('flyer-box').checked = cfg.box !== false;

  const list = M.qr_codes.filter(q => scopeCds().includes(q.cd));
  fillSelect('flyer-preview-qr', list.length
    ? list.map(q => ({ value: q.id, label: q.label + ' — ' + q.cd }))
    : [{ value: '', label: 'Crie um QR Code primeiro' }]);

  updateFlyerQr();
  enableFlyerDrag();
}

function updateFlyerQr() {
  const cfg = flyerCfg();
  const size = +$('flyer-size').value;
  const box  = $('flyer-box').checked;
  $('flyer-size-val').textContent = size;

  const el = $('flyer-qr');
  el.style.width = size + '%';
  el.style.left  = cfg.x + '%';
  el.style.top   = cfg.y + '%';
  el.style.transform = 'translate(-50%, -50%)';
  el.classList.toggle('boxed', box);

  const qid = $('flyer-preview-qr').value;
  const q = byId(M.qr_codes, qid);
  const url = q ? qrUrlFor(q) : (baseUrl() || 'https://exemplo.com');
  try {
    el.innerHTML = QRCode.toSVG(url, { size: 400, dark: '#0a2a6b' });
  } catch (e) { el.innerHTML = ''; }

  // mantém proporção quadrada
  requestAnimationFrame(() => { el.style.height = el.offsetWidth + 'px'; });
}

function enableFlyerDrag() {
  const stage = $('flyer-stage'), el = $('flyer-qr');
  if (el._dragReady) return;
  el._dragReady = true;

  const move = (clientX, clientY) => {
    const r = stage.getBoundingClientRect();
    let x = ((clientX - r.left) / r.width) * 100;
    let y = ((clientY - r.top) / r.height) * 100;
    x = Math.max(6, Math.min(94, x));
    y = Math.max(6, Math.min(94, y));
    el.style.left = x + '%';
    el.style.top  = y + '%';
    const cfg = flyerCfg();
    M.settings.flyer_config = { x: +x.toFixed(1), y: +y.toFixed(1), size: cfg.size, box: cfg.box };
  };

  const start = e => {
    e.preventDefault();
    el.classList.add('dragging');
    const onMove = ev => {
      const t = ev.touches ? ev.touches[0] : ev;
      move(t.clientX, t.clientY);
    };
    const onUp = () => {
      el.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  };
  el.addEventListener('mousedown', start);
  el.addEventListener('touchstart', start, { passive: false });
}

async function saveFlyer() {
  const cur = flyerCfg();
  const cfg = {
    x: cur.x, y: cur.y,
    size: +$('flyer-size').value,
    box: $('flyer-box').checked,
  };
  M.settings.flyer_config = cfg;
  try {
    await DB.update('app_settings', 'app', { flyer_config: cfg });
    toast('Posição salva! Todos os cartazes usam esta configuração.', 'green');
  } catch (e) {
    toast('Rode o 08-flyer.sql no Supabase para salvar.', 'orange');
  }
  renderQrList();
}

/* ---- Composição final: arte + QR ---- */
function composeFlyer(qrId) {
  return new Promise((resolve, reject) => {
    const q = byId(M.qr_codes, qrId);
    if (!q || !M.settings.flyer_image) return reject(new Error('Sem arte definida.'));
    const cfg = flyerCfg();

    const art = new Image();
    art.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = art.naturalWidth; cv.height = art.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(art, 0, 0);

      const qrPx = Math.round(cv.width * (cfg.size / 100));
      const cx   = cv.width  * (cfg.x / 100);
      const cy   = cv.height * (cfg.y / 100);
      const pad  = cfg.box !== false ? Math.round(qrPx * 0.055) : 0;
      const boxPx = qrPx + pad * 2;
      const bx = Math.round(cx - boxPx / 2);
      const by = Math.round(cy - boxPx / 2);

      if (cfg.box !== false) {
        const r = Math.round(boxPx * 0.06);
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,.28)';
        ctx.shadowBlur = Math.round(boxPx * 0.05);
        ctx.shadowOffsetY = Math.round(boxPx * 0.015);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, boxPx, boxPx, r);
        else ctx.rect(bx, by, boxPx, boxPx);
        ctx.fill();
        ctx.restore();
      }

      const qrCv = QRCode.toCanvas(qrUrlFor(q), { size: qrPx * 2, margin: 1, dark: '#0a2a6b' });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(qrCv, bx + pad, by + pad, qrPx, qrPx);

      resolve(cv);
    };
    art.onerror = () => reject(new Error('Não foi possível carregar a arte.'));
    art.src = M.settings.flyer_image;
  });
}

async function downloadFlyer(qrId) {
  try {
    const cv = await composeFlyer(qrId);
    const q = byId(M.qr_codes, qrId);
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = 'cartaz-' + q.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png';
    a.click();
    toast('Cartaz baixado!', 'green');
  } catch (e) { toast(e.message, 'red'); }
}

async function printFlyer(qrId) {
  try {
    const cv = await composeFlyer(qrId);
    const q = byId(M.qr_codes, qrId);
    const img = cv.toDataURL('image/png');
    const vertical = cv.height >= cv.width;
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
      <title>${esc(q.label)}</title><style>
      @page { size: A4 ${vertical ? 'portrait' : 'landscape'}; margin: 0; }
      *{margin:0;padding:0;box-sizing:border-box}
      html,body{width:100%;height:100%}
      body{display:flex;align-items:center;justify-content:center;background:#fff}
      img{max-width:100%;max-height:100%;display:block}
      </style></head><body><img src="${img}">
      <script>window.onload=()=>setTimeout(()=>window.print(),600)<\/script>
      </body></html>`);
    w.document.close();
  } catch (e) { toast(e.message, 'red'); }
}

/* ══════════ CONFIGURAÇÕES ══════════ */
function renderConfig() {
  renderCfgUsers(); renderCfgEmployees(); renderCfgEmails();
  renderCfgLogThemes(); renderCfgSurvThemes(); renderVersionHistory();
}

/* -- gestores -- */
function renderCfgUsers() {
  $('cfg-users-list').innerHTML = M.profiles.map(u => `
    <div class="list-item">
      <div class="list-avatar ${u.role}">${esc(initials(u.name))}</div>
      <div class="list-body">
        <div class="list-name">${esc(u.name)}
          <span class="badge ${u.role === 'admin' ? 'badge-gray' : u.role === 'gerente' ? 'badge-purple' : u.role === 'coordenador' ? 'badge-blue' : 'badge-green'}">${ROLE_LABEL[u.role]}</span></div>
        <div class="list-meta">Matrícula ${esc(u.matricula)} · ${esc(u.cd)} · ${esc(u.email || 'sem e-mail')}</div>
      </div>
      <button class="btn-icon" onclick="openUserModal('${u.id}')">✏️</button>
      ${u.id !== 'u0' ? `<button class="btn-icon del" onclick="removeUser('${u.id}')">🗑</button>` : ''}
    </div>`).join('');
}
function openUserModal(id) {
  S._editUser = id || null;
  const u = id ? byId(M.profiles, id) : null;
  $('modal-user-title').innerHTML = (u ? '✏️ Editar Gestor' : '👤 Novo Gestor') +
    ' <button class="modal-close" onclick="closeModal(\'modal-user\')">✕</button>';
  fillSelect('usr-cd', [{ value: 'TODOS', label: 'Todos os CDs' }, ...CDS.map(c => ({ value: c, label: c }))], u ? u.cd : CDS[0]);
  $('usr-name').value = u ? u.name : '';
  $('usr-matricula').value = u ? u.matricula : '';
  $('usr-pass').value = u ? (DB.online ? '' : (u.password || '')) : '';
  $('usr-pass').placeholder = u && DB.online ? 'deixe em branco para manter' : 'Senha de acesso';
  $('usr-role').value = u ? u.role : 'supervisor';
  $('usr-email').value = u ? (u.email || '') : '';
  openModal('modal-user');
}
async function submitUser() {
  const name = $('usr-name').value.trim(), mat = $('usr-matricula').value.trim(), pass = $('usr-pass').value.trim();
  const role = $('usr-role').value, cd = $('usr-cd').value, email = $('usr-email').value.trim();
  if (!name || !mat) { toast('Nome e matrícula são obrigatórios.', 'orange'); return; }
  if (!S._editUser && !pass) { toast('Defina uma senha para o novo gestor.', 'orange'); return; }
  if (M.profiles.some(u => u.matricula === mat && u.id !== S._editUser)) { toast('Já existe gestor com esta matrícula.', 'orange'); return; }
  try {
    if (S._editUser) {
      const patch = { name, matricula: mat, role, cd, email };
      if (DB.online) {
        await DB.update('profiles', S._editUser, patch);
        const orig = byId(M.profiles, S._editUser);
        if (pass && pass !== '••••••') {
          await DB.rpc('set_staff_password', { p_profile: S._editUser, p_password: pass });
        }
        Object.assign(orig, patch);
      } else {
        patch.password = pass;
        await DB.update('profiles', S._editUser, patch);
        Object.assign(byId(M.profiles, S._editUser), patch);
      }
      toast('Gestor atualizado!', 'green');
    } else {
      if (DB.online) {
        await DB.rpc('create_staff', {
          p_matricula: mat, p_name: name, p_password: pass,
          p_role: role, p_cd: cd, p_email: email,
        });
        M.profiles = await DB.select('profiles');
      } else {
        const rec = await DB.insert('profiles', { name, matricula: mat, password: pass, role, cd, email, active: true });
        M.profiles.push(rec);
      }
      toast('Gestor cadastrado!', 'green');
    }
  } catch (e) { toast(e.message, 'red'); return; }
  closeModal('modal-user'); renderCfgUsers(); renderCfgLogThemes();
}
function removeUser(id) {
  if (id === 'u0') { toast('O administrador principal não pode ser removido.', 'orange'); return; }
  if (S.user && S.user.id === id) { toast('Você não pode remover o próprio usuário.', 'orange'); return; }
  const u = byId(M.profiles, id);
  confirmAction('Remover gestor', `Remover ${u.name}? Os temas sob responsabilidade dele ficarão sem supervisor.`, async () => {
    try {
      if (DB.online) await DB.rpc('delete_staff', { p_profile: id });
      else await DB.remove('profiles', id);
    } catch (e) { toast(e.message, 'red'); return; }
    M.profiles = M.profiles.filter(x => x.id !== id);
    for (const t of M.log_themes.filter(t => t.supervisor_id === id)) {
      await DB.update('log_themes', t.id, { supervisor_id: null });
      t.supervisor_id = null;
    }
    renderCfgUsers(); renderCfgLogThemes();
    toast('Gestor removido.', 'orange');
  });
}

/* -- colaboradores -- */
function renderCfgEmployees() {
  const q = ($('emp-search').value || '').toLowerCase().trim();
  let list = M.employees.filter(e => scopeCds().includes(e.cd));
  if (q) list = list.filter(e => e.matricula.toLowerCase().includes(q) || e.name.toLowerCase().includes(q));
  list.sort((a, b) => a.cd.localeCompare(b.cd) || a.name.localeCompare(b.name));
  const total = M.employees.filter(e => scopeCds().includes(e.cd)).length;
  $('cfg-emp-list').innerHTML = list.length
    ? `<div class="text-muted mb-1">${list.length} de ${total} colaborador${total !== 1 ? 'es' : ''}</div>
       <div class="scroll-list">${list.map(e => `
        <div class="list-item">
          <div class="list-avatar emp">${esc(initials(e.name))}</div>
          <div class="list-body"><div class="list-name">${esc(e.name)}
            <span class="cd-tag">${esc(e.cd.replace('CD ', ''))}</span></div>
            <div class="list-meta">Matrícula ${esc(e.matricula)} · ${esc(e.job_title || 'sem função')} · ${esc(e.shift)} · ${esc(e.sector)}${e.admission_date ? ' · desde ' + fmtDateISO(e.admission_date) : ''}</div></div>
          <button class="btn-icon" onclick="openEmpModal('${e.id}')">✏️</button>
          <button class="btn-icon del" onclick="removeEmp('${e.id}')">🗑</button>
        </div>`).join('')}</div>`
    : emptyBox('🧑‍🏭', 'Nenhum colaborador encontrado', 'Cadastre ou importe a lista de colaboradores ativos.');
}
function openEmpModal(id) {
  S._editEmp = id || null;
  const e = id ? byId(M.employees, id) : null;
  $('modal-emp-title').innerHTML = (e ? '✏️ Editar Colaborador' : '🧑‍🏭 Novo Colaborador') +
    ' <button class="modal-close" onclick="closeModal(\'modal-emp\')">✕</button>';
  fillSelect('emp-cd', scopeCds(), e ? e.cd : scopeCds()[0]);
  $('emp-matricula').value = e ? e.matricula : '';
  $('emp-name').value = e ? e.name : '';
  $('emp-shift').value = e ? e.shift : SHIFTS[0];
  $('emp-sector').value = e ? e.sector : '';
  $('emp-job').value = e ? (e.job_title || '') : '';
  $('emp-admission').value = e ? (e.admission_date || '') : '';
  openModal('modal-emp');
}
async function submitEmp() {
  const mat = $('emp-matricula').value.trim(), name = $('emp-name').value.trim();
  const cd = $('emp-cd').value, shift = $('emp-shift').value, sector = $('emp-sector').value.trim();
  const job = $('emp-job').value.trim(), adm = $('emp-admission').value;
  if (!mat || !name) { toast('Matrícula e nome são obrigatórios.', 'orange'); return; }
  if (M.employees.some(e => e.matricula === mat && e.id !== S._editEmp)) { toast('Já existe colaborador com esta matrícula.', 'orange'); return; }
  if (S._editEmp) {
    const patch = { matricula: mat, name, cd, shift, sector, job_title: job, admission_date: adm };
    await DB.update('employees', S._editEmp, patch);
    Object.assign(byId(M.employees, S._editEmp), patch);
    toast('Colaborador atualizado!', 'green');
  } else {
    const rec = await DB.insert('employees', { matricula: mat, name, cd, shift, sector, job_title: job, admission_date: adm, active: true });
    M.employees.push(rec);
    toast('Colaborador cadastrado!', 'green');
  }
  closeModal('modal-emp'); renderCfgEmployees();
}
function removeEmp(id) {
  const e = byId(M.employees, id);
  confirmAction('Remover colaborador', `Remover ${e.name}? Ele deixará de poder votar e registrar pontos.`, async () => {
    await DB.remove('employees', id);
    M.employees = M.employees.filter(x => x.id !== id);
    renderCfgEmployees();
    toast('Colaborador removido.', 'orange');
  });
}
function openImportModal() {
  fillSelect('import-cd', scopeCds());
  $('import-text').value = '';
  $('import-preview').classList.add('hidden');
  $('import-btn').disabled = true;
  S._importRows = [];
  openModal('modal-import');
}

/* Normaliza data: aceita 10/05/2021, 10-05-2021, 2021-05-10 e serial do Excel */
function parseAdmission(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (+y > 50 ? '19' : '20') + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // serial do Excel (dias desde 30/12/1899)
  if (/^\d{5}$/.test(t)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + (+t) * 86400000);
    return dt.toISOString().slice(0, 10);
  }
  return '';
}

/* Normaliza turno: 1, 1º, 1o, "primeiro", "turno 1" → "1º Turno" */
function parseShift(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return SHIFTS[0];
  if (/1|prim/.test(t)) return '1º Turno';
  if (/2|seg/.test(t))  return '2º Turno';
  if (/3|ter/.test(t))  return '3º Turno';
  return SHIFTS[0];
}

function splitLine(line) {
  // Excel copiado usa TAB; texto digitado costuma usar ; ou ,
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(';'))  return line.split(';');
  if (line.includes(','))  return line.split(',');
  return [line];
}

function analyzeImport() {
  const raw = $('import-text').value;
  const cd  = $('import-cd').value;
  const box = $('import-preview'), btn = $('import-btn');

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) { box.classList.add('hidden'); btn.disabled = true; S._importRows = []; return; }

  const rows = [];
  const seen = new Set();

  lines.forEach((line, idx) => {
    const p = splitLine(line).map(x => x.trim().replace(/^["']|["']$/g, ''));
    const mat = (p[0] || '').replace(/\s+/g, '');
    const nome = p[1] || '';

    // cabeçalho: primeira linha sem matrícula numérica e com palavra conhecida
    if (idx === 0 && /matr|nome|colaborador/i.test(line) && !/^\d/.test(mat)) return;

    let status = 'ok', motivo = '';
    if (!mat || !nome) { status = 'err'; motivo = 'faltou matrícula ou nome'; }
    else if (seen.has(mat)) { status = 'err'; motivo = 'repetida na lista'; }
    else if (M.employees.some(e => e.matricula === mat)) { status = 'dup'; motivo = 'já cadastrada'; }

    if (mat) seen.add(mat);
    rows.push({
      matricula: mat, name: nome,
      shift: parseShift(p[2]), sector: (p[3] || '').trim(),
      job_title: (p[4] || '').trim(), admission_date: parseAdmission(p[5]),
      cd, status, motivo,
    });
  });

  S._importRows = rows;
  const nOk  = rows.filter(r => r.status === 'ok').length;
  const nDup = rows.filter(r => r.status === 'dup').length;
  const nErr = rows.filter(r => r.status === 'err').length;

  $('import-stats').innerHTML =
    `<span class="import-stat ok">✓ ${nOk} para importar</span>` +
    (nDup ? `<span class="import-stat dup">↺ ${nDup} já cadastrada${nDup > 1 ? 's' : ''}</span>` : '') +
    (nErr ? `<span class="import-stat err">✕ ${nErr} com problema</span>` : '');

  $('import-tbody').innerHTML = rows.slice(0, 200).map(r => `
    <tr class="${r.status}">
      <td><strong>${esc(r.matricula || '—')}</strong></td>
      <td>${esc(r.name || '—')}</td>
      <td style="font-size:12px">${esc(r.shift)}</td>
      <td style="font-size:12px">${esc(r.sector || '—')}</td>
      <td style="font-size:12px">${esc(r.job_title || '—')}</td>
      <td style="font-size:12px;white-space:nowrap">${r.admission_date ? fmtDateISO(r.admission_date) : '—'}</td>
      <td><span class="row-tag ${r.status}">${r.status === 'ok' ? 'novo' : r.status === 'dup' ? 'existe' : esc(r.motivo)}</span></td>
    </tr>`).join('') +
    (rows.length > 200 ? `<tr><td colspan="7" class="text-muted" style="text-align:center">…e mais ${rows.length - 200} linha(s)</td></tr>` : '');

  box.classList.remove('hidden');
  btn.disabled = nOk === 0;
  btn.textContent = nOk ? `✅ Importar ${nOk} colaborador${nOk > 1 ? 'es' : ''}` : '✅ Importar';
}

async function submitImport() {
  const rows = (S._importRows || []).filter(r => r.status === 'ok');
  if (!rows.length) { toast('Nenhuma linha válida para importar.', 'orange'); return; }
  const btn = $('import-btn');
  btn.disabled = true; btn.textContent = 'Importando...';

  let ok = 0, falhou = 0;
  for (const r of rows) {
    try {
      const rec = await DB.insert('employees', {
        matricula: r.matricula, name: r.name, cd: r.cd,
        shift: r.shift, sector: r.sector || '—',
        job_title: r.job_title, admission_date: r.admission_date || null,
        active: true,
      });
      M.employees.push(rec); ok++;
    } catch (e) { falhou++; }
  }

  closeModal('modal-import');
  renderCfgEmployees();
  toast(`${ok} colaborador${ok > 1 ? 'es' : ''} importado${ok > 1 ? 's' : ''}` +
        (falhou ? ` · ${falhou} falhou(ram)` : ''), ok ? 'green' : 'red');
}

/* -- e-mails -- */
function renderCfgEmails() {
  const list = M.notify_emails.filter(e => scopeCds().includes(e.cd) || e.cd === 'TODOS');
  $('cfg-emails-list').innerHTML = list.length ? list.map(e => `
    <div class="email-row">
      <div class="email-info"><div class="email-addr">${esc(e.address)}</div>
        <div class="email-name">${esc(e.name)} · ${esc(e.cd)}</div></div>
      <div class="email-events">
        <span class="evt-chip new ${e.on_new ? 'on' : ''}"      onclick="toggleEvt('${e.id}','on_new')">📌 Novo</span>
        <span class="evt-chip warn ${e.on_warning ? 'on' : ''}" onclick="toggleEvt('${e.id}','on_warning')">⏰ 12h</span>
        <span class="evt-chip exp ${e.on_expired ? 'on' : ''}"  onclick="toggleEvt('${e.id}','on_expired')">🚨 Vencido</span>
      </div>
      <button class="btn-icon del" onclick="removeEmail('${e.id}')">🗑</button>
    </div>`).join('') : noData('Nenhum destinatário cadastrado.');
}
function openEmailModal() {
  fillSelect('eml-cd', [{ value: 'TODOS', label: 'Todos os CDs' }, ...scopeCds().map(c => ({ value: c, label: c }))]);
  $('eml-name').value = ''; $('eml-addr').value = '';
  ['eml-new', 'eml-warn', 'eml-exp'].forEach(i => $(i).checked = true);
  openModal('modal-email');
}
async function submitEmail() {
  const name = $('eml-name').value.trim(), addr = $('eml-addr').value.trim();
  if (!name || !addr) { toast('Preencha nome e e-mail.', 'orange'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { toast('E-mail inválido.', 'orange'); return; }
  const rec = await DB.insert('notify_emails', {
    name, address: addr, cd: $('eml-cd').value,
    on_new: $('eml-new').checked, on_warning: $('eml-warn').checked, on_expired: $('eml-exp').checked,
  });
  M.notify_emails.push(rec);
  closeModal('modal-email'); renderCfgEmails();
  toast('Destinatário adicionado!', 'green');
}
async function toggleEvt(id, field) {
  const e = byId(M.notify_emails, id); if (!e) return;
  e[field] = !e[field];
  await DB.update('notify_emails', id, { [field]: e[field] });
  renderCfgEmails();
}
async function removeEmail(id) {
  await DB.remove('notify_emails', id);
  M.notify_emails = M.notify_emails.filter(e => e.id !== id);
  renderCfgEmails();
}

/* -- temas logística -- */
function renderCfgLogThemes() {
  if (!S.draftLogThemes) S.draftLogThemes = JSON.parse(JSON.stringify(M.log_themes));
  const sups = M.profiles.filter(u => u.role === 'supervisor' || u.role === 'admin');
  $('cfg-log-themes').innerHTML = S.draftLogThemes.map((t, i) => `
    <div class="theme-editor-item"><div class="theme-editor-header">
      <input class="theme-editor-icon-input" value="${esc(t.icon)}" maxlength="2" oninput="S.draftLogThemes[${i}].icon=this.value">
      <input class="theme-editor-name-input" value="${esc(t.label)}" oninput="S.draftLogThemes[${i}].label=this.value">
      <span class="cd-tag">${esc(t.cd.replace('CD ', ''))}</span>
      <select class="sup-select" onchange="S.draftLogThemes[${i}].supervisor_id=this.value||null">
        <option value="">— sem supervisor —</option>
        ${sups.map(u => `<option value="${u.id}" ${t.supervisor_id === u.id ? 'selected' : ''}>👤 ${esc(u.name)}</option>`).join('')}
      </select>
      <button class="btn-icon del" onclick="removeLogTheme(${i})">🗑</button>
    </div></div>`).join('') || noData('Nenhum tema cadastrado.');
}
function addLogTheme() {
  if (!S.draftLogThemes) S.draftLogThemes = JSON.parse(JSON.stringify(M.log_themes));
  const sup = M.profiles.find(u => u.role === 'supervisor');
  S.draftLogThemes.push({ id: 'new_' + Date.now(), label: 'Novo Tema', icon: '📌', cd: scopeCds()[0], supervisor_id: sup ? sup.id : null, active: true });
  renderCfgLogThemes();
  toast('Tema adicionado. Clique em Salvar para confirmar.', 'blue');
}
function removeLogTheme(i) {
  S.draftLogThemes.splice(i, 1);
  renderCfgLogThemes();
}
async function saveLogThemes() {
  await DB.replaceAll('log_themes', S.draftLogThemes.map(t => ({ ...t, id: t.id.startsWith('new_') ? 't_' + Math.random().toString(36).slice(2, 9) : t.id })));
  M.log_themes = await DB.select('log_themes');
  S.draftLogThemes = null;
  renderCfgLogThemes(); renderLogDash();
  toast('Temas salvos com sucesso!', 'green');
}

/* -- temas pesquisa -- */
function renderCfgSurvThemes() {
  const ver = currentVersion();
  if (!S.draftSurvThemes) S.draftSurvThemes = JSON.parse(JSON.stringify(ver ? ver.themes : []));
  $('cfg-surv-themes').innerHTML = S.draftSurvThemes.map((t, ti) => `
    <div class="theme-editor-item">
      <div class="theme-editor-header clickable" onclick="toggleBody('sv-${ti}',this)">
        <input class="theme-editor-icon-input" value="${esc(t.icon)}" maxlength="2" onclick="event.stopPropagation()" oninput="S.draftSurvThemes[${ti}].icon=this.value">
        <input class="theme-editor-name-input" value="${esc(t.label)}" onclick="event.stopPropagation()" oninput="S.draftSurvThemes[${ti}].label=this.value">
        <span style="font-size:11px;color:var(--text3)">${(t.questions || []).length} pergunta${(t.questions || []).length !== 1 ? 's' : ''}</span>
        <button class="btn-icon del" onclick="event.stopPropagation();removeSurvTheme(${ti})">🗑</button>
        <span class="theme-editor-toggle">▾</span>
      </div>
      <div class="theme-editor-body" id="sv-${ti}">
        ${(t.questions || []).map((q, qi) => `
          <div class="question-editor-row">
            <span class="qe-num">${qi + 1}.</span>
            <input value="${esc(q)}" oninput="S.draftSurvThemes[${ti}].questions[${qi}]=this.value" placeholder="Digite a pergunta...">
            <button class="btn-icon del" onclick="removeSurvQuestion(${ti},${qi})">🗑</button>
          </div>`).join('')}
        <button class="btn-secondary" style="font-size:12px;padding:7px 14px;margin-top:6px" onclick="addSurvQuestion(${ti})">+ Adicionar Pergunta</button>
      </div>
    </div>`).join('') || noData('Nenhum tema cadastrado.');
}
function toggleBody(id, hdr) {
  const b = $(id); if (!b) return;
  b.classList.toggle('open');
  const a = hdr.querySelector('.theme-editor-toggle'); if (a) a.classList.toggle('open');
}
function addSurvTheme() {
  if (!S.draftSurvThemes) S.draftSurvThemes = JSON.parse(JSON.stringify(currentVersion().themes));
  S.draftSurvThemes.push({ id: 'st_' + Math.random().toString(36).slice(2, 9), label: 'Novo Tema', icon: '📌', questions: ['Digite a primeira pergunta'] });
  renderCfgSurvThemes();
  toast('Tema adicionado. Expanda para editar as perguntas.', 'blue');
}
function removeSurvTheme(i) {
  S.draftSurvThemes.splice(i, 1);
  renderCfgSurvThemes();
}
function addSurvQuestion(ti) {
  if (!S.draftSurvThemes[ti].questions) S.draftSurvThemes[ti].questions = [];
  S.draftSurvThemes[ti].questions.push('Nova pergunta');
  renderCfgSurvThemes();
  const b = $('sv-' + ti); if (b) b.classList.add('open');
}
function removeSurvQuestion(ti, qi) {
  if (S.draftSurvThemes[ti].questions.length <= 1) { toast('Cada tema precisa de ao menos uma pergunta.', 'orange'); return; }
  S.draftSurvThemes[ti].questions.splice(qi, 1);
  renderCfgSurvThemes();
  const b = $('sv-' + ti); if (b) b.classList.add('open');
}
async function saveSurvThemes() {
  if (!S.draftSurvThemes || !S.draftSurvThemes.length) { toast('Cadastre ao menos um tema.', 'orange'); return; }
  const last = M.survey_theme_versions[M.survey_theme_versions.length - 1];
  for (const v of M.survey_theme_versions) {
    if (v.is_current) { await DB.update('survey_theme_versions', v.id, { is_current: false }); v.is_current = false; }
  }
  const nq = S.draftSurvThemes.reduce((a, t) => a + (t.questions || []).length, 0);
  const rec = await DB.insert('survey_theme_versions', {
    version: (last ? last.version : 0) + 1,
    description: `${S.draftSurvThemes.length} tema${S.draftSurvThemes.length !== 1 ? 's' : ''} · ${nq} perguntas`,
    themes: JSON.parse(JSON.stringify(S.draftSurvThemes)), is_current: true,
  });
  M.survey_theme_versions.push(rec);
  S.draftSurvThemes = null;
  renderCfgSurvThemes(); renderVersionHistory(); renderSurvDash();
  toast('Nova versão criada! Respostas anteriores preservadas.', 'green');
}
function renderVersionHistory() {
  $('cfg-version-history').innerHTML = [...M.survey_theme_versions].sort((a, b) => b.version - a.version).map(v => {
    const n = M.survey_responses.filter(r => r.version === v.version).length;
    return `<div class="version-row ${v.is_current ? 'current' : ''}">
      <div class="version-num">${v.is_current ? '<span class="version-badge">Atual</span>' : 'V' + v.version}</div>
      <div class="version-date">${fmtDate(v.created_at)}</div>
      <div class="version-desc">${esc(v.description)} · <strong>${n}</strong> resposta${n !== 1 ? 's' : ''}</div>
      ${!v.is_current ? `<button class="btn-restore" onclick="restoreVersion(${v.version})">↩ Restaurar</button>`
        : '<span style="font-size:11px;color:var(--blue2);font-weight:700">✓ Em uso</span>'}</div>`;
  }).join('');
}
function restoreVersion(n) {
  confirmAction('Restaurar versão', `Restaurar a V${n} como versão ativa? A versão atual fica preservada no histórico.`, async () => {
    const v = M.survey_theme_versions.find(x => x.version === n); if (!v) return;
    S.draftSurvThemes = JSON.parse(JSON.stringify(v.themes));
    await saveSurvThemes();
    toast('Versão V' + n + ' restaurada!', 'green');
  });
}

/* ══════════ EXPORTAÇÃO ══════════ */
function exportCSV() {
  const rows = [['ID', 'CD', 'Tema', 'Assunto', 'Detalhe', 'Local', 'Criticidade', 'Prazo(h)', 'Supervisor',
    'Autor', 'Matrícula', 'Turno', 'Criado em', 'Status', 'Tratado em', 'Tratado por', 'Devolutiva', 'No prazo']];
  visibleOccurrences().sort((a, b) => b.created_at - a.created_at).forEach(o => {
    const t = byId(M.log_themes, o.theme_id) || { label: '—' };
    const c = CRIT[o.criticality] || {};
    const s = byId(M.profiles, o.supervisor_id);
    const onTime = o.status === 'done' ? (o.resolved_at - o.created_at <= o.sla_hours * H ? 'Sim' : 'Não') : '';
    rows.push([o.id, o.cd, t.label, o.title, o.description, o.location || '', c.label || '', o.sla_hours,
      s ? s.name : '', o.author_name, o.author_matricula, o.author_shift || '',
      new Date(o.created_at).toLocaleString('pt-BR'), o.status === 'done' ? 'Tratado' : 'Aberto',
      o.resolved_at ? new Date(o.resolved_at).toLocaleString('pt-BR') : '', o.resolved_by || '',
      o.resolution_note || '', onTime]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'voz-operacao-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  toast('CSV exportado!', 'green');
}

function exportPDF() {
  const l = visibleOccurrences();
  const cdLabel = S.dashCd === 'TODOS' ? 'Todos os CDs' : S.dashCd;
  const total = l.length, done = l.filter(o => o.status === 'done').length;
  const open = l.filter(o => o.status === 'open').length;
  const exp = l.filter(o => o.status === 'open' && remaining(o) <= 0).length;

  const ids = uniq(l.map(o => o.theme_id));
  const stats = ids.map(id => {
    const t = byId(M.log_themes, id) || { icon: '', label: '—' };
    const all = l.filter(o => o.theme_id === id);
    const d = all.filter(o => o.status === 'done').length;
    return { label: t.label, total: all.length, done: d, pct: all.length ? Math.round(d / all.length * 100) : 0 };
  }).sort((a, b) => b.total - a.total);

  const cds = dashCds();
  const res = M.survey_responses.filter(r => cds.includes(r.cd));
  const ver = currentVersion();
  const sStats = surveyStatsFor(res, ver ? ver.themes : []);

  const rowsHtml = l.sort((a, b) => b.created_at - a.created_at).slice(0, 120).map(o => {
    const t = byId(M.log_themes, o.theme_id) || { label: '—' };
    const c = CRIT[o.criticality] || {};
    const s = byId(M.profiles, o.supervisor_id);
    const st = o.status === 'done' ? 'Tratado' : (remaining(o) <= 0 ? 'VENCIDO' : 'Em aberto');
    return `<tr class="${st === 'VENCIDO' ? 'r-exp' : st === 'Tratado' ? 'r-ok' : ''}">
      <td>${esc(o.cd.replace('CD ', ''))}</td><td>${esc(t.label)}</td>
      <td><strong>${esc(o.title)}</strong><br><span class="dim">${esc(o.description)}</span></td>
      <td>${c.label || ''}<br><span class="dim">${o.sla_hours}h</span></td>
      <td>${esc(s ? s.name : '—')}</td>
      <td>${esc(o.author_name)}<br><span class="dim">${esc(o.author_matricula)}</span></td>
      <td>${fmtDate(o.created_at)}</td><td><strong>${st}</strong></td></tr>`;
  }).join('');

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>Relatório — Voz da Operação</title><style>
    @page{size:A4 landscape;margin:12mm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;color:#0d1f38;font-size:11px;padding:6mm}
    .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #04336b;padding-bottom:9px;margin-bottom:14px}
    h1{font-size:21px;color:#04336b}
    .sub{font-size:12px;color:#3a5572;margin-top:2px}
    .meta{font-size:10px;color:#7a93b0;text-align:right}
    h2{font-size:13px;color:#04336b;margin:16px 0 7px;padding-bottom:4px;border-bottom:1.5px solid #cddaee}
    .kpis{display:flex;gap:9px;flex-wrap:wrap}
    .kpi{border:1.5px solid #cddaee;border-radius:8px;padding:9px 14px;min-width:105px}
    .kpi .v{font-size:20px;font-weight:800;color:#0f5bbf;line-height:1}
    .kpi .l{font-size:9.5px;color:#7a93b0;margin-top:3px}
    .kpi.red .v{color:#c01c1c}.kpi.green .v{color:#0e7a45}
    table{width:100%;border-collapse:collapse;margin-top:7px}
    th{background:#e8f2fd;color:#04336b;font-size:9px;text-transform:uppercase;letter-spacing:.4px;padding:6px;text-align:left;border-bottom:1.5px solid #cddaee}
    td{padding:6px;border-bottom:1px solid #e4ecf7;vertical-align:top;font-size:10px}
    .dim{color:#7a93b0;font-size:9px}
    .r-exp{background:#fdeaea}.r-ok{background:#f4fcf8}
    .two{display:flex;gap:18px}.two>div{flex:1}
    .foot{margin-top:18px;padding-top:9px;border-top:1.5px solid #cddaee;font-size:9px;color:#7a93b0;text-align:center}
    </style></head><body>
    <div class="hd"><div><h1>🎙️ Voz da Operação</h1>
      <div class="sub">Relatório Gerencial · ${esc(cdLabel)}</div></div>
      <div class="meta">Emitido em ${new Date().toLocaleString('pt-BR')}<br>
      Por ${esc(S.user.name)} · ${ROLE_LABEL[S.user.role]}</div></div>

    <h2>Pontos de Atenção — Indicadores</h2>
    <div class="kpis">
      <div class="kpi"><div class="v">${total}</div><div class="l">Total</div></div>
      <div class="kpi"><div class="v">${open}</div><div class="l">Em aberto</div></div>
      <div class="kpi green"><div class="v">${done}</div><div class="l">Tratados</div></div>
      <div class="kpi red"><div class="v">${exp}</div><div class="l">Vencidos</div></div>
      <div class="kpi"><div class="v">${total ? Math.round(done / total * 100) : 0}%</div><div class="l">Resolução</div></div>
    </div>

    <div class="two">
      <div><h2>Ocorrências por tema</h2>
      <table><thead><tr><th>Tema</th><th>Total</th><th>Tratados</th><th>%</th></tr></thead><tbody>
      ${stats.length ? stats.map(s => `<tr><td>${esc(s.label)}</td><td>${s.total}</td><td>${s.done}</td><td><strong>${s.pct}%</strong></td></tr>`).join('')
        : '<tr><td colspan="4" class="dim">Sem dados</td></tr>'}
      </tbody></table></div>
      <div><h2>Pesquisa de clima</h2>
      <table><thead><tr><th>Tema</th><th>Média</th><th>Satisfação</th><th>Respostas</th></tr></thead><tbody>
      ${sStats.length ? sStats.map(s => `<tr><td>${esc(s.label)}</td><td><strong>${s.avg.toFixed(1)}</strong></td><td>${s.sat}%</td><td>${s.responders}</td></tr>`).join('')
        : '<tr><td colspan="4" class="dim">Nenhuma resposta registrada</td></tr>'}
      </tbody></table></div>
    </div>

    <h2>Detalhamento dos pontos de atenção${l.length > 120 ? ' (120 mais recentes)' : ''}</h2>
    <table><thead><tr><th>CD</th><th>Tema</th><th>Assunto</th><th>Criticidade</th><th>Supervisor</th><th>Registrado por</th><th>Data</th><th>Status</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="8" class="dim">Nenhum ponto registrado</td></tr>'}</tbody></table>

    <div class="foot">Voz da Operação · Lactalis Brasil — documento gerado automaticamente</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),500)<\/script>
    </body></html>`);
  w.document.close();
  toast('Use "Salvar como PDF" na janela de impressão.', 'blue');
}

/* ══════════ BACKUP ══════════ */
async function exportBackup() {
  const json = await DB.exportJSON();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'voz-operacao-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  toast('Backup baixado!', 'green');
}
function importBackup(ev) {
  if (DB.online) { toast('A restauração só está disponível no modo offline.', 'orange'); ev.target.value=''; return; }
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = async () => {
    try {
      await DB.importJSON(r.result);
      await loadAll();
      S.draftLogThemes = null; S.draftSurvThemes = null;
      renderHome(); if (S.user) { buildDashTabs(); renderDash(); }
      toast('Backup restaurado com sucesso!', 'green');
    } catch (e) { toast('Arquivo inválido.', 'red'); }
  };
  r.readAsText(f);
  ev.target.value = '';
}
function resetAll() {
  if (DB.online) { toast('No modo online, zere o banco reexecutando os scripts SQL no Supabase.', 'orange'); return; }
  confirmAction('Zerar sistema', 'TODOS os dados serão apagados e o sistema volta ao estado inicial. Faça um backup antes se precisar. Esta ação não pode ser desfeita.', async () => {
    await DB.reset();
    await loadAll();
    S.user = null; S.draftLogThemes = null; S.draftSurvThemes = null;
    doLogout();
    toast('Sistema zerado.', 'orange');
  });
}

/* ══════════ DEEP LINK (QR CODE) ══════════ */
function applyDeepLink() {
  const p = new URLSearchParams(location.search);
  const cd = p.get('cd'), acao = p.get('acao'), setor = p.get('setor');
  if (cd) {
    const match = CDS.find(c => c.toLowerCase().replace(/\s|cd/gi, '') === cd.toLowerCase().replace(/\s|cd/gi, ''));
    if (match) { S.cd = match; S.pontosCd = match; }
  }
  if (setor) S.qrSector = setor;
  if (acao && ['ponto', 'pesquisa', 'voto'].includes(acao)) {
    goPage('registrar');
    setTimeout(() => startCanal(acao), 80);
    return true;
  }
  return false;
}

/* ══════════ INIT ══════════ */
function paintConnLabel() {
  const el = $('nav-cd-label');
  if (!el) return;
  if (S.conn.error) {
    el.innerHTML = '<span style="color:#ffb4b4">⚠ sem conexão com o banco</span>';
  } else if (!S.conn.online) {
    el.innerHTML = '<span style="color:#ffd08a">● Modo local</span> <span style="opacity:.6">· ' + esc(S.cd) + '</span>';
  } else {
    el.innerHTML = '<span style="color:#8fe3b0">● Online</span> <span style="opacity:.6">· ' + esc(S.cd) + '</span>';
  }
}
function showConnectionState(online, err) {
  S.conn.online = online; S.conn.error = err || null;
  paintConnLabel();
  if (err) toast('Não foi possível conectar ao banco: ' + err, 'red');
}

(async function init() {
  let online = false, err = null;
  try {
    const r = await DB.ready();
    online = r.online;
  } catch (e) { err = e.message; }

  // Sessão de gestor ainda válida? Restaura direto no painel.
  if (online && DB.profile) {
    S.user = DB.profile;
    S.dashCd = S.user.cd === 'TODOS' ? 'TODOS' : S.user.cd;
  }

  try { await loadAll(); } catch (e) { err = err || e.message; }

  if (S.user) {
    $('gestor-login').classList.add('hidden');
    $('gestor-dash').classList.remove('hidden');
    $('nav-user').classList.remove('hidden');
    $('nav-user-av').textContent = initials(S.user.name);
    $('nav-user-nm').textContent = S.user.name.split(' ')[0];
    $('nav-user-rl').textContent = ROLE_LABEL[S.user.role];
    $('dash-user-info').textContent = `${S.user.name} · ${ROLE_LABEL[S.user.role]} · ${S.user.cd}`;
    buildDashTabs(); renderDash();
  }

  S.conn.online = online; S.conn.error = err || null;
  const jumped = applyDeepLink();
  if (!jumped) renderHome();
  showConnectionState(online, err);
  refreshBanner();
  setInterval(refreshBanner, 20000);
})();
