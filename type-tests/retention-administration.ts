import { defineAuth } from '@clank.run/framework/auth';
import { defineDatabase, defineTable } from '@clank.run/framework/backend';
import { s } from '@clank.run/framework/ai';
import { openRetentionAdministration, createRetentionAdministrationClient, mountRetentionAdministration, type RetentionScheduleInput } from '@clank.run/framework/retention-administration';
import { type RetentionKind } from '@clank.run/framework';
const schema = defineDatabase({ operators: defineTable({ userId: s.string(), allowed: s.boolean() }).index('by_user', ['userId']) });
void openRetentionAdministration({ path: 'app.sqlite', auth: defineAuth(), schema, sources: { imports: true, collaboration: { maxCharacters: 100000 } }, policyRevision: 'operator/1', scope: (_context, resource) => resource.ownerId ?? null,
  authorize({ auth, db }, scope, operation) {
    // @ts-expect-error Retention policies retain the declared schema field contract.
    db.table('operators').query().where('missing', scope);
    return auth.user?.id === scope && db.table('operators').query().where('userId', scope).first()?.allowed === true && operation !== 'schedule';
  }, intervalMs: false });
const client = createRetentionAdministrationClient();
void client.inventory('account', { kinds: ['import'], limit: 10 });
// @ts-expect-error Unknown source kinds are not accepted.
void client.inventory('account', { kinds: ['files'] });
const rule: RetentionScheduleInput = { id: 'daily', scope: 'account', expectedVersion: 0, kinds: ['collaboration'], olderThanMs: 86400000, everyMs: 86400000, maxDeletes: 1000, state: 'active' };
void client.saveSchedule(rule, 'accepted-identity');
// @ts-expect-error Explicit current hold versions are required.
void client.release('account', { kind: 'import', id: 'job' }, 'operation');
// @ts-expect-error Schedule states are explicit and bounded by the protocol.
const badRule: RetentionScheduleInput = { ...rule, state: 'deleted' }; void badRule;
const kind: RetentionKind = 'audit'; void kind;
void mountRetentionAdministration(document.body, { client, currentUser: () => 'account', scope: () => 'account', kinds: ['import'] });
// @ts-expect-error Account binding is mandatory for the operator UI.
void mountRetentionAdministration(document.body, { client, scope: () => 'account' });
