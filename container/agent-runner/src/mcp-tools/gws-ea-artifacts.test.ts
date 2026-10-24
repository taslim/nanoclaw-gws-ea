import { expect, it } from 'bun:test';
import Ajv from 'ajv';
import { artifactDelete, artifactList, artifactRead, artifactSave, artifactShare } from './gws-ea-artifacts.js';
const hash = 'a'.repeat(64);
const mark = { id: 'principal-message', messaging_group_id: 'chat' };
it.each([
  [artifactSave, { create_key: 'trip', title: 'Trip', file: 'trip.html' }],
  [artifactSave, { artifact_id: 'trip', expected_revision: 1, title: 'Trip', file: 'trip.html' }],
  [artifactRead, { artifact_id: 'trip', checkout: true }],
  [artifactRead, { artifact_id: 'trip', shares_after: 'share-cursor' }],
  [artifactList, {}],
  [artifactDelete, { artifact_id: 'trip', expected_generation: 1 }],
  [
    artifactShare,
    {
      operation: 'named_publish',
      artifact_id: 'trip',
      revision: 1,
      expected_hash: hash,
      principal_message: mark,
      recipients: [{ email: 'juno@example.com', name: 'Juno' }],
    },
  ],
  [
    artifactShare,
    { operation: 'public_publish', artifact_id: 'trip', revision: 1, expected_hash: hash, principal_message: mark },
  ],
  [
    artifactShare,
    { operation: 'revoke', artifact_id: 'trip', share_id: 'share', expected_generation: 1, principal_message: mark },
  ],
] as const)('closes every artifact tool to caller-chosen authority fields: %s', (tool, args) => {
  const validate = new Ajv({ strict: false }).compile(tool.tool.inputSchema);
  expect(validate(args)).toBe(true);
  for (const field of ['author_group_id', 'session_id', 'isMain', 'grant'])
    expect(validate({ ...args, [field]: 'spoof' })).toBe(false);
});
it('rejects mixed create/revise and mixed audience operations', () => {
  const validateSave = new Ajv({ strict: false }).compile(artifactSave.tool.inputSchema);
  expect(
    validateSave({ create_key: 'trip', artifact_id: 'trip', expected_revision: 1, title: 'Trip', file: 'trip.html' }),
  ).toBe(false);
  const validateShare = new Ajv({ strict: false }).compile(artifactShare.tool.inputSchema);
  expect(
    validateShare({
      operation: 'public_publish',
      artifact_id: 'trip',
      revision: 1,
      expected_hash: hash,
      principal_message: mark,
      recipients: [{ email: 'juno@example.com' }],
    }),
  ).toBe(false);
});
it('accepts opaque native principal message IDs while refusing empty, oversized and control-bearing marks', () => {
  const validate = new Ajv({ strict: false }).compile(artifactShare.tool.inputSchema);
  const request = { operation: 'public_publish', artifact_id: 'trip', revision: 1, expected_hash: hash };
  expect(validate({ ...request, principal_message: { ...mark, id: 'spaces/AAAAjuno/messages/remy.1' } })).toBe(true);
  for (const id of ['', 'a'.repeat(1025), 'spaces/room\n/messages/message', 'message\u007f'])
    expect(validate({ ...request, principal_message: { ...mark, id } })).toBe(false);
});
