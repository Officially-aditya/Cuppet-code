import * as readline from 'readline';
import {
  createGame,
  makeMove,
  type Game,
  type Player,
  type Square,
  type Line,
} from './game.js';
import { findBestMove } from './ai.js';

// Setup readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// --- CLI Functions ---

function renderBoard(board: Square[], winningLine: Line | null): string {
  // Helper to color output for better readability
  const C = (s: string, colorCode: number) => `\x1b[${colorCode}m${s}\x1b[0m`;
  
  const S = (i: number): string => {
    const value = board[i];
    if (winningLine && winningLine.includes(i)) {
      // Highlight winning line squares in green
      return C(value || ' ', 32); 
    }
    // Color X in cyan, O in magenta, and empty square number in dim white
    if (value === 'X') return C('X', 36);
    if (value === 'O') return C('O', 35);
    return C((i + 1).toString(), 90); // Fallback to dimmed number for empty square
  };

  return `
   ${S(0)} | ${S(1)} | ${S(2)}
  ---+---+---
   ${S(3)} | ${S(4)} | ${S(5)}
  ---+---+---
   ${S(6)} | ${S(7)} | ${S(8)}
  `;
}

function printHelp() {
  console.log(renderBoard([null, null, null, null, null, null, null, null, null], null));
  console.log(`
Tic-Tac-Toe CLI Game

How to play:
Enter a number (1-9) corresponding to the square you want to mark.

Commands:
  q or quit - Quit the game.
  h or help - Show this help message.
`);
}

function handleArgs() {
  if (process.argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }
}

// --- Game Loop ---

let game = createGame();
const humanPlayer: Player = 'X';
const aiPlayer: Player = 'O';

function startGame() {
  console.log('Starting Tic-Tac-Toe! You are X (Cyan). The AI is O (Magenta).');
  gameLoop();
}

function gameLoop() {
  if (game.status !== 'playing') {
    endGame();
    return;
  }

  if (game.currentPlayer === aiPlayer) {
    console.log("AI (O) is thinking...");
    // Minimax can be slow for the first few moves (since it searches the entire tree)
    const aiMove = findBestMove(game);
    game = makeMove(game, aiMove);
    console.log(`AI played in square ${aiMove + 1}.`);
    // Recurse immediately for the human player's turn
    gameLoop(); 
    return;
  }

  // Human player turn
  console.log(renderBoard(game.board, game.winningLine));
  rl.question(`Your turn (${game.currentPlayer}), enter square (1-9) or (q/h): `, (input) => {
    const normalizedInput = input.trim().toLowerCase();

    if (normalizedInput === 'q' || normalizedInput === 'quit') {
      console.log('Goodbye!');
      rl.close();
      return;
    }

    if (normalizedInput === 'h' || normalizedInput === 'help') {
      printHelp();
      gameLoop(); // Continue game after help
      return;
    }

    const index = parseInt(normalizedInput) - 1;

    // 1. Validate input format
    if (isNaN(index) || index < 0 || index > 8) {
      console.log(`\n❌ Invalid input: Please enter a number between 1 and 9, or 'q'.\n`);
      gameLoop();
      return;
    }

    const newState = makeMove(game, index);

    // 2. Validate move legality (occupied or post-game)
    if (newState === game) {
      // Check if square is occupied
      if (game.board[index] !== null) {
        console.log(`\n❌ Square ${index + 1} is already occupied by ${game.board[index]}. Choose an empty square.\n`);
      } else {
        // Should not happen if game.ts logic is correct, but safe fallback
        console.log(`\n❌ Move to square ${index + 1} is illegal in the current state.\n`);
      }
      gameLoop();
      return;
    }

    game = newState;
    gameLoop();
  });
}

function endGame() {
  console.log(renderBoard(game.board, game.winningLine));
  if (game.status === 'won') {
    const isAI = game.winner === aiPlayer;
    const message = isAI ? 
      `\n😭 Game over. AI (${game.winner}) wins in ${game.moveCount} moves!` :
      `\n🎉 Congratulations! You (${game.winner}) win in ${game.moveCount} moves!`;
    console.log(message);
  } else if (game.status === 'draw') {
    console.log(`\n🤝 Game over. It's a draw.`);
  }
  rl.close();
}

// Initial setup
handleArgs();
startGame();