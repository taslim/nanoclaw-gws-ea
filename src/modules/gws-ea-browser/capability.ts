import { registerCapability } from '../../capabilities.js';

registerCapability('browser', {
  description: 'Host browser batches, sign-in, purchases, recipes and watches for sealed browser errands',
  default: 'off',
  instructions: ['gws-ea-browser'],
});
