import * as assert from 'assert/strict';
import {
  createGame,
  makeMove,
  availableMoves,
  getWinner,
  type Board,
  type Game,
  type Player,
} from '../src/game.js';
import { findBestMove } from '../src/ai.js';

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log('[PASS] ' + name);
  } catch (error) {
    console.error('[FAIL] ' + name);
    console.error(error);
    process.exit(1);
  }
}

// --- Helper for move sequences ---

function applyMoves(initialState: Game, moves: number[]): Game {
  let state = initialState;
  for (const move of moves) {
    state = makeMove(state, move);
  }
  return state;
}

// --- Game Engine Tests (game.ts) ---

runTest('Game: createGame initializes correctly', () => {
  const game = createGame();
  assert.equal(game.status, 'playing');
  assert.equal(game.currentPlayer, 'X');
  assert.equal(game.moveCount, 0);
  assert.deepEqual(game.board.every(s => s === null), true);
});

runTest('Game: makeMove changes board and switches player', () => {
  let game = createGame();
  game = makeMove(game, 0); // X plays
  assert.equal(game.board[0], 'X');
  assert.equal(game.currentPlayer, 'O');
  assert.equal(game.moveCount, 1);
});

runTest('Game: makeMove rejects occupied square', () => {
  let game = createGame();
  game = makeMove(game, 0); // X plays
  const gameBefore = game;
  const gameAfter = makeMove(game, 0); // O tries to play 0
  
  assert.deepEqual(gameBefore.board, gameAfter.board, 'Board should not change');
  assert.equal(gameBefore.currentPlayer, gameAfter.currentPlayer, 'Player should not change');
  assert.equal(gameBefore.moveCount, gameAfter.moveCount, 'Move count should not change');
});

runTest('Game: detects win - horizontal', () => {
  // X wins on top row (0, 1, 2)
  let game = createGame();
  game = makeMove(game, 0); // X
  game = makeMove(game, 3); // O
  game = makeMove(game, 1); // X
  game = makeMove(game, 4); // O
  game = makeMove(game, 2); // X WIN

  assert.equal(game.status, 'won');
  assert.equal(game.winner, 'X');
  assert.deepEqual(game.winningLine, [0, 1, 2]);
});

runTest('Game: detects win - diagonal (2, 4, 6)', () => {
  // O wins on diagonal (2, 4, 6)
  let game = createGame('O'); // O starts
  game = makeMove(game, 2); // O
  game = makeMove(game, 0); // X
  game = makeMove(game, 4); // O
  game = makeMove(game, 1); // X
  game = makeMove(game, 6); // O WIN

  assert.equal(game.status, 'won');
  assert.equal(game.winner, 'O');
  assert.deepEqual(game.winningLine, [2, 4, 6]);
});

runTest('Game: detects draw', () => {
  // X: 0, 1, 5, 6, 7
  // O: 2, 3, 4, 8
  const moves = [
    0, // X
    2, // O
    1, // X
    3, // O
    5, // X
    4, // O
    6, // X
    8, // O
    7, // X DRAW
  ];
  const game = applyMoves(createGame(), moves);
  
  assert.equal(game.status, 'draw');
  assert.equal(game.winner, null);
  assert.equal(game.moveCount, 9);
});

runTest('Game: rejects move after game is won', () => {
  // X wins on top row (0, 1, 2)
  let game = createGame();
  game = makeMove(game, 0); // X
  game = makeMove(game, 3); // O
  game = makeMove(game, 1); // X
  game = makeMove(game, 4); // O
  game = makeMove(game, 2); // X WIN
  
  const gameAfter = makeMove(game, 8); // O tries to move
  assert.deepEqual(gameAfter, game, 'State should not change after win');
});

runTest('Game: availableMoves works correctly', () => {
  const board: Board = ['X', null, 'O', null, null, null, null, null, 'X'];
  const moves = availableMoves(board);
  assert.deepEqual(moves, [1, 3, 4, 5, 6, 7]);
});


// --- AI Tests (ai.ts) ---

runTest('AI: takes immediate win (X)', () => {
  // Board state where X can win at 8
  // X: 0, 4
  // O: 1, 3
  // Board: [X, O, null, O, X, null, null, null, null]
  let game = createGame();
  game = makeMove(game, 0); // X
  game = makeMove(game, 1); // O
  game = makeMove(game, 4); // X
  game = makeMove(game, 3); // O
  // Current Player: X (AI)
  
  const bestMove = findBestMove(game);
  assert.equal(bestMove, 8, 'AI should take winning move 8 (diagonal 0, 4, 8)');
  
  const gameAfter = makeMove(game, bestMove);
  assert.equal(gameAfter.status, 'won');
  assert.equal(gameAfter.winner, 'X');
});



runTest('AI: plays perfectly (draw or win)', () => {
  // Test a game sequence that should result in a draw if both play perfectly (AI vs AI)
  // X (AI) starts.
  let game = createGame('X');
  
  // Game 1: X (AI) vs O (AI)
  for (let i = 0; i < 9; i++) {
    if (game.status !== 'playing') break;
    const move = findBestMove(game);
    game = makeMove(game, move);
  }
  
  assert.equal(game.status, 'draw', 'Perfect AI should not lose when playing first against perfect opponent (results in draw).');
  
  // Game 2: O (AI) vs X (Human/Random - but we'll force first move to center)
  game = createGame('O');
  
  // X (human) plays center
  game = makeMove(game, 4); 

  // Now O (AI) plays
  for (let i = 0; i < 8; i++) {
    if (game.status !== 'playing') break;
    const move = findBestMove(game);
    game = makeMove(game, move);
  }
  
  // If O starts second and X plays center, the best O can do is force a draw.
  assert.notEqual(game.winner, 'X', 'O (AI) should not lose to X when playing second');
});


console.log('--- All Tic-Tac-Toe tests completed successfully ---');
