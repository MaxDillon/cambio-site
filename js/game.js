// Cambio — deterministic state machine (2–4 players)
// Trust-based broadcast: every peer holds full state and applies events in order.
// The UI hides cards the local player isn't allowed to see.
//
// Hand model: hands[pid] is an array of slots { card, penalty }.
//   - "original" cards (penalty:false) render in a 2-column, row-major grid.
//   - "penalty" cards (penalty:true) render to the right, marked distinctly.
//   The grid can grow (penalties) or shrink (cards matched away).
//
// Deal size: 2 players → 6 cards each; 3–4 players → 4 cards each.
// Initial peek: the bottom two original cards (last two dealt).

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A','2','3','4','5','6','7','8','9','T','J','Q','K'];

export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_DISPLAY = { T: '10' };

export function cardRank(card) { return card.slice(0, -1); }
export function cardSuit(card) { return card.slice(-1); }
export function cardDisplay(card) { return RANK_DISPLAY[cardRank(card)] ?? cardRank(card); }
export function isRed(card) { const s = cardSuit(card); return s === 'H' || s === 'D'; }

// Cambio scoring: A=1, 2-10 face value, J/Q=10, black K=10, red K=-1
export function scoreValue(card) {
  const r = cardRank(card);
  if (r === 'A') return 1;
  if (r === 'K') return isRed(card) ? -1 : 10;
  if (r === 'Q' || r === 'J' || r === 'T') return 10;
  return parseInt(r, 10);
}

// Power triggered by discarding a drawn card (draw-pile only)
export function powerOf(card) {
  const r = cardRank(card);
  if (r === '7' || r === '8')  return 'PEEK_OWN';
  if (r === '9' || r === 'T')  return 'PEEK_OTHER';
  if (r === 'J' || r === 'Q')  return 'BLIND_SWAP';
  if (r === 'K')               return 'KING';
  return null;
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  return deck;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const MAX_PLAYERS = 4;

export class GameState {
  constructor(localPlayerId) {
    this.localPlayerId = localPlayerId;

    this.phase = 'LOBBY';          // LOBBY | PEEK | PLAYING | GAME_OVER
    this.players = [];
    this.spectators = [];
    this.ready = new Set();

    this.cardsPerPlayer = 4;
    this.hands = {};               // pid → [{ card, penalty }]
    this.drawPile = [];
    this.discardPile = [];

    this.peekReady = new Set();

    this.currentTurnIndex = 0;
    this.turnPhase = null;
    this.turnCount = 0;
    this.drawnCard = null;

    this.cambioCalledBy = null;
    this.finalTurnsRemaining = 0;

    // Flip mechanic
    this.pendingTransfer = null;   // { flipper, targetPid, slot } after matching an opponent's card
    this.processedFlips = new Set(); // flipIds already resolved (dedupe)

    this.scores = null;
    this.winner = null;
  }

  // ─── Roles / queries ───────────────────────────────────────────────────────
  get localRole() { return this.players.includes(this.localPlayerId) ? 'player' : 'spectator'; }
  get currentPlayerId() { return this.players[this.currentTurnIndex] ?? null; }
  isLocalTurn() { return this.currentPlayerId === this.localPlayerId; }
  get numPlayers() { return this.players.length; }
  get discardTop() { return this.discardPile[this.discardPile.length - 1] ?? null; }

  // Grid is 3 wide for 6-card (2-player) hands, otherwise 2 wide.
  //   6 cards:  0 1 2        4 cards:  0 1
  //             3 4 5                  2 3
  gridCols() { return this.cardsPerPlayer === 6 ? 3 : 2; }

  // Cards you look at in your OWN hand during the initial peek.
  //   6-card: the two OUTER bottom cards (3 and 5), skipping bottom-middle.
  //   4-card: the bottom row (2 and 3).
  ownPeekPositions() {
    return this.cardsPerPlayer === 6
      ? [3, 5]
      : [this.cardsPerPlayer - 2, this.cardsPerPlayer - 1];
  }

  // In 2-player you also peek ONE of the opponent's cards (their bottom-middle).
  opponentPeekPosition() {
    return this.cardsPerPlayer === 6 ? 4 : null;
  }

  bothReady() {
    return this.players.length >= 2 &&
           this.players.length <= MAX_PLAYERS &&
           this.players.every(p => this.ready.has(p));
  }

  canCallCambio(playerId) {
    return this.phase === 'PLAYING' &&
           this.turnPhase === 'DRAW' &&
           this.currentPlayerId === playerId &&
           this.cambioCalledBy === null &&
           this.turnCount >= this.numPlayers;
  }

  // Flips are allowed any time once cards are on the table (PEEK or PLAYING),
  // as long as no transfer is pending for the same flipper.
  canFlip() {
    return (this.phase === 'PLAYING' || this.phase === 'PEEK') && this.discardTop !== null;
  }

  // ─── Event application ─────────────────────────────────────────────────────
  applyEvent(event) {
    switch (event.type) {
      case 'PLAYER_JOINED':     return this._onPlayerJoined(event);
      case 'PLAYER_READY':      return this._onPlayerReady(event);
      case 'GAME_START':        return this._onGameStart(event);
      case 'PEEK_DONE':         return this._onPeekDone(event);
      case 'DRAW_FROM_PILE':    return this._onDrawFromPile(event);
      case 'TAKE_FROM_DISCARD': return this._onTakeFromDiscard(event);
      case 'SWAP_DRAWN':        return this._onSwapDrawn(event);
      case 'DISCARD_DRAWN':     return this._onDiscardDrawn(event);
      case 'POWER_PEEK_OWN':    return this._onPeekOwn(event);
      case 'POWER_PEEK_OTHER':  return this._onPeekOther(event);
      case 'POWER_BLIND_SWAP':  return this._onBlindSwap(event);
      case 'KING_PEEK_OWN':     return this._onKingPeekOwn(event);
      case 'KING_PEEK_OTHER':   return this._onKingPeekOther(event);
      case 'KING_SWAP':         return this._onKingSwap(event);
      case 'KING_SKIP':         return this._onKingSkip(event);
      case 'CALL_CAMBIO':       return this._onCallCambio(event);
      case 'FLIP':              return this._onFlip(event);
      case 'FLIP_TRANSFER':     return this._onFlipTransfer(event);
      default:                  return null;
    }
  }

  // ─── Lobby ───────────────────────────────────────────────────────────────
  _onPlayerJoined({ playerId, isRejoining }) {
    if (this.players.includes(playerId)) return { role: 'player', isRejoining: true };
    if (this.spectators.includes(playerId)) return { role: 'spectator', isRejoining: true };
    if (this.players.length < MAX_PLAYERS && this.phase === 'LOBBY') {
      this.players.push(playerId);
      return { role: 'player', isRejoining };
    }
    this.spectators.push(playerId);
    return { role: 'spectator', isRejoining };
  }

  _onPlayerReady({ playerId }) {
    if (!this.players.includes(playerId)) return null;
    this.ready.add(playerId);
    return { ready: [...this.ready] };
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────
  _onGameStart({ seed }) {
    if (this.phase !== 'LOBBY') return null;
    this.cardsPerPlayer = this.players.length === 2 ? 6 : 4;
    const deck = shuffle(makeDeck(), mulberry32(seed));
    let i = 0;
    this.hands = {};
    for (const p of this.players) {
      this.hands[p] = deck.slice(i, i + this.cardsPerPlayer).map(card => ({ card, penalty: false }));
      i += this.cardsPerPlayer;
    }
    this.discardPile = [deck[i]];
    this.drawPile = deck.slice(i + 1);

    this.peekReady = new Set();
    this.drawnCard = null;
    this.cambioCalledBy = null;
    this.finalTurnsRemaining = 0;
    this.pendingTransfer = null;
    this.processedFlips = new Set();
    this.phase = 'PEEK';
    return { started: true };
  }

  _onPeekDone({ playerId }) {
    if (this.phase !== 'PEEK') return null;
    if (!this.players.includes(playerId)) return null;
    this.peekReady.add(playerId);
    if (this.peekReady.size === this.players.length) {
      this.phase = 'PLAYING';
      this.currentTurnIndex = 0;
      this.turnPhase = 'DRAW';
      this.turnCount = 0;
    }
    return { peekReady: [...this.peekReady] };
  }

  // ─── Turn: drawing ─────────────────────────────────────────────────────────
  _onDrawFromPile({ playerId }) {
    if (!this._isActor(playerId, 'DRAW')) return null;
    if (this.drawPile.length === 0) this._recycleDiscard();
    const card = this.drawPile.shift();
    this.drawnCard = { card, source: 'pile' };
    this.turnPhase = 'DECIDE';
    return { drew: card };
  }

  _onTakeFromDiscard({ playerId }) {
    if (!this._isActor(playerId, 'DRAW')) return null;
    if (this.discardPile.length === 0) return null;
    const card = this.discardPile.pop();
    this.drawnCard = { card, source: 'discard' };
    this.turnPhase = 'SWAP_REQUIRED';
    return { drew: card };
  }

  // ─── Turn: resolving the drawn card ─────────────────────────────────────────
  _onSwapDrawn({ playerId, pos }) {
    if (this.currentPlayerId !== playerId) return null;
    if (this.turnPhase !== 'DECIDE' && this.turnPhase !== 'SWAP_REQUIRED') return null;
    if (!this.drawnCard) return null;
    const slot = this.hands[playerId][pos];
    if (!slot) return null;
    const old = slot.card;
    slot.card = this.drawnCard.card;   // keep the slot's penalty flag
    this.discardPile.push(old);
    this.drawnCard = null;
    this._endTurn();
    return { swappedOut: old };
  }

  _onDiscardDrawn({ playerId }) {
    if (!this._isActor(playerId, 'DECIDE')) return null;
    if (!this.drawnCard) return null;
    const card = this.drawnCard.card;
    this.discardPile.push(card);
    this.drawnCard = null;

    const power = powerOf(card);
    if (!power) { this._endTurn(); return { discarded: card, power: null }; }
    switch (power) {
      case 'PEEK_OWN':   this.turnPhase = 'POWER_OWN'; break;
      case 'PEEK_OTHER': this.turnPhase = 'POWER_OTHER'; break;
      case 'BLIND_SWAP': this.turnPhase = 'POWER_SWAP'; break;
      case 'KING':       this.turnPhase = 'KING_PEEK_OWN'; break;
    }
    return { discarded: card, power };
  }

  // ─── Turn: powers ──────────────────────────────────────────────────────────
  _onPeekOwn({ playerId, pos }) {
    if (!this._isActor(playerId, 'POWER_OWN')) return null;
    this._endTurn();
    return { reveal: { pid: playerId, pos } };
  }
  _onPeekOther({ playerId, targetId, pos }) {
    if (!this._isActor(playerId, 'POWER_OTHER')) return null;
    if (targetId === playerId || !this.players.includes(targetId)) return null;
    this._endTurn();
    return { reveal: { pid: targetId, pos } };
  }
  _onBlindSwap({ playerId, a, b }) {
    if (!this._isActor(playerId, 'POWER_SWAP')) return null;
    this._swapCards(a, b);
    this._endTurn();
    return { swap: [a, b] };
  }
  _onKingPeekOwn({ playerId, pos }) {
    if (!this._isActor(playerId, 'KING_PEEK_OWN')) return null;
    this.turnPhase = 'KING_PEEK_OTHER';
    return { reveal: { pid: playerId, pos } };
  }
  _onKingPeekOther({ playerId, targetId, pos }) {
    if (!this._isActor(playerId, 'KING_PEEK_OTHER')) return null;
    if (targetId === playerId || !this.players.includes(targetId)) return null;
    this.turnPhase = 'KING_SWAP';
    return { reveal: { pid: targetId, pos } };
  }
  _onKingSwap({ playerId, a, b }) {
    if (!this._isActor(playerId, 'KING_SWAP')) return null;
    this._swapCards(a, b);
    this._endTurn();
    return { swap: [a, b] };
  }
  _onKingSkip({ playerId }) {
    if (!this._isActor(playerId, 'KING_SWAP')) return null;
    this._endTurn();
    return { skipped: true };
  }

  // ─── Cambio ──────────────────────────────────────────────────────────────
  _onCallCambio({ playerId }) {
    if (!this.canCallCambio(playerId)) return null;
    this.cambioCalledBy = playerId;
    this.finalTurnsRemaining = this.numPlayers;
    this._advanceTurn();
    return { cambio: playerId };
  }

  // ─── Flip / match (any time, any player) ────────────────────────────────────
  _onFlip({ flipId, flipper, targetPid, pos }) {
    if (flipId && this.processedFlips.has(flipId)) return null; // dedupe
    if (!this.canFlip()) return null;
    if (!this.players.includes(flipper)) return null;
    const targetHand = this.hands[targetPid];
    if (!targetHand || !targetHand[pos]) return null;
    // A flipper resolving a transfer can't start another flip first
    if (this.pendingTransfer && this.pendingTransfer.flipper === flipper) return null;
    if (flipId) this.processedFlips.add(flipId);

    const attemptedCard = targetHand[pos].card;
    const top = this.discardTop;
    const match = top && cardRank(attemptedCard) === cardRank(top);

    if (!match) {
      // Penalty: draw a card face-down into the flipper's grid (marked penalty)
      if (this.drawPile.length === 0) this._recycleDiscard();
      const pen = this.drawPile.shift();
      if (pen) this.hands[flipper].push({ card: pen, penalty: true });
      return {
        flip: 'fail', flipper, targetPid, pos,
        attemptedCard,                 // for the flipper's own reveal
        penaltyCard: pen,
      };
    }

    // Success — remove the matched card from the target's hand
    targetHand.splice(pos, 1);
    this.discardPile.push(attemptedCard); // same rank, becomes new top

    if (targetPid === flipper) {
      // Matched your own card → just lose it
      this._maybeEndByEmpty(flipper);
      return { flip: 'success-own', flipper, targetPid, pos, matchedCard: attemptedCard };
    }

    // Matched an opponent's card → flipper must hand over one of their own
    this.pendingTransfer = { flipper, targetPid, slot: pos };
    return { flip: 'success-opp', flipper, targetPid, pos, matchedCard: attemptedCard };
  }

  _onFlipTransfer({ flipper, pos }) {
    if (!this.pendingTransfer || this.pendingTransfer.flipper !== flipper) return null;
    const { targetPid, slot } = this.pendingTransfer;
    const giveSlot = this.hands[flipper][pos];
    if (!giveSlot) return null;
    // Move the chosen card from flipper → opponent's freed slot (keeps opp count steady)
    this.hands[flipper].splice(pos, 1);
    const insertAt = Math.min(slot, this.hands[targetPid].length);
    this.hands[targetPid].splice(insertAt, 0, { card: giveSlot.card, penalty: false });
    this.pendingTransfer = null;
    this._maybeEndByEmpty(flipper);
    return { transfer: 'done', flipper, targetPid, gave: giveSlot.card };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────
  _isActor(playerId, requiredPhase) {
    return this.phase === 'PLAYING' &&
           this.currentPlayerId === playerId &&
           this.turnPhase === requiredPhase;
  }

  _swapCards(a, b) {
    const tmp = this.hands[a.pid][a.pos].card;
    this.hands[a.pid][a.pos].card = this.hands[b.pid][b.pos].card;
    this.hands[b.pid][b.pos].card = tmp;
  }

  _recycleDiscard() {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile.pop();
    this.drawPile = this.discardPile.slice();
    this.discardPile = [top];
  }

  // Emptying your hand by matching all your cards away is an instant win.
  _maybeEndByEmpty(pid) {
    if (this.phase !== 'GAME_OVER' && this.hands[pid] && this.hands[pid].length === 0) {
      this._endGame(pid);
    }
  }

  _endTurn() {
    this.drawnCard = null;
    this._advanceTurn();
  }

  _advanceTurn() {
    if (this.cambioCalledBy !== null) {
      this.finalTurnsRemaining--;
      if (this.finalTurnsRemaining <= 0) { this._endGame(); return; }
    }
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.numPlayers;
    this.turnPhase = 'DRAW';
    this.turnCount++;
  }

  _endGame(forcedWinner = null) {
    this.scores = {};
    for (const p of this.players) {
      this.scores[p] = this.hands[p].reduce((s, slot) => s + scoreValue(slot.card), 0);
    }
    let best = forcedWinner;
    if (best === null) {
      for (const p of this.players) {
        if (best === null || this.scores[p] < this.scores[best]) best = p;
      }
    }
    this.winner = best;
    this.phase = 'GAME_OVER';
    this.turnPhase = null;
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────────
  snapshot() {
    return {
      phase: this.phase,
      players: [...this.players],
      spectators: [...this.spectators],
      ready: [...this.ready],
      cardsPerPlayer: this.cardsPerPlayer,
      hands: JSON.parse(JSON.stringify(this.hands)),
      drawPile: [...this.drawPile],
      discardPile: [...this.discardPile],
      peekReady: [...this.peekReady],
      currentTurnIndex: this.currentTurnIndex,
      turnPhase: this.turnPhase,
      turnCount: this.turnCount,
      drawnCard: this.drawnCard ? { ...this.drawnCard } : null,
      cambioCalledBy: this.cambioCalledBy,
      finalTurnsRemaining: this.finalTurnsRemaining,
      pendingTransfer: this.pendingTransfer ? { ...this.pendingTransfer } : null,
      processedFlips: [...this.processedFlips],
      scores: this.scores,
      winner: this.winner,
    };
  }

  loadSnapshot(s) {
    this.phase = s.phase;
    this.players = s.players;
    this.spectators = s.spectators;
    this.ready = new Set(s.ready);
    this.cardsPerPlayer = s.cardsPerPlayer ?? 4;
    this.hands = s.hands;
    this.drawPile = s.drawPile;
    this.discardPile = s.discardPile;
    this.peekReady = new Set(s.peekReady);
    this.currentTurnIndex = s.currentTurnIndex;
    this.turnPhase = s.turnPhase;
    this.turnCount = s.turnCount;
    this.drawnCard = s.drawnCard;
    this.cambioCalledBy = s.cambioCalledBy;
    this.finalTurnsRemaining = s.finalTurnsRemaining;
    this.pendingTransfer = s.pendingTransfer ?? null;
    this.processedFlips = new Set(s.processedFlips ?? []);
    this.scores = s.scores;
    this.winner = s.winner;
  }
}
