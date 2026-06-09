/**
 * Humorous, value-laden phrases shown by the main-conversation WorkingSpinner
 * while the agent is running. One is picked per turn (keyed by runId) and stays
 * fixed for that turn.
 *
 * Phrases carry the ohbaby-agent personality ("building an agent just like
 * raising a baby" / Saint Seiya cosmo imagery). Edit freely — count need not be
 * exactly ten.
 */
export const WORKING_PHRASES = [
  "I was thinking about the name of this project when I travelled to Shenzhen...",
  "I still remember the time I couldn't walk and just crawled...",
  "Looking back on the path of raising a baby, I mean, an agent...",
  "The awakening of individual consciousness...",
  'Guess where the "ohbaby-agent" name comes from...',
  "Actually, I watched Saint Seiya during my Java course in my sophomore year...",
  "What's your favorite programming language?...",
  "I do nearly everything with the help of Codex and Claude Code these days...",
  "How did you find your internships?...",
  "Using parallel agents to complete tasks actually distracts my attention...",
] as const;

/** Pick a random phrase. Used once per turn. */
export function pickWorkingPhrase(): string {
  const index = Math.floor(Math.random() * WORKING_PHRASES.length);
  return WORKING_PHRASES[index] ?? WORKING_PHRASES[0];
}
