/* Floodlight FC team screen: line-up, tactics, roles and skill moves. It edits one team setup (see data.js)
   and calls back whenever it changes. Everything shown comes from data.js, never from typed input. */
import { STATS, TRAITS, STYLES, AI_STYLES, SKILLS, MOVES, SLOT_DIRS, canDo, moveNeeds, FORMATIONS, PLAYSTYLES, PLAY_KEYS, MANAGERS, managerById, LINKUPS, LINKUP_AT,
  INSTR, squadById, posFit, fitLabel, ovr, COND, assignSlots, autoXI, cleanSetup, buildTeam, teamRating } from './data.js';

const TABS = [['lineup', 'Line-up'], ['tactics', 'Tactics'], ['roles', 'Roles'], ['skills', 'Skill moves']];
const fitCls = f => f >= 1 ? 'f1' : f >= 0.95 ? 'f2' : f >= 0.88 ? 'f3' : 'f4';
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const opt = (v, label, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${label}</option>`;
const statName = Object.fromEntries(STATS.map(s => [s.k, s.name]));

export function initTeamScreen(root, { get, set, conds, done }) {
  let tab = 'lineup', sel = null;
  const setup = () => get();
  const squad = () => squadById(setup().team);
  const condOf = pl => (conds()[pl.idx] || 0) + 2;
  const condHtml = pl => { const c = COND[condOf(pl)]; return `<i style="color:${c.css}" title="Condition: ${c.label}">${c.sym}</i>`; };
  function commit(s) { set(cleanSetup(s, s.team)); render(); }

  // ---------- line-up
  function lineupHtml() {
    const s = setup(), sq = squad(), slots = FORMATIONS[s.tactics[0].formation].slots;
    const chips = s.xi.map((idx, si) => {
      const pl = sq.players[idx], [pos, fx, fz] = slots[si], f = posFit(pl, pos);
      const left = 50 + fz * 60, top = 7 + (-fx - 0.05) / 0.9 * 84;
      return `<button class="chip${sel === idx ? ' sel' : ''}" data-p="${idx}" style="left:${left}%;top:${top}%" aria-label="${pl.name}, ${pos}, rated ${ovr(pl, pos)}">
        ${s.captain === idx ? '<em class="c">C</em>' : ''}<b>${ovr(pl, pos)}</b><span>${pl.name}</span><i class="${fitCls(f)}">${pos}</i> ${condHtml(pl)}</button>`;
    }).join('');
    const bench = sq.players.filter(p => !s.xi.includes(p.idx)).map(pl =>
      `<button class="bn${sel === pl.idx ? ' sel' : ''}" data-p="${pl.idx}"><b>${ovr(pl)}</b><em>${pl.pos}</em><span>${pl.name}</span>${condHtml(pl)}<em>${stars(pl.stars)}</em></button>`).join('');
    return `<div class="lu">
      <div class="row"><div class="pitch" id="pitch">${chips}</div>
        <p class="note">Tap a player to see him, then tap another to swap them. The position colour shows how well he fits the slot: <b class="f1">natural</b>, <b class="f2">familiar</b>, <b class="f3">awkward</b>, <b class="f4">out of position</b>. The arrow is today's condition.</p></div>
      <div class="row">
        <div class="panel"><div class="lab">Bench</div><div class="bench">${bench}</div>
          <div><button class="ghost sm" data-act="best">Pick the best eleven</button></div></div>
        ${sel === null ? '' : cardHtml(sq.players[sel])}
      </div></div>`;
  }
  function cardHtml(pl) {
    const s = setup(), si = s.xi.indexOf(pl.idx), slot = si >= 0 ? FORMATIONS[s.tactics[0].formation].slots[si][0] : pl.pos;
    const f = posFit(pl, slot), mgr = managerById(s.manager), styleOn = STYLES[pl.style].pos.includes(slot), c = COND[condOf(pl)];
    const groups = ['Attack', 'Defence', 'Goalkeeping', 'Physical'].filter(g => g !== 'Goalkeeping' || pl.pos === 'GK').map(g =>
      `<div class="sgh">${g}</div>` + STATS.filter(x => x.group === g).map(x => {
        const v = pl.stats[x.k], b = mgr.boost.includes(x.k);
        return `<div class="sr" title="${x.use}"><span>${x.name}${b ? ' <b class="f1">+1</b>' : ''}</span><b>${v}</b><u><s style="width:${(v - 40) / 59 * 100}%"></s></u></div>`;
      }).join('')).join('');
    const traits = TRAITS.map(t => `<dt title="${t.use}">${t.name}</dt><dd>${pl[t.k]} / ${t.max}</dd>`).join('');
    const skills = pl.skills.map(k => `<span class="${SKILLS[k].fx ? '' : 'off'}" title="${SKILLS[k].fx || 'Listed, but not used by the match engine yet'}">${k}</span>`).join('');
    const moves = Object.keys(MOVES).filter(m => canDo(pl, m)).map(m => MOVES[m].name).join(', ');
    return `<div class="panel pc">
      <h3><em>${pl.num}</em>${pl.name}</h3>
      <div class="meta"><b>${pl.pos}</b>${pl.fam.length ? ' (also ' + pl.fam.join(', ') + ')' : ''} · age ${pl.age} · ${pl.foot > 0 ? 'right' : 'left'}-footed · <b style="color:var(--flood)">${stars(pl.stars)}</b><br>
        Rated <b>${ovr(pl, slot)}</b> at ${slot} (<span class="${fitCls(f)}">${fitLabel(f).toLowerCase()}</span>) · condition <b style="color:${c.css}">${c.sym} ${c.label}</b></div>
      <dl class="kv"><dt>Playing style</dt><dd>${pl.style}${styleOn ? '' : ' <span class="f3">(off at ' + slot + ')</span>'}<br><span class="note">${STYLES[pl.style].desc}</span></dd>
        ${pl.ai ? `<dt>On the ball</dt><dd>${pl.ai}<br><span class="note">${AI_STYLES[pl.ai].desc} (when the computer controls him)</span></dd>` : ''}
        ${traits}<dt>Can do</dt><dd>${moves}</dd></dl>
      <div class="sg">${groups}</div>
      <div class="lab">Skills</div><div class="tags">${skills}</div>
      ${si >= 0 ? `<div><button class="ghost sm" data-act="captain" data-p="${pl.idx}">${s.captain === pl.idx ? 'Captain' : 'Make captain'}</button></div>` : ''}
    </div>`;
  }
  function tapPlayer(idx) {
    const s = setup();
    if (sel === null || sel === idx) { sel = sel === idx ? null : idx; render(); return; }
    const a = s.xi.indexOf(sel), b = s.xi.indexOf(idx), xi = s.xi.slice();
    if (a < 0 && b < 0) { sel = idx; render(); return; }                // two bench players: just look at the other one
    if (a >= 0 && b >= 0) { xi[a] = idx; xi[b] = sel; } else if (a >= 0) xi[a] = idx; else xi[b] = sel;
    const keep = a >= 0 && b >= 0 ? sel : (a >= 0 ? idx : sel);
    sel = keep;
    commit({ ...s, xi });
  }

  // ---------- tactics
  function tacticHtml(i) {
    const s = setup(), t = s.tactics[i], mgr = managerById(s.manager), P = PLAYSTYLES[t.playstyle], prof = mgr.prof[t.playstyle];
    const team = buildTeam(s), awk = team.xi.filter(x => x.tac[i].fit < 0.95).map(x => `${x.pl.name} at ${x.tac[i].pos}`);
    const link = mgr.linkUp ? (prof >= LINKUP_AT ? `<b class="f1">${LINKUPS[mgr.linkUp].name}</b>: ${LINKUPS[mgr.linkUp].desc}` : `${LINKUPS[mgr.linkUp].name} needs proficiency ${LINKUP_AT}`) : 'This manager has no Link-Up Play';
    return `<div class="panel">
      <div class="lab">Sub-tactic ${'AB'[i]}${i === 0 ? ' · you start with this' : ' · switch to it mid-match'}</div>
      <div class="two">
        <div class="row"><label for="f${i}">Formation</label><select id="f${i}" data-tac="${i}" data-k="formation">${Object.keys(FORMATIONS).map(f => opt(f, f, f === t.formation)).join('')}</select></div>
        <div class="row"><label for="p${i}">Team playstyle</label><select id="p${i}" data-tac="${i}" data-k="playstyle">${PLAY_KEYS.map(k => opt(k, PLAYSTYLES[k].name, k === t.playstyle)).join('')}</select></div>
      </div>
      <p class="note">${FORMATIONS[t.formation].why}.</p>
      <dl class="kv"><dt>With the ball</dt><dd>${P.inPoss}</dd><dt>Without it</dt><dd>${P.outPoss}</dd><dt>Link-Up Play</dt><dd>${link}</dd>
        ${awk.length ? `<dt>Out of position</dt><dd class="f3">${awk.join(', ')}</dd>` : ''}</dl>
      <div class="prof"><u><s style="width:${(prof - 40) / 49 * 100}%"></s></u><b>${prof}</b></div>
      <p class="note">${mgr.name}'s proficiency in ${P.name}. The higher it is, the more of the playstyle the team actually plays.</p>
    </div>`;
  }
  function tacticsHtml() {
    const s = setup(), mgr = managerById(s.manager);
    const profs = PLAY_KEYS.map(k => `<div class="prof" style="grid-template-columns:9em 1fr 2.2em"><span>${PLAYSTYLES[k].name}</span><u><s style="width:${(mgr.prof[k] - 40) / 49 * 100}%"></s></u><b>${mgr.prof[k]}</b></div>`).join('');
    return `<div class="panel">
        <div class="row"><label for="mgr">Manager</label><select id="mgr">${MANAGERS.map(m => opt(m.id, `${m.name} · ${PLAYSTYLES[PLAY_KEYS.reduce((a, k) => m.prof[k] > m.prof[a] ? k : a)].name}`, m.id === s.manager)).join('')}</select></div>
        <p class="note">${mgr.note}. Boosters: <b class="f1">${mgr.boost.map(k => statName[k] + ' +1').join(', ')}</b> for every player. Coaching affinity: ${mgr.affinity} (kept for a future progression mode; it does nothing in a single match).</p>
        ${profs}
      </div>
      <div class="g2">${tacticHtml(0)}${tacticHtml(1)}</div>`;
  }

  // ---------- roles
  function rolesHtml() {
    const s = setup(), sq = squad(), xi = s.xi.map(i => sq.players[i]);
    const who = (cur, key, noGK) => xi.filter(p => !noGK || p.pos !== 'GK').map(p => opt(p.idx, `${p.name} · ${statName[key]} ${p.stats[key]}`, p.idx === cur)).join('');
    const instr = (side, n) => {
      const v = s.instr[side][n] || { p: '', type: '' };
      return `<div class="two"><select data-ins="${side}" data-n="${n}" data-k="p" aria-label="Player">${opt('', 'Nobody', !v.p && v.p !== 0)}${xi.filter(p => p.pos !== 'GK').map(p => opt(p.idx, `${p.name} (${p.pos})`, p.idx === v.p)).join('')}</select>
        <select data-ins="${side}" data-n="${n}" data-k="type" aria-label="Instruction">${Object.entries(INSTR[side]).map(([k, [name]]) => opt(k, name, k === v.type)).join('')}</select></div>`;
    };
    const explain = side => Object.values(INSTR[side]).map(([name, d]) => `<b>${name}</b>: ${d.toLowerCase()}`).join(' · ');
    return `<div class="g2">
      <div class="panel">
        <div class="lab">Set pieces and captain</div>
        <div class="row"><label for="rc">Captain</label><select id="rc" data-role="captain">${xi.map(p => opt(p.idx, `${p.name} (${p.pos})${p.skills.includes('Captaincy') ? ' · Captaincy' : ''}`, p.idx === s.captain)).join('')}</select></div>
        <div class="row"><label for="rf">Free kicks</label><select id="rf" data-role="fk">${who(s.takers.fk, 'setPiece', true)}</select></div>
        <div class="row"><label for="rk">Corners</label><select id="rk" data-role="ck">${who(s.takers.ck, 'loftPass', true)}</select></div>
        <div class="row"><label for="rp">Penalties</label><select id="rp" data-role="pk">${who(s.takers.pk, 'setPiece')}</select></div>
        <div class="row"><label>Centre-backs up for corners</label><div class="seg" data-role="cbUp">${[0, 1, 2].map(n => `<button data-v="${n}" aria-pressed="${s.cbUp === n}">${['None', 'One', 'Two'][n]}</button>`).join('')}</div></div>
        <p class="note">A captain with the Captaincy skill makes the whole team tire more slowly.</p>
      </div>
      <div class="panel">
        <div class="lab">Individual instructions</div>
        <p class="note">Two when you attack and two when you defend. An instruction overrides the player's own playing style.</p>
        <div class="row"><label>When attacking</label>${instr('att', 0)}${instr('att', 1)}<p class="note">${explain('att')}</p></div>
        <div class="row"><label>When defending</label>${instr('def', 0)}${instr('def', 1)}<p class="note">${explain('def')}</p></div>
      </div></div>`;
  }

  // ---------- skill moves
  function skillsHtml() {
    const s = setup(), sq = squad(), out = s.xi.map(i => sq.players[i]).filter(p => p.pos !== 'GK');
    const slot = dir => {
      const id = s.moves[dir], able = out.filter(p => canDo(p, id)).map(p => p.name);
      return `<div class="row"><label for="mv${dir}">Swipe ${dir}</label>
        <select id="mv${dir}" data-move="${dir}">${Object.entries(MOVES).filter(([, m]) => m.slot).map(([k, m]) => opt(k, `${m.name} · ${moveNeeds(k)}`, k === id)).join('')}</select>
        <p class="note">${able.length ? `${able.length} of ${out.length} outfield players can do it: ${able.join(', ')}` : '<span class="f4">Nobody in this eleven can do it</span>'}</p></div>`;
    };
    const table = Object.entries(MOVES).map(([, m]) => `<dt>${m.name}</dt><dd>${m.stars}★${m.skill ? ' and the ' + m.skill + ' skill' : ''}${m.how ? ' · ' + m.how : ''}</dd>`).join('');
    return `<div class="g2">
      <div class="panel"><div class="lab">Your four moves</div>
        <p class="note">Swipe off the Skill button (or anywhere on the right side) to play the move in that slot. A move needs enough skill-move stars and, for most, the matching skill. A player who lacks either cannot try it.</p>
        ${SLOT_DIRS.map(slot).join('')}</div>
      <div class="panel"><div class="lab">Every move</div><dl class="kv">${table}</dl>
        <p class="note">Tap Skill for a Body Feint. Hold it to shield the ball.</p></div></div>`;
  }

  function render() {
    const s = setup(), sq = squad();
    const body = tab === 'lineup' ? lineupHtml() : tab === 'tactics' ? tacticsHtml() : tab === 'roles' ? rolesHtml() : skillsHtml();
    const y = root.scrollTop;
    root.innerHTML = `<div class="tw">
      <div class="th"><h2>${sq.name} <span>${teamRating(s)}</span></h2><button class="go" data-act="done" style="font-size:20px;padding:8px 20px">Done</button></div>
      <div class="tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${n}</button>`).join('')}</div>
      ${body}</div>`;
    root.scrollTop = y;
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const s = setup();
    if (b.dataset.tab) { tab = b.dataset.tab; render(); root.scrollTop = 0; }
    else if (b.dataset.act === 'done') done();
    else if (b.dataset.act === 'best') { sel = null; commit({ ...s, xi: autoXI(squad(), s.tactics[0].formation) }); }
    else if (b.dataset.act === 'captain') commit({ ...s, captain: +b.dataset.p });
    else if (b.dataset.p !== undefined) tapPlayer(+b.dataset.p);
    else if (b.dataset.v !== undefined && b.parentElement.dataset.role === 'cbUp') commit({ ...s, cbUp: +b.dataset.v });
  });
  root.addEventListener('change', e => {
    const el = e.target, s = setup(), sq = squad();
    if (el.id === 'mgr') commit({ ...s, manager: el.value });
    else if (el.dataset.tac !== undefined) {
      const i = +el.dataset.tac, tactics = s.tactics.map(t => ({ ...t }));
      tactics[i][el.dataset.k] = el.value;
      let xi = s.xi;
      // a new starting formation: the same eleven, each moved to the slot that suits him best
      if (i === 0 && el.dataset.k === 'formation') xi = assignSlots(s.xi.map(x => sq.players[x]), el.value).map(p => p.idx);
      commit({ ...s, tactics, xi });
    }
    else if (el.dataset.role === 'captain') commit({ ...s, captain: +el.value });
    else if (el.dataset.role) commit({ ...s, takers: { ...s.takers, [el.dataset.role]: +el.value } });
    else if (el.dataset.ins) {
      const side = el.dataset.ins, n = +el.dataset.n, instr = { att: s.instr.att.slice(), def: s.instr.def.slice() };
      const row = el.parentElement, p = row.querySelector('[data-k="p"]').value, type = row.querySelector('[data-k="type"]').value;
      instr[side][n] = p === '' ? null : { p: +p, type };
      commit({ ...s, instr });
    }
    else if (el.dataset.move) commit({ ...s, moves: { ...s.moves, [el.dataset.move]: el.value } });
  });
  return { open() { sel = null; tab = 'lineup'; render(); root.hidden = false; root.scrollTop = 0; }, close() { root.hidden = true; } };
}
