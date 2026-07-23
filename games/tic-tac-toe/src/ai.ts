import { makeMove, availableMoves, type Game, type Player } from './game.js';

// Utility function to get the numerical score of a terminal state
function getScore(game: Game, maxPlayer: Player, depth: number): number {
  if (game.status === 'won') {
    // Win is 10, Draw is 0, Loss is -10. We subtract/add depth for faster wins/slower losses.
    if (game.winner === maxPlayer) {
      return 10 - depth; // Maximize (closer to 10)
    }
    return -10 + depth; // Minimize (closer to -10)
  }
  return 0; // Draw
}

function minimax(game: Game, maxPlayer: Player, depth: number): number {
  if (game.status !== 'playing') {
    return getScore(game, maxPlayer, depth);
  }

  depth++;
  const moves = availableMoves(game.board);
  const isMaximizingTurn = game.currentPlayer === maxPlayer;

  if (isMaximizingTurn) {
    let bestScore = -Infinity;
    for (const move of moves) {
      const newState = makeMove(game, move);
      bestScore = Math.max(bestScore, minimax(newState, maxPlayer, depth));
    }
    return bestScore;
  } else {
    let bestScore = Infinity;
    for (const move of moves) {
      const newState = makeMove(game, move);
      bestScore = Math.min(bestScore, minimax(newState, maxPlayer, depth));
    }
    return bestScore;
  }
}

/**
 * Finds the optimal move for the current player using the Minimax algorithm.
 * This guarantees a perfect, non-losing strategy.
 * @param game The current game state.
 * @returns The index (0-8) of the best move.
 */
export function findBestMove(game: Game): number {
  if (game.status !== 'playing') {
    throw new Error('Cannot find a move in a non-playing game state.');
  }

  const maxPlayer = game.currentPlayer;
  let bestScore = -Infinity;
  let bestMove = -1;
  let depth = 0;

  const moves = availableMoves(game.board);
  
  // To ensure the AI selects the best move when multiple are available with the same score,
  // we iterate through all possible moves and find the one that yields the highest score.
  // Note: Minimax is expensive, but for a 9-move board it is manageable.
  for (const move of moves) {
    const newState = makeMove(game, move);
    // The next move is the minimizing player's move
    const score = minimax(newState, maxPlayer, depth);

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}