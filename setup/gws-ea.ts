import { runCli } from '../src/gws-ea/cli.js';
import { authenticateGwsEaProvider, collectGwsEaCreateInput } from './gws-ea-input.js';
import { listSetupProviders } from './providers/registry.js';
import './providers/index.js';

const providers = listSetupProviders();

process.exitCode = await runCli(process.argv.slice(2), {
  collectCreateInputs: (context) => collectGwsEaCreateInput(context, { providers }),
  authenticateProvider: (provider) => authenticateGwsEaProvider(provider, providers),
});
