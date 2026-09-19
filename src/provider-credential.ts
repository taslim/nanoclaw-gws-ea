/** Provider-owned credential description shared by setup and vault importers. */
export interface ProviderCredential {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly hostPattern: string;
  readonly pathPattern?: string;
  readonly headerName?: string;
  readonly valueFormat?: string;
  readonly paramName?: string;
  readonly paramFormat?: string;
}

export type ProviderCredentialMetadata = Omit<ProviderCredential, 'value'>;

export function credentialMatchesMetadata(
  credential: ProviderCredential,
  metadata: ProviderCredentialMetadata,
): boolean {
  return (
    credential.name === metadata.name &&
    credential.type === metadata.type &&
    credential.hostPattern === metadata.hostPattern &&
    credential.pathPattern === metadata.pathPattern &&
    credential.headerName === metadata.headerName &&
    credential.valueFormat === metadata.valueFormat &&
    credential.paramName === metadata.paramName &&
    credential.paramFormat === metadata.paramFormat
  );
}

export function sameCredentialMetadata(left: ProviderCredentialMetadata, right: ProviderCredentialMetadata): boolean {
  return credentialMatchesMetadata({ ...left, value: '' }, right);
}
