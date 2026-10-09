import { describe, expect, it } from 'vitest';

import { untrusted, untrustedLine } from './untrusted.js';

/** Every model control token the wrapper neutralizes. */
const CONTROL_TOKENS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|begin_of_text|>',
  '<|end_of_text|>',
  '<|start_header_id|>',
  '<|end_header_id|>',
  '<|eot_id|>',
  '<|python_tag|>',
  '<|eom_id|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '<|channel|>',
  '<|message|>',
  '<|return|>',
  '<|call|>',
  '<start_of_turn>',
  '<end_of_turn>',
  '<|reserved_special_token_42|>',
];

describe('untrusted text', () => {
  it.each(CONTROL_TOKENS)('neutralizes %s in a body and in a line', (token) => {
    for (const wrapped of [untrusted(`before ${token} after`, 1_000), untrustedLine(`before ${token} after`, 1_000)]) {
      expect(wrapped).not.toContain(token);
      expect(wrapped).toContain('before [REMOVED_SPECIAL_TOKEN] after');
    }
  });
});
