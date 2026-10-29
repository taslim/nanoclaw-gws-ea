import { registerResource, type ColumnDef } from '../../cli/crud.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { registerPersonForgetHook, registerPersonForgetReview } from '../gws-ea-people/db.js';
import { assertMainCaller, projectDocAudience } from '../gws-ea-profile/db.js';
import {
  getManualHistory,
  getManualSection,
  getManualSections,
  MANUAL_KEYS,
  manualKey,
  setManualSection,
} from './db.js';
import { forgetFromManual, manualToRewrite } from './forget.js';
import { loadManualFrontPage } from './front-page.js';
import { gwsEaManualMigration } from './migration.js';

registerMigration(gwsEaManualMigration);
registerPersonForgetReview('gws-ea-manual:forget', manualToRewrite);
registerPersonForgetHook('gws-ea-manual:forget', forgetFromManual);
registerRequiredProjectDocSection('gws-ea-manual:front-page', async (group) => {
  if (!(await getDb().hasTable('gws_ea_manual_sections')) || (await projectDocAudience(group.id)) !== 'main')
    return undefined;
  return { name: 'Principal Manual', body: await loadManualFrontPage() };
});

const SECTION: ColumnDef = {
  name: 'section',
  type: 'string',
  description: 'The Manual section.',
  enum: [...MANUAL_KEYS],
};
/** to: main */
registerResource({
  name: 'Manual',
  plural: 'manual',
  table: 'gws_ea_manual_sections',
  idColumn: 'key',
  description:
    "The principal's living Manual. Main only. Profile, whereabouts, scheduling preferences and people keep their facts in their own stores; Manual sections hold priorities, principles, other preferences, granted authority and narrative.",
  columns: [],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description:
        'Read every Manual section in full, or one with --section. Profile, whereabouts, preferences and people have their own reads. Read the Manual in chat when the principal asks. Share only the part a delegated job needs, under the existing disclosure rules.',
      args: [SECTION],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'the Manual');
        return args.section === undefined
          ? getManualSections()
          : ((await getManualSection(manualKey(args.section))) ?? null);
      },
    },
    set: {
      access: 'open',
      description:
        'Save a complete section, dating it and retaining its previous value. Text is always stored in full; a large section appears on the front page as a pointer. Empty text clears a section. Scheduling preferences belong only in ncl preferences; places, rhythm and the trip source only in ncl whereabouts. A taste correction becomes a principle; craft goes to the lessons queue. Authority records actual grants from the principal.',
      args: [
        { ...SECTION, required: true },
        { name: 'text', type: 'string', description: 'The complete section text.', required: true },
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'the Manual');
        if (typeof args.text !== 'string') throw new Error('--text is required');
        return setManualSection(manualKey(args.section), args.text);
      },
    },
    history: {
      access: 'open',
      description:
        'Read each retained dated previous section value, optionally for --section. Current text is available through get.',
      args: [SECTION],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'the Manual');
        return getManualHistory(args.section === undefined ? undefined : manualKey(args.section));
      },
    },
  },
});
