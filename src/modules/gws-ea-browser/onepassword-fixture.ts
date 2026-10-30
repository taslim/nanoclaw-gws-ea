/**
 * Test fixture: the 1Password SDK as an assistant's runtime service account sees it, and the host and instance
 * records that bind it. Tests mock `createClient` to return `FakeOnePassword.client()`; nothing here reaches
 * 1Password.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ItemFieldType, ItemState, type Item, type ItemCreateParams, type ItemOverview } from '@1password/sdk';

import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from './onepassword-policy.js';
import { instanceMarkerFile } from '../../gws-ea/paths.js';
import { instanceLayout } from '../../gws-ea/release-layout.js';
import { writePrivateFile } from './paths.js';

export const FIXTURE_ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
export const FIXTURE_SIGN_IN_ADDRESS = 'hale.1password.com';
export const FIXTURE_RUNTIME_ID = 'RUNTIMESERVICEACCOUNT00001';
export const FIXTURE_VAULT_ID = 'morganelleryvault000000001';
export const FIXTURE_INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
export const FIXTURE_TOKEN = 'ops_fixture-runtime-service-account-token';

type Operation = 'vaults' | 'list' | 'get' | 'create' | 'put' | 'delete' | 'resolve';
interface Fault {
  readonly error: Error;
  readonly applied: boolean | 'later';
}
const fail = (): never => {
  throw new Error('no such item');
};

/**
 * The provider as the SDK presents it: item versions, the optimistic lock on put, active listings, and faults that
 * can land a write before failing, as a lost response does. A full item carries no state, so a read returns an
 * archived item like any other; only the listing tells it apart.
 */
export class FakeOnePassword {
  readonly items = new Map<string, Item>();
  /** Items the principal archived in the 1Password app: still read in full, never listed as active. */
  readonly archived = new Set<string>();
  readonly calls: Operation[] = [];
  beforePut: (() => void) | undefined;
  /** Runs once the next create has stored its item, before the SDK answers. */
  afterCreate: (() => Promise<void>) | undefined;
  private count = 0;
  private readonly faults = new Map<Operation, Fault>();
  private readonly late: ItemCreateParams[] = [];

  constructor(private readonly vaultId = FIXTURE_VAULT_ID) {}

  /** The next call fails; its write lands first (`true`), never (`false`), or once `landLate` runs. */
  failNext(operation: Operation, error: Error, applied: Fault['applied'] = false): void {
    this.faults.set(operation, { error, applied });
  }

  landLate(): void {
    for (const params of this.late.splice(0)) this.store(params);
  }

  private take(operation: Operation): Fault | undefined {
    this.calls.push(operation);
    const fault = this.faults.get(operation);
    this.faults.delete(operation);
    return fault;
  }

  store(params: ItemCreateParams): Item {
    this.count += 1;
    const at = new Date();
    const item: Item = {
      id: `fakeitem${String(this.count).padStart(18, '0')}`,
      title: params.title,
      category: params.category,
      vaultId: params.vaultId,
      fields: params.fields ?? [],
      sections: params.sections ?? [],
      notes: params.notes ?? '',
      tags: params.tags ?? [],
      websites: params.websites ?? [],
      version: 1,
      files: [],
      createdAt: at,
      updatedAt: at,
    };
    this.items.set(item.id, structuredClone(item));
    return item;
  }

  /** The 1Password app's "Duplicate": a new item with the same content, tags included. */
  duplicate(id: string, title: string): Item {
    const { category, vaultId, fields, sections, notes, tags, websites } = structuredClone(
      this.items.get(id) ?? fail(),
    );
    return this.store({ category, vaultId, title, fields, sections, notes, tags, websites });
  }

  /** A principal's edit in the 1Password app: a new version, whatever changed. */
  edit(id: string, change: (item: Item) => Item): void {
    const current = this.items.get(id);
    if (!current) throw new Error('no such item');
    this.items.set(id, {
      ...change(structuredClone(current)),
      id,
      version: current.version + 1,
      updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
    });
  }

  value(id: string, fieldId: string): string | undefined {
    return this.items.get(id)?.fields.find((field) => field.id === fieldId)?.value;
  }

  concealed(): string[] {
    return [...this.items.values()].flatMap((item) =>
      item.fields.filter((field) => field.fieldType === ItemFieldType.Concealed).map((field) => field.value),
    );
  }

  client(): unknown {
    return {
      vaults: {
        list: async () => {
          this.take('vaults');
          return [{ id: this.vaultId }];
        },
      },
      items: {
        create: async (params: ItemCreateParams) => {
          const fault = this.take('create');
          if (fault?.applied === true) this.store(params);
          if (fault?.applied === 'later') this.late.push(structuredClone(params));
          if (fault) throw fault.error;
          const stored = this.store(params);
          const after = this.afterCreate;
          this.afterCreate = undefined;
          await after?.();
          return stored;
        },
        get: async (vaultId: string, itemId: string) => {
          const fault = this.take('get');
          if (fault) throw fault.error;
          const item = this.items.get(itemId);
          if (!item || item.vaultId !== vaultId) throw new Error('item not found');
          return structuredClone(item);
        },
        put: async (item: Item) => {
          const fault = this.take('put');
          const edit = this.beforePut;
          this.beforePut = undefined;
          edit?.();
          if (fault && fault.applied !== true) throw fault.error;
          const current = this.items.get(item.id);
          if (!current || current.version !== item.version) throw new Error('item version is out of date');
          const next: Item = { ...structuredClone(item), version: current.version + 1, updatedAt: new Date() };
          this.items.set(item.id, next);
          if (fault) throw fault.error;
          return structuredClone(next);
        },
        list: async (vaultId: string) => {
          const fault = this.take('list');
          if (fault) throw fault.error;
          return [...this.items.values()]
            .filter((item) => item.vaultId === vaultId && !this.archived.has(item.id))
            .map(
              (item): ItemOverview => ({
                id: item.id,
                title: item.title,
                category: item.category,
                vaultId: item.vaultId,
                websites: item.websites,
                tags: item.tags,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                state: ItemState.Active,
              }),
            );
        },
        delete: async (vaultId: string, itemId: string) => {
          const fault = this.take('delete');
          if (fault?.applied === true) this.items.delete(itemId);
          if (fault) throw fault.error;
          const item = this.items.get(itemId);
          if (!item || item.vaultId !== vaultId) throw new Error('item not found');
          this.items.delete(itemId);
        },
      },
      secrets: {
        resolve: async (reference: string) => {
          this.take('resolve');
          const [, , , itemId, field] = reference.split('/');
          return this.value(itemId, field) ?? '';
        },
      },
    };
  }
}

export interface VaultFixtureFiles {
  readonly browserRoot: string;
  readonly onePasswordPolicyFile: string;
  readonly tokenFile: string;
}

/** The host policy, instance marker, vault record and runtime token a ready vault reads, under `directory`. */
export async function writeVaultFixture(directory: string): Promise<VaultFixtureFiles> {
  const configRoot = path.join(directory, 'config');
  await mkdir(configRoot, { mode: 0o700 });
  const onePasswordPolicyFile = onePasswordHostPaths(configRoot).policyFile;
  await writeOnePasswordHostPolicy(onePasswordPolicyFile, {
    schemaVersion: 2,
    enabled: true,
    accountId: FIXTURE_ACCOUNT_ID,
    signInAddress: FIXTURE_SIGN_IN_ADDRESS,
    cliPath: '/opt/homebrew/bin/op',
    managementServiceAccountId: null,
  });
  const instanceRoot = path.join(directory, FIXTURE_INSTANCE_ID.slice(0, 8));
  await mkdir(instanceRoot, { mode: 0o700 });
  await writePrivateFile(
    instanceMarkerFile(instanceLayout(instanceRoot).state),
    JSON.stringify({ schema_version: 1, instance_id: FIXTURE_INSTANCE_ID }),
  );
  const files = onePasswordInstancePaths(instanceRoot);
  await writeOnePasswordResources(files.resourceFile, {
    schemaVersion: 2,
    instanceId: FIXTURE_INSTANCE_ID,
    accountId: FIXTURE_ACCOUNT_ID,
    vault: { id: FIXTURE_VAULT_ID, createdBy: { kind: 'operator' } },
    operatorGrant: null,
    runtimeServiceAccountId: FIXTURE_RUNTIME_ID,
    retiredRuntimeServiceAccountIds: [],
  });
  await writePrivateFile(files.runtimeTokenFile, FIXTURE_TOKEN);
  return {
    browserRoot: path.join(instanceRoot, 'browser'),
    onePasswordPolicyFile,
    tokenFile: files.runtimeTokenFile,
  };
}
