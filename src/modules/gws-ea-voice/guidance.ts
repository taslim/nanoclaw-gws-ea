import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../log.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';

// Original receiving-agent guidance, informed by FreeFlow's public fidelity
// principles (Sources/PostProcessingService.swift), without copying its prompt
// or its dictation-only prohibition on fulfilling the user's requests.
const GUIDANCE_FILE = path.join('src', 'modules', 'gws-ea-voice', 'guidance.md');

registerRequiredProjectDocSection('gws-ea-voice:guidance', () => {
  const file = path.resolve(process.cwd(), GUIDANCE_FILE);
  if (!fs.existsSync(file)) {
    log.error('Voice guidance is missing; the agent starts without it', { file });
    return undefined;
  }
  const body = fs.readFileSync(file, 'utf8').trim();
  if (!body) {
    log.error('Voice guidance is empty; the agent starts without it', { file });
    return undefined;
  }
  return { name: 'Voice notes', body };
});
