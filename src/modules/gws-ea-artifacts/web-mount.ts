import type { ArtifactReadersMount } from '../gws-ea-web/mounts.js';
import { createArtifactViewResolver } from './access.js';
import { createArtifactViewHandler, isArtifactDocumentPath } from './server.js';
import { artifactAdmissionEmails } from './sharing.js';

export const artifactsWebMount: ArtifactReadersMount = {
  name: 'artifacts',
  audience: 'artifact-readers',
  path: '/artifacts',
  methods: ['GET', 'HEAD'],
  handler: (config, identity) =>
    createArtifactViewHandler({ hostname: config.hostname, resolve: createArtifactViewResolver(config, identity) }),
  admissionEmails: artifactAdmissionEmails,
  authoredContent: isArtifactDocumentPath,
};
