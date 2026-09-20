import type { AgentGroup } from './types.js';

export interface RequiredProjectDocSection {
  readonly name: string;
  readonly body: string;
}

export type RequiredProjectDocSectionProvider = (
  group: AgentGroup,
) => RequiredProjectDocSection | undefined | Promise<RequiredProjectDocSection | undefined>;

const providers = new Map<string, RequiredProjectDocSectionProvider>();
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

/**
 * Register a host-rendered section that must survive project-document size
 * degradation. Modules own their data and rendering; core owns only this
 * provider-neutral composition seam.
 */
export function registerRequiredProjectDocSection(id: string, provider: RequiredProjectDocSectionProvider): void {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`Project-document section provider "${id}" must use "<module-id>:<section-id>"`);
  }
  if (providers.has(id)) throw new Error(`Project-document section provider "${id}" is already registered`);
  providers.set(id, provider);
}

export async function getRequiredProjectDocSections(group: AgentGroup): Promise<RequiredProjectDocSection[]> {
  const sections: RequiredProjectDocSection[] = [];
  for (const [id, provider] of providers) {
    const section = await provider(group);
    if (section === undefined) continue;
    const name = section.name.trim();
    const body = section.body.trim();
    if (!name || !body || /[\r\n]/u.test(name)) {
      throw new Error(`Project-document section provider "${id}" returned an invalid section`);
    }
    sections.push({ name, body });
  }
  return sections;
}
