import { registerResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { addLesson, listLessons, LessonRefusal, LESSON_STATUSES, type LessonStatus } from './db.js';
import { lessonsMigration } from './migration.js';

registerMigration(lessonsMigration);

async function asMain<T>(ctx: CallerContext, work: () => Promise<T>): Promise<T> {
  let main: string | null;
  try {
    main = await getMainAgentGroupId();
  } catch (error) {
    throw new Error('Lessons are unavailable just now.', { cause: error });
  }
  if (ctx.caller === 'agent' && (main === null || ctx.agentGroupId !== main))
    throw new Error('Only main may use lessons.');
  try {
    return await work();
  } catch (error) {
    if (error instanceof LessonRefusal) throw error;
    throw new Error('Lessons are unavailable just now.', { cause: error });
  }
}

registerResource({
  name: 'lesson',
  plural: 'lessons',
  table: 'gws_ea_lessons',
  idColumn: 'id',
  description: 'General craft principles for review. Only main may add or read them; private details are refused.',
  columns: [],
  operations: {},
  customOperations: {
    add: {
      access: 'open',
      description: 'Queue a general craft principle, without private details. Exact repeats are held once.',
      args: [
        {
          name: 'text',
          type: 'string',
          required: true,
          description: 'One general principle without names, places or contact details.',
        },
      ],
      handler: (args, ctx) => asMain(ctx, () => addLesson(String(args.text))),
    },
    list: {
      access: 'open',
      description: 'Read lessons and their review status; check for earlier lessons before adding one.',
      args: [
        {
          name: 'status',
          type: 'string',
          enum: [...LESSON_STATUSES],
          description: 'queued, accepted, folded or declined; omit for all.',
        },
      ],
      handler: (args, ctx) => asMain(ctx, () => listLessons(args.status as LessonStatus | undefined)),
    },
  },
});
