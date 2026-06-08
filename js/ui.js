// Cambio UI — renders the table from GameState + local visibility.
import { cardDisplay, cardSuit, isRed, SUIT_SYMBOL } from './game.js';

const PEEK_MS = 5000;
// Per-player accent colors (assigned by seat index)
const PLAYER_COLORS = ['#e0563f', '#3f9be0', '#5fd97a', '#c98ae2'];

export class UI {
  constructor(game, localPlayerId, playerNames) {
    this.game = game;
    this.localPlayerId = localPlayerId;
    this.playerNames = playerNames;
    this.networkReady = false;

    this.revealed = new Set();   // "pid:pos" temporarily face-up to this client
    this._timers = new Map();
    this.selectBuffer = [];      // two-pick buffer for swaps

    this.onReady = this.onPeekDone = this.onDraw = this.onTakeDiscard = null;
    this.onCallCambio = this.onSwapDrawn = this.onDiscardDrawn = null;
    this.onCardSelect = this.onKingSkip = this.onNewGame = null;

    this._bindStaticButtons();
  }

  name(pid) { return this.playerNames?.get(pid) ?? 'Player'; }
  colorFor(pid) {
    const i = this.game.players.indexOf(pid);
    return i === -1 ? '#999' : PLAYER_COLORS[i % PLAYER_COLORS.length];
  }

  _bindStaticButtons() {
    const on = (id, cb) => document.getElementById(id)?.addEventListener('click', () => cb?.());
    on('btn-ready',    () => this.onReady?.());
    on('btn-peek-done',() => this.onPeekDone?.());
    on('btn-cambio',   () => this.onCallCambio?.());
    on('btn-discard-drawn', () => this.onDiscardDrawn?.());
    on('btn-king-skip',() => this.onKingSkip?.());
    on('btn-new-game', () => this.onNewGame?.());

    // Clicking the piles draws / takes the discard (gated to your DRAW phase)
    on('draw-pile', () => { if (this._canDraw()) this.onDraw?.(); });
    on('discard-pile', () => { if (this._canTakeDiscard()) this.onTakeDiscard?.(); });
  }

  _canDraw() {
    const g = this.game;
    return g.isLocalTurn() && g.turnPhase === 'DRAW' && !g.pendingTransfer;
  }
  _canTakeDiscard() {
    return this._canDraw() && this.game.discardPile.length > 0;
  }

  // ─── Temporary reveals ────────────────────────────────────────────────────
  reveal(pid, pos, ms = PEEK_MS) {
    const key = `${pid}:${pos}`;
    this.revealed.add(key);
    if (this._timers.has(key)) clearTimeout(this._timers.get(key));
    this._timers.set(key, setTimeout(() => {
      this.revealed.delete(key);
      this._timers.delete(key);
      this.render();
    }, ms));
    this.render();
  }

  _isVisible(pid, pos) {
    const g = this.game;
    if (g.phase === 'GAME_OVER') return true;
    if (g.phase === 'PEEK' && !g.peekReady.has(this.localPlayerId)) {
      // Your own peek cards
      if (pid === this.localPlayerId && g.ownPeekPositions().includes(pos)) return true;
      // In 2-player, also peek one of the opponent's cards
      const oppPeek = g.opponentPeekPosition();
      if (oppPeek !== null && g.players.length === 2 &&
          pid !== this.localPlayerId && pos === oppPeek) return true;
    }
    return this.revealed.has(`${pid}:${pos}`);
  }

  clearSelection() { this.selectBuffer = []; }

  toast(msg, duration = 2600) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  // ─── Flip feedback ────────────────────────────────────────────────────────
  // Call AFTER render(): briefly highlight the attempted card / target panel
  // in the flipper's color.
  flashFlip({ flipper, targetPid, pos, success }) {
    const color = this.colorFor(flipper);
    if (success) {
      const panel = document.querySelector(`.player-panel[data-pid="${targetPid}"]`);
      if (panel) {
        panel.style.setProperty('--flip-color', color);
        panel.classList.add('flip-hit');
        setTimeout(() => panel.classList.remove('flip-hit'), 900);
      }
    } else {
      const el = document.querySelector(`.grid-card[data-pid="${targetPid}"][data-pos="${pos}"]`);
      if (el) {
        el.style.setProperty('--flip-color', color);
        el.classList.add('flip-miss');
        setTimeout(() => el.classList.remove('flip-miss'), 900);
      }
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  render() {
    const g = this.game;
    this._show('lobby-panel',    g.phase === 'LOBBY');
    this._show('peek-panel',     g.phase === 'PEEK');
    this._show('table',          g.phase !== 'LOBBY');
    this._show('gameover-panel', g.phase === 'GAME_OVER');

    this._renderStatus();

    const banner = document.getElementById('spectator-banner');
    if (banner) banner.style.display =
      (this.networkReady && g.localRole === 'spectator' && g.phase !== 'LOBBY') ? 'flex' : 'none';

    if (g.phase === 'LOBBY') { this._renderLobby(); return; }

    this._renderTable();
    if (g.phase === 'PEEK')      this._renderPeekControls();
    if (g.phase === 'PLAYING')   this._renderActionControls();
    if (g.phase === 'GAME_OVER') this._renderGameOver();
  }

  _renderStatus() {
    const g = this.game;
    const el = document.getElementById('status-text');
    if (!el) return;
    let txt = '';

    // Pending-transfer takes priority in the status line
    if (g.pendingTransfer) {
      const f = g.pendingTransfer.flipper, t = g.pendingTransfer.targetPid;
      txt = f === this.localPlayerId
        ? `You matched ${this.name(t)}'s card — pick one of YOUR cards to give them`
        : `${this.name(f)} matched ${this.name(t)}'s card — choosing a card to give…`;
      el.textContent = txt;
      return;
    }

    if (g.phase === 'LOBBY') {
      if (g.players.length < 2) txt = `Waiting for players… (${g.players.length}/4)`;
      else if (!g.bothReady())  txt = 'Waiting for everyone to press Ready…';
      else txt = 'Starting…';
    } else if (g.phase === 'PEEK') {
      const peekDesc = g.players.length === 2
        ? 'your two outer bottom cards + one of your opponent\'s'
        : 'your bottom two cards';
      txt = `Memorize ${peekDesc} — ${g.peekReady.size}/${g.players.length} ready · you may flip any time`;
    } else if (g.phase === 'PLAYING') {
      const who = g.isLocalTurn() ? 'Your turn' : `${this.name(g.currentPlayerId)}'s turn`;
      txt = who + this._phaseHint();
      if (g.cambioCalledBy) txt = `⚠️ ${this.name(g.cambioCalledBy)} called Cambio! ` + txt;
    } else if (g.phase === 'GAME_OVER') {
      txt = `${this.name(g.winner)} wins!`;
    }
    el.textContent = txt;
  }

  _phaseHint() {
    if (!this.game.isLocalTurn()) return ' · click any card to flip-match';
    switch (this.game.turnPhase) {
      case 'DRAW':          return ' — click the draw or discard pile, or flip a card';
      case 'DECIDE':        return ' — swap into your grid, or discard';
      case 'SWAP_REQUIRED': return ' — pick a card to swap out';
      case 'POWER_OWN':     return ' — peek at one of YOUR cards';
      case 'POWER_OTHER':   return " — peek at an OPPONENT's card";
      case 'POWER_SWAP':    return ' — blind-swap: pick any two cards';
      case 'KING_PEEK_OWN':   return ' — King: peek at one of YOUR cards';
      case 'KING_PEEK_OTHER': return " — King: peek at an OPPONENT's card";
      case 'KING_SWAP':     return ' — King: swap any two cards (or skip)';
      default: return '';
    }
  }

  // ─── Lobby ──────────────────────────────────────────────────────────────
  _renderLobby() {
    const g = this.game;
    const isPlayer = g.localRole === 'player';
    const alreadyReady = g.ready.has(this.localPlayerId);
    const btn = document.getElementById('btn-ready');
    if (btn) btn.style.display = (isPlayer && !alreadyReady) ? 'inline-block' : 'none';

    const list = document.getElementById('lobby-players');
    if (list) {
      const rows = g.players.map((p, i) => {
        const isReady = g.ready.has(p);
        const isLocal = p === this.localPlayerId;
        return `<div class="lobby-player" style="border-left:4px solid ${this.colorFor(p)}">
          <span class="lobby-player-name">${this.name(p)}${isLocal ? ' (you)' : ''}</span>
          <span class="lobby-ready ${isReady ? 'is-ready' : ''}">${isReady ? '✓ Ready' : 'Not ready'}</span>
        </div>`;
      });
      for (let i = g.players.length; i < 4; i++)
        rows.push(`<div class="lobby-player waiting-slot">Open seat ${i + 1}…</div>`);
      list.innerHTML = rows.join('');
    }

    const spec = document.getElementById('lobby-spectators');
    if (spec) spec.textContent = g.spectators.length
      ? `Spectators: ${g.spectators.map(p => this.name(p)).join(', ')}` : '';
  }

  // ─── Table ──────────────────────────────────────────────────────────────
  _seatOrder() {
    const g = this.game;
    const n = g.players.length;
    const myIdx = g.players.indexOf(this.localPlayerId);
    const start = myIdx === -1 ? 0 : myIdx;
    const opp = [];
    for (let i = 1; i < n; i++) opp.push(g.players[(start + i) % n]);
    return { local: myIdx === -1 ? null : this.localPlayerId, opponents: opp };
  }

  _renderTable() {
    const g = this.game;
    const { local, opponents } = this._seatOrder();

    const oppWrap = document.getElementById('opponents');
    if (oppWrap) oppWrap.innerHTML = opponents.map(pid => this._playerPanelHTML(pid, false)).join('');

    const localWrap = document.getElementById('local-area');
    if (localWrap) localWrap.innerHTML = local
      ? this._playerPanelHTML(local, true)
      : '<div class="spectating-note">Spectating</div>';

    this._renderCenter();

    document.querySelectorAll('.grid-card, .penalty-card').forEach(el => {
      el.addEventListener('click', () => {
        this.onCardSelect?.(el.dataset.pid, parseInt(el.dataset.pos, 10));
      });
    });
  }

  _playerPanelHTML(pid, isLocal) {
    const g = this.game;
    const hand = g.hands[pid] ?? [];
    const isCurrent = g.currentPlayerId === pid && g.phase === 'PLAYING';
    const calledCambio = g.cambioCalledBy === pid;
    const color = this.colorFor(pid);

    const cardHTML = (slot, idx) => {
      const visible = this._isVisible(pid, idx);
      const selected = this.selectBuffer.some(s => s.pid === pid && s.pos === idx);
      const cls = slot.penalty ? 'penalty-card' : 'grid-card';
      return `<div class="${cls} ${visible ? 'face-up' : 'face-down'} ${selected ? 'selected' : ''}"
                   data-pid="${pid}" data-pos="${idx}">
                ${visible ? this._cardFace(slot.card) : ''}
                ${slot.penalty ? '<span class="pen-badge">+</span>' : ''}
              </div>`;
    };

    const originals = [];
    const penalties = [];
    hand.forEach((slot, idx) => (slot.penalty ? penalties : originals).push(cardHTML(slot, idx)));

    const scoreTag = g.phase === 'GAME_OVER' && g.scores
      ? `<span class="panel-score">${g.scores[pid]} pts</span>` : '';

    return `<div class="player-panel ${isCurrent ? 'current-turn' : ''} ${isLocal ? 'local' : ''}"
                 data-pid="${pid}" style="--seat-color:${color}">
      <div class="panel-header">
        <span class="seat-dot" style="background:${color}"></span>
        <span class="panel-name">${this.name(pid)}${isLocal ? ' (you)' : ''}</span>
        ${calledCambio ? '<span class="cambio-flag">CAMBIO</span>' : ''}
        ${scoreTag}
      </div>
      <div class="hand">
        <div class="card-grid" style="grid-template-columns:repeat(${g.gridCols()},auto)">${originals.join('')}</div>
        ${penalties.length ? `<div class="penalty-strip">${penalties.join('')}</div>` : ''}
      </div>
    </div>`;
  }

  _renderCenter() {
    const g = this.game;
    const drawEl = document.getElementById('draw-pile');
    if (drawEl) {
      drawEl.innerHTML = g.drawPile.length
        ? `<div class="card face-down pile-card"></div>`
        : `<div class="pile-empty">empty</div>`;
      drawEl.classList.toggle('pile-actionable', this._canDraw());
      const cnt = document.getElementById('draw-count');
      if (cnt) cnt.textContent = `${g.drawPile.length} left`;
    }
    const discEl = document.getElementById('discard-pile');
    if (discEl) {
      const top = g.discardTop;
      discEl.innerHTML = top
        ? `<div class="card face-up pile-card">${this._cardFace(top)}</div>`
        : `<div class="pile-empty">empty</div>`;
      discEl.classList.toggle('pile-actionable', this._canTakeDiscard());
    }
    const drawnEl = document.getElementById('drawn-card');
    if (drawnEl) {
      if (g.drawnCard && (g.isLocalTurn() || g.drawnCard.source === 'discard'))
        drawnEl.innerHTML = `<div class="card face-up drawn">${this._cardFace(g.drawnCard.card)}</div>`;
      else if (g.drawnCard)
        drawnEl.innerHTML = `<div class="card face-down drawn"></div>`;
      else
        drawnEl.innerHTML = '';
    }
  }

  _cardFace(card) {
    const sym = SUIT_SYMBOL[cardSuit(card)];
    const color = isRed(card) ? 'red' : 'black';
    return `<span class="cf ${color}"><span class="cf-rank">${cardDisplay(card)}</span><span class="cf-suit">${sym}</span></span>`;
  }

  // ─── Controls ──────────────────────────────────────────────────────────────
  _renderPeekControls() {
    const g = this.game;
    const done = g.peekReady.has(this.localPlayerId);
    const btn = document.getElementById('btn-peek-done');
    if (btn) btn.style.display = (g.localRole === 'player' && !done) ? 'inline-block' : 'none';
    this._toggleActionBar(false);
  }

  _renderActionControls() {
    const g = this.game;
    const myTurn = g.isLocalTurn() && !g.pendingTransfer;
    this._toggleActionBar(myTurn);
    if (!myTurn) { if (!g.pendingTransfer) this.clearSelection(); return; }
    const setVis = (id, vis) => { const el = document.getElementById(id); if (el) el.style.display = vis ? 'inline-block' : 'none'; };
    const tp = g.turnPhase;
    setVis('btn-cambio',        g.canCallCambio(this.localPlayerId));
    setVis('btn-discard-drawn', tp === 'DECIDE');
    setVis('btn-king-skip',     tp === 'KING_SWAP');
  }

  _toggleActionBar(visible) {
    const bar = document.getElementById('action-bar');
    if (bar) bar.style.display = visible ? 'flex' : 'none';
  }

  _renderGameOver() {
    const g = this.game;
    const el = document.getElementById('gameover-message');
    if (!el) return;
    const youWon = g.winner === this.localPlayerId;
    const lines = g.players.slice().sort((a, b) => g.scores[a] - g.scores[b])
      .map(p => `<div class="score-line ${p === g.winner ? 'winner' : ''}">
        ${this.name(p)}${p === this.localPlayerId ? ' (you)' : ''}: <strong>${g.scores[p]}</strong>
      </div>`).join('');
    el.innerHTML = `<div class="${youWon ? 'win-text' : 'loss-text'}">
        ${youWon ? 'You win! 🎉' : `${this.name(g.winner)} wins`}
      </div><div class="final-scores">${lines}</div>`;
  }

  _show(id, visible) { const el = document.getElementById(id); if (el) el.style.display = visible ? '' : 'none'; }
}
