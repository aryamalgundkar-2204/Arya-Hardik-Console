/**
 * Personal Ledger — shared app logic.
 * Both consoles (index.html / hardik.html) load this same file.
 * Each HTML page sets PERSON, PERSON_LABEL, PARTNER_URL, PARTNER_LABEL
 * in an inline <script> before this file loads.
 *
 * >>> PASTE YOUR APPS SCRIPT WEB APP URL BELOW (ends in /exec) <<<
 */
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwJmnXKuPQNfDQdwlr8uilaOCc8ponCuQDt7ag9apz9RsgLxZeDTj4uZKqUNJBgFuPJ/exec';

const EXPENSE_CATEGORIES = [
  { key:'food',          label:'Food & Beverages',        type:'expense',    color:'#E8583F' },
  { key:'entertainment',  label:'Entertainment',           type:'expense',    color:'#8B6FE0' },
  { key:'office',         label:'Office Expense',          type:'receivable', color:'#D68A1F' },
  { key:'lending',        label:'Lending to Friends',      type:'receivable', color:'#A98A3E' },
  { key:'bills',          label:'Bills & Utilities',       type:'expense',    color:'#4A7FD4' },
  { key:'groceries',      label:'Groceries',               type:'expense',    color:'#2FA37A' },
  { key:'emergencies',    label:'Emergencies',             type:'expense',    color:'#C4507A' },
  { key:'selfcare',       label:'Self-care / Date Night',  type:'expense',    color:'#D95FA3' },
];
const INCOME_CATEGORIES = [
  { key:'salary',        label:'Salary',              color:'#2FA37A' },
  { key:'business',      label:'Business Payout',     color:'#4A7FD4' },
  { key:'interest',      label:'Interest / Savings',  color:'#8B6FE0' },
  { key:'other_income',  label:'Other Income',        color:'#8C9A92' },
];
const TRANSFER_COLOR = '#7A7D82';
const catByKey = k => EXPENSE_CATEGORIES.find(c => c.key === k) || INCOME_CATEGORIES.find(c => c.key === k);

let entries = [];
let accounts = [];
let goals = [];
let incomeSchedule = [];
let recurringExpenses = [];
let selectedMonth = monthKey(new Date());
let editingId = null;
let currentType = 'expense';
let settlingId = null;
let editingGoalId = null;
let editingIncomeId = null;
let editingRecurringId = null;

function monthKey(d){ return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); }
function monthLabel(mk){
  if(mk === 'all') return 'All Time';
  const [y,m] = mk.split('-');
  return new Date(y, m-1, 1).toLocaleString('en-IN', { month:'long', year:'numeric' });
}
function fmtINR(n){ return '₹' + Number(n||0).toLocaleString('en-IN', { minimumFractionDigits:0, maximumFractionDigits:2 }); }
function fmtDateShort(iso){
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function yesterdayISO(){ const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function accName(id){ const a = accounts.find(x=>x.id===id); return a ? a.name : '—'; }
function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

let toastTimer = null;
function showToast(msg, isError){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 3200 : 1400);
}

// ---------------- API layer ----------------
async function apiGet(params){
  const url = APPS_SCRIPT_URL + '?' + new URLSearchParams(params).toString();
  const res = await fetch(url);
  if(!res.ok) throw new Error('Network error: ' + res.status);
  const data = await res.json();
  if(!data.ok) throw new Error(data.error || 'Unknown API error');
  return data;
}
async function apiPost(body){
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error('Network error: ' + res.status);
  const data = await res.json();
  if(!data.ok) throw new Error(data.error || 'Unknown API error');
  return data.result;
}
async function withRetry(fn, attempts){
  attempts = attempts || 3;
  let lastErr;
  for(let i=0;i<attempts;i++){
    try{ return await fn(); }
    catch(e){ lastErr = e; if(i < attempts-1) await sleep(400*(i+1)); }
  }
  throw lastErr;
}

async function loadData(){
  const data = await withRetry(() => apiGet({ action:'getData', person:PERSON }));
  accounts = data.accounts;
  entries = data.entries;
  goals = data.goals || [];
  incomeSchedule = data.incomeSchedule || [];
  recurringExpenses = data.recurringExpenses || [];
}
async function ensureDefaultAccounts(){
  if(accounts.length === 0){
    const defaults = [
      { id:'acc_'+uid(), name:'Primary', openingBalance:0, isSavings:false },
      { id:'acc_'+uid(), name:'Savings', openingBalance:0, isSavings:true },
    ];
    await withRetry(() => apiPost({ action:'saveAccounts', person:PERSON, accounts:defaults }));
    accounts = defaults;
  }
}

function accountBalance(accId){
  const acc = accounts.find(a => a.id === accId);
  let bal = acc ? Number(acc.openingBalance) || 0 : 0;
  entries.forEach(e => {
    if(e.kind === 'income' && e.account === accId) bal += Number(e.amount);
    else if(e.kind === 'expense' && e.account === accId) bal -= Number(e.amount);
    else if(e.kind === 'transfer'){
      if(e.fromAccount === accId) bal -= Number(e.amount);
      if(e.toAccount === accId) bal += Number(e.amount);
    }
    if(e.kind === 'expense' && e.settled && e.settledAccount === accId) bal += Number(e.amount);
  });
  return bal;
}
function totalBalance(){ return accounts.reduce((s,a) => s + accountBalance(a.id), 0); }

function getMonthOptions(){
  const set = new Set(entries.map(e => e.date.slice(0,7)));
  set.add(monthKey(new Date()));
  return Array.from(set).sort().reverse();
}
function filteredEntries(){
  return entries
    .filter(e => selectedMonth === 'all' || e.date.slice(0,7) === selectedMonth)
    .sort((a,b) => b.date.localeCompare(a.date) || String(a.id).localeCompare(String(b.id)));
}

// ---------------- Forecasting helpers ----------------
function clampDay(year, month, day){
  const lastDay = new Date(year, month+1, 0).getDate();
  return Math.min(day, lastDay);
}
function nextOccurrence(dayOfMonth, fromDate){
  let year = fromDate.getFullYear(), month = fromDate.getMonth();
  let day = clampDay(year, month, dayOfMonth);
  let candidate = new Date(year, month, day);
  const today = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  if(candidate < today){
    month += 1;
    if(month > 11){ month = 0; year += 1; }
    day = clampDay(year, month, dayOfMonth);
    candidate = new Date(year, month, day);
  }
  return candidate;
}
function computeNextIncome(){
  const active = incomeSchedule.filter(s => s.active !== false);
  if(!active.length) return null;
  const today = new Date();
  let best = null;
  active.forEach(s => {
    const date = nextOccurrence(Number(s.dayOfMonth), today);
    if(!best || date < best.date) best = Object.assign({}, s, { date });
  });
  if(best){
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    best.daysAway = Math.round((best.date - todayMid) / 86400000);
  }
  return best;
}
function loggedThisMonth(recurringId){
  const mk = monthKey(new Date());
  return entries.some(e => e.recurringId === recurringId && e.date.slice(0,7) === mk);
}
function computeUpcomingRecurring(fromDate, toDate){
  return recurringExpenses
    .filter(r => r.active !== false && !loggedThisMonth(r.id))
    .map(r => Object.assign({}, r, { date: nextOccurrence(Number(r.dayOfMonth), fromDate) }))
    .filter(r => (!toDate || r.date <= toDate))
    .sort((a,b) => a.date - b.date);
}
function computeRunway(){
  const today = new Date(); today.setHours(0,0,0,0);
  const since = new Date(today); since.setDate(since.getDate()-29);
  const inRange = entries.filter(e => {
    if(e.kind !== 'expense') return false;
    const cat = catByKey(e.category);
    if(!cat || cat.type !== 'expense') return false;
    const d = new Date(e.date + 'T00:00:00');
    return d >= since && d <= today;
  });
  const recentSpend = inRange.reduce((s,e) => s + Number(e.amount), 0);
  let spanDays = 30;
  if(entries.length){
    const earliestDate = entries.reduce((min,e) => e.date < min ? e.date : min, todayISO());
    const earliest = new Date(earliestDate + 'T00:00:00');
    const diff = Math.max(1, Math.round((today - earliest) / 86400000) + 1);
    spanDays = Math.min(30, diff);
  }
  const dailyRate = spanDays > 0 ? recentSpend / spanDays : 0;
  const balance = totalBalance();
  const nextIncome = computeNextIncome();
  const upcomingRecurring = nextIncome ? computeUpcomingRecurring(today, nextIncome.date) : [];
  const knownUpcomingTotal = upcomingRecurring.reduce((s,r) => s + Number(r.amount), 0);
  let shortfall = false, projected = null;
  if(nextIncome){
    projected = balance - dailyRate * nextIncome.daysAway - knownUpcomingTotal;
    shortfall = projected < 0;
  }
  const daysCovered = dailyRate > 0 ? Math.floor(balance / dailyRate) : null;
  const pendingReceivables = entries.filter(e => e.kind==='expense' && catByKey(e.category) && catByKey(e.category).type==='receivable' && !e.settled)
    .sort((a,b) => Number(b.amount) - Number(a.amount));
  return { dailyRate, daysCovered, shortfall, projected, nextIncome, upcomingRecurring, knownUpcomingTotal, pendingReceivables, balance };
}

// ---------------- Donut / legend ----------------
function buildDonut(items, total, holeLabel){
  if(total <= 0){
    return `<div class="donut-wrap"><div class="donut" style="background:var(--empty-donut)"></div>
      <div class="donut-hole"><div class="donut-total" style="color:var(--faint)">—</div><div class="donut-total-label">${holeLabel}</div></div></div>`;
  }
  let cum = 0;
  const stops = items.map(it => {
    const start = (cum/total*100);
    cum += it.total;
    const end = (cum/total*100);
    return `${it.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
  }).join(',');
  return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${stops})"></div>
    <div class="donut-hole"><div class="donut-total">${fmtINR(total)}</div><div class="donut-total-label">${holeLabel}</div></div></div>`;
}
function buildLegend(items, total){
  if(!items.length) return `<div class="empty-note">Nothing here yet.</div>`;
  return items.map(it => `
    <div class="legend-row">
      <span class="legend-dot" style="background:${it.color}"></span>
      <span class="legend-name">${it.label}</span>
      <span class="legend-pct">${total>0 ? Math.round(it.total/total*100) : 0}%</span>
      <span class="legend-amount">${fmtINR(it.total)}</span>
    </div>`).join('');
}
function accountCardHtml(a){
  return `<div class="account-card"><div class="account-name-row"><span class="account-name">${escapeHtml(a.name)}</span>${a.isSavings?'<span class="badge-savings">SAVINGS</span>':''}</div><div class="account-balance">${fmtINR(accountBalance(a.id))}</div></div>`;
}

// ---------------- Main render ----------------
function render(){
  const app = document.getElementById('app');
  const fe = filteredEntries();
  const balance = totalBalance();

  const moneyOut = fe.filter(e => e.kind==='expense' && !e.settled).reduce((s,e) => s + Number(e.amount), 0);
  const owedToYou = fe.filter(e => e.kind==='expense' && catByKey(e.category).type === 'receivable' && !e.settled)
                       .reduce((s,e) => s + Number(e.amount), 0);
  const permanentSpend = fe.filter(e => e.kind==='expense' && catByKey(e.category).type === 'expense')
                            .reduce((s,e) => s + Number(e.amount), 0);
  const incomePeriod = fe.filter(e => e.kind==='income').reduce((s,e) => s + Number(e.amount), 0);
  const receivedBackPeriod = entries.filter(e => e.kind==='expense' && catByKey(e.category).type==='receivable' && e.settled && e.settledDate &&
      (selectedMonth==='all' || e.settledDate.slice(0,7)===selectedMonth))
      .reduce((s,e) => s + Number(e.amount), 0);
  const net = incomePeriod + receivedBackPeriod - moneyOut;

  const monthOpts = getMonthOptions();
  const monthSelectHtml = `<select class="month-select" id="monthSelect">
      ${monthOpts.map(mk => `<option value="${mk}" ${mk===selectedMonth?'selected':''}>${monthLabel(mk)}</option>`).join('')}
      <option value="all" ${selectedMonth==='all'?'selected':''}>All Time</option>
    </select>`;

  // Today vs yesterday
  const todaySpend = entries.filter(e => e.kind==='expense' && e.date===todayISO()).reduce((s,e)=>s+Number(e.amount),0);
  const yestSpend = entries.filter(e => e.kind==='expense' && e.date===yesterdayISO()).reduce((s,e)=>s+Number(e.amount),0);
  const todayByCat = EXPENSE_CATEGORIES.map(c => ({
    ...c, total: entries.filter(e => e.kind==='expense' && e.date===todayISO() && e.category===c.key).reduce((s,e)=>s+Number(e.amount),0)
  })).filter(c => c.total > 0).sort((a,b)=>b.total-a.total);
  const delta = todaySpend - yestSpend;

  // Runway
  const runway = computeRunway();

  const spendCats = EXPENSE_CATEGORIES.map(c => ({
    ...c, total: fe.filter(e => e.kind==='expense' && e.category===c.key).reduce((s,e)=>s+Number(e.amount),0)
  })).filter(c => c.total > 0).sort((a,b)=>b.total-a.total);
  const spendTotal = spendCats.reduce((s,c)=>s+c.total,0);

  const incomeCats = INCOME_CATEGORIES.map(c => ({
    ...c, total: fe.filter(e => e.kind==='income' && e.category===c.key).reduce((s,e)=>s+Number(e.amount),0)
  })).filter(c => c.total > 0).sort((a,b)=>b.total-a.total);
  const incomeTotal = incomeCats.reduce((s,c)=>s+c.total,0);

  app.innerHTML = `
    <header class="top">
      <div><h1>Personal Ledger</h1><div class="sub">${PERSON_LABEL} &middot; ${monthLabel(selectedMonth)}</div></div>
      ${monthSelectHtml}
    </header>

    <div class="card hero-balance-card">
      <div class="hero-label">Total Balance</div>
      <div class="hero-value">${fmtINR(balance)}</div>
      <div class="accounts-grid">${accounts.length ? accounts.map(a=>accountCardHtml(a)).join('') : '<div class="empty-note">No accounts yet.</div>'}</div>
    </div>
    <div class="eyebrow"><span></span><a id="manageAccountsLink">Manage accounts</a></div>

    <div class="eyebrow">Today</div>
    <div class="card balance-card">
      <div class="balance-grid">
        <div><div class="stat-label">Today</div><div class="stat-value">${fmtINR(todaySpend)}</div></div>
        <div><div class="stat-label">Yesterday</div><div class="stat-value" style="opacity:.65">${fmtINR(yestSpend)}</div></div>
      </div>
      <hr class="balance-divider">
      <div style="font-size:12px;color:var(--muted);margin-bottom:${todayByCat.length?'8px':'0'};">
        ${delta===0 ? "Same as yesterday." : (delta>0 ? `₹${Math.abs(delta).toLocaleString('en-IN')} more than yesterday.` : `₹${Math.abs(delta).toLocaleString('en-IN')} less than yesterday.`)}
      </div>
      ${todayByCat.length ? todayByCat.map(c => `
        <div class="legend-row"><span class="legend-dot" style="background:${c.color}"></span><span class="legend-name">${c.label}</span><span class="legend-amount">${fmtINR(c.total)}</span></div>
      `).join('') : ''}
    </div>

    <div class="eyebrow">This Period</div>
    <div class="card balance-card">
      <div class="balance-grid">
        <div><div class="stat-label">Money Out</div><div class="stat-value">${fmtINR(moneyOut)}</div></div>
        <div><div class="stat-label">Owed To You</div><div class="stat-value amber">${fmtINR(owedToYou)}</div></div>
      </div>
      <hr class="balance-divider">
      <div class="mini-grid">
        <div>Permanent spend<b>${fmtINR(permanentSpend)}</b></div>
        <div>Income<b class="pos">${fmtINR(incomePeriod)}</b></div>
        <div>Received back<b>${fmtINR(receivedBackPeriod)}</b></div>
        <div>Net this period<b class="${net>=0?'pos':'neg'}">${net>=0?'+':''}${fmtINR(net)}</b></div>
      </div>
    </div>

    <div class="eyebrow">Runway<a id="addIncomeLink">+ Expected income</a></div>
    <div class="card balance-card">
      ${ runway.nextIncome
          ? `<div class="hero-label">Next expected income</div><div class="hero-value" style="font-size:19px;">${escapeHtml(runway.nextIncome.label)} &middot; ${fmtINR(runway.nextIncome.amount)}</div>
             <div style="font-size:12px;color:var(--muted);margin-top:2px;">${runway.nextIncome.daysAway<=0?'Today':runway.nextIncome.daysAway+' day'+(runway.nextIncome.daysAway===1?'':'s')+' away'} &middot; into ${accName(runway.nextIncome.account)}</div>`
          : `<div class="empty-note" style="padding:0 0 4px;">No expected income set. Tap "+ Expected income" to add your salary date so this can project ahead.</div>`
      }
      <hr class="balance-divider">
      <div style="font-size:13px;color:var(--muted);line-height:1.6;">
        ${ runway.dailyRate > 0
            ? `At your recent pace (~${fmtINR(runway.dailyRate)}/day), your balance covers about ${runway.daysCovered} more day${runway.daysCovered===1?'':'s'}.`
            : `Not enough recent spending logged yet to estimate a pace.`
        }
        ${ runway.knownUpcomingTotal > 0
            ? `<br><br>Known upcoming before then: ${runway.upcomingRecurring.map(r=>`${escapeHtml(r.label)} (${fmtINR(r.amount)})`).join(', ')} — already counted below.`
            : ``
        }
        ${ runway.nextIncome
            ? `<br><br>${ runway.shortfall
                ? `Projected balance on ${fmtDateShort(runway.nextIncome.date.toISOString().slice(0,10))}: <b style="color:var(--danger);">${fmtINR(runway.projected)}</b> — you may run low before then.
                   ${ runway.pendingReceivables.length
                      ? ` You have ${fmtINR(runway.pendingReceivables.reduce((s,e)=>s+Number(e.amount),0))} pending — ${runway.pendingReceivables.slice(0,2).map(e=>`"${escapeHtml(e.title)}" (${fmtINR(e.amount)})`).join(', ')}${runway.pendingReceivables.length>2?', and more':''}. Might be worth following up.`
                      : ``
                   }`
                : `Projected balance on ${fmtDateShort(runway.nextIncome.date.toISOString().slice(0,10))}: <b style="color:var(--success);">${fmtINR(runway.projected)}</b>. You're on track.`
              }`
            : ``
        }
      </div>
      ${ incomeSchedule.length ? `<hr class="balance-divider">` + incomeSchedule.map(s => `
        <div class="legend-row" data-edit-income="${s.id}" style="cursor:pointer;">
          <span class="legend-name">${escapeHtml(s.label)}${s.active===false?' (paused)':''}</span>
          <span class="legend-pct">day ${s.dayOfMonth}</span>
          <span class="legend-amount">${fmtINR(s.amount)}</span>
        </div>`).join('') : '' }
    </div>

    <div class="eyebrow">Recurring Expenses<a id="addRecurringLink">+ Add</a></div>
    ${ recurringExpenses.length === 0
        ? `<div class="card balance-card"><div class="empty-note" style="padding:0;">No recurring expenses set. Add rent, subscriptions, or anything else that repeats — tap "+ Add".</div></div>`
        : recurringExpenses.map(r => renderRecurringCard(r)).join('')
    }

    <div class="eyebrow">Savings Goals<a id="addGoalLink">+ New goal</a></div>
    ${ goals.length === 0
        ? `<div class="card balance-card"><div class="empty-note" style="padding:0;">No goals yet. Saving up for something? Tap "+ New goal" to start tracking it.</div></div>`
        : goals.map(g => renderGoalCard(g)).join('')
    }

    <div class="eyebrow">Can I Afford This?</div>
    <div class="card balance-card">
      <div class="row2">
        <div class="field" style="margin-bottom:0;"><label>Category</label><select id="calc-category">${EXPENSE_CATEGORIES.map(c=>`<option value="${c.key}">${c.label}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:0;"><label>Amount (₹)</label><input type="number" id="calc-amount" step="0.01" min="0" placeholder="0.00"></div>
      </div>
      <button type="button" class="btn btn-primary" id="calcCheck" style="width:100%;margin-top:12px;">Check</button>
      <div id="calcResult"></div>
    </div>

    <div class="eyebrow">Spending by Category</div>
    <div class="card pie-card">${buildDonut(spendCats, spendTotal, 'Spent')}${buildLegend(spendCats, spendTotal)}</div>

    <div class="eyebrow">Income by Source</div>
    <div class="card pie-card">${buildDonut(incomeCats, incomeTotal, 'Income')}${buildLegend(incomeCats, incomeTotal)}</div>

    <div class="eyebrow">Log</div>
    <div class="card log-card">
      ${ fe.length === 0
          ? `<div class="empty-note">Nothing logged yet for ${monthLabel(selectedMonth)}. Tap + to add your first transaction.</div>`
          : fe.map(e => renderLogRow(e)).join('')
      }
    </div>

    <span class="footer-link"><a href="${PARTNER_URL}">Open ${PARTNER_LABEL}'s console</a></span>
  `;

  document.getElementById('monthSelect').addEventListener('change', (ev) => { selectedMonth = ev.target.value; render(); });
  document.querySelectorAll('.log-row').forEach(row => {
    row.addEventListener('click', (ev) => { if(ev.target.closest('[data-settle]')) return; openEdit(row.dataset.id); });
  });
  document.querySelectorAll('[data-settle]').forEach(btn => {
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); openSettle(btn.dataset.settle); });
  });
  document.getElementById('manageAccountsLink').addEventListener('click', openManageAccounts);
  document.getElementById('addIncomeLink').addEventListener('click', () => openIncomeModal(null));
  document.querySelectorAll('[data-edit-income]').forEach(el => el.addEventListener('click', () => openIncomeModal(el.dataset.editIncome)));
  document.getElementById('addGoalLink').addEventListener('click', () => openGoalModal(null));
  document.querySelectorAll('[data-edit-goal]').forEach(el => el.addEventListener('click', () => openGoalModal(el.dataset.editGoal)));
  document.getElementById('addRecurringLink').addEventListener('click', () => openRecurringModal(null));
  document.querySelectorAll('[data-edit-recurring]').forEach(el => {
    el.addEventListener('click', (ev) => { if(ev.target.closest('[data-log-recurring]')) return; openRecurringModal(el.dataset.editRecurring); });
  });
  document.querySelectorAll('[data-log-recurring]').forEach(btn => {
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); logRecurring(btn.dataset.logRecurring); });
  });
  document.getElementById('calcCheck').addEventListener('click', runCalculator);
}

function renderGoalCard(g){
  const pct = g.targetAmount > 0 ? Math.min(100, Math.round(g.savedAmount / g.targetAmount * 100)) : 0;
  return `
    <div class="card balance-card" data-edit-goal="${g.id}" style="cursor:pointer;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div class="hero-label" style="text-transform:none;font-size:14px;color:var(--ink);font-weight:700;">${escapeHtml(g.name)}</div>
        <div style="font-size:11px;color:var(--muted);">${g.targetDate ? 'by ' + fmtDateShort(g.targetDate) : ''}</div>
      </div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px;">${fmtINR(g.savedAmount)} of ${fmtINR(g.targetAmount)}</div>
      <div style="height:7px;background:var(--rule);border-radius:4px;margin-top:8px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:var(--cta-bg);border-radius:4px;"></div>
      </div>
    </div>`;
}

function renderRecurringCard(r){
  const cat = catByKey(r.category) || { label:'Uncategorized', color:'#8C9A92' };
  const already = loggedThisMonth(r.id);
  const today = new Date(); today.setHours(0,0,0,0);
  const nextDate = nextOccurrence(Number(r.dayOfMonth), today);
  const daysAway = Math.round((nextDate - today) / 86400000);
  const dueSoon = !already && daysAway <= 3;
  return `
    <div class="card balance-card" data-edit-recurring="${r.id}" style="cursor:pointer;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div class="hero-label" style="text-transform:none;font-size:14px;color:var(--ink);font-weight:700;">${escapeHtml(r.label)}</div>
        <span class="pill" style="background:${cat.color}">${cat.label}</span>
      </div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px;">${fmtINR(r.amount)} &middot; day ${r.dayOfMonth} &middot; ${accName(r.account)}${r.active===false?' &middot; paused':''}</div>
      <div style="margin-top:8px;">
        ${ already
            ? `<span class="stamp">LOGGED THIS MONTH</span>`
            : dueSoon
              ? `<button class="settle-btn" data-log-recurring="${r.id}">Log for ${monthLabel(monthKey(today))}</button>`
              : `<span style="font-size:11px;color:var(--faint);">Next: ${fmtDateShort(nextDate.toISOString().slice(0,10))}</span>`
        }
      </div>
    </div>`;
}

function renderLogRow(e){
  if(e.kind === 'transfer'){
    const title = e.title && e.title.trim() ? e.title : `${accName(e.fromAccount)} &rarr; ${accName(e.toAccount)}`;
    return `<div class="log-row" data-id="${e.id}">
        <div class="log-date">${fmtDateShort(e.date)}</div>
        <div class="log-main">
          <div class="log-title-line"><span class="log-title">${escapeHtml(title)}</span><span class="pill" style="background:${TRANSFER_COLOR}">Transfer</span></div>
          <div class="log-notes">${accName(e.fromAccount)} &rarr; ${accName(e.toAccount)}${e.notes ? ' &middot; ' + escapeHtml(e.notes) : ''}</div>
        </div>
        <div class="log-right"><div class="log-amount">${fmtINR(e.amount)}</div></div>
      </div>`;
  }
  const c = catByKey(e.category);
  if(e.kind === 'income'){
    return `<div class="log-row" data-id="${e.id}">
        <div class="log-date">${fmtDateShort(e.date)}</div>
        <div class="log-main">
          <div class="log-title-line"><span class="log-title">${escapeHtml(e.title)}</span><span class="pill" style="background:${c.color}">${c.label}</span></div>
          <div class="log-notes">into ${accName(e.account)}${e.notes ? ' &middot; ' + escapeHtml(e.notes) : ''}</div>
        </div>
        <div class="log-right"><div class="log-amount pos">+${fmtINR(e.amount)}</div></div>
      </div>`;
  }
  const isReceivable = c.type === 'receivable';
  return `<div class="log-row" data-id="${e.id}">
      <div class="log-date">${fmtDateShort(e.date)}</div>
      <div class="log-main">
        <div class="log-title-line"><span class="log-title">${escapeHtml(e.title)}</span><span class="pill" style="background:${c.color}">${c.label}</span></div>
        <div class="log-notes">from ${accName(e.account)}${e.notes ? ' &middot; ' + escapeHtml(e.notes) : ''}</div>
      </div>
      <div class="log-right">
        <div class="log-amount">${fmtINR(e.amount)}</div>
        ${ isReceivable ? (e.settled ? `<span class="stamp">SETTLED</span>` : `<button class="settle-btn" data-settle="${e.id}">Mark received</button>`) : '' }
      </div>
    </div>`;
}

// ---------------- Calculator ----------------
function runCalculator(){
  const catKey = document.getElementById('calc-category').value;
  const amount = parseFloat(document.getElementById('calc-amount').value);
  const resultEl = document.getElementById('calcResult');
  if(isNaN(amount) || amount <= 0){
    resultEl.innerHTML = `<div class="empty-note" style="padding:10px 0 0;">Enter an amount to check.</div>`;
    return;
  }
  const cat = catByKey(catKey);
  const balance = totalBalance();
  const balanceAfter = balance - amount;
  const spentThisMonthInCat = entries.filter(e => e.kind==='expense' && e.category===catKey && e.date.slice(0,7)===monthKey(new Date()))
    .reduce((s,e)=>s+Number(e.amount),0);
  const nextIncome = computeNextIncome();
  resultEl.innerHTML = `
    <hr class="balance-divider">
    <div class="mini-grid">
      <div>Balance after<b class="${balanceAfter>=0?'':'neg'}">${fmtINR(balanceAfter)}</b></div>
      <div>${cat.label} this month<b>${fmtINR(spentThisMonthInCat)} &rarr; ${fmtINR(spentThisMonthInCat+amount)}</b></div>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-top:10px;">
      ${ nextIncome ? `Your next expected income is in ${nextIncome.daysAway<=0?'today':nextIncome.daysAway+' day'+(nextIncome.daysAway===1?'':'s')}.` : `No expected income set — add one above for more context here.` }
    </div>`;
}

// ---------------- Settle modal ----------------
function openSettle(id){
  settlingId = id;
  const sel = document.getElementById('settle-account');
  sel.innerHTML = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  const e = entries.find(x=>x.id===id);
  if(e && e.account) sel.value = e.account;
  document.getElementById('overlaySettle').classList.add('open');
}
document.getElementById('settleCancel').addEventListener('click', () => { document.getElementById('overlaySettle').classList.remove('open'); settlingId=null; });
document.getElementById('overlaySettle').addEventListener('click', (ev) => { if(ev.target.id==='overlaySettle'){ ev.currentTarget.classList.remove('open'); settlingId=null; } });
document.getElementById('settleConfirm').addEventListener('click', async () => {
  const settledAccount = document.getElementById('settle-account').value;
  const settledDate = todayISO();
  try{
    await withRetry(() => apiPost({ action:'updateEntry', person:PERSON, id:settlingId, patch:{ settled:true, settledAccount, settledDate } }));
    const e = entries.find(x=>x.id===settlingId);
    if(e){ e.settled=true; e.settledAccount=settledAccount; e.settledDate=settledDate; }
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlaySettle').classList.remove('open');
  settlingId = null;
  render();
});

// ---------------- Manage accounts ----------------
let accountsDraft = [];
function openManageAccounts(){
  accountsDraft = JSON.parse(JSON.stringify(accounts));
  renderAccountsForm();
  document.getElementById('overlayAccounts').classList.add('open');
}
function renderAccountsForm(){
  const list = document.getElementById('accountsFormList');
  list.innerHTML = accountsDraft.map((a,i) => `
    <div class="acct-row" data-idx="${i}">
      <div class="field"><label>Name</label><input type="text" class="acct-name" value="${escapeHtml(a.name)}"></div>
      <div class="field"><label>Opening balance</label><input type="number" class="acct-opening" step="0.01" value="${a.openingBalance}"></div>
      <label class="chk"><input type="checkbox" class="acct-savings" ${a.isSavings?'checked':''}> Savings</label>
      <button type="button" class="acct-del" data-del="${i}" aria-label="Delete account">&times;</button>
    </div>`).join('');
  list.querySelectorAll('.acct-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.del);
      const accId = accountsDraft[idx].id;
      const used = entries.some(e => e.account===accId || e.fromAccount===accId || e.toAccount===accId || e.settledAccount===accId);
      if(used){ alert("Can't delete — this account has transactions linked to it."); return; }
      accountsDraft.splice(idx,1);
      renderAccountsForm();
    });
  });
}
document.getElementById('btnAddAccount').addEventListener('click', () => {
  accountsDraft.push({ id:'acc_'+uid(), name:'New Account', openingBalance:0, isSavings:false });
  renderAccountsForm();
});
document.getElementById('acctCancel').addEventListener('click', () => document.getElementById('overlayAccounts').classList.remove('open'));
document.getElementById('overlayAccounts').addEventListener('click', (ev) => { if(ev.target.id==='overlayAccounts') ev.currentTarget.classList.remove('open'); });
document.getElementById('acctSave').addEventListener('click', async () => {
  const rows = document.querySelectorAll('#accountsFormList .acct-row');
  const updated = [];
  let hasError = false;
  rows.forEach((row) => {
    const idx = Number(row.dataset.idx);
    const name = row.querySelector('.acct-name').value.trim();
    const opening = parseFloat(row.querySelector('.acct-opening').value) || 0;
    const isSavings = row.querySelector('.acct-savings').checked;
    if(!name) hasError = true;
    updated.push({ ...accountsDraft[idx], name, openingBalance: opening, isSavings });
  });
  if(hasError || updated.length === 0){ alert('Every account needs a name.'); return; }
  try{
    await withRetry(() => apiPost({ action:'saveAccounts', person:PERSON, accounts:updated }));
    accounts = updated;
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayAccounts').classList.remove('open');
  render();
});

// ---------------- Goals modal ----------------
function openGoalModal(id){
  editingGoalId = id;
  const overlay = document.getElementById('overlayGoal');
  const btnDeleteGoal = document.getElementById('goalDeleteBtn');
  if(id){
    const g = goals.find(x=>x.id===id);
    document.getElementById('goalSheetTitle').textContent = 'Edit Goal';
    document.getElementById('g-name').value = g.name;
    document.getElementById('g-target').value = g.targetAmount;
    document.getElementById('g-date').value = g.targetDate || '';
    document.getElementById('g-notes').value = g.notes || '';
    document.getElementById('g-saved-display').textContent = fmtINR(g.savedAmount);
    document.getElementById('g-add-amount').value = '';
    document.getElementById('goalContributeRow').style.display = 'block';
    btnDeleteGoal.style.display = 'block';
  }else{
    document.getElementById('goalSheetTitle').textContent = 'New Goal';
    document.getElementById('g-name').value = '';
    document.getElementById('g-target').value = '';
    document.getElementById('g-date').value = '';
    document.getElementById('g-notes').value = '';
    document.getElementById('goalContributeRow').style.display = 'none';
    btnDeleteGoal.style.display = 'none';
  }
  overlay.classList.add('open');
}
document.getElementById('goalCancel').addEventListener('click', () => document.getElementById('overlayGoal').classList.remove('open'));
document.getElementById('overlayGoal').addEventListener('click', (ev) => { if(ev.target.id==='overlayGoal') ev.currentTarget.classList.remove('open'); });

document.getElementById('goalAddAmountBtn').addEventListener('click', async () => {
  if(!editingGoalId) return;
  const amt = parseFloat(document.getElementById('g-add-amount').value);
  if(isNaN(amt) || amt <= 0) return;
  const g = goals.find(x=>x.id===editingGoalId);
  g.savedAmount = Number(g.savedAmount||0) + amt;
  try{
    await withRetry(() => apiPost({ action:'saveGoals', person:PERSON, goals }));
    document.getElementById('g-saved-display').textContent = fmtINR(g.savedAmount);
    document.getElementById('g-add-amount').value = '';
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
});

document.getElementById('goalDeleteBtn').addEventListener('click', async () => {
  if(!editingGoalId) return;
  if(!confirm('Delete this goal?')) return;
  goals = goals.filter(g => g.id !== editingGoalId);
  try{
    await withRetry(() => apiPost({ action:'saveGoals', person:PERSON, goals }));
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayGoal').classList.remove('open');
  render();
});

document.getElementById('goalSave').addEventListener('click', async () => {
  const name = document.getElementById('g-name').value.trim();
  const targetAmount = parseFloat(document.getElementById('g-target').value) || 0;
  const targetDate = document.getElementById('g-date').value;
  const notes = document.getElementById('g-notes').value.trim();
  if(!name || targetAmount <= 0){ alert('Give the goal a name and a target amount.'); return; }
  if(editingGoalId){
    const g = goals.find(x=>x.id===editingGoalId);
    Object.assign(g, { name, targetAmount, targetDate, notes });
  }else{
    goals.push({ id:'goal_'+uid(), name, targetAmount, savedAmount:0, targetDate, notes });
  }
  try{
    await withRetry(() => apiPost({ action:'saveGoals', person:PERSON, goals }));
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayGoal').classList.remove('open');
  render();
});

// ---------------- Expected income modal ----------------
function openIncomeModal(id){
  editingIncomeId = id;
  const overlay = document.getElementById('overlayIncome');
  const opts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  document.getElementById('i-account').innerHTML = opts;
  document.getElementById('btnDeleteIncome').style.display = id ? 'block' : 'none';
  if(id){
    const s = incomeSchedule.find(x=>x.id===id);
    document.getElementById('incomeSheetTitle').textContent = 'Edit Expected Income';
    document.getElementById('i-label').value = s.label;
    document.getElementById('i-amount').value = s.amount;
    document.getElementById('i-account').value = s.account;
    document.getElementById('i-day').value = s.dayOfMonth;
    document.getElementById('i-active').checked = s.active !== false;
  }else{
    document.getElementById('incomeSheetTitle').textContent = 'Add Expected Income';
    document.getElementById('i-label').value = '';
    document.getElementById('i-amount').value = '';
    document.getElementById('i-day').value = '';
    document.getElementById('i-active').checked = true;
  }
  overlay.classList.add('open');
}
document.getElementById('incomeCancel').addEventListener('click', () => document.getElementById('overlayIncome').classList.remove('open'));
document.getElementById('overlayIncome').addEventListener('click', (ev) => { if(ev.target.id==='overlayIncome') ev.currentTarget.classList.remove('open'); });

document.getElementById('btnDeleteIncome').addEventListener('click', async () => {
  if(!editingIncomeId) return;
  if(!confirm('Remove this expected income?')) return;
  incomeSchedule = incomeSchedule.filter(s => s.id !== editingIncomeId);
  try{
    await withRetry(() => apiPost({ action:'saveIncomeSchedule', person:PERSON, schedule:incomeSchedule }));
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayIncome').classList.remove('open');
  render();
});

document.getElementById('incomeSave').addEventListener('click', async () => {
  const label = document.getElementById('i-label').value.trim();
  const amount = parseFloat(document.getElementById('i-amount').value) || 0;
  const account = document.getElementById('i-account').value;
  const dayOfMonth = parseInt(document.getElementById('i-day').value, 10);
  const active = document.getElementById('i-active').checked;
  if(!label || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31){
    alert('Give it a label, a positive amount, and a day of month between 1 and 31.');
    return;
  }
  if(editingIncomeId){
    const s = incomeSchedule.find(x=>x.id===editingIncomeId);
    Object.assign(s, { label, amount, account, dayOfMonth, active });
  }else{
    incomeSchedule.push({ id:'inc_'+uid(), label, amount, account, dayOfMonth, active });
  }
  try{
    await withRetry(() => apiPost({ action:'saveIncomeSchedule', person:PERSON, schedule:incomeSchedule }));
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayIncome').classList.remove('open');
  render();
});

// ---------------- Recurring expenses modal (rent, subscriptions, etc.) ----------------
function openRecurringModal(id){
  editingRecurringId = id;
  const overlay = document.getElementById('overlayRecurring');
  const acctOpts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  const catOpts = EXPENSE_CATEGORIES.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
  document.getElementById('r-account').innerHTML = acctOpts;
  document.getElementById('r-category').innerHTML = catOpts;
  document.getElementById('btnDeleteRecurring').style.display = id ? 'block' : 'none';
  if(id){
    const r = recurringExpenses.find(x=>x.id===id);
    document.getElementById('recurringSheetTitle').textContent = 'Edit Recurring Expense';
    document.getElementById('r-label').value = r.label;
    document.getElementById('r-amount').value = r.amount;
    document.getElementById('r-category').value = r.category;
    document.getElementById('r-account').value = r.account;
    document.getElementById('r-day').value = r.dayOfMonth;
    document.getElementById('r-active').checked = r.active !== false;
  }else{
    document.getElementById('recurringSheetTitle').textContent = 'Add Recurring Expense';
    document.getElementById('r-label').value = '';
    document.getElementById('r-amount').value = '';
    document.getElementById('r-day').value = '';
    document.getElementById('r-active').checked = true;
  }
  overlay.classList.add('open');
}
document.getElementById('recurringCancel').addEventListener('click', () => document.getElementById('overlayRecurring').classList.remove('open'));
document.getElementById('overlayRecurring').addEventListener('click', (ev) => { if(ev.target.id==='overlayRecurring') ev.currentTarget.classList.remove('open'); });

document.getElementById('btnDeleteRecurring').addEventListener('click', async () => {
  if(!editingRecurringId) return;
  if(!confirm('Remove this recurring expense? Past logged transactions stay untouched.')) return;
  recurringExpenses = recurringExpenses.filter(r => r.id !== editingRecurringId);
  try{
    await withRetry(() => apiPost({ action:'saveRecurring', person:PERSON, recurring:recurringExpenses }));
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayRecurring').classList.remove('open');
  render();
});

document.getElementById('recurringSave').addEventListener('click', async () => {
  const label = document.getElementById('r-label').value.trim();
  const amount = parseFloat(document.getElementById('r-amount').value) || 0;
  const category = document.getElementById('r-category').value;
  const account = document.getElementById('r-account').value;
  const dayOfMonth = parseInt(document.getElementById('r-day').value, 10);
  const active = document.getElementById('r-active').checked;
  if(!label || amount <= 0 || !dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31){
    alert('Give it a label, a positive amount, and a day of month between 1 and 31.');
    return;
  }
  if(editingRecurringId){
    const r = recurringExpenses.find(x=>x.id===editingRecurringId);
    Object.assign(r, { label, amount, category, account, dayOfMonth, active });
  }else{
    recurringExpenses.push({ id:'rec_'+uid(), label, amount, category, account, dayOfMonth, active });
  }
  try{
    await withRetry(() => apiPost({ action:'saveRecurring', person:PERSON, recurring:recurringExpenses }));
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  document.getElementById('overlayRecurring').classList.remove('open');
  render();
});

// One tap: turn a recurring template into an actual logged transaction for
// this month, tagged with recurringId so it won't be offered again till next month.
async function logRecurring(id){
  const r = recurringExpenses.find(x => x.id === id);
  if(!r) return;
  const entry = { kind:'expense', category:r.category, account:r.account, amount:r.amount, date: todayISO(), title:r.label, notes:'', recurringId:r.id, id: uid() };
  try{
    await withRetry(() => apiPost({ action:'addEntry', person:PERSON, entry }));
    entries.push(entry);
    showToast('Logged');
  }catch(err){ showToast("Couldn't save — try again", true); }
  render();
}

// ---------------- Entry modal ----------------
const overlay = document.getElementById('overlay');
const form = document.getElementById('entryForm');
const sheetTitle = document.getElementById('sheetTitle');
const btnDelete = document.getElementById('btnDelete');
const formErr = document.getElementById('formErr');
const typeToggle = document.getElementById('typeToggle');

function populateSelects(){
  const opts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  document.getElementById('f-account').innerHTML = opts;
  document.getElementById('f-from-account').innerHTML = opts;
  document.getElementById('f-to-account').innerHTML = opts;
}
function setCategoryOptions(kind){
  const sel = document.getElementById('f-category');
  const list = kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  sel.innerHTML = list.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
}
function applyTypeUI(kind){
  currentType = kind;
  typeToggle.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === kind));
  const catAcctRow = document.getElementById('categoryAccountRow');
  const transferRow = document.getElementById('transferRow');
  const titleField = document.getElementById('f-title');
  if(kind === 'transfer'){
    catAcctRow.style.display = 'none';
    transferRow.style.display = 'grid';
    titleField.placeholder = 'e.g. Monthly savings deposit';
  }else{
    catAcctRow.style.display = 'grid';
    transferRow.style.display = 'none';
    setCategoryOptions(kind);
    document.getElementById('f-account-label').textContent = kind === 'income' ? 'Into Account' : 'Paid From';
    titleField.placeholder = kind === 'income' ? 'e.g. August salary' : 'e.g. Zomato dinner';
  }
}
typeToggle.querySelectorAll('.type-btn').forEach(btn => btn.addEventListener('click', () => applyTypeUI(btn.dataset.type)));

function openAdd(){
  editingId = null;
  populateSelects();
  sheetTitle.textContent = 'Add Transaction';
  typeToggle.style.display = 'flex';
  btnDelete.style.display = 'none';
  formErr.style.display = 'none';
  document.getElementById('f-title').value = '';
  document.getElementById('f-amount').value = '';
  document.getElementById('f-date').value = todayISO();
  document.getElementById('f-notes').value = '';
  applyTypeUI('expense');
  overlay.classList.add('open');
}
function openEdit(id){
  const e = entries.find(x => x.id === id);
  if(!e) return;
  editingId = id;
  populateSelects();
  sheetTitle.textContent = 'Edit Transaction';
  typeToggle.style.display = 'none';
  btnDelete.style.display = 'block';
  formErr.style.display = 'none';
  applyTypeUI(e.kind);
  document.getElementById('f-title').value = e.title || '';
  document.getElementById('f-amount').value = e.amount;
  document.getElementById('f-date').value = e.date;
  document.getElementById('f-notes').value = e.notes || '';
  if(e.kind === 'transfer'){
    document.getElementById('f-from-account').value = e.fromAccount;
    document.getElementById('f-to-account').value = e.toAccount;
  }else{
    document.getElementById('f-category').value = e.category;
    document.getElementById('f-account').value = e.account;
  }
  overlay.classList.add('open');
}
function closeSheet(){ overlay.classList.remove('open'); editingId = null; }

document.getElementById('fabAdd').addEventListener('click', openAdd);
document.getElementById('btnCancel').addEventListener('click', closeSheet);
overlay.addEventListener('click', (ev) => { if(ev.target === overlay) closeSheet(); });

document.getElementById('btnDelete').addEventListener('click', async () => {
  if(!editingId) return;
  if(!confirm('Delete this entry?')) return;
  try{
    await withRetry(() => apiPost({ action:'deleteEntry', person:PERSON, id:editingId }));
    entries = entries.filter(e => e.id !== editingId);
    showToast('Saved');
  }catch(err){ showToast("Couldn't delete — try again", true); }
  closeSheet();
  render();
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const title = document.getElementById('f-title').value.trim();
  const amount = parseFloat(document.getElementById('f-amount').value);
  const date = document.getElementById('f-date').value;
  const notes = document.getElementById('f-notes').value.trim();
  if(!date || isNaN(amount) || amount <= 0){ formErr.style.display = 'block'; return; }

  let payload;
  if(currentType === 'transfer'){
    const fromAccount = document.getElementById('f-from-account').value;
    const toAccount = document.getElementById('f-to-account').value;
    if(!fromAccount || !toAccount || fromAccount === toAccount){
      formErr.textContent = 'Choose two different accounts to transfer between.';
      formErr.style.display = 'block';
      return;
    }
    payload = { kind:'transfer', title, fromAccount, toAccount, amount, date, notes };
  }else{
    const category = document.getElementById('f-category').value;
    const account = document.getElementById('f-account').value;
    if(!title || !category || !account){ formErr.style.display = 'block'; return; }
    payload = { kind: currentType, title, category, account, amount, date, notes };
  }
  formErr.style.display = 'none';

  try{
    if(editingId){
      await withRetry(() => apiPost({ action:'updateEntry', person:PERSON, id:editingId, patch:payload }));
      const idx = entries.findIndex(x => x.id === editingId);
      entries[idx] = { ...entries[idx], ...payload };
    }else{
      const entry = { ...payload, id: uid() };
      await withRetry(() => apiPost({ action:'addEntry', person:PERSON, entry }));
      entries.push(entry);
    }
    showToast('Saved');
  }catch(err){ showToast("Couldn't save — try again", true); }
  closeSheet();
  render();
});

// ---------------- Init ----------------
async function init(){
  if(!APPS_SCRIPT_URL || APPS_SCRIPT_URL.indexOf('PASTE_YOUR') === 0){
    document.getElementById('app').innerHTML = `<div class="setup-note">
      This console isn't connected to your backend yet.<br><br>
      1. Deploy <code>Code.gs</code> as a Web App in Apps Script.<br>
      2. Copy the URL (ends in <code>/exec</code>).<br>
      3. Paste it into <code>APPS_SCRIPT_URL</code> at the top of <code>app.js</code>.
    </div>`;
    return;
  }
  try{
    await loadData();
    await ensureDefaultAccounts();
    render();
  }catch(err){
    document.getElementById('app').innerHTML = `<div class="setup-note">Couldn't reach the backend.<br><br>${escapeHtml(String(err))}<br><br>
      Check that the Apps Script is deployed with access set to "Anyone", and that the URL in <code>app.js</code> ends in <code>/exec</code>.</div>`;
  }
}
init();
