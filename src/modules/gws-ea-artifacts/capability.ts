import { registerCapability } from '../../capabilities.js';
import { ARTIFACTS_CAPABILITY, hasArtifactsAccess } from './policy.js';

registerCapability(ARTIFACTS_CAPABILITY, {
  description: 'Create, revise and inspect private HTML artifacts; canonical main manages sharing',
  default: 'off',
  instructions: ['gws-ea-artifacts'],
  skills: ['artifact-designer'],
  grantedTo: hasArtifactsAccess,
});
export { ARTIFACTS_CAPABILITY } from './policy.js';
