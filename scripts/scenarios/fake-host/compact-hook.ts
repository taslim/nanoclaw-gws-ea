import { buildCompactInstructions } from '../../../container/agent-runner/src/compact-instructions.js';
const grants: unknown = JSON.parse(process.argv[2] ?? '[]');
if (!Array.isArray(grants) || !grants.every((entry): entry is string => typeof entry === 'string'))
  throw new Error('Invalid hook grants.');
console.log(buildCompactInstructions(['principal', 'outward', 'external-email'], null, new Set(grants)));
