/**
 * Usage:
 *   node scripts/create-user.js <username>
 *
 * Prompts for a password (visible in the terminal - this is a local admin
 * CLI, not a network-facing form) and creates or resets that user's login
 * for the Agent Deployment Manager dashboard.
 */
const readline = require("readline");
const userStore = require("../src/userStore");

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error("Usage: node scripts/create-user.js <username>");
    process.exit(1);
  }

  const password = await prompt(`Password for "${username}": `);
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const existing = userStore.findByUsername(username);
  if (existing) {
    await userStore.changePassword(username, password);
    console.log(`Password updated for existing user "${username}".`);
  } else {
    await userStore.createUser(username, password);
    console.log(`User "${username}" created.`);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
