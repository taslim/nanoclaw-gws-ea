/** The host's one public-address policy. DNS is checked once and the caller dials the IP it returns. */
import dns from 'node:dns/promises';
import net from 'node:net';

import ipaddr from 'ipaddr.js';

export interface Destination {
  port: number;
  address: string;
  family: 4 | 6;
}

export class RefusedDestination extends Error {}

export function publicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv4') return parsed.range() === 'unicast';
  // IPv4 embeddings, translation ranges, 6to4, Teredo, reserved and local
  // ranges are excluded even when their inner IPv4 address would be public.
  return parsed.range() === 'unicast' && parsed.match(ipaddr.parse('2000::'), 3);
}

export async function resolveDestination(target: URL): Promise<Destination> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new RefusedDestination();
  if (target.username || target.password) throw new RefusedDestination();
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  // WHATWG URL canonicalizes legacy integer/hex/octal IP spellings first.
  // Every literal is refused, so no spelling can bypass the resolver check.
  if (![80, 443].includes(port) || net.isIP(host) !== 0 || ipaddr.isValid(host) || !host) {
    throw new RefusedDestination();
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (answers.length === 0 || answers.some(({ address }) => !publicAddress(address))) throw new RefusedDestination();
  const selected = answers[0];
  if (selected.family !== 4 && selected.family !== 6) throw new RefusedDestination();
  return { port, address: selected.address, family: selected.family };
}
