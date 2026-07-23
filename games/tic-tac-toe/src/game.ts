export type Player = 'X' | 'O';
export type Square = Player | null;
export type Board = [Square, Square, Square, Square, Square, Square, Square, Square, Square];
export type GameStatus = 'playing' | 'won' | 'draw';
export type Line = [number, number, number];

export interface Game {
  board: Board;
  currentPlayer: Player;
  status: GameStatus;
  winner: Player | null;
  winningLine: Line | null;
  moveCount: number;
}

const WINNING_LINES: Line[] = [
  // Rows
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  // Columns
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  // Diagonals
  [0, 4, 8], [2, 4, 6],
];

export function getWinner(board: Board): { winner: Player | null; winningLine: Line | null } {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    const player = board[a];
    if (player && player === board[b] && player === board[c]) {
      return { winner: player, winningLine: line };
    }
  }
  return { winner: null, winningLine: null };
}

export function createGame(startingPlayer: Player = 'X'): Game {
  const emptyBoard: Board = [null, null, null, null, null, null, null, null, null];
  return {
    board: emptyBoard,
    currentPlayer: startingPlayer,
    status: 'playing',
    winner: null,
    winningLine: null,
    moveCount: 0,
  };
}

export function availableMoves(board: Board): number[] {
  if (!board) return [];
  return board.map((square, index) => square === null ? index : -1)
              .filter(index => index !== -1);
}

function getNextPlayer(currentPlayer: Player): Player {
  return currentPlayer === 'X' ? 'O' : 'X';
}

export function makeMove(state: Game, index: number): Game {
  // 1. Check if the game is already over
  if (state.status !== 'playing') {
    return state; // Illegal move: game over
  }

  // 2. Check if the index is valid and the square is empty
  if (index < 0 || index > 8 || state.board[index] !== null) {
    return state; // Illegal move: out of bounds or occupied
  }

  // 3. Create the new board
  const newBoard: Board = [...state.board];
  newBoard[index] = state.currentPlayer;

  // 4. Check for winner/draw
  const { winner, winningLine } = getWinner(newBoard);
  const newMoveCount = state.moveCount + 1;

  if (winner) {
    return {
      ...state,
      board: newBoard,
      status: 'won',
      winner,
      winningLine,
      moveCount: newMoveCount,
    };
  }

  // Check for draw (board is full and no winner)
  if (newMoveCount === 9) {
    return {
      ...state,
      board: newBoard,
      status: 'draw',
      moveCount: newMoveCount,
    };
  }

  // 5. Continue playing
  return {
    ...state,
    board: newBoard,
    currentPlayer: getNextPlayer(state.currentPlayer),
    moveCount: newMoveCount,
  };
}