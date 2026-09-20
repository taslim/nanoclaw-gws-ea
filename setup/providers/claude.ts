import { registerSetupProvider } from './registry.js';
import { claudeProvisioning } from './claude-auth.js';

registerSetupProvider({
  value: 'claude',
  label: 'Claude',
  hint: 'default — Anthropic subscription or API key',
  provisioning: claudeProvisioning,
});
