import { register } from '../../cli/registry.js';
import { confirmAliasCandidate, getAliasSetup, proposeAliasCandidate } from './db.js';

function fields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown alias field: --${unknown[0]}`);
}

function address(raw: Record<string, unknown>): string {
  if (typeof raw.address !== 'string' || raw.address.length === 0) throw new Error('--address is required');
  return raw.address;
}

register({
  name: 'gws-ea-alias-get',
  description: "Report the web alias's setup.",
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    fields(raw, []);
    return undefined;
  },
  handler: async () => getAliasSetup(),
});

register({
  name: 'gws-ea-alias-propose',
  description: 'Propose the web alias (--address), or withdraw the candidate (--none).',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    fields(raw, ['address', 'none']);
    if (raw.none === true && raw.address === undefined) return null;
    if (raw.none !== undefined) throw new Error('Give --address or --none, not both');
    return address(raw);
  },
  handler: async (candidate) => proposeAliasCandidate(candidate),
});

register({
  name: 'gws-ea-alias-confirm',
  description: 'Record that the operator added exactly the proposed web alias.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    fields(raw, ['address']);
    return address(raw);
  },
  handler: async (candidate) => {
    if (!(await confirmAliasCandidate(candidate)))
      throw new Error('The web alias candidate changed; run the command again');
    return getAliasSetup();
  },
});
