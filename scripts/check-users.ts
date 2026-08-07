import { db } from '../lib/db/src/index.ts';
import { usersTable } from '../lib/db/src/schema/users.ts';
const result = await db.select().from(usersTable);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
