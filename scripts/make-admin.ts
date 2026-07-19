import { db } from '../lib/db/src/index.ts';
import { usersTable } from '../lib/db/src/schema/users.ts';
await db.insert(usersTable).values({
  clerkId: 'user_3E7fl8I2CvTZuAHPnWzAl85PGF7',
  email: 'alammahatab717@gmail.com',
  firstName: 'Admin',
  role: 'admin',
});
console.log('Done');
process.exit(0);
